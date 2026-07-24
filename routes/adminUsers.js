// routes/adminUsers.js
const express = require('express');

const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  listUsers,
  getUserStats,
  getUserDetails,
  updateAccountStatus,
} = require('../controllers/adminUsersController');

const router = express.Router();

/**
 * GET /api/admin/users   [Admin only]
 * Searchable, filterable, paginated user list for the Admin Panel's User
 * Management module.
 *
 * Query: ?page=1&limit=15&search=&kyc_status=&plan_status=&account_status=
 */
router.get('/', authenticate, requireAdmin, listUsers);

/**
 * GET /api/admin/users/stats   [Admin only]
 * Aggregate counts for the Users page KPI cards.
 * NOTE: registered before '/:id' so it isn't swallowed by that param route.
 */
router.get('/stats', authenticate, requireAdmin, getUserStats);

/**
 * GET /api/admin/users/:id   [Admin only]
 * Full profile for the User Details page — financials, plan history,
 * referrals, login history, bank details snapshot.
 */
router.get('/:id', authenticate, requireAdmin, getUserDetails);

/**
 * PUT /api/admin/users/:id/status   [Admin only]
 * Body: { status: 'active' | 'suspended' | 'blocked', reason?: string }
 */
router.put('/:id/status', authenticate, requireAdmin, updateAccountStatus);

module.exports = router;