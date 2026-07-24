// routes/notification.js
const express = require('express');
const router  = express.Router();

const { authenticate }                       = require('../middleware/auth');
const { requireAdmin }                       = require('../middleware/admin');
const { getNotifications, adminGetUserNotifications, markAsRead, markAllRead, deleteNotification } = require('../controllers/notificationController');

// All routes require a valid JWT
router.use(authenticate);

// GET  /api/notifications            — paginated list (supports ?pageNo=&pageSize= or JSON body)
router.get('/',          getNotifications);
router.post('/',         getNotifications);   // also accept POST for body-based pagination

// GET  /api/notifications/admin/:userId   [Admin only]
// Same paginated feed, for any user — powers the "Notifications" tab on the
// Admin Panel's User Details page.
router.get('/admin/:userId', requireAdmin, adminGetUserNotifications);

// POST /api/notifications/mark-read  — mark single notification read
router.post('/mark-read',     markAsRead);

// POST /api/notifications/mark-all-read — mark all read
router.post('/mark-all-read', markAllRead);

// DELETE /api/notifications/:id — permanently delete a single notification
router.delete('/:id', deleteNotification);

module.exports = router;