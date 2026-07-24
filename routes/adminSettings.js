// routes/adminSettings.js
'use strict';

const express = require('express');

const { authenticate } = require('../middleware/auth');
const { requireAdmin }  = require('../middleware/admin');
const {
  getAdminProfile,
  updateAdminProfile,
  getNotificationPreferences,
  updateNotificationPreferences,
  getThemePreferences,
  updateThemePreferences,
  getSystemInfo,
} = require('../controllers/adminSettingsController');

const router = express.Router();

// All admin settings routes require a valid admin session.
router.use(authenticate, requireAdmin);

// ── Admin Profile ─────────────────────────────────────────────────────────────
// GET /api/admin/settings/profile
router.get('/profile', getAdminProfile);
// PUT /api/admin/settings/profile
router.put('/profile', updateAdminProfile);

// NOTE: Avatar upload/removal, Change Password, 2FA, and Session Management
// intentionally reuse the existing generic endpoints below instead of being
// duplicated here — they already operate on req.user.sub (the authenticated
// admin) and require nothing admin-specific:
//   POST   /api/profile/avatar
//   DELETE /api/profile/avatar
//   POST   /api/security/change-password
//   GET    /api/security/2fa/status
//   POST   /api/security/2fa/send-otp
//   POST   /api/security/2fa/verify-otp
//   POST   /api/security/2fa/disable
//   GET    /api/security/sessions
//   POST   /api/security/sessions/register
//   DELETE /api/security/sessions/:sessionId
//   GET    /api/security/login-history
//   POST   /api/security/login-history/record

// ── Notification Preferences ──────────────────────────────────────────────────
// GET /api/admin/settings/notifications
router.get('/notifications', getNotificationPreferences);
// PUT /api/admin/settings/notifications
router.put('/notifications', updateNotificationPreferences);

// ── Theme Settings ─────────────────────────────────────────────────────────────
// GET /api/admin/settings/theme
router.get('/theme', getThemePreferences);
// PUT /api/admin/settings/theme
router.put('/theme', updateThemePreferences);

// ── System Information ────────────────────────────────────────────────────────
// GET /api/admin/settings/system-info
router.get('/system-info', getSystemInfo);

module.exports = router;