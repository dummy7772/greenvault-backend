// routes/plan.js
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  getMyPlans,
  getPlanAmount,
  enrollPlan,
  withdrawRoi,
  withdrawPrincipal,
  adminListPlans,
  adminApprovePlan,
  adminRejectPlan,
  adminApproveInstalment,
  adminRejectInstalment,
  adminFixPlanDates,
} = require('../controllers/planController');

const router = express.Router();

// ── Multer storage for plan instalment proof images ──────────────────────────
const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const userId = req.user?.sub || 'unknown';
    const dir = path.join(__dirname, '..', 'uploads', 'plans', String(userId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `proof-${Date.now()}${ext}`);
  },
});

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp', '.gif']);
const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'image/bmp', 'image/gif',
  'application/octet-stream', 'application/jpeg',
]);

function fileFilter(_req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext) || ALLOWED_MIMES.has(mime)) {
    cb(null, true);
  } else {
    cb(null, false);
  }
}

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

// ── User routes ───────────────────────────────────────────────────────────────

// GET  /api/plans/my              — user's own plans + instalments
router.get('/my', authenticate, getMyPlans);

// GET  /api/plans/plan-amount     — total invested amount for profile
router.get('/plan-amount', authenticate, getPlanAmount);

// POST /api/plans/enroll          — enroll in a plan (UPI / proof image)
router.post('/enroll', authenticate, enrollPlan);

// NOTE: Recurring monthly instalment payments have been permanently
// removed. A plan is funded by exactly one payment, submitted at
// enrollment (POST /enroll above) and reviewed once by admin — there is no
// "pay next instalment" endpoint anymore.
//
// NOTE: Wallet-balance payment for investment plans (enroll-wallet /
// pay-wallet) has been permanently removed. Wallet Balance must never be
// used to create or pay for an investment plan — a plan is only ever
// activated through the UPI/bank-transfer proof + admin-approval flow
// above. Do not re-add wallet-funded enroll/pay routes.

// POST /api/plans/:id/withdraw-roi       — transfer accrued ROI to wallet
router.post('/:id/withdraw-roi', authenticate, withdrawRoi);

// POST /api/plans/:id/withdraw-principal — redeem principal after completion
router.post('/:id/withdraw-principal', authenticate, withdrawPrincipal);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET  /api/plans/admin/list              — list all plans (with optional ?status=)
router.get('/admin/list', authenticate, requireAdmin, adminListPlans);

// POST /api/plans/admin/:id/approve       — approve a plan (under_review → approved)
router.post('/admin/:id/approve', authenticate, requireAdmin, adminApprovePlan);

// POST /api/plans/admin/:id/reject        — reject a plan
router.post('/admin/:id/reject', authenticate, requireAdmin, adminRejectPlan);

// POST /api/plans/admin/instalment/:id/approve — approve a monthly instalment
router.post('/admin/instalment/:id/approve', authenticate, requireAdmin, adminApproveInstalment);

// POST /api/plans/admin/instalment/:id/reject  — reject a monthly instalment
router.post('/admin/instalment/:id/reject', authenticate, requireAdmin, adminRejectInstalment);

// POST /api/plans/admin/fix-dates         — one-time date correction utility
router.post('/admin/fix-dates', authenticate, requireAdmin, adminFixPlanDates);

module.exports = router;
