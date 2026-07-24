// routes/referral.js
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  getReferralInfo,
  claimReward,
  getReferralTransactions,
  getReferralCandidates,
  adminBackfillReferralBonuses,
} = require('../controllers/referralController');

const router = express.Router();

router.use(authenticate);

// GET  /api/referral/info              — wallet balance, code, refers, task progress
router.get('/info', getReferralInfo);

// POST /api/referral/claim-reward      — claim the one-time ₹500 invite-5 reward
router.post('/claim-reward', claimReward);

// GET  /api/referral/transactions      — referral bonus + reward claim history
router.get('/transactions', getReferralTransactions);

// GET  /api/referral/candidates        — referred users who completed their
//                                          first plan payment (Referral
//                                          Candidates tab)
router.get('/candidates', getReferralCandidates);

// POST /api/referral/admin/backfill-bonuses — admin-only. Retroactively
//                                          credits any referred user whose
//                                          plan is already approved/active/
//                                          completed but never got their
//                                          referrer's bonus (e.g. from
//                                          before the atomic-transaction
//                                          fix). Safe to run repeatedly.
router.post('/admin/backfill-bonuses', requireAdmin, adminBackfillReferralBonuses);

module.exports = router;