// utils/memberId.js
//
// Generates the human-readable "member ID" (MT1112, MT1113, MT1114, ...)
// shown to users/admins, separate from the internal `users.id` primary key
// that everything else in the codebase (FKs, JWT `sub`, session tracking,
// etc.) continues to use unchanged.
//
// Design:
//  • `users.member_id` — new nullable, unique column. Existing users are
//    left untouched (NULL) — this migration never backfills old rows.
//  • `member_id_sequence` — a single-row counter table (created by
//    config/schema.sql) that hands out the next MT number. Using a
//    dedicated counter instead of `users.id` means the sequence is never
//    affected by deletions/gaps in the users table and a number is never
//    reused, even if a registration fails partway through.
//  • Assignment happens inside its own transaction with `SELECT ... FOR
//    UPDATE` row locking, so concurrent registrations can never be handed
//    the same MT number.

const db = require('../config/db');

const SEQUENCE_NAME = 'user_member_id';

let _memberIdColumnVerified = false;

/**
 * Idempotent, safe-to-call-every-time migration that adds `users.member_id`
 * if it doesn't already exist. Mirrors the same
 * INFORMATION_SCHEMA.COLUMNS-guarded pattern already used elsewhere in this
 * codebase (see ensureAccountStatusColumn / ensureProfileColumns) so it
 * works regardless of MySQL version and is safe to run on every boot.
 *
 * The `member_id_sequence` counter table itself is created/seeded by
 * config/schema.sql (auto-run on startup via config/db.js), so it's
 * guaranteed to exist by the time this runs.
 */
async function ensureMemberIdSchema() {
  if (_memberIdColumnVerified) return;
  try {
    const [rows] = await db.execute(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'users'
          AND COLUMN_NAME  = 'member_id'
        LIMIT 1`
    );
    if (rows.length === 0) {
      console.warn('[member-id] member_id column missing — running migration…');
      await db.execute(
        `ALTER TABLE users
           ADD COLUMN member_id VARCHAR(20) NULL DEFAULT NULL AFTER id`
      );
      await db.execute(
        `ALTER TABLE users
           ADD UNIQUE KEY uq_member_id (member_id)`
      );
      console.log('[member-id] ✅ member_id column added to users table.');
    }
    _memberIdColumnVerified = true;
  } catch (err) {
    console.error('[member-id] schema check failed:', err.message);
    // Non-fatal — let the caller proceed; assignMemberId() will simply fail
    // loudly (and be caught/logged) if the column truly isn't there yet.
  }
}

// ── Self-healing guard ───────────────────────────────────────────────────
// Same fix as the referral-code sequence table (utils/referralCode.js):
// previously this assumed config/schema.sql had already created
// `member_id_sequence` before assignMemberId() ever ran. If that table was
// missing on a given deploy, the SELECT ... FOR UPDATE below threw,
// registration silently swallowed the error, and the user was left with
// member_id = NULL. assignMemberId() now ensures its own table exists
// every time it runs, independent of schema.sql.
let _seqTableReady = false;
async function ensureSequenceTable() {
  if (_seqTableReady) return;
  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_id_sequence (
      name        VARCHAR(50)  NOT NULL,
      next_value  INT UNSIGNED NOT NULL,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await db.execute(
    `INSERT INTO member_id_sequence (name, next_value)
     SELECT ?, 1112
     WHERE NOT EXISTS (
       SELECT 1 FROM member_id_sequence WHERE name = ?
     )`,
    [SEQUENCE_NAME, SEQUENCE_NAME]
  );
  _seqTableReady = true;
}

/**
 * Atomically claims the next MT number and writes it onto the given user's
 * row. Intended to be called exactly once, right after a brand-new user is
 * inserted during registration. Never call this for an existing user — it
 * always assigns from the "next" counter value going forward, it does not
 * fill in numbers for users created before this feature existed.
 *
 * Returns the new member ID string (e.g. "MT1112").
 */
async function assignMemberId(userId) {
  await ensureSequenceTable();

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [seqRows] = await conn.execute(
      'SELECT next_value FROM member_id_sequence WHERE name = ? FOR UPDATE',
      [SEQUENCE_NAME]
    );

    if (seqRows.length === 0) {
      // Should never happen — config/schema.sql seeds this row on startup —
      // but guard against a database that hasn't run the latest schema yet.
      throw new Error(
        `member_id_sequence row "${SEQUENCE_NAME}" not found — re-run config/schema.sql`
      );
    }

    const nextValue = seqRows[0].next_value;
    const memberId = `MT${nextValue}`;

    await conn.execute(
      'UPDATE member_id_sequence SET next_value = next_value + 1 WHERE name = ?',
      [SEQUENCE_NAME]
    );

    await conn.execute(
      'UPDATE users SET member_id = ? WHERE id = ?',
      [memberId, userId]
    );

    await conn.commit();
    return memberId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { ensureMemberIdSchema, assignMemberId };
