// utils/pushService.js
//
// Push notification delivery via Firebase Cloud Messaging (FCM), plus the
// device_tokens table that maps a user to the FCM registration token(s) of
// every device they're signed in on. A user may have more than one device
// token (phone + tablet, etc.) — every push goes to all of them, the same
// way WhatsApp/most apps notify every linked device.
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
 * Registers (or refreshes) an FCM token for a user. Called by the app right
 * after login and on every app start / token-refresh event, so a rotated
 * FCM token is always kept current.
 *
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
        },
      },
      apns: {
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
  getTokensForUser,
  sendPushToUser,
};