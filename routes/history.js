// routes/history.js
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  getSummary,
  getUnifiedHistory,
  adminGetUserHistory,
  getDepositHistory,
  getWithdrawalHistory,
  getWalletHistory,
  getRoiHistory,
} = require('../controllers/historyController');

const router = express.Router();

// All history routes require a valid user JWT.

// GET /api/history/summary     — totals card (deposited / withdrawn / ROI)
router.get('/summary', authenticate, getSummary);

// GET /api/history/deposits    — deposit tab
router.get('/deposits', authenticate, getDepositHistory);

// GET /api/history/withdrawals — withdraw tab (wallet + vault combined)
router.get('/withdrawals', authenticate, getWithdrawalHistory);

// GET /api/history/wallet      — wallet-only withdrawals (convenience alias)
router.get('/wallet', authenticate, getWalletHistory);

// GET /api/history/roi         — ROI tab
router.get('/roi', authenticate, getRoiHistory);

// GET /api/history/admin/:userId   [Admin only]
// Same unified feed as GET /api/history below, but for any user — powers
// the "Transactions" tab on the Admin Panel's User Details page.
router.get('/admin/:userId', authenticate, requireAdmin, adminGetUserHistory);

// GET /api/history             — unified feed (all tabs merged, filterable via ?tab=)
router.get('/', authenticate, getUnifiedHistory);

module.exports = router;