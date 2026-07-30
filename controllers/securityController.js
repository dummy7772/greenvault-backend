// controllers/securityController.js
const bcrypt     = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db         = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

// ── Login Credentials → Change Password policy ─────────────────────────────
const PASSWORD_CHANGE_MAX_ATTEMPTS = 5;
const PASSWORD_CHANGE_LOCK_MS = 5 * 60 * 1000;      // 5 minutes
const PASSWORD_CHANGE_VERIFIED_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ── One-time migration ────────────────────────────────────────────────────────
let _migrated = false;

async function ensureSecurityColumns() {
  if (_migrated) return;
  try {
    const columns = [
      {
        col: 'two_factor_enabled',
        sql: `ALTER TABLE users ADD COLUMN two_factor_enabled TINYINT(1) NOT NULL DEFAULT 0`,
      },
      {
        col: 'two_factor_otp',
        sql: `ALTER TABLE users ADD COLUMN two_factor_otp VARCHAR(10) DEFAULT NULL`,
      },
      {
        col: 'two_factor_otp_expires_at',
        sql: `ALTER TABLE users ADD COLUMN two_factor_otp_expires_at TIMESTAMP NULL DEFAULT NULL`,
      },
      {
        // Single Device Login: holds the session id of whichever device is
        // currently allowed to use this account. Overwritten on every
        // successful login (see authController's issueSessionAndToken) and
        // checked against each request's JWT `sid` claim in
        // middleware/auth.js — a mismatch means a newer login elsewhere has
        // superseded this device, so the request (and therefore that
        // device) is signed out.
        col: 'active_session_id',
        sql: `ALTER TABLE users ADD COLUMN active_session_id VARCHAR(64) DEFAULT NULL`,
      },
      {
        // Login Credentials → Change Password flow: number of consecutive
        // incorrect "current password" attempts since the last success or
        // lockout. Reset to 0 on a correct verification and whenever a
        // lockout window (see password_change_locked_until) expires.
        col: 'password_change_failed_attempts',
        sql: `ALTER TABLE users ADD COLUMN password_change_failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0`,
      },
      {
        // Set once password_change_failed_attempts reaches the 5-attempt
        // cap. While in the future, POST /api/security/password/verify is
        // rejected with 423 and the remaining lock seconds so the app can
        // show a countdown. Cleared automatically once it elapses.
        col: 'password_change_locked_until',
        sql: `ALTER TABLE users ADD COLUMN password_change_locked_until TIMESTAMP NULL DEFAULT NULL`,
      },
      {
        // Short-lived proof that the account owner just supplied the
        // correct current password. Set by POST /api/security/password/verify
        // on success and required by POST /api/security/password/update —
        // this is what lets the "New Password" page be a separate step/
        // screen from re-entering the current password.
        col: 'password_change_verified_until',
        sql: `ALTER TABLE users ADD COLUMN password_change_verified_until TIMESTAMP NULL DEFAULT NULL`,
      },
    ];

    for (const { col, sql } of columns) {
      const [rows] = await db.execute(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = 'users'
            AND COLUMN_NAME  = ?
          LIMIT 1`,
        [col]
      );
      if (rows.length === 0) {
        await db.execute(sql);
        console.log(`[security-migration] Added column: ${col}`);
      }
    }

    // user_sessions table
    // NOTE: session_token stores a full signed JWT (sub, email, phone, role,
    // sid, iat, exp claims), which routinely exceeds 255 characters. It's
    // declared VARCHAR(512) here for fresh databases.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        id          INT UNSIGNED     NOT NULL AUTO_INCREMENT,
        user_id     INT UNSIGNED     NOT NULL,
        session_token VARCHAR(512)   NOT NULL,
        device_name  VARCHAR(191)   NOT NULL DEFAULT 'Unknown Device',
        device_type  VARCHAR(20)    NOT NULL DEFAULT 'android',
        location     VARCHAR(191)   NOT NULL DEFAULT 'Unknown',
        last_active  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        is_current   TINYINT(1)     NOT NULL DEFAULT 0,
        created_at   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_sess_user (user_id),
        KEY idx_sess_token (session_token(64)),
        CONSTRAINT fk_sess_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migration for databases where user_sessions already exists with the
    // old, too-narrow VARCHAR(255) definition — CREATE TABLE IF NOT EXISTS
    // above is a no-op on those, so widen it explicitly here.
    const [sessTokenCol] = await db.execute(
      `SELECT CHARACTER_MAXIMUM_LENGTH AS len
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'user_sessions'
          AND COLUMN_NAME  = 'session_token'
        LIMIT 1`
    );
    if (sessTokenCol.length > 0 && sessTokenCol[0].len < 512) {
      await db.execute(
        `ALTER TABLE user_sessions MODIFY COLUMN session_token VARCHAR(512) NOT NULL`
      );
      console.log('[security-migration] Widened user_sessions.session_token to VARCHAR(512)');
    }

    // login_history table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS login_history (
        id          INT UNSIGNED     NOT NULL AUTO_INCREMENT,
        user_id     INT UNSIGNED     NOT NULL,
        device_name VARCHAR(191)    NOT NULL DEFAULT 'Unknown Device',
        location    VARCHAR(191)    NOT NULL DEFAULT 'Unknown',
        success     TINYINT(1)      NOT NULL DEFAULT 1,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_lh_user (user_id),
        KEY idx_lh_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    _migrated = true;
  } catch (err) {
    console.error('[security-migration] error:', err.message);
  }
}

// ── POST /api/security/change-password ───────────────────────────────────────

async function changePassword(req, res) {
  await ensureSecurityColumns();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const { current_password, new_password, confirm_password } = req.body;

  if (new_password !== confirm_password) {
    return fail(res, 'New password and confirmation do not match', 400);
  }

  try {
    const [rows] = await db.execute(
      'SELECT id, password_hash FROM users WHERE id = ? LIMIT 1',
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    const user = rows[0];
    const valid = await bcrypt.compare(current_password, user.password_hash);

    if (!valid) {
      return fail(res, 'Current password is incorrect', 401);
    }

    const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);

    await db.execute(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [newHash, user.id]
    );

    createNotification(
      user.id,
      'system',
      'Security PIN Changed',
      'Your account password/PIN was changed successfully. If this wasn\'t you, please contact support immediately.'
    ).catch(e => console.error('[changePassword] notify error:', e.message));

    return ok(res, 'Password changed successfully');
  } catch (err) {
    console.error('[changePassword]', err);
    return fail(res, 'Failed to change password. Please try again.', 500);
  }
}

// ── GET /api/security/password/status ────────────────────────────────────────
// Lets the app resume the correct UI (locked countdown vs. remaining
// attempts) if the user re-opens Change Password after backgrounding/
// killing the app mid-lockout.

async function getPasswordChangeStatus(req, res) {
  await ensureSecurityColumns();

  try {
    const [rows] = await db.execute(
      `SELECT password_change_failed_attempts, password_change_locked_until
         FROM users WHERE id = ? LIMIT 1`,
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    const user = rows[0];
    const lockedUntil = user.password_change_locked_until
      ? new Date(user.password_change_locked_until)
      : null;
    const now = new Date();

    if (lockedUntil && lockedUntil > now) {
      return ok(res, 'Change Password is temporarily locked', {
        locked: true,
        remaining_seconds: Math.ceil((lockedUntil - now) / 1000),
        remaining_attempts: 0,
      });
    }

    return ok(res, 'Change Password status fetched', {
      locked: false,
      remaining_seconds: 0,
      remaining_attempts:
        PASSWORD_CHANGE_MAX_ATTEMPTS - (user.password_change_failed_attempts || 0),
    });
  } catch (err) {
    console.error('[getPasswordChangeStatus]', err);
    return fail(res, 'Failed to fetch status.', 500);
  }
}

// ── POST /api/security/password/verify ───────────────────────────────────────
// Step 1 of Change Password: confirm the account owner knows the current
// login password before letting them choose a new one. Tracks failed
// attempts server-side (max 5) and locks this feature for 5 minutes once
// the cap is hit — independent of the login screen's own rate limiting.

async function verifyCurrentPassword(req, res) {
  await ensureSecurityColumns();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const { current_password } = req.body;

  try {
    const [rows] = await db.execute(
      `SELECT id, password_hash, password_change_failed_attempts,
              password_change_locked_until
         FROM users WHERE id = ? LIMIT 1`,
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    const user = rows[0];
    const now = new Date();
    let failedAttempts = user.password_change_failed_attempts || 0;
    const lockedUntil = user.password_change_locked_until
      ? new Date(user.password_change_locked_until)
      : null;

    // Still inside an active lockout window — reject without even checking
    // the password so a locked-out attacker can't keep probing.
    if (lockedUntil && lockedUntil > now) {
      return res.status(423).json({
        success: false,
        message: 'Too many incorrect attempts. Please try again later.',
        data: {
          locked: true,
          remaining_seconds: Math.ceil((lockedUntil - now) / 1000),
          remaining_attempts: 0,
        },
      });
    }

    // A previous lockout has elapsed — clear it before evaluating this
    // attempt so the user gets a fresh set of tries.
    if (lockedUntil && lockedUntil <= now) {
      failedAttempts = 0;
    }

    const valid = await bcrypt.compare(current_password, user.password_hash);

    if (!valid) {
      failedAttempts += 1;

      if (failedAttempts >= PASSWORD_CHANGE_MAX_ATTEMPTS) {
        const newLockedUntil = new Date(Date.now() + PASSWORD_CHANGE_LOCK_MS);
        await db.execute(
          `UPDATE users
             SET password_change_failed_attempts = 0,
                 password_change_locked_until = ?
             WHERE id = ?`,
          [newLockedUntil, user.id]
        );
        return res.status(423).json({
          success: false,
          message: 'Too many incorrect attempts. Change Password has been locked for 5 minutes.',
          data: {
            locked: true,
            remaining_seconds: Math.ceil(PASSWORD_CHANGE_LOCK_MS / 1000),
            remaining_attempts: 0,
          },
        });
      }

      await db.execute(
        `UPDATE users
           SET password_change_failed_attempts = ?,
               password_change_locked_until = NULL
           WHERE id = ?`,
        [failedAttempts, user.id]
      );

      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect.',
        data: {
          locked: false,
          remaining_seconds: 0,
          remaining_attempts: PASSWORD_CHANGE_MAX_ATTEMPTS - failedAttempts,
        },
      });
    }

    // Correct password — reset the attempt counter and open a short
    // verification window for the "New Password" step.
    const verifiedUntil = new Date(Date.now() + PASSWORD_CHANGE_VERIFIED_WINDOW_MS);
    await db.execute(
      `UPDATE users
         SET password_change_failed_attempts = 0,
             password_change_locked_until = NULL,
             password_change_verified_until = ?
         WHERE id = ?`,
      [verifiedUntil, user.id]
    );

    return ok(res, 'Password verified', {
      verified: true,
      verified_window_seconds: Math.ceil(PASSWORD_CHANGE_VERIFIED_WINDOW_MS / 1000),
    });
  } catch (err) {
    console.error('[verifyCurrentPassword]', err);
    return fail(res, 'Failed to verify password. Please try again.', 500);
  }
}

// ── POST /api/security/password/update ────────────────────────────────────────
// Step 2 of Change Password: set the new login password. Only allowed
// within the short window opened by a successful verifyCurrentPassword
// call above — this is what lets the New Password page rely on Step 1
// having already happened, without resubmitting the current password.

async function updatePassword(req, res) {
  await ensureSecurityColumns();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const { new_password, confirm_password } = req.body;

  if (new_password !== confirm_password) {
    return fail(res, 'New password and confirmation do not match', 400);
  }

  try {
    const [rows] = await db.execute(
      `SELECT id, password_hash, password_change_verified_until
         FROM users WHERE id = ? LIMIT 1`,
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    const user = rows[0];
    const verifiedUntil = user.password_change_verified_until
      ? new Date(user.password_change_verified_until)
      : null;

    if (!verifiedUntil || verifiedUntil <= new Date()) {
      return fail(res, 'Verification expired. Please re-enter your current password.', 401);
    }

    const sameAsOld = await bcrypt.compare(new_password, user.password_hash);
    if (sameAsOld) {
      return fail(res, 'New password must be different from your current password.', 400);
    }

    const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);

    await db.execute(
      `UPDATE users
         SET password_hash = ?,
             password_change_verified_until = NULL,
             password_change_failed_attempts = 0,
             password_change_locked_until = NULL
         WHERE id = ?`,
      [newHash, user.id]
    );

    createNotification(
      user.id,
      'system',
      'Password Changed',
      'Your login password was changed successfully. If this wasn\'t you, please contact support immediately.'
    ).catch(e => console.error('[updatePassword] notify error:', e.message));

    return ok(res, 'Password changed successfully');
  } catch (err) {
    console.error('[updatePassword]', err);
    return fail(res, 'Failed to change password. Please try again.', 500);
  }
}

// ── POST /api/security/2fa/send-otp ─────────────────────────────────────────

async function send2faOtp(req, res) {
  await ensureSecurityColumns();

  try {
    const [rows] = await db.execute(
      'SELECT id, phone FROM users WHERE id = ? LIMIT 1',
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    await db.execute(
      'UPDATE users SET two_factor_otp = ?, two_factor_otp_expires_at = ? WHERE id = ?',
      [otp, expiresAt, req.user.sub]
    );

    // In production, integrate an SMS gateway here (e.g. Twilio, MSG91)
    // For now, log the OTP to console (remove in production)
    console.log(`[2FA OTP] User ${req.user.sub} | OTP: ${otp}`);

    return ok(res, 'OTP sent to your registered mobile number', {
      // Return OTP in dev mode only — remove this in production
      ...(process.env.NODE_ENV !== 'production' && { otp }),
    });
  } catch (err) {
    console.error('[send2faOtp]', err);
    return fail(res, 'Failed to send OTP. Please try again.', 500);
  }
}

// ── POST /api/security/2fa/verify-otp ───────────────────────────────────────

async function verify2faOtp(req, res) {
  await ensureSecurityColumns();

  const { otp } = req.body;

  if (!otp || typeof otp !== 'string' || otp.length !== 6) {
    return fail(res, 'Please provide a valid 6-digit OTP', 400);
  }

  try {
    const [rows] = await db.execute(
      `SELECT id, two_factor_otp, two_factor_otp_expires_at
         FROM users WHERE id = ? LIMIT 1`,
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    const user = rows[0];

    if (!user.two_factor_otp) {
      return fail(res, 'No OTP requested. Please request a new OTP.', 400);
    }

    if (new Date() > new Date(user.two_factor_otp_expires_at)) {
      await db.execute(
        'UPDATE users SET two_factor_otp = NULL, two_factor_otp_expires_at = NULL WHERE id = ?',
        [req.user.sub]
      );
      return fail(res, 'OTP has expired. Please request a new one.', 400);
    }

    if (user.two_factor_otp !== otp) {
      return fail(res, 'Invalid OTP. Please try again.', 400);
    }

    // OTP is valid — enable 2FA and clear OTP
    await db.execute(
      `UPDATE users
         SET two_factor_enabled = 1,
             two_factor_otp = NULL,
             two_factor_otp_expires_at = NULL
         WHERE id = ?`,
      [req.user.sub]
    );

    return ok(res, '2FA enabled successfully');
  } catch (err) {
    console.error('[verify2faOtp]', err);
    return fail(res, 'Failed to verify OTP. Please try again.', 500);
  }
}

// ── POST /api/security/2fa/disable ──────────────────────────────────────────

async function disable2fa(req, res) {
  await ensureSecurityColumns();

  try {
    await db.execute(
      `UPDATE users
         SET two_factor_enabled = 0,
             two_factor_otp = NULL,
             two_factor_otp_expires_at = NULL
         WHERE id = ?`,
      [req.user.sub]
    );

    return ok(res, '2FA has been disabled');
  } catch (err) {
    console.error('[disable2fa]', err);
    return fail(res, 'Failed to disable 2FA. Please try again.', 500);
  }
}

// ── GET /api/security/2fa/status ────────────────────────────────────────────

async function get2faStatus(req, res) {
  await ensureSecurityColumns();

  try {
    const [rows] = await db.execute(
      'SELECT two_factor_enabled FROM users WHERE id = ? LIMIT 1',
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    return ok(res, '2FA status fetched', {
      two_factor_enabled: rows[0].two_factor_enabled === 1,
    });
  } catch (err) {
    console.error('[get2faStatus]', err);
    return fail(res, 'Failed to fetch 2FA status.', 500);
  }
}

// ── GET /api/security/sessions ───────────────────────────────────────────────

async function getSessions(req, res) {
  await ensureSecurityColumns();

  try {
    const [rows] = await db.execute(
      `SELECT id, device_name, device_type, location, last_active, is_current
         FROM user_sessions
         WHERE user_id = ?
         ORDER BY is_current DESC, last_active DESC
         LIMIT 20`,
      [req.user.sub]
    );

    const sessions = rows.map(r => ({
      id:          r.id.toString(),
      device_name: r.device_name,
      device_type: r.device_type,
      location:    r.location,
      last_active: _formatLastActive(r.last_active),
      is_current:  r.is_current === 1,
    }));

    return ok(res, 'Sessions fetched', { sessions });
  } catch (err) {
    console.error('[getSessions]', err);
    return fail(res, 'Failed to fetch sessions.', 500);
  }
}

// ── POST /api/security/sessions/register ────────────────────────────────────
// Called after a successful login from the app to register/update the session.

async function registerSession(req, res) {
  await ensureSecurityColumns();

  const { device_name = 'Unknown Device', device_type = 'android', location = 'Unknown', session_token } = req.body;

  if (!session_token) {
    return fail(res, 'session_token is required', 400);
  }

  try {
    // Mark all existing sessions for this user as not current
    await db.execute(
      'UPDATE user_sessions SET is_current = 0 WHERE user_id = ?',
      [req.user.sub]
    );

    // Upsert by session_token
    const [existing] = await db.execute(
      'SELECT id FROM user_sessions WHERE user_id = ? AND session_token = ? LIMIT 1',
      [req.user.sub, session_token]
    );

    if (existing.length > 0) {
      await db.execute(
        `UPDATE user_sessions
           SET device_name = ?, device_type = ?, location = ?, is_current = 1, last_active = NOW()
           WHERE id = ?`,
        [device_name, device_type, location, existing[0].id]
      );
    } else {
      await db.execute(
        `INSERT INTO user_sessions (user_id, session_token, device_name, device_type, location, is_current)
           VALUES (?, ?, ?, ?, ?, 1)`,
        [req.user.sub, session_token, device_name, device_type, location]
      );
    }

    return ok(res, 'Session registered');
  } catch (err) {
    console.error('[registerSession]', err);
    return fail(res, 'Failed to register session.', 500);
  }
}

// ── DELETE /api/security/sessions/:sessionId ─────────────────────────────────

async function revokeSession(req, res) {
  await ensureSecurityColumns();

  const { sessionId } = req.params;

  try {
    const [rows] = await db.execute(
      'SELECT id, is_current FROM user_sessions WHERE id = ? AND user_id = ? LIMIT 1',
      [sessionId, req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'Session not found', 404);
    }

    if (rows[0].is_current) {
      return fail(res, 'Cannot revoke your current active session', 400);
    }

    await db.execute(
      'DELETE FROM user_sessions WHERE id = ? AND user_id = ?',
      [sessionId, req.user.sub]
    );

    return ok(res, 'Device signed out successfully');
  } catch (err) {
    console.error('[revokeSession]', err);
    return fail(res, 'Failed to revoke session.', 500);
  }
}

// ── GET /api/security/login-history ─────────────────────────────────────────

async function getLoginHistory(req, res) {
  await ensureSecurityColumns();

  try {
    const [rows] = await db.execute(
      `SELECT id, device_name, location, success, created_at
         FROM login_history
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
      [req.user.sub]
    );

    const history = rows.map(r => ({
      id:          r.id.toString(),
      device_name: r.device_name,
      location:    r.location,
      success:     r.success === 1,
      timestamp:   _formatTimestamp(r.created_at),
    }));

    return ok(res, 'Login history fetched', { history });
  } catch (err) {
    console.error('[getLoginHistory]', err);
    return fail(res, 'Failed to fetch login history.', 500);
  }
}

// ── POST /api/security/login-history/record ──────────────────────────────────
// Called after login from the app to record the event.

async function recordLoginEvent(req, res) {
  await ensureSecurityColumns();

  const { device_name = 'Unknown Device', location = 'Unknown', success = true } = req.body;

  try {
    await db.execute(
      `INSERT INTO login_history (user_id, device_name, location, success)
         VALUES (?, ?, ?, ?)`,
      [req.user.sub, device_name, location, success ? 1 : 0]
    );

    // Keep only last 50 entries per user
    await db.execute(
      `DELETE FROM login_history
         WHERE user_id = ?
           AND id NOT IN (
             SELECT id FROM (
               SELECT id FROM login_history
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT 50
             ) AS t
           )`,
      [req.user.sub, req.user.sub]
    );

    if (success) {
      createNotification(
        req.user.sub,
        'system',
        'New Login Detected',
        `A new login was detected on ${device_name} (${location}). If this wasn't you, please secure your account immediately.`
      ).catch(e => console.error('[recordLoginEvent] notify error:', e.message));
    }

    return ok(res, 'Login event recorded');
  } catch (err) {
    console.error('[recordLoginEvent]', err);
    return fail(res, 'Failed to record login event.', 500);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _formatLastActive(date) {
  if (!date) return 'Unknown';
  const d = new Date(date);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1)  return 'Active now';
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24)  return `${diffHrs} hr ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days ago`;
}

function _formatTimestamp(date) {
  if (!date) return '';
  const d = new Date(date);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  let dateStr;
  if (dDate.getTime() === today.getTime()) {
    dateStr = 'Today';
  } else if (dDate.getTime() === yesterday.getTime()) {
    dateStr = 'Yesterday';
  } else {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    dateStr = `${d.getDate()} ${months[d.getMonth()]}`;
  }

  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const timeStr = `${hour}:${m} ${period}`;

  return `${dateStr}, ${timeStr}`;
}

// ── Validation rules ─────────────────────────────────────────────────────────

const changePasswordRules = [
  body('current_password')
    .notEmpty().withMessage('Current password is required'),
  body('new_password')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  body('confirm_password')
    .notEmpty().withMessage('Please confirm the new password'),
];

// Login Credentials → Change Password (step 1: verify current password)
const verifyCurrentPasswordRules = [
  body('current_password')
    .notEmpty().withMessage('Current password is required'),
];

// Login Credentials → Change Password (step 2: set new password)
// Mirrors the registration screen's password policy (min 8 chars, letters + numbers)
// so the requirement is identical everywhere it's enforced in the app.
const updatePasswordRules = [
  body('new_password')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
    .matches(/(?=.*[A-Za-z])(?=.*\d)/).withMessage('New password must contain letters and numbers'),
  body('confirm_password')
    .notEmpty().withMessage('Please confirm the new password'),
];

module.exports = {
  ensureSecurityColumns,
  changePassword,
  changePasswordRules,
  getPasswordChangeStatus,
  verifyCurrentPassword,
  verifyCurrentPasswordRules,
  updatePassword,
  updatePasswordRules,
  send2faOtp,
  verify2faOtp,
  disable2fa,
  get2faStatus,
  getSessions,
  registerSession,
  revokeSession,
  getLoginHistory,
  recordLoginEvent,
};
