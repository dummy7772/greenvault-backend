// utils/jwt.js
const jwt = require('jsonwebtoken');

const SECRET  = process.env.JWT_SECRET     || 'change_me_in_production';
const EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Sign a JWT containing a safe user payload.
 * Includes `role` so the requireAdmin middleware can check it.
 *
 * `sessionId`, when provided, is embedded as the `sid` claim — this is the
 * Single Device Login mechanism. Every time a login completes,
 * authController persists a freshly generated session id to
 * users.active_session_id AND stamps that same id into the token issued
 * for that login. middleware/auth.js then compares a request's `sid`
 * against the DB value on every authenticated call, so as soon as a second
 * device logs in (and overwrites active_session_id), every token minted
 * for the previous device — whose `sid` no longer matches — is rejected.
 */
function signToken(user, sessionId) {
  const payload = {
    sub:   user.id,
    email: user.email,
    phone: user.phone,
    role:  user.role || 'user',   // ← role included so admin guard works
  };
  if (sessionId) payload.sid = sessionId;
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

/**
 * Verify a JWT and return its decoded payload.
 * Throws JsonWebTokenError / TokenExpiredError on failure.
 */
function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

/**
 * Sign a short-lived, limited-scope JWT used only to carry a user through
 * the Two-Factor Authentication login OTP step. This token intentionally
 * does NOT grant access to any protected app resource — the `purpose`
 * claim is checked by middleware/auth.js and rejected everywhere except
 * the two dedicated 2FA-login endpoints. It expires quickly (10 minutes)
 * so an abandoned login attempt can't be resumed indefinitely.
 */
function signPendingToken(userId) {
  return jwt.sign(
    {
      sub: userId,
      purpose: '2fa_pending',
    },
    SECRET,
    { expiresIn: '10m' }
  );
}

module.exports = { signToken, verifyToken, signPendingToken };
