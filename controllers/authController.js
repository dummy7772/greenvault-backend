// controllers/authController.js
const bcrypt       = require('bcryptjs');
const crypto        = require('crypto');
const { validationResult } = require('express-validator');
const db           = require('../config/db');
const { signToken, signPendingToken } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');
const { processReferralOnSignup, ensureReferralSchema } = require('./referralController');
const { isPhoneOtpVerified, clearVerifiedOtp } = require('./mobileOtpController');
const { isEmailOtpVerified, clearVerifiedEmailOtp } = require('./emailOtpController');
const { ensureSecurityColumns } = require('./securityController');
const { ensureMemberIdSchema, assignMemberId } = require('../utils/memberId');
const { assignReferralCode } = require('../utils/referralCode');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');
const LOGIN_OTP_EXPIRY_MINUTES = 5;

// Run once at startup — non-fatal; register() calls it again as a guard.
ensureMemberIdSchema().catch(err =>
  console.error('[auth] member_id startup migration error:', err.message)
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip fields that must never reach the client. */
function safeUser(row) {
  const { password_hash, two_factor_otp, two_factor_otp_expires_at, ...safe } = row;
  return safe;
}

/** Generates a 6-digit numeric OTP. */
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Masks a phone number for display on the "Enter OTP" screen, e.g.
 * "9876543210" -> "98••••••10". Never send the full number back to the
 * client at this stage — the login isn't complete yet.
 */
function maskPhone(phone) {
  if (!phone || phone.length < 4) return phone || '';
  const start = phone.slice(0, 2);
  const end = phone.slice(-2);
  return `${start}${'•'.repeat(Math.max(phone.length - 4, 4))}${end}`;
}

/**
 * Generates a fresh 2FA login OTP for the given user, persists it, and
 * "sends" it (console log placeholder — swap in a real SMS gateway such as
 * Twilio/MSG91 in production, mirroring send2faOtp in securityController).
 * Returns the plaintext OTP only so the caller can optionally echo it back
 * in non-production responses for testing.
 */
async function issueLoginOtp(userId) {
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + LOGIN_OTP_EXPIRY_MINUTES * 60 * 1000);

  await db.execute(
    'UPDATE users SET two_factor_otp = ?, two_factor_otp_expires_at = ? WHERE id = ?',
    [otp, expiresAt, userId]
  );

  // In production, integrate an SMS gateway here (e.g. Twilio, MSG91).
  console.log(`[login-2fa-otp] User ${userId} | OTP: ${otp}`);

  return otp;
}

/**
 * ── Single Device Login ──────────────────────────────────────────────────
 * Generates a brand-new session id for this login, persists it to
 * users.active_session_id (overwriting whatever device was active before),
 * and signs a token carrying that same id as its `sid` claim.
 *
 * Because this UPDATE always wins over whatever was stored a moment ago,
 * calling this a second time — from any device, at any later login — is
 * exactly what "kicks out" the previous device: middleware/auth.js checks
 * every request's `sid` against this column, and the old token's `sid` will
 * no longer match once this runs.
 */
async function issueSessionAndToken(user) {
  const sessionId = crypto.randomUUID();
  await db.execute(
    'UPDATE users SET active_session_id = ? WHERE id = ?',
    [sessionId, user.id]
  );
  return signToken(user, sessionId);
}

/**
 * Format a MySQL DATE value (Date object or string) → "YYYY-MM-DD" or null.
 */
function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const dt = new Date(String(value));
  return isNaN(dt.getTime()) ? null : dt.toISOString().split('T')[0];
}

// ── POST /api/auth/register ──────────────────────────────────────────────────

async function register(req, res) {
  // Needed because register() also issues a session-bound token below —
  // active_session_id is lazily migrated in on first use (securityController).
  await ensureSecurityColumns();
  // New-user MTxxxx member ID support — lazily adds users.member_id if
  // missing. Never touches existing users; see utils/memberId.js.
  await ensureMemberIdSchema();
  // Needed unconditionally now (not just when a referral code was typed in)
  // because every newly registered user gets their own referral code below.
  await ensureReferralSchema();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const {
    firstName,
    lastName,
    email,
    phone,
    password,
    referralCode = null,
    emailVerified = false,
    phoneVerified = false,
  } = req.body;

  try {
    const [byEmail] = await db.execute(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email.trim().toLowerCase()]
    );
    if (byEmail.length > 0) {
      return fail(res, 'An account with this email already exists', 409);
    }

    const [byPhone] = await db.execute(
      'SELECT id FROM users WHERE phone = ? LIMIT 1',
      [phone.trim()]
    );
    if (byPhone.length > 0) {
      return fail(res, 'An account with this phone number already exists', 409);
    }

    // Server-side enforcement: registration is only allowed once the mobile
    // number has completed OTP verification via
    // /api/users/send_mob_otp_register + /api/users/verify_mob_otp_register.
    const phoneOtpVerified = await isPhoneOtpVerified(phone);
    if (!phoneOtpVerified) {
      return fail(res, 'Please verify your mobile number via OTP before registering.', 400);
    }

    // Server-side enforcement: registration is only allowed once the email
    // address has completed OTP verification via
    // /api/users/send_email_otp_register + /api/users/verify_email_otp_register.
    // (Mirrors the phone OTP gate above — the emailVerified flag sent in the
    // request body is just a UI hint and must never be trusted on its own.)
    const emailOtpVerified = await isEmailOtpVerified(email);
    if (!emailOtpVerified) {
      return fail(res, 'Please verify your email address via OTP before registering.', 400);
    }

    // ── Referral code validation ─────────────────────────────────────────────
    // The field is optional, but if the user typed something in it, it must
    // actually resolve to a real referrer's code. Previously a wrong/typo'd
    // code was silently swallowed (processReferralOnSignup just no-op'd),
    // so the user had no idea their referral link never got credited. Now
    // we check it up front and reject with a clear message before the
    // account is even created — mirroring the same code lookup used later
    // in processReferralOnSignup / processReferralOnFirstPlanPayment, so a
    // code that passes here is guaranteed to resolve there too.
    const trimmedReferralCode = (referralCode || '').trim().toUpperCase();
    if (trimmedReferralCode) {
      await ensureReferralSchema();
      const [referrerRows] = await db.execute(
        'SELECT id FROM users WHERE my_referral_code = ? LIMIT 1',
        [trimmedReferralCode]
      );
      if (referrerRows.length === 0) {
        return fail(res, 'Invalid referral code. Please check and try again.', 400);
      }
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const [result] = await db.execute(
      `INSERT INTO users
         (first_name, last_name, email, phone, password_hash,
          referral_code, email_verified, phone_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        firstName.trim(),
        lastName.trim(),
        email.trim().toLowerCase(),
        phone.trim(),
        passwordHash,
        trimmedReferralCode || null,
        emailVerified ? 1 : 0,
        phoneVerified ? 1 : 0,
      ]
    );

    const [rows] = await db.execute(
      'SELECT id, member_id, my_referral_code, first_name, last_name, email, phone, role, email_verified, phone_verified, created_at FROM users WHERE id = ?',
      [result.insertId]
    );

    const user = rows[0];

    // Assign this brand-new user's MTxxxx member ID. Only ever runs here,
    // on the row that was just inserted — existing users' IDs are never
    // touched, and the underlying counter guarantees the number is unique
    // and never reused even under concurrent registrations.
    try {
      user.member_id = await assignMemberId(result.insertId);
    } catch (e) {
      // Non-fatal for the registration flow itself — log loudly so it gets
      // noticed, but don't block account creation on it.
      console.error('[register] assignMemberId error:', e.message);
    }

    // Assign this brand-new user's own referral code — MT<seq><FirstInitial>
    // <LastInitial> (e.g. "MT001MX"). Only ever runs here, on the row that
    // was just inserted; existing users' my_referral_code is never touched.
    try {
      user.my_referral_code = await assignReferralCode(
        result.insertId,
        firstName.trim(),
        lastName.trim()
      );
    } catch (e) {
      // Non-fatal for the registration flow itself — log loudly so it gets
      // noticed, but don't block account creation on it. The referral
      // screen falls back to lazily generating a code on first visit
      // (getOrCreateReferralCode in referralController.js) if this is ever
      // left null.
      console.error('[register] assignReferralCode error:', e.message);
    }

    const token = await issueSessionAndToken(user);

    if (trimmedReferralCode) {
      processReferralOnSignup(result.insertId, trimmedReferralCode).catch(e =>
        console.error('[register] referral hook error:', e.message)
      );
    }

    // Clean up the now-used OTP verification records for this phone/email.
    clearVerifiedOtp(phone).catch(e =>
      console.error('[register] clearVerifiedOtp error:', e.message)
    );
    clearVerifiedEmailOtp(email).catch(e =>
      console.error('[register] clearVerifiedEmailOtp error:', e.message)
    );

    return ok(res, 'Registration successful', { token, user }, 201);
  } catch (err) {
    console.error('[register]', err);
    return fail(res, 'Registration failed. Please try again.', 500);
  }
}

// ── POST /api/auth/login ─────────────────────────────────────────────────────

async function login(req, res) {
  // Needed because we may read/write the two_factor_* columns below —
  // these are lazily migrated in on first use (see securityController).
  await ensureSecurityColumns();

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return fail(res, 'Validation failed', 422, errors.array());
  }

  const { identifier, password } = req.body;
  const id = identifier.trim();

  const isEmail  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
  const isMobile = /^\d{10}$/.test(id);

  if (!isEmail && !isMobile) {
    return fail(res, 'Enter a valid email or 10-digit mobile number', 400);
  }

  try {
    const column = isEmail ? 'email' : 'phone';
    const value  = isEmail ? id.toLowerCase() : id;

    const [rows] = await db.execute(
      `SELECT id, member_id, first_name, last_name, email, phone,
              password_hash, role, email_verified, phone_verified,
              is_active, created_at, two_factor_enabled
       FROM users WHERE ${column} = ? LIMIT 1`,
      [value]
    );

    if (rows.length === 0) {
      return fail(res, 'Invalid credentials. Please check and try again.', 401);
    }

    const user = rows[0];

    if (!user.is_active) {
      return fail(res, 'Your account has been deactivated. Please contact support.', 403);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return fail(res, 'Invalid credentials. Please check and try again.', 401);
    }

    // ── 2FA branch ─────────────────────────────────────────────────────────
    // Identifier + password are correct, but this account has Two-Factor
    // Authentication turned on (Security Settings). Do NOT issue a full
    // access token yet — send an OTP to the registered mobile number and
    // hand back only a short-lived "pending" token that is good for
    // nothing except completing the OTP step below.
    if (user.two_factor_enabled === 1) {
      await issueLoginOtp(user.id);
      const pendingToken = signPendingToken(user.id);

      return ok(res, 'OTP sent to your registered mobile number', {
        requires_2fa: true,
        pending_token: pendingToken,
        phone_hint: maskPhone(user.phone),
        expires_in_seconds: LOGIN_OTP_EXPIRY_MINUTES * 60,
      });
    }

    // ── Normal (non-2FA) flow ────────────────────────────────────────────
    const token = await issueSessionAndToken(user);

    return ok(res, 'Login successful', {
      requires_2fa: false,
      token,
      user: safeUser(user),
    });
  } catch (err) {
    console.error('[login]', err);
    return fail(res, 'Login failed. Please try again.', 500);
  }
}

// ── POST /api/auth/2fa/resend-otp ────────────────────────────────────────────
// Protected by authenticatePending2FA — requires the pending_token issued
// by login() above. Re-issues a fresh OTP for the same account (invalidating
// the previous one, since issueLoginOtp overwrites the stored OTP/expiry).

async function resendLoginOtp(req, res) {
  await ensureSecurityColumns();

  try {
    const [rows] = await db.execute(
      'SELECT id, phone FROM users WHERE id = ? LIMIT 1',
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    await issueLoginOtp(rows[0].id);

    return ok(res, 'A new OTP has been sent to your registered mobile number', {
      phone_hint: maskPhone(rows[0].phone),
      expires_in_seconds: LOGIN_OTP_EXPIRY_MINUTES * 60,
    });
  } catch (err) {
    console.error('[resendLoginOtp]', err);
    return fail(res, 'Failed to resend OTP. Please try again.', 500);
  }
}

// ── POST /api/auth/2fa/verify-otp ────────────────────────────────────────────
// Protected by authenticatePending2FA. On success, completes the login: the
// stored OTP is cleared and a full access token + user payload is returned,
// in the exact same shape as a non-2FA login() success — so the Flutter
// side can reuse its existing "after successful login" handling.

async function verifyLoginOtp(req, res) {
  await ensureSecurityColumns();

  const { otp } = req.body;

  if (!otp || typeof otp !== 'string' || otp.length !== 6) {
    return fail(res, 'Please enter a valid 6-digit OTP', 400);
  }

  try {
    const [rows] = await db.execute(
      `SELECT id, member_id, first_name, last_name, email, phone,
              password_hash, role, email_verified, phone_verified,
              is_active, created_at,
              two_factor_otp, two_factor_otp_expires_at
         FROM users WHERE id = ? LIMIT 1`,
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    const user = rows[0];

    if (!user.is_active) {
      return fail(res, 'Your account has been deactivated. Please contact support.', 403);
    }

    if (!user.two_factor_otp) {
      return fail(res, 'No OTP requested. Please request a new OTP.', 400);
    }

    if (new Date() > new Date(user.two_factor_otp_expires_at)) {
      await db.execute(
        'UPDATE users SET two_factor_otp = NULL, two_factor_otp_expires_at = NULL WHERE id = ?',
        [user.id]
      );
      return fail(res, 'OTP has expired. Please request a new one.', 400);
    }

    if (user.two_factor_otp !== otp) {
      return fail(res, 'Invalid OTP. Please try again.', 400);
    }

    // OTP correct — clear it so it can never be replayed, then issue the
    // real, full-scope access token exactly like a completed login.
    await db.execute(
      'UPDATE users SET two_factor_otp = NULL, two_factor_otp_expires_at = NULL WHERE id = ?',
      [user.id]
    );

    const token = await issueSessionAndToken(user);

    return ok(res, 'Login successful', {
      requires_2fa: false,
      token,
      user: safeUser(user),
    });
  } catch (err) {
    console.error('[verifyLoginOtp]', err);
    return fail(res, 'Failed to verify OTP. Please try again.', 500);
  }
}

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
// Returns the full profile payload — same shape as GET /api/profile so Flutter
// can use either endpoint interchangeably.

async function me(req, res) {
  try {
    // Select core fields + profile fields (profile fields may not exist on
    // older DBs — the profileController migration handles adding them, but
    // we guard gracefully here with COALESCE / ifnull).
    const [rows] = await db.execute(
      `SELECT id, member_id, first_name, last_name, email, phone, role,
              email_verified, phone_verified, created_at,
              COALESCE(profile_image, NULL)  AS profile_image,
              COALESCE(date_of_birth, NULL)  AS date_of_birth,
              COALESCE(gender, NULL)         AS gender,
              COALESCE(address, NULL)        AS address
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [req.user.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    const u = rows[0];
    return ok(res, 'Profile fetched', {
      id:             u.id,
      member_id:      u.member_id || null,
      first_name:     u.first_name,
      last_name:      u.last_name,
      full_name:      `${u.first_name} ${u.last_name}`.trim(),
      email:          u.email,
      phone:          u.phone,
      phone_verified: u.phone_verified === 1,
      email_verified: u.email_verified === 1,
      profile_image:  u.profile_image  || null,
      date_of_birth:  formatDate(u.date_of_birth),
      gender:         u.gender   || null,
      address:        u.address  || null,
      created_at:     u.created_at,
    });
  } catch (err) {
    // If the profile columns don't exist yet the COALESCE query will still
    // fail with "Unknown column". Fall back to basic fields.
    console.error('[me]', err.message);
    try {
      const [rows] = await db.execute(
        `SELECT id, member_id, first_name, last_name, email, phone, role,
                email_verified, phone_verified, created_at
           FROM users WHERE id = ? LIMIT 1`,
        [req.user.sub]
      );
      if (rows.length === 0) return fail(res, 'User not found', 404);
      const u = rows[0];
      return ok(res, 'Profile fetched', {
        id:             u.id,
        member_id:      u.member_id || null,
        first_name:     u.first_name,
        last_name:      u.last_name,
        full_name:      `${u.first_name} ${u.last_name}`.trim(),
        email:          u.email,
        phone:          u.phone,
        phone_verified: u.phone_verified === 1,
        email_verified: u.email_verified === 1,
        profile_image:  null,
        date_of_birth:  null,
        gender:         null,
        address:        null,
        created_at:     u.created_at,
      });
    } catch (inner) {
      console.error('[me] fallback error:', inner.message);
      return fail(res, 'Could not fetch profile', 500);
    }
  }
}

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
// Protected — requires a currently-valid (not-yet-superseded) access token.
// Clears users.active_session_id so this device's token is immediately
// unusable, and so no "ghost" session is left behind for a future login on
// another device to compare against.

async function logout(req, res) {
  try {
    // Only clear it if it still belongs to THIS token's session — if a
    // newer login already overwrote it (this device was already kicked
    // out), we must not touch the newer device's active session.
    await db.execute(
      'UPDATE users SET active_session_id = NULL WHERE id = ? AND active_session_id = ?',
      [req.user.sub, req.user.sid || null]
    );

    return ok(res, 'Logged out successfully');
  } catch (err) {
    console.error('[logout]', err);
    return fail(res, 'Logout failed. Please try again.', 500);
  }
}

module.exports = { register, login, me, resendLoginOtp, verifyLoginOtp, logout };