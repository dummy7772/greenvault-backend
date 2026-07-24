// controllers/passwordResetController.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validationResult } = require('express-validator');
const db           = require('../config/db');
const { ok, fail } = require('../utils/response');

const OTP_EXPIRY_MINUTES = 5;
const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

// ── One-time migration ────────────────────────────────────────────────────────
// Lazily creates the password_reset_otps table on first use, mirroring the
// pattern already used in controllers/mobileOtpController.js.
let _migrated = false;

async function ensurePasswordResetTable() {
  if (_migrated) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS password_reset_otps (
        id          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
        user_id     INT UNSIGNED    NOT NULL,
        identifier  VARCHAR(191)    NOT NULL,
        otp         VARCHAR(6)      NOT NULL,
        reset_token VARCHAR(64)     DEFAULT NULL,
        expires_at  TIMESTAMP       NOT NULL,
        verified    TINYINT(1)      NOT NULL DEFAULT 0,
        used        TINYINT(1)      NOT NULL DEFAULT 0,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_pro_identifier (identifier)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    _migrated = true;
  } catch (err) {
    console.error('[password-reset-migration] error:', err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Resolves a raw identifier string into the users-table column + normalized
 * value to query against — mirrors the identical logic used in
 * authController.login so both endpoints treat "identifier" identically.
 */
function resolveIdentifier(identifierRaw) {
  const id = (identifierRaw || '').trim();
  const isEmail  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
  const isMobile = /^\d{10}$/.test(id);

  if (!isEmail && !isMobile) return null;

  return {
    column: isEmail ? 'email' : 'phone',
    value:  isEmail ? id.toLowerCase() : id,
  };
}

// ── POST /api/auth/forgot-password/send-otp ──────────────────────────────────
// Generates a 6-digit OTP for the account matching the given email/mobile,
// valid for 5 minutes. Any previous OTP(s) issued for that identifier are
// invalidated (deleted) first, so this endpoint also powers "Resend OTP".

async function sendResetOtp(req, res) {
  await ensurePasswordResetTable();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const resolved = resolveIdentifier(req.body.identifier);
  if (!resolved) {
    return fail(res, 'Enter a valid email or 10-digit mobile number', 400);
  }
  const { column, value } = resolved;

  try {
    const [users] = await db.execute(
      `SELECT id FROM users WHERE ${column} = ? LIMIT 1`,
      [value]
    );

    if (users.length === 0) {
      return fail(res, 'No account found with this email or mobile number', 404);
    }

    const userId = users[0].id;

    // Invalidate any previous OTP(s) for this identifier (covers resend flow).
    await db.execute(
      'DELETE FROM password_reset_otps WHERE identifier = ?',
      [value]
    );

    const otp       = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await db.execute(
      `INSERT INTO password_reset_otps (user_id, identifier, otp, expires_at, verified, used)
       VALUES (?, ?, ?, ?, 0, 0)`,
      [userId, value, otp, expiresAt]
    );

    // In production, integrate an SMS/email gateway here (e.g. Twilio, MSG91, SES).
    console.log(`[forgot-password:send-otp] Identifier ${value} | OTP: ${otp}`);

    return ok(res, 'OTP sent successfully', {
      identifier: value,
      expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
      // Dev-mode only — Flutter uses this to verify without a real SMS/email
      // gateway wired up. Remove this field once a provider is configured.
      ...(process.env.NODE_ENV !== 'production' && { otp }),
    });
  } catch (err) {
    console.error('[sendResetOtp]', err);
    return fail(res, 'Failed to send OTP. Please try again.', 500);
  }
}

// ── POST /api/auth/forgot-password/verify-otp ────────────────────────────────
// Verifies the OTP for an identifier. On success, issues a short-lived
// reset_token that must be presented to the reset-password endpoint — this
// prevents anyone from skipping straight to resetting the password without
// having actually verified the OTP.

async function verifyResetOtp(req, res) {
  await ensurePasswordResetTable();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const resolved = resolveIdentifier(req.body.identifier);
  if (!resolved) {
    return fail(res, 'Enter a valid email or 10-digit mobile number', 400);
  }
  const { value } = resolved;
  const otp = req.body.otp.trim();

  try {
    const [rows] = await db.execute(
      `SELECT id, otp, expires_at, verified, used
         FROM password_reset_otps
        WHERE identifier = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [value]
    );

    if (rows.length === 0) {
      return fail(res, 'No OTP was requested for this identifier. Please request a new OTP.', 400);
    }

    const record = rows[0];

    if (record.used === 1) {
      return fail(res, 'This OTP has already been used. Please request a new OTP.', 400);
    }

    if (new Date() > new Date(record.expires_at)) {
      // Clean up the expired row so a stale OTP can never be replayed.
      await db.execute('DELETE FROM password_reset_otps WHERE id = ?', [record.id]);
      return fail(res, 'OTP has expired. Please request a new one.', 400);
    }

    if (record.otp !== otp) {
      return fail(res, 'Invalid OTP. Please try again.', 400);
    }

    const resetToken = generateResetToken();

    await db.execute(
      'UPDATE password_reset_otps SET verified = 1, reset_token = ? WHERE id = ?',
      [resetToken, record.id]
    );

    return ok(res, 'OTP verified successfully', {
      identifier: value,
      reset_token: resetToken,
      expires_in_seconds: OTP_EXPIRY_MINUTES * 60,
    });
  } catch (err) {
    console.error('[verifyResetOtp]', err);
    return fail(res, 'Failed to verify OTP. Please try again.', 500);
  }
}

// ── POST /api/auth/forgot-password/reset-password ────────────────────────────
// Sets a new password for the account, but only if a verified, unexpired,
// unused reset_token (issued by verifyResetOtp) is presented. Hashes the new
// password with bcrypt before saving, replaces the old password hash, and
// invalidates all reset OTPs for that identifier afterwards.

async function resetPassword(req, res) {
  await ensurePasswordResetTable();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const resolved = resolveIdentifier(req.body.identifier);
  if (!resolved) {
    return fail(res, 'Enter a valid email or 10-digit mobile number', 400);
  }
  const { column, value } = resolved;
  const { resetToken, newPassword } = req.body;

  try {
    const [rows] = await db.execute(
      `SELECT id, user_id, expires_at, verified, used
         FROM password_reset_otps
        WHERE identifier = ? AND reset_token = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [value, resetToken]
    );

    if (rows.length === 0) {
      return fail(res, 'Invalid or expired reset session. Please restart the password reset process.', 400);
    }

    const record = rows[0];

    if (record.verified !== 1) {
      return fail(res, 'Please verify the OTP before resetting your password.', 400);
    }

    if (record.used === 1) {
      return fail(res, 'This reset session has already been used. Please request a new OTP.', 400);
    }

    if (new Date() > new Date(record.expires_at)) {
      await db.execute('DELETE FROM password_reset_otps WHERE identifier = ?', [value]);
      return fail(res, 'Reset session expired. Please request a new OTP.', 400);
    }

    const [users] = await db.execute(
      `SELECT id FROM users WHERE ${column} = ? LIMIT 1`,
      [value]
    );
    if (users.length === 0) {
      return fail(res, 'No account found with this email or mobile number', 404);
    }

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    await db.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, users[0].id]
    );

    // Invalidate every previous reset OTP for this identifier (including the
    // one just used) so none of them can ever be replayed.
    await db.execute('DELETE FROM password_reset_otps WHERE identifier = ?', [value]);

    return ok(res, 'Password updated successfully', { identifier: value });
  } catch (err) {
    console.error('[resetPassword]', err);
    return fail(res, 'Failed to reset password. Please try again.', 500);
  }
}

module.exports = { sendResetOtp, verifyResetOtp, resetPassword };