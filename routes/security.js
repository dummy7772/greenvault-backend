// routes/security.js
const express = require('express');
const { authenticate } = require('../middleware/auth');

const {
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
} = require('../controllers/securityController');

const router = express.Router();

// All security routes require authentication
router.use(authenticate);

// ── Change Password (PIN) ────────────────────────────────────────────────────
// POST /api/security/change-password
router.post('/change-password', changePasswordRules, changePassword);

// ── Login Credentials → Change Password ──────────────────────────────────────
// GET  /api/security/password/status  — resume lock countdown / attempts left
router.get('/password/status', getPasswordChangeStatus);

// POST /api/security/password/verify  — step 1: check current password
router.post('/password/verify', verifyCurrentPasswordRules, verifyCurrentPassword);

// POST /api/security/password/update  — step 2: set the new password
router.post('/password/update', updatePasswordRules, updatePassword);

// ── Two-Factor Authentication ────────────────────────────────────────────────
// GET  /api/security/2fa/status
router.get('/2fa/status', get2faStatus);

// POST /api/security/2fa/send-otp
router.post('/2fa/send-otp', send2faOtp);

// POST /api/security/2fa/verify-otp
router.post('/2fa/verify-otp', verify2faOtp);

// POST /api/security/2fa/disable
router.post('/2fa/disable', disable2fa);

// ── Active Sessions ──────────────────────────────────────────────────────────
// GET    /api/security/sessions
router.get('/sessions', getSessions);

// POST   /api/security/sessions/register
router.post('/sessions/register', registerSession);

// DELETE /api/security/sessions/:sessionId
router.delete('/sessions/:sessionId', revokeSession);

// ── Login History ────────────────────────────────────────────────────────────
// GET  /api/security/login-history
router.get('/login-history', getLoginHistory);

// POST /api/security/login-history/record
router.post('/login-history/record', recordLoginEvent);

module.exports = router;
