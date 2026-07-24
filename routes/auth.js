// routes/auth.js
const express    = require('express');
const { body }   = require('express-validator');
const rateLimit  = require('express-rate-limit');

const { register, login, me, resendLoginOtp, verifyLoginOtp, logout } = require('../controllers/authController');
const {
  sendResetOtp,
  verifyResetOtp,
  resetPassword,
} = require('../controllers/passwordResetController');
const { authenticate, authenticatePending2FA } = require('../middleware/auth');

const router = express.Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────

/** Tight limiter for auth endpoints — 10 attempts per 15 minutes per IP */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { success: false, message: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

/** Slightly looser limiter for forgot-password OTP endpoints — 10 per 15 min/IP */
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { success: false, message: 'Too many requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ── Validation rules ──────────────────────────────────────────────────────────

const registerRules = [
  body('firstName')
    .trim()
    .notEmpty().withMessage('First name is required'),

  body('lastName')
    .trim()
    .notEmpty().withMessage('Last name is required'),

  body('email')
    .trim()
    .notEmpty().withMessage('Email address is required')
    .isEmail().withMessage('Enter a valid email address')
    .normalizeEmail(),

  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^\d{10}$/).withMessage('Enter a valid 10-digit phone number'),

  body('password')
    .notEmpty().withMessage('Password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/(?=.*[A-Za-z])(?=.*\d)/).withMessage('Password must contain letters and numbers'),

  body('confirmPassword')
    .notEmpty().withMessage('Please confirm your password')
    .custom((value, { req }) => {
      if (value !== req.body.password) throw new Error('Passwords do not match');
      return true;
    }),

  body('emailVerified')
    .isBoolean().withMessage('emailVerified must be a boolean')
    .toBoolean()
    .custom(v => {
      if (!v) throw new Error('Please verify your email address');
      return true;
    }),

  body('phoneVerified')
    .isBoolean().withMessage('phoneVerified must be a boolean')
    .toBoolean()
    .custom(v => {
      if (!v) throw new Error('Please verify your phone number');
      return true;
    }),

  body('referralCode')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 30 }).withMessage('Referral code too long'),
];

const loginRules = [
  body('identifier')
    .trim()
    .notEmpty().withMessage('Please enter your email or mobile number'),

  body('password')
    .notEmpty().withMessage('Please enter your password')
    .isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

// ── Login-time 2FA validation rules ───────────────────────────────────────────

const loginOtpVerifyRules = [
  body('otp')
    .trim()
    .notEmpty().withMessage('OTP is required')
    .matches(/^\d{6}$/).withMessage('OTP must be a 6-digit number'),
];

// ── Forgot-password validation rules ──────────────────────────────────────────

const identifierRule = body('identifier')
  .trim()
  .notEmpty().withMessage('Please enter your email or mobile number');

const resetOtpRule = body('otp')
  .trim()
  .notEmpty().withMessage('OTP is required')
  .matches(/^\d{6}$/).withMessage('OTP must be a 6-digit number');

const resetPasswordRules = [
  identifierRule,

  body('resetToken')
    .trim()
    .notEmpty().withMessage('Reset session is missing or invalid'),

  body('newPassword')
    .notEmpty().withMessage('New password is required')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/(?=.*[A-Za-z])(?=.*\d)/).withMessage('Password must contain letters and numbers'),

  body('confirmPassword')
    .notEmpty().withMessage('Please confirm your new password')
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) throw new Error('Passwords do not match');
      return true;
    }),
];

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/auth/register
router.post('/register', authLimiter, registerRules, register);

// POST /api/auth/login
router.post('/login', authLimiter, loginRules, login);

// GET  /api/auth/me  (protected — requires valid JWT)
router.get('/me', authenticate, me);

// POST /api/auth/logout  (protected — requires valid JWT; clears the active session)
router.post('/logout', authenticate, logout);

// ── Login-time Two-Factor Authentication ──────────────────────────────────────
// These two endpoints are only reachable with the short-lived "pending_token"
// that POST /api/auth/login returns when a 2FA-enabled account's password
// check succeeds. They complete the second factor of the login itself —
// distinct from /api/security/2fa/*, which manages turning 2FA on/off from
// an already-authenticated Security Settings session.

// POST /api/auth/2fa/resend-otp
router.post('/2fa/resend-otp', authLimiter, authenticatePending2FA, resendLoginOtp);

// POST /api/auth/2fa/verify-otp
router.post(
  '/2fa/verify-otp',
  authLimiter,
  authenticatePending2FA,
  loginOtpVerifyRules,
  verifyLoginOtp
);

// ── Forgot password flow ──────────────────────────────────────────────────────

// POST /api/auth/forgot-password/send-otp
router.post(
  '/forgot-password/send-otp',
  forgotPasswordLimiter,
  [identifierRule],
  sendResetOtp
);

// POST /api/auth/forgot-password/verify-otp
router.post(
  '/forgot-password/verify-otp',
  forgotPasswordLimiter,
  [identifierRule, resetOtpRule],
  verifyResetOtp
);

// POST /api/auth/forgot-password/reset-password
router.post(
  '/forgot-password/reset-password',
  forgotPasswordLimiter,
  resetPasswordRules,
  resetPassword
);

module.exports = router;
