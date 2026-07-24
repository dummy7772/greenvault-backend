// controllers/mobileOtpController.js
const { validationResult } = require('express-validator');
const db           = require('../config/db');
const { ok, fail } = require('../utils/response');

const OTP_EXPIRY_MINUTES = 5;

// ── One-time migration ────────────────────────────────────────────────────────
// Lazily creates the mobile_otp_verifications table on first use, mirroring the
// pattern already used in controllers/securityController.js.
let _migrated = false;

async function ensureMobileOtpTable() {
  if (_migrated) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS mobile_otp_verifications (
        id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
        phone       VARCHAR(15)     NOT NULL,
        otp         VARCHAR(6)      NOT NULL,
        expires_at  TIMESTAMP       NOT NULL,
        verified    TINYINT(1)      NOT NULL DEFAULT 0,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_motp_phone (phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    _migrated = true;
  } catch (err) {
    console.error('[mobile-otp-migration] error:', err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── POST /api/users/send_mob_otp_register ────────────────────────────────────
// Generates a 6-digit OTP for the given mobile number, valid for 5 minutes.
// Any previous OTP(s) issued for that number are invalidated (deleted) first,
// so this same endpoint also powers "Resend OTP".

async function sendMobOtpRegister(req, res) {
  await ensureMobileOtpTable();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const phone = req.body.phone.trim();

  try {
    // Prevent duplicate mobile numbers — block OTP issuance for a number
    // that's already tied to an existing account.
    const [existingUser] = await db.execute(
      'SELECT id FROM users WHERE phone = ? LIMIT 1',
      [phone]
    );
    if (existingUser.length > 0) {
      return fail(res, 'An account with this mobile number already exists', 409);
    }

    // Invalidate any previous OTP(s) for this number (covers resend flow).
    await db.execute(
      'DELETE FROM mobile_otp_verifications WHERE phone = ?',
      [phone]
    );

    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await db.execute(
      `INSERT INTO mobile_otp_verifications (phone, otp, expires_at, verified)
       VALUES (?, ?, ?, 0)`,
      [phone, otp, expiresAt]
    );

    // In production, integrate an SMS gateway here (e.g. Twilio, MSG91).
    console.log(`[send_mob_otp_register] Phone ${phone} | OTP: ${otp}`);

    return ok(res, 'OTP sent to your mobile number', {
      phone,
      expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
      // Dev-mode only — Flutter uses this to verify without a real SMS gateway.
      // Remove this field once an SMS provider is wired up in production.
      ...(process.env.NODE_ENV !== 'production' && { otp }),
    });
  } catch (err) {
    console.error('[sendMobOtpRegister]', err);
    return fail(res, 'Failed to send OTP. Please try again.', 500);
  }
}

// ── POST /api/users/verify_mob_otp_register ──────────────────────────────────
// Verifies the OTP for a mobile number. On success, marks it verified so the
// registration endpoint can confirm the number was OTP-checked before the
// account is created.

async function verifyMobOtpRegister(req, res) {
  await ensureMobileOtpTable();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const phone = req.body.phone.trim();
  const otp   = req.body.otp.trim();

  try {
    const [rows] = await db.execute(
      `SELECT id, otp, expires_at, verified
         FROM mobile_otp_verifications
        WHERE phone = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [phone]
    );

    if (rows.length === 0) {
      return fail(res, 'No OTP was requested for this number. Please request a new OTP.', 400);
    }

    const record = rows[0];

    if (record.verified === 1) {
      return fail(res, 'This OTP has already been used. Please proceed to registration.', 400);
    }

    if (new Date() > new Date(record.expires_at)) {
      // Clean up the expired row so a stale OTP can never be replayed.
      await db.execute(
        'DELETE FROM mobile_otp_verifications WHERE id = ?',
        [record.id]
      );
      return fail(res, 'OTP has expired. Please request a new one.', 400);
    }

    if (record.otp !== otp) {
      return fail(res, 'Invalid OTP. Please try again.', 400);
    }

    await db.execute(
      'UPDATE mobile_otp_verifications SET verified = 1 WHERE id = ?',
      [record.id]
    );

    return ok(res, 'Mobile number verified successfully', { phone, verified: true });
  } catch (err) {
    console.error('[verifyMobOtpRegister]', err);
    return fail(res, 'Failed to verify OTP. Please try again.', 500);
  }
}

// ── Internal helper used by authController.register ──────────────────────────
// Confirms a mobile number has a verified OTP record before allowing account
// creation. Not exposed as a route.

async function isPhoneOtpVerified(phone) {
  await ensureMobileOtpTable();
  const [rows] = await db.execute(
    `SELECT id FROM mobile_otp_verifications
      WHERE phone = ? AND verified = 1
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone.trim()]
  );
  return rows.length > 0;
}

/** Called after a successful registration to clean up the used OTP record. */
async function clearVerifiedOtp(phone) {
  try {
    await db.execute(
      'DELETE FROM mobile_otp_verifications WHERE phone = ?',
      [phone.trim()]
    );
  } catch (err) {
    console.error('[clearVerifiedOtp]', err.message);
  }
}

module.exports = {
  sendMobOtpRegister,
  verifyMobOtpRegister,
  isPhoneOtpVerified,
  clearVerifiedOtp,
};