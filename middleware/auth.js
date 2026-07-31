// middleware/auth.js
const { verifyToken } = require('../utils/jwt');
const { fail }        = require('../utils/response');
const db               = require('../config/db');
const { ensureSecurityColumns } = require('../controllers/securityController');

/**
 * Protect a route — attach req.user if the Bearer token is valid.
 *
 * Also enforces Single Device Login: every full-access token carries the
 * `sid` (session id) that was current for this user at the moment it was
 * issued (see utils/jwt.js signToken). If the account has since logged in
 * on another device, authController's login()/verifyLoginOtp() will have
 * overwritten users.active_session_id with a brand-new value — which
 * immediately invalidates every token minted before that point, including
 * this one. Comparing the token's `sid` against the DB value on every
 * authenticated request is what actually forces the older device to be
 * signed out, not just at login time.
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return fail(res, 'Authorization token missing', 401);
  }

  try {
    const decoded = verifyToken(token);

    // A "2fa_pending" token is only a partial credential issued after a
    // correct password but before the OTP step of a 2FA-protected login
    // has been completed. It must never be usable to reach any regular
    // protected route — otherwise 2FA could be trivially bypassed by
    // stopping right after the password check.
    if (decoded.purpose === '2fa_pending') {
      return fail(res, 'Please complete two-factor verification to continue', 401);
    }

    // ── Single Device Login check ─────────────────────────────────────────
    await ensureSecurityColumns(); // lazily adds users.active_session_id if missing

    const [rows] = await db.execute(
      'SELECT active_session_id FROM users WHERE id = ? LIMIT 1',
      [decoded.sub]
    );

    if (rows.length === 0) {
      return fail(res, 'Account not found. Please log in again.', 401);
    }

    const currentSessionId = rows[0].active_session_id;

    // A token with no `sid` (issued before this feature existed) or one
    // whose `sid` no longer matches the account's current active session
    // means this device has been superseded by a newer login elsewhere.
    if (!decoded.sid || !currentSessionId || decoded.sid !== currentSessionId) {
      return res.status(401).json({
        success: false,
        message: 'Your account has been logged in on another device. Please log in again.',
        code: 'SESSION_INVALIDATED',
      });
    }

    req.user = decoded;
    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? 'Token has expired, please log in again'
      : 'Invalid token';
    return fail(res, message, 401);
  }
}

/**
 * Protect the two login-time 2FA endpoints (resend OTP / verify OTP).
 * Accepts ONLY the short-lived "2fa_pending" token issued by
 * POST /api/auth/login when a user with 2FA enabled supplies the correct
 * password. A normal full-access token is rejected here too, keeping the
 * two token types cleanly separated.
 */
function authenticatePending2FA(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return fail(res, 'Verification session missing', 401);
  }

  try {
    const decoded = verifyToken(token);

    if (decoded.purpose !== '2fa_pending') {
      return fail(res, 'Invalid verification session', 401);
    }

    req.user = decoded;
    next();
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? 'Verification session expired. Please log in again.'
      : 'Invalid verification session. Please log in again.';
    return fail(res, message, 401);
  }
}

module.exports = { authenticate, authenticatePending2FA };
