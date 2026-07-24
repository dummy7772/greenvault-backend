// routes/withdrawal.js
const express = require('express');

const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  getWithdrawalKycStatus,
  getBalances,
  walletWithdrawRequest,
  vaultWithdrawRequest,
  listWithdrawals,
  adminListWithdrawals,
  getWithdrawalById,
  adminReviewWithdrawal,
} = require('../controllers/withdrawalController');

const router = express.Router();

// ── User routes ───────────────────────────────────────────────────────────────

// GET  /api/withdrawal/kyc-status  — KYC + bank detail, shaped for the withdrawal screen
router.get('/kyc-status', authenticate, getWithdrawalKycStatus);

// GET  /api/withdrawal/balances    — real wallet + vault balances
router.get('/balances', authenticate, getBalances);

// POST /api/withdrawal/wallet      — withdraw from main wallet to bank
router.post('/wallet', authenticate, walletWithdrawRequest);

// POST /api/withdrawal/vault       — move vault (mining earnings) to main wallet (admin review)
router.post('/vault', authenticate, vaultWithdrawRequest);

// POST /api/withdrawal/list        — user's own withdrawal history
router.post('/list', authenticate, listWithdrawals);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET  /api/withdrawal/admin/all
router.get('/admin/all', authenticate, requireAdmin, adminListWithdrawals);

// GET  /api/withdrawal/admin/:id
router.get('/admin/:id', authenticate, requireAdmin, getWithdrawalById);

// PUT  /api/withdrawal/admin/:id/review
router.put('/admin/:id/review', authenticate, requireAdmin, adminReviewWithdrawal);

module.exports = router;