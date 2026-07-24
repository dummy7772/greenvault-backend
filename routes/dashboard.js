// routes/dashboard.js
const express = require('express');

const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const { getDashboardSummary } = require('../controllers/dashboardController');

const router = express.Router();

/**
 * GET /api/dashboard/summary   [Admin only]
 * Aggregated real-data payload for the Admin Panel Dashboard page:
 * KPI stats, 14-day deposits/withdrawals trend, plan distribution,
 * recent activity feed, notifications, quick-action counts, top plans,
 * and the header summary strip. See controllers/dashboardController.js.
 */
router.get('/summary', authenticate, requireAdmin, getDashboardSummary);

module.exports = router;