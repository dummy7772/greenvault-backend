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
  getPinsStatus,
  setLoginPin,
  verifyLoginPin,
  setWithdrawalPin,
  verifyWithdrawalPinRemote,
  getBiometricStatus,
  setBiometricEnabled,
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

// ── Account-level Login PIN / Withdrawal PIN / Biometric Login ──────────────
// Fetched/updated by ANY device for the account, so a PIN or biometric
// preference set on one device is available on all others instead of
// having to be re-created per device.

// GET  /api/security/pins/status — what's already configured on this account
router.get('/pins/status', getPinsStatus);

// POST /api/security/pin/login          — set/change the account Login PIN
// POST /api/security/pin/login/verify   — verify an entered Login PIN
router.post('/pin/login', setLoginPin);
router.post('/pin/login/verify', verifyLoginPin);

// POST /api/security/pin/withdrawal          — set/change the Withdrawal PIN
// POST /api/security/pin/withdrawal/verify   — verify an entered Withdrawal PIN
router.post('/pin/withdrawal', setWithdrawalPin);
router.post('/pin/withdrawal/verify', verifyWithdrawalPinRemote);

// GET  /api/security/biometric/status — account-wide biometric login flag
// POST /api/security/biometric        — enable/disable biometric login
router.get('/biometric/status', getBiometricStatus);
router.post('/biometric', setBiometricEnabled);

module.exports = router;
