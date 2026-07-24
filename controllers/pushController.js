// controllers/pushController.js
const { ok, fail } = require('../utils/response');
const { registerDeviceToken, unregisterDeviceToken } = require('../utils/pushService');

// ── POST /api/push/register-token  { fcm_token, platform } ──────────────────
// Called by the app right after login/registration, on every app start, and
// whenever FCM rotates the token (onTokenRefresh). Idempotent — safe to
// call repeatedly with the same token.
async function registerToken(req, res) {
  const { fcm_token, platform } = req.body;

  if (!fcm_token) {
    return fail(res, 'fcm_token is required');
  }

  try {
    await registerDeviceToken(req.user.sub, fcm_token, platform);
    return ok(res, 'Device token registered');
  } catch (err) {
    console.error('[push] registerToken error:', err.message);
    return fail(res, 'Failed to register device token', 500);
  }
}

// ── POST /api/push/unregister-token  { fcm_token } ───────────────────────────
// Called right before a manual "Logout" clears the local session, so a
// signed-out device stops receiving this account's pushes.
async function unregisterToken(req, res) {
  const { fcm_token } = req.body;

  if (!fcm_token) {
    return fail(res, 'fcm_token is required');
  }

  try {
    await unregisterDeviceToken(req.user.sub, fcm_token);
    return ok(res, 'Device token unregistered');
  } catch (err) {
    console.error('[push] unregisterToken error:', err.message);
    return fail(res, 'Failed to unregister device token', 500);
  }
}

module.exports = { registerToken, unregisterToken };