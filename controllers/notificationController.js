// controllers/notificationController.js
const db = require('../config/db');
const { ok, fail } = require('../utils/response');
const { sendPushToUser } = require('../utils/pushService');

// ── Push notification routing ────────────────────────────────────────────────
// Maps a notification's `type` to the screen the Flutter app should open
// when the user taps the push notification in the OS notification bar.
// Keep in sync with AppRoutes in the frontend (lib/routes/app_routes.dart).
const NOTIFICATION_ROUTE_MAP = {
  deposit:    '/history',
  withdrawal: '/history',
  kyc:        '/kyc',
  referral:   '/referral',
  roi:        '/history',
  plan:       '/plan',
  system:     '/notifications',
};

/**
 * Fires an FCM push for a notification row that was just inserted. Always
 * fire-and-forget from the caller's perspective — a push failure (FCM not
 * configured, network error, dead token, etc.) must never affect the
 * already-committed notification row, which is the source of truth for the
 * in-app Notification screen.
 */
function pushForNotification(userId, type, title, message, notificationId) {
  sendPushToUser(userId, {
    title,
    body: message,
    data: {
      type,
      notification_id: notificationId ?? '',
      route: NOTIFICATION_ROUTE_MAP[type] || '/notifications',
    },
  }).catch(e => console.error('[notification] push send error:', e.message));
}

// ── Ensure notifications table exists ────────────────────────────────────────
//
// NOTE: no FOREIGN KEY constraint on user_id. Every other migration block in
// this codebase (security/deposit/kyc/withdrawal) has hit cases where a
// hard FK silently makes `CREATE TABLE IF NOT EXISTS` fail on some installs
// (e.g. a users.id type/engine mismatch), which then makes every single
// notifications query fail with "table doesn't exist" — exactly the 500
// ("Failed to fetch notifications") the app was showing. user_id is still
// indexed for fast lookups; the FK just isn't required for correctness here
// since every row is only ever inserted by our own trusted server code.
let _tableVerified = false;

async function ensureNotificationsTable() {
  if (_tableVerified) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        user_id     INT UNSIGNED  NOT NULL,
        type        ENUM('deposit','withdrawal','kyc','referral','roi','plan','system')
                                  NOT NULL DEFAULT 'system',
        title       VARCHAR(255)  NOT NULL,
        message     TEXT          NOT NULL,
        is_read     TINYINT(1)    NOT NULL DEFAULT 0,
        created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        KEY idx_notif_user   (user_id),
        KEY idx_notif_unread (user_id, is_read)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Older installs may already have the table from before the 'plan' type
    // (or the old FK-based version) existed — widen the ENUM so inserting a
    // 'plan' notification never fails with "data truncated for column type".
    try {
      await db.execute(`
        ALTER TABLE notifications
          MODIFY COLUMN type ENUM('deposit','withdrawal','kyc','referral','roi','plan','system')
                              NOT NULL DEFAULT 'system'
      `);
    } catch (alterErr) {
      // Non-fatal — table may already be up to date, or this install may
      // not permit ALTER; inserts will just fall back to 'system' if an
      // unrecognised type is ever used.
      console.warn('[notification] type-enum widen skipped:', alterErr.message);
    }

    _tableVerified = true;
  } catch (err) {
    console.error('[notification] table check failed:', err.message);
  }
}

ensureNotificationsTable();

// ── GET /api/notifications  (paginated) ───────────────────────────────────────
//
// NOTE ON THE FIX: mysql2's `execute()` (prepared statements / binary
// protocol) has a long-standing bug where passing `LIMIT ?` / `OFFSET ?`
// placeholders throws "Incorrect arguments to mysqld_stmt_execute", even
// though the same query works fine with `query()` or with the values
// inlined directly. Since pageNo/pageSize are parsed with parseInt() and
// clamped (Math.max/Math.min) before use, limitInt/offsetInt are guaranteed
// to be safe integers — there is no SQL-injection risk in inlining them
// directly into the query string below. Every other value (user_id, etc.)
// still goes through the normal `?` placeholder binding.
async function fetchNotificationsForUser(userId, pageNo, pageSize) {
  const offset    = (pageNo - 1) * pageSize;
  const limitInt  = pageSize | 0;
  const offsetInt = offset   | 0;

  await ensureNotificationsTable();

  try {
    const [[{ total }]] = await db.execute(
      'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?',
      [userId]
    );
    const [[{ unreadCount }]] = await db.execute(
      'SELECT COUNT(*) AS unreadCount FROM notifications WHERE user_id = ? AND is_read = 0',
      [userId]
    );
    const [rows] = await db.execute(
      `SELECT id, type, title, message, is_read, created_at
         FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ${limitInt} OFFSET ${offsetInt}`,
      [userId]
    );
    return {
      pageNo, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      unread_count: unreadCount,
      data: rows,
    };
  } catch (err) {
    // If the table genuinely didn't exist yet (e.g. this is the very first
    // request after a fresh deploy, or an earlier CREATE TABLE attempt
    // silently failed), force a retry of the migration and try exactly
    // once more before giving up — instead of permanently 500ing forever.
    if (err.code === 'ER_NO_SUCH_TABLE') {
      console.warn('[notification] table missing — retrying migration once');
      _tableVerified = false;
      await ensureNotificationsTable();
      const [[{ total }]] = await db.execute(
        'SELECT COUNT(*) AS total FROM notifications WHERE user_id = ?',
        [userId]
      );
      const [[{ unreadCount }]] = await db.execute(
        'SELECT COUNT(*) AS unreadCount FROM notifications WHERE user_id = ? AND is_read = 0',
        [userId]
      );
      const [rows] = await db.execute(
        `SELECT id, type, title, message, is_read, created_at
           FROM notifications
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ${limitInt} OFFSET ${offsetInt}`,
        [userId]
      );
      return {
        pageNo, pageSize, total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        unread_count: unreadCount,
        data: rows,
      };
    }
    throw err;
  }
}

async function getNotifications(req, res) {
  const userId   = req.user.sub;
  const pageNo   = Math.max(1,  parseInt(req.query.pageNo   || req.body?.pageNo   || 1,  10) || 1);
  const pageSize = Math.min(50, parseInt(req.query.pageSize || req.body?.pageSize || 20, 10) || 20);

  try {
    const result = await fetchNotificationsForUser(userId, pageNo, pageSize);
    return ok(res, 'Notifications fetched', result);
  } catch (err) {
    console.error('[notification] getNotifications error:', err.message);
    return fail(res, 'Failed to fetch notifications', 500);
  }
}

// GET /api/notifications/admin/:userId   [Admin only]
// Same paginated feed as above, but for any user — powers the
// "Notifications" tab on the Admin Panel's User Details page.
async function adminGetUserNotifications(req, res) {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return fail(res, 'Invalid user id', 400);
  }
  const pageNo   = Math.max(1,  parseInt(req.query.pageNo   || 1,  10) || 1);
  const pageSize = Math.min(50, parseInt(req.query.pageSize || 20, 10) || 20);

  try {
    const result = await fetchNotificationsForUser(userId, pageNo, pageSize);
    return ok(res, 'Notifications fetched', result);
  } catch (err) {
    console.error('[notification] adminGetUserNotifications error:', err.message);
    return fail(res, 'Failed to fetch notifications', 500);
  }
}

// ── POST /api/notifications/mark-read  { notification_id } ───────────────────
async function markAsRead(req, res) {
  const userId         = req.user.sub;
  const notificationId = req.body.notification_id;

  if (!notificationId) {
    return fail(res, 'notification_id is required');
  }

  try {
    await ensureNotificationsTable();

    const [result] = await db.execute(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [notificationId, userId]
    );

    if (result.affectedRows === 0) {
      return fail(res, 'Notification not found', 404);
    }

    return ok(res, 'Notification marked as read');
  } catch (err) {
    console.error('[notification] markAsRead error:', err.message);
    return fail(res, 'Failed to mark notification as read', 500);
  }
}

// ── POST /api/notifications/mark-all-read ────────────────────────────────────
async function markAllRead(req, res) {
  const userId = req.user.sub;

  try {
    await ensureNotificationsTable();

    await db.execute(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [userId]
    );

    return ok(res, 'All notifications marked as read');
  } catch (err) {
    console.error('[notification] markAllRead error:', err.message);
    return fail(res, 'Failed to mark all notifications as read', 500);
  }
}

// ── DELETE /api/notifications/:id  — permanently delete a notification ───────
async function deleteNotification(req, res) {
  const userId         = req.user.sub;
  const notificationId = req.params.id;

  if (!notificationId) {
    return fail(res, 'notification_id is required');
  }

  try {
    await ensureNotificationsTable();

    // Scoped to user_id so a user can never delete another user's
    // notification, regardless of what id is passed in.
    const [result] = await db.execute(
      'DELETE FROM notifications WHERE id = ? AND user_id = ?',
      [notificationId, userId]
    );

    if (result.affectedRows === 0) {
      return fail(res, 'Notification not found', 404);
    }

    return ok(res, 'Notification deleted');
  } catch (err) {
    console.error('[notification] deleteNotification error:', err.message);
    return fail(res, 'Failed to delete notification', 500);
  }
}

// ── Internal helper: insert a notification for a user ────────────────────────
// Called by other controllers (deposit, withdrawal, kyc, etc.)
async function createNotification(userId, type, title, message) {
  try {
    await ensureNotificationsTable();
    const [result] = await db.execute(
      'INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)',
      [userId, type, title, message]
    );
    pushForNotification(userId, type, title, message, result.insertId);
  } catch (err) {
    // Non-fatal — log and continue
    console.error('[notification] createNotification error:', err.message);
  }
}

// ── Internal helper: insert a notification with an explicit created_at ───────
// Used for backdated events — e.g. daily ROI catch-up, where a notification
// for a day the user was offline should show that day's date/time rather
// than the moment the catch-up job actually ran.
async function createNotificationAt(userId, type, title, message, createdAt) {
  try {
    await ensureNotificationsTable();
    const [result] = await db.execute(
      'INSERT INTO notifications (user_id, type, title, message, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, type, title, message, createdAt]
    );
    pushForNotification(userId, type, title, message, result.insertId);
  } catch (err) {
    // Non-fatal — log and continue
    console.error('[notification] createNotificationAt error:', err.message);
  }
}

module.exports = { getNotifications, adminGetUserNotifications, markAsRead, markAllRead, deleteNotification, createNotification, createNotificationAt };