// utils/referralCode.js
//
// Generates new-format referral codes for newly registered users only.
//
// Format:  MT + 3-digit zero-padded sequence + first initial of first name
//          + first initial of last name, both uppercase.
//
//   Examples:
//     seq=1,   firstName="Max",   lastName="Kumar"  → "MT001MK"
//     seq=9,   firstName="Aryan", lastName="Tiwari" → "MT009AT"
//     seq=125, firstName="Raj",   lastName="Kumar"  → "MT125RK"
//     seq=10,  firstName="Meera", lastName=""       → "MT010MX"  (no last name → 'X')
//
// Sequence grows naturally past 999 without truncating:
//   seq=1000, firstName="Max", lastName="Kumar" → "MT1000MK"
//
// Rules:
//  • Only ever called ONCE per user, at registration time (authController.js).
//  • Existing users' my_referral_code is NEVER touched or replaced.
//  • If the generated candidate collides with any existing code (e.g. a
//    legacy GV-format code that happened to be set this way, or a same-
//    initials user registered in the same sequence slot), the sequence is
//    advanced and the next candidate is tried — guaranteeing uniqueness
//    before writing.
//  • Assignment is inside a transaction with SELECT...FOR UPDATE row
//    locking, so concurrent registrations never receive the same sequence
//    number.
//
// Design mirrors utils/memberId.js — a dedicated `referral_code_sequence`
// counter table (seeded in config/schema.sql) keeps the sequence
// independent of users.id and member_id_sequence.

const db = require('../config/db');

const SEQUENCE_NAME = 'user_referral_code';
const MAX_ATTEMPTS  = 1000;

/**
 * Returns the first letter of a name string, uppercased.
 * Falls back to 'X' when the name is empty, null, or whitespace-only,
 * so the 7-character code format is never broken by missing data.
 *
 * Examples:
 *   initial("meera")  → "M"
 *   initial("Kumar")  → "K"
 *   initial("")       → "X"
 *   initial(null)     → "X"
 */
function initial(name) {
  const trimmed = (name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : 'X';
}

/**
 * Builds one candidate referral code for a given sequence number.
 *
 *   buildCode(1,   "Max",   "Kumar")  → "MT001MK"
 *   buildCode(9,   "Aryan", "Tiwari") → "MT009AT"
 *   buildCode(125, "Raj",   "Kumar")  → "MT125RK"
 *   buildCode(10,  "Meera", "")       → "MT010MX"
 *   buildCode(1000,"Max",   "Kumar")  → "MT1000MK"
 */
function buildCode(seq, firstName, lastName) {
  const paddedSeq = String(seq).padStart(3, '0');
  const fi = initial(firstName);
  const li = initial(lastName);
  return `MT${paddedSeq}${fi}${li}`;
}

/**
 * Atomically claims the next available referral code and writes it onto
 * the given user's row. Must be called exactly once per new user,
 * immediately after their row is inserted during registration.
 *
 * Never call this for an existing user — it does not backfill or replace
 * codes for users created before this feature was introduced.
 *
 * Returns the assigned referral code string (e.g. "MT001MK").
 *
 * @param {number} userId     - The newly inserted users.id
 * @param {string} firstName  - User's first name (for the first initial)
 * @param {string} lastName   - User's last name  (for the second initial; 'X' if blank)
 */
async function assignReferralCode(userId, firstName, lastName) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the counter row for the duration of this transaction so
    // concurrent registrations queue up and never get the same number.
    const [seqRows] = await conn.execute(
      'SELECT next_value FROM referral_code_sequence WHERE name = ? FOR UPDATE',
      [SEQUENCE_NAME]
    );

    if (seqRows.length === 0) {
      // Should never happen — config/schema.sql seeds this row on startup.
      throw new Error(
        `referral_code_sequence row "${SEQUENCE_NAME}" not found — re-run config/schema.sql`
      );
    }

    let seq  = seqRows[0].next_value;
    let code = null;

    // Walk forward through sequence values until we find a candidate that
    // does not already exist in users.my_referral_code. This handles the
    // (rare) case where a legacy GV-format code, or a manually-set code,
    // happens to match the MT<seq><initials> pattern we would generate.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const candidate = buildCode(seq, firstName, lastName);

      const [conflict] = await conn.execute(
        'SELECT id FROM users WHERE my_referral_code = ? LIMIT 1',
        [candidate]
      );

      // Always advance seq BEFORE the break so the stored next_value is
      // always one past the last code we actually examined (whether used
      // or skipped due to a collision). This ensures no sequence number
      // is ever handed out a second time.
      seq += 1;

      if (conflict.length === 0) {
        code = candidate;
        break;
      }
      // Collision — try the next sequence value on the next iteration.
    }

    if (!code) {
      throw new Error(
        `Could not find a unique referral code after ${MAX_ATTEMPTS} attempts`
      );
    }

    // Persist the advanced counter so the next registration picks up where
    // this one left off.
    await conn.execute(
      'UPDATE referral_code_sequence SET next_value = ? WHERE name = ?',
      [seq, SEQUENCE_NAME]
    );

    // Write the code onto the user row.
    await conn.execute(
      'UPDATE users SET my_referral_code = ? WHERE id = ?',
      [code, userId]
    );

    await conn.commit();
    return code;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { assignReferralCode };