// routes/users.js
const express   = require('express');
const { body }  = require('express-validator');
const rateLimit = require('express-rate-limit');

const {
  sendMobOtpRegister,
  verifyMobOtpRegister,
} = require('../controllers/mobileOtpController');

const {
  sendEmailOtpRegister,
  verifyEmailOtpRegister,
} = require('../controllers/emailOtpController');

const router = express.Router();

// ── Rate limiter ───────────────────────────────────────────────────────────────
// Same shape as the limiter in routes/auth.js — 10 attempts per 15 minutes/IP.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { success: false, message: 'Too many OTP requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ── Validation rules ──────────────────────────────────────────────────────────

const phoneRule = body('phone')
  .trim()
  .notEmpty().withMessage('Phone number is required')
  .matches(/^\d{10}$/).withMessage('Enter a valid 10-digit phone number');

const otpRule = body('otp')
  .trim()
  .notEmpty().withMessage('OTP is required')
  .matches(/^\d{6}$/).withMessage('OTP must be a 6-digit number');

const emailRule = body('email')
  .trim()
  .notEmpty().withMessage('Email address is required')
  .isEmail().withMessage('Enter a valid email address')
  .normalizeEmail();

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/users/send_mob_otp_register
router.post('/send_mob_otp_register', otpLimiter, [phoneRule], sendMobOtpRegister);

// POST /api/users/verify_mob_otp_register
router.post('/verify_mob_otp_register', otpLimiter, [phoneRule, otpRule], verifyMobOtpRegister);

// POST /api/users/send_email_otp_register
router.post('/send_email_otp_register', otpLimiter, [emailRule], sendEmailOtpRegister);

// POST /api/users/verify_email_otp_register
router.post('/verify_email_otp_register', otpLimiter, [emailRule, otpRule], verifyEmailOtpRegister);

module.exports = router;