// controllers/emailOtpController.js
const { validationResult } = require('express-validator');
const db           = require('../config/db');
const { ok, fail } = require('../utils/response');

const OTP_EXPIRY_MINUTES = 5;

// ── One-time migration ────────────────────────────────────────────────────────
// Lazily creates the email_otp_verifications table on first use, mirroring the
// pattern already used in controllers/mobileOtpController.js.
let _migrated = false;

async function ensureEmailOtpTable() {
  if (_migrated) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS email_otp_verifications (
        id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
        email       VARCHAR(191)    NOT NULL,
        otp         VARCHAR(6)      NOT NULL,
        expires_at  TIMESTAMP       NOT NULL,
        verified    TINYINT(1)      NOT NULL DEFAULT 0,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_eotp_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    _migrated = true;
  } catch (err) {
    console.error('[email-otp-migration] error:', err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(raw) {
  return (raw || '').trim().toLowerCase();
}

// ── POST /api/users/send_email_otp_register ───────────────────────────────────
// Generates a 6-digit OTP for the given email address, valid for 5 minutes.
// Any previous OTP(s) issued for that email are invalidated (deleted) first,
// so this same endpoint also powers "Resend Code".

async function sendEmailOtpRegister(req, res) {
  await ensureEmailOtpTable();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const email = normalizeEmail(req.body.email);

  try {
    // Prevent duplicate emails — block OTP issuance for an address that's
    // already tied to an existing account.
    const [existingUser] = await db.execute(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    if (existingUser.length > 0) {
      return fail(res, 'An account with this email already exists', 409);
    }

    // Invalidate any previous OTP(s) for this email (covers resend flow).
    await db.execute(
      'DELETE FROM email_otp_verifications WHERE email = ?',
      [email]
    );

    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await db.execute(
      `INSERT INTO email_otp_verifications (email, otp, expires_at, verified)
       VALUES (?, ?, ?, 0)`,
      [email, otp, expiresAt]
    );

    // In production, integrate an email gateway here (e.g. SES, SendGrid, SMTP).
    console.log(`[send_email_otp_register] Email ${email} | OTP: ${otp}`);

    return ok(res, 'OTP sent to your email address', {
      email,
      expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
      // Dev-mode only — Flutter uses this to verify without a real email
      // gateway. Remove this field once an email provider is wired up in
      // production.
      ...(process.env.NODE_ENV !== 'production' && { otp }),
    });
  } catch (err) {
    console.error('[sendEmailOtpRegister]', err);
    return fail(res, 'Failed to send OTP. Please try again.', 500);
  }
}

// ── POST /api/users/verify_email_otp_register ─────────────────────────────────
// Verifies the OTP for an email address. On success, marks it verified so the
// registration endpoint can confirm the email was OTP-checked before the
// account is created.

async function verifyEmailOtpRegister(req, res) {
  await ensureEmailOtpTable();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const email = normalizeEmail(req.body.email);
  const otp   = req.body.otp.trim();

  try {
    const [rows] = await db.execute(
      `SELECT id, otp, expires_at, verified
         FROM email_otp_verifications
        WHERE email = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [email]
    );

    if (rows.length === 0) {
      return fail(res, 'No OTP was requested for this email. Please request a new OTP.', 400);
    }

    const record = rows[0];

    if (record.verified === 1) {
      return fail(res, 'This OTP has already been used. Please proceed to registration.', 400);
    }

    if (new Date() > new Date(record.expires_at)) {
      // Clean up the expired row so a stale OTP can never be replayed.
      await db.execute(
        'DELETE FROM email_otp_verifications WHERE id = ?',
        [record.id]
      );
      return fail(res, 'OTP has expired. Please request a new one.', 400);
    }

    if (record.otp !== otp) {
      return fail(res, 'Invalid OTP. Please try again.', 400);
    }

    await db.execute(
      'UPDATE email_otp_verifications SET verified = 1 WHERE id = ?',
      [record.id]
    );

    return ok(res, 'Email verified successfully', { email, verified: true });
  } catch (err) {
    console.error('[verifyEmailOtpRegister]', err);
    return fail(res, 'Failed to verify OTP. Please try again.', 500);
  }
}

// ── Internal helper used by authController.register ──────────────────────────
// Confirms an email address has a verified OTP record before allowing account
// creation. Not exposed as a route.

async function isEmailOtpVerified(email) {
  await ensureEmailOtpTable();
  const [rows] = await db.execute(
    `SELECT id FROM email_otp_verifications
      WHERE email = ? AND verified = 1
      ORDER BY created_at DESC
      LIMIT 1`,
    [normalizeEmail(email)]
  );
  return rows.length > 0;
}

/** Called after a successful registration to clean up the used OTP record. */
async function clearVerifiedEmailOtp(email) {
  try {
    await db.execute(
      'DELETE FROM email_otp_verifications WHERE email = ?',
      [normalizeEmail(email)]
    );
  } catch (err) {
    console.error('[clearVerifiedEmailOtp]', err.message);
  }
}

module.exports = {
  sendEmailOtpRegister,
  verifyEmailOtpRegister,
  isEmailOtpVerified,
  clearVerifiedEmailOtp,
};