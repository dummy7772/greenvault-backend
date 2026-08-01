// utils/pushService.js
//
// Push notification delivery via Firebase Cloud Messaging (FCM), plus the
// device_tokens table that maps a user to their currently active device's
// FCM registration token.
//
// ── Single Device Login alignment ──────────────────────────────────────────
// This app enforces Single Device Login (see authController.issueSessionAndToken
// and middleware/auth.js): only one device may be signed in per account at a
// time. device_tokens now mirrors that exactly — at most one row per user_id.
// registerDeviceToken() below always deletes any other token(s) already on
// file for that user before saving the new one, and
// clearTokensForUser() is called by authController the instant a new login
// succeeds, so the previous device's token is removed immediately — it does
// not linger until that old device happens to call register-token again (it
// never will; its session is already invalidated) or unregister itself
// (it can't — /api/push/unregister-token requires a valid, non-invalidated
// session). This is what guarantees a logged-out device stops receiving
// pushes right away, even while still offline.
//
// NOTE: no FOREIGN KEY constraint on user_id, matching the same pattern
// already used in notifications/security/kyc tables in this codebase — a
// hard FK has repeatedly caused CREATE TABLE IF NOT EXISTS to silently fail
// on some installs. user_id is still indexed for fast lookups.
const db = require('../config/db');
const { getMessaging } = require('../config/firebase');

let _tableVerified = false;

async function ensureDeviceTokensTable() {
  if (_tableVerified) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        user_id     INT UNSIGNED  NOT NULL,
        fcm_token   VARCHAR(255)  NOT NULL,
        platform    ENUM('android','ios') NOT NULL DEFAULT 'android',
        created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uq_device_user_token (user_id, fcm_token),
        KEY idx_device_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    _tableVerified = true;
  } catch (err) {
    console.error('[pushService] device_tokens table check failed:', err.message);
  }
}

ensureDeviceTokensTable();

/**
 * Deletes every device_tokens row for a user, with no exceptions. Called by
 * authController.issueSessionAndToken() the instant a login/registration
 * mints a brand-new active_session_id — i.e. the moment a previous device
 * (if any) is superseded. This is what makes the previous device stop
 * receiving pushes immediately, rather than waiting for the new device to
 * finish its own register-token call (which could be delayed, e.g. by the
 * notification-permission prompt on a slow real device).
 */
async function clearTokensForUser(userId) {
  await ensureDeviceTokensTable();
  try {
    await db.execute('DELETE FROM device_tokens WHERE user_id = ?', [userId]);
  } catch (err) {
    console.error('[pushService] clearTokensForUser error:', err.message);
  }
}

/**
 * Registers (or refreshes) an FCM token for a user. Called by the app right
 * after login and on every app start / token-refresh event, so a rotated
 * FCM token is always kept current.
 *
 * Enforces "at most one active token per user" (Single Device Login): any
 * OTHER token already on file for this user_id is deleted first, so this
 * newly-registering device becomes the sole recipient of future pushes.
 * Also removes this exact token from any OTHER user_id it was previously
 * registered under — handles the case where a different account logged in
 * on the same physical device earlier (shared/reset device); otherwise that
 * old account would keep receiving this device's pushes forever.
 */
async function registerDeviceToken(userId, fcmToken, platform = 'android') {
  await ensureDeviceTokensTable();
  if (!fcmToken) return;

  try {
    await db.execute(
      'DELETE FROM device_tokens WHERE fcm_token = ? AND user_id != ?',
      [fcmToken, userId]
    );
    // Single Device Login: this user_id keeps exactly one token — theirs.
    await db.execute(
      'DELETE FROM device_tokens WHERE user_id = ? AND fcm_token != ?',
      [userId, fcmToken]
    );
    await db.execute(
      `INSERT INTO device_tokens (user_id, fcm_token, platform)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE platform = VALUES(platform), updated_at = CURRENT_TIMESTAMP`,
      [userId, fcmToken, platform === 'ios' ? 'ios' : 'android']
    );
  } catch (err) {
    console.error('[pushService] registerDeviceToken error:', err.message);
  }
}

/** Removes a token — called on logout / sign-out-of-device so a signed-out phone stops getting pushes. */
async function unregisterDeviceToken(userId, fcmToken) {
  await ensureDeviceTokensTable();
  if (!fcmToken) return;
  try {
    await db.execute(
      'DELETE FROM device_tokens WHERE user_id = ? AND fcm_token = ?',
      [userId, fcmToken]
    );
  } catch (err) {
    console.error('[pushService] unregisterDeviceToken error:', err.message);
  }
}

async function getTokensForUser(userId) {
  await ensureDeviceTokensTable();
  try {
    const [rows] = await db.execute(
      'SELECT fcm_token FROM device_tokens WHERE user_id = ?',
      [userId]
    );
    return rows.map(r => r.fcm_token);
  } catch (err) {
    console.error('[pushService] getTokensForUser error:', err.message);
    return [];
  }
}

async function removeTokens(tokens) {
  if (!tokens.length) return;
  try {
    const placeholders = tokens.map(() => '?').join(',');
    await db.execute(`DELETE FROM device_tokens WHERE fcm_token IN (${placeholders})`, tokens);
  } catch (err) {
    console.error('[pushService] removeTokens error:', err.message);
  }
}

/**
 * Sends a push notification to every device registered for `userId`, so it
 * shows in the OS notification bar (outside the app) exactly like WhatsApp.
 *
 * `data` values are stringified (FCM data payloads are string-only) and
 * always end up containing `type` and `route` so the app can open the right
 * screen on tap — see NOTIFICATION_ROUTE_MAP in notificationController.js.
 *
 * Non-fatal by design: a push failure never affects the underlying
 * notification row already saved in MySQL, which remains the source of
 * truth shown on the in-app Notification screen.
 */
async function sendPushToUser(userId, { title, body, data = {} }) {
  const messaging = getMessaging();
  if (!messaging) return; // FCM not configured — no-op

  const tokens = await getTokensForUser(userId);
  if (tokens.length === 0) return;

  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    stringData[key] = value === null || value === undefined ? '' : String(value);
  }
  // Title/body are duplicated into `data` as a fallback for the app's own
  // foreground handler (see push_notification_service.dart), in addition
  // to the top-level `notification` block below.
  //
  // IMPORTANT — do not remove the top-level `notification` block again:
  // it is what lets Android auto-display the notification in the
  // background/terminated state WITHOUT needing the app's Dart background
  // isolate to run at all. A lot of real Android OEMs (Xiaomi/MIUI,
  // Vivo/Funtouch, Oppo/ColorOS, Realme UI, etc.) restrict background
  // isolate execution for apps that aren't manually whitelisted in their
  // battery/autostart settings — a data-only message silently never
  // arrives on such a device, while a `notification` block still shows up
  // every time, since the OS itself (not app code) renders it. The app
  // only needs to handle display itself for the ONE state the OS never
  // auto-displays in: while the app is already open in the foreground.
  stringData.title = title || '';
  stringData.body  = body  || '';

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          channelId: 'greenvault_notifications',
          sound: 'default',
          defaultSound: true,
          defaultVibrateTimings: true,
          // Status-bar icon while the app is backgrounded/terminated (FCM
          // auto-displays the notification itself in this state, using
          // this exact resource — must be the monochrome drawable, not the
          // full-color launcher icon, or Android shows a flat grey square).
          icon: 'ic_stat_notification',
          color: '#108156',
        },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: { sound: 'default', badge: 1, 'content-available': 1 },
        },
      },
    });

    // Prune tokens FCM says are dead (app uninstalled, token expired, etc.)
    // so future sends don't keep retrying them forever.
    const deadTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          deadTokens.push(tokens[i]);
        }
      }
    });
    if (deadTokens.length) await removeTokens(deadTokens);
  } catch (err) {
    console.error('[pushService] sendPushToUser error:', err.message);
  }
}

module.exports = {
  ensureDeviceTokensTable,
  registerDeviceToken,
  unregisterDeviceToken,
  clearTokensForUser,
  getTokensForUser,
  sendPushToUser,
};
