// controllers/adminUsersController.js
//
// Backend for the Admin Panel's "User Management" module (Users.jsx /
// UserDetails.jsx on the frontend). Implements exactly the four endpoints
// that file was built against:
//
//   GET  /api/admin/users            listUsers
//   GET  /api/admin/users/stats      getUserStats
//   GET  /api/admin/users/:id        getUserDetails
//   PUT  /api/admin/users/:id/status updateAccountStatus
//
// Data sources used (no new tables needed beyond one small column addition):
//   users               — profile, kyc_status, balance (wallet), vault_balance (ROI),
//                          my_referral_code (this user's own code), referral_code
//                          (the code THEY signed up with), referral_count
//   investment_plans    — plan_type/status/plan_amount → current plan, plan
//                          status, total investment
//   kyc_submissions     — latest approved/pending bank details snapshot
//   login_history       — last login + login history list (populated by the
//                          app via POST /api/security/login-history/record)
//   user_sessions       — most recent device/session info

const db = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');

// ── One-time migration: add users.account_status ────────────────────────────
//
// The users table already has `is_active` (a simple 0/1 gate checked at
// login), but the admin panel needs a 3-state status — active / suspended /
// blocked — to show and filter on. We add a new column instead of overloading
// is_active, and keep is_active in sync with it so the existing login check
// in authController (`if (!user.is_active)`) continues to work unchanged for
// both suspended and blocked accounts.
let _accountStatusColumnVerified = false;

async function ensureAccountStatusColumn() {
  if (_accountStatusColumnVerified) return;
  try {
    const [rows] = await db.execute(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'users'
          AND COLUMN_NAME  = 'account_status'
        LIMIT 1`
    );
    if (rows.length === 0) {
      console.warn('[admin-users] account_status column missing — running migration…');
      await db.execute(
        `ALTER TABLE users
           ADD COLUMN account_status ENUM('active','suspended','blocked')
             NOT NULL DEFAULT 'active'
           AFTER is_active`
      );
      // Backfill: any account previously deactivated via is_active alone
      // (e.g. by an older admin tool) is treated as 'suspended' rather than
      // silently showing as 'active'.
      await db.execute(
        `UPDATE users SET account_status = 'suspended' WHERE is_active = 0 AND account_status = 'active'`
      );
      console.log('[admin-users] ✅ account_status column added to users table.');
    }
    _accountStatusColumnVerified = true;
  } catch (err) {
    console.error('[admin-users] migration check failed:', err.message);
  }
}

// Run once on module load (non-blocking) — mirrors kycController's pattern.
ensureAccountStatusColumn();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** '3_month' -> '3 Month', '12_month' -> '12 Month' */
function formatPlanType(planType) {
  if (!planType) return null;
  const months = String(planType).split('_')[0];
  return `${months} Month`;
}

const ALLOWED_KYC_STATUSES = ['approved', 'pending', 'rejected', 'not_submitted'];
const ALLOWED_PLAN_STATUSES = ['active', 'matured', 'none'];
const ALLOWED_ACCOUNT_STATUSES = ['active', 'suspended', 'blocked'];

// ── GET /api/admin/users ──────────────────────────────────────────────────────
//
// Query: ?page=1&limit=15&search=&kyc_status=&plan_status=&account_status=
async function listUsers(req, res) {
  await ensureAccountStatusColumn();

  const pageNum  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limitNum = Math.max(1, Math.min(100, parseInt(req.query.limit || '15', 10)));
  const offset   = (pageNum - 1) * limitNum;

  const search        = (req.query.search || '').trim();
  const kycStatus     = ALLOWED_KYC_STATUSES.includes(req.query.kyc_status) ? req.query.kyc_status : '';
  const planStatus    = ALLOWED_PLAN_STATUSES.includes(req.query.plan_status) ? req.query.plan_status : '';
  const accountStatus = ALLOWED_ACCOUNT_STATUSES.includes(req.query.account_status) ? req.query.account_status : '';

  // Base filters that can be applied directly on the `users` row.
  const baseWhere = ["u.role = 'user'"];
  const baseParams = [];

  if (kycStatus) {
    baseWhere.push('u.kyc_status = ?');
    baseParams.push(kycStatus);
  }
  if (accountStatus) {
    baseWhere.push('u.account_status = ?');
    baseParams.push(accountStatus);
  }
  if (search) {
    baseWhere.push(`(
      u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR
      u.phone LIKE ? OR u.my_referral_code LIKE ? OR u.id = ?
    )`);
    const like = `%${search}%`;
    baseParams.push(like, like, like, like, like, /^\d+$/.test(search) ? Number(search) : -1);
  }

  const baseWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : '';

  // Per-user plan aggregation: active/matured/none + total investment, joined
  // once so both the list and the plan_status filter can reuse it.
  const planAggSql = `
    LEFT JOIN (
      SELECT
        user_id,
        MAX(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) AS has_active,
        MAX(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS has_completed,
        SUM(CASE WHEN status IN ('approved','active','completed') THEN plan_amount ELSE 0 END) AS total_investment
      FROM investment_plans
      GROUP BY user_id
    ) plan_agg ON plan_agg.user_id = u.id
  `;

  const currentPlanSubquery = `(
    SELECT ip.plan_type FROM investment_plans ip
     WHERE ip.user_id = u.id AND ip.status IN ('active','completed')
     ORDER BY FIELD(ip.status,'active','completed'), ip.id DESC LIMIT 1
  )`;

  const lastLoginSubquery = `(
    SELECT MAX(created_at) FROM login_history lh
     WHERE lh.user_id = u.id AND lh.success = 1
  )`;

  const selectSql = `
    SELECT
      u.id AS user_id, u.member_id, u.first_name, u.last_name, u.phone, u.email,
      u.my_referral_code AS referral_code, u.referral_count,
      u.kyc_status, u.account_status,
      u.balance AS wallet_balance, u.vault_balance AS roi_balance,
      u.created_at AS registered_at,
      ${lastLoginSubquery} AS last_login_at,
      ${currentPlanSubquery} AS current_plan_type,
      COALESCE(plan_agg.has_active, 0)    AS has_active_plan,
      COALESCE(plan_agg.has_completed, 0) AS has_completed_plan,
      COALESCE(plan_agg.total_investment, 0) AS total_investment,
      CASE WHEN COALESCE(plan_agg.has_active, 0) = 1 THEN 'active'
           WHEN COALESCE(plan_agg.has_completed, 0) = 1 THEN 'matured'
           ELSE 'none' END AS plan_status
    FROM users u
    ${planAggSql}
    ${baseWhereSql}
  `;

  try {
    // plan_status is computed, so it's filtered in an outer wrapper query
    // rather than the inner WHERE (which only has direct-column filters).
    const planFilterSql = planStatus ? 'WHERE t.plan_status = ?' : '';
    const planFilterParams = planStatus ? [planStatus] : [];

    const limitOffsetSql = `LIMIT ${limitNum} OFFSET ${offset}`;

    const [rows] = await db.query(
      `SELECT * FROM (${selectSql}) t
       ${planFilterSql}
       ORDER BY t.user_id DESC
       ${limitOffsetSql}`,
      [...baseParams, ...planFilterParams]
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM (${selectSql}) t ${planFilterSql}`,
      [...baseParams, ...planFilterParams]
    );

    const users = rows.map((r) => ({
      user_id: r.user_id,
      member_id: r.member_id || null,
      first_name: r.first_name,
      last_name: r.last_name,
      phone: r.phone,
      email: r.email,
      referral_code: r.referral_code,
      referral_count: r.referral_count,
      kyc_status: r.kyc_status,
      plan_status: r.plan_status,
      current_plan: formatPlanType(r.current_plan_type) || '—',
      wallet_balance: Number(r.wallet_balance) || 0,
      roi_balance: Number(r.roi_balance) || 0,
      total_investment: Number(r.total_investment) || 0,
      registered_at: r.registered_at,
      last_login_at: r.last_login_at,
      account_status: r.account_status,
    }));

    return ok(res, 'Users fetched', {
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) {
    console.error('[admin-users:list]', err);
    return fail(res, 'Could not fetch users', 500);
  }
}

// ── GET /api/admin/users/stats ────────────────────────────────────────────────
async function getUserStats(_req, res) {
  await ensureAccountStatusColumn();

  try {
    const [[{ total_users }]] = await db.query(
      `SELECT COUNT(*) AS total_users FROM users WHERE role = 'user'`
    );
    const [[{ kyc_pending }]] = await db.query(
      `SELECT COUNT(*) AS kyc_pending FROM users WHERE role = 'user' AND kyc_status = 'pending'`
    );
    const [[{ active_plans }]] = await db.query(
      `SELECT COUNT(DISTINCT user_id) AS active_plans FROM investment_plans WHERE status = 'active'`
    );
    const [[{ total_investment }]] = await db.query(
      `SELECT COALESCE(SUM(plan_amount), 0) AS total_investment
         FROM investment_plans WHERE status IN ('approved','active','completed')`
    );

    return ok(res, 'User stats fetched', {
      total_users,
      kyc_pending,
      active_plans,
      total_investment: Number(total_investment) || 0,
    });
  } catch (err) {
    console.error('[admin-users:stats]', err);
    return fail(res, 'Could not fetch user stats', 500);
  }
}

// ── GET /api/admin/users/:id ──────────────────────────────────────────────────
async function getUserDetails(req, res) {
  await ensureAccountStatusColumn();

  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return fail(res, 'Invalid user id', 400);
  }

  try {
    const [userRows] = await db.execute(
      `SELECT id AS user_id, member_id, first_name, last_name, phone, email,
              my_referral_code AS referral_code, referral_code AS referred_by_code,
              referral_count, kyc_status, account_status,
              balance AS wallet_balance, vault_balance AS roi_balance,
              created_at AS registered_at
         FROM users
        WHERE id = ? AND role = 'user'
        LIMIT 1`,
      [userId]
    );
    if (userRows.length === 0) {
      return fail(res, 'User not found', 404);
    }
    const u = userRows[0];

    // Plan history — most recent first.
    const [plans] = await db.execute(
      `SELECT plan_type, plan_amount, monthly_amount, months_paid,
              start_date, maturity_date, accrued_roi, withdrawn_roi, status,
              created_at
         FROM investment_plans
        WHERE user_id = ?
        ORDER BY created_at DESC`,
      [userId]
    );
    const hasActive = plans.some((p) => p.status === 'active');
    const hasCompleted = plans.some((p) => p.status === 'completed');
    const planStatus = hasActive ? 'active' : hasCompleted ? 'matured' : 'none';
    const currentPlan = plans.find((p) => p.status === 'active')
      || plans.find((p) => p.status === 'completed');
    const totalInvestment = plans
      .filter((p) => ['approved', 'active', 'completed'].includes(p.status))
      .reduce((sum, p) => sum + Number(p.plan_amount || 0), 0);

    // Latest KYC submission — bank details snapshot for the profile page.
    const [kycRows] = await db.execute(
      `SELECT account_holder_name, account_number, ifsc_code, bank_name,
              bank_branch, bank_city, bank_state
         FROM kyc_submissions
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );
    const kyc = kycRows[0] || null;

    // Referred users — anyone who signed up using this user's own code.
    const [referrals] = await db.execute(
      `SELECT id AS user_id, first_name, last_name, created_at AS joined_at
         FROM users
        WHERE referral_code = ?
        ORDER BY created_at DESC`,
      [u.referral_code || '']
    );

    // Login history (populated by the app via
    // POST /api/security/login-history/record).
    const [loginHistory] = await db.execute(
      `SELECT device_name, location, success, created_at
         FROM login_history
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 20`,
      [userId]
    );
    const lastSuccessfulLogin = loginHistory.find((l) => l.success === 1) || null;

    // Most recent device/session, if any (richer than login_history alone).
    const [sessionRows] = await db.execute(
      `SELECT device_name, device_type, location, last_active
         FROM user_sessions
        WHERE user_id = ?
        ORDER BY last_active DESC
        LIMIT 1`,
      [userId]
    );
    const latestSession = sessionRows[0] || null;

    return ok(res, 'User details fetched', {
      user_id: u.user_id,
      member_id: u.member_id || null,
      first_name: u.first_name,
      last_name: u.last_name,
      phone: u.phone,
      email: u.email,
      referral_code: u.referral_code,
      referred_by_code: u.referred_by_code,
      referral_count: u.referral_count,
      kyc_status: u.kyc_status,
      plan_status: planStatus,
      current_plan: currentPlan ? formatPlanType(currentPlan.plan_type) : '—',
      wallet_balance: Number(u.wallet_balance) || 0,
      roi_balance: Number(u.roi_balance) || 0,
      total_investment: totalInvestment,
      registered_at: u.registered_at,
      last_login_at: lastSuccessfulLogin ? lastSuccessfulLogin.created_at : null,
      account_status: u.account_status,

      bank_account_holder: kyc?.account_holder_name || null,
      bank_account_number: kyc?.account_number || null,
      bank_ifsc: kyc?.ifsc_code || null,
      // No UPI-ID column exists anywhere in the schema (deposits only store
      // a UTR reference, not the payer's UPI handle) — left null on purpose.
      upi_id: null,

      device_info: latestSession
        ? `${latestSession.device_type || 'Unknown'} · ${latestSession.device_name}`
        : (loginHistory[0]?.device_name || null),
      // No IP-address column exists anywhere in the schema today (neither
      // on users nor login_history) — left null on purpose. Add one to
      // login_history if this is needed.
      registration_ip: null,

      plan_history: plans.map((p) => ({
        plan_type: formatPlanType(p.plan_type),
        amount: Number(p.plan_amount) || 0,
        started_at: p.start_date || p.created_at,
        status: p.status,
      })),
      referrals: referrals.map((r) => ({
        user_id: r.user_id,
        name: `${r.first_name} ${r.last_name}`,
        joined_at: r.joined_at,
      })),
      login_history: loginHistory.map((l) => ({
        at: l.created_at,
        device: l.device_name,
        location: l.location,
        success: l.success === 1,
      })),
    });
  } catch (err) {
    console.error('[admin-users:detail]', err);
    return fail(res, 'Could not fetch user details', 500);
  }
}

// ── PUT /api/admin/users/:id/status ───────────────────────────────────────────
// Body: { status: 'active' | 'suspended' | 'blocked', reason?: string }
async function updateAccountStatus(req, res) {
  await ensureAccountStatusColumn();

  const userId = parseInt(req.params.id, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return fail(res, 'Invalid user id', 400);
  }

  const { status, reason } = req.body;
  if (!ALLOWED_ACCOUNT_STATUSES.includes(status)) {
    return fail(res, `status must be one of: ${ALLOWED_ACCOUNT_STATUSES.join(', ')}`, 422);
  }

  try {
    const [existing] = await db.execute(
      `SELECT id, account_status FROM users WHERE id = ? AND role = 'user' LIMIT 1`,
      [userId]
    );
    if (existing.length === 0) {
      return fail(res, 'User not found', 404);
    }

    await db.execute(
      `UPDATE users SET account_status = ?, is_active = ? WHERE id = ?`,
      [status, status === 'active' ? 1 : 0, userId]
    );

    const messages = {
      active:    'Your account has been reactivated by the admin team.',
      suspended: `Your account has been suspended.${reason ? ` Reason: ${reason}` : ''} Please contact support.`,
      blocked:   `Your account has been blocked.${reason ? ` Reason: ${reason}` : ''} Please contact support.`,
    };
    createNotification(userId, 'system', 'Account Status Updated', messages[status])
      .catch((e) => console.error('[admin-users:status] notify error:', e.message));

    return ok(res, 'Account status updated', { user_id: userId, account_status: status });
  } catch (err) {
    console.error('[admin-users:status]', err);
    return fail(res, 'Could not update account status', 500);
  }
}

module.exports = {
  listUsers,
  getUserStats,
  getUserDetails,
  updateAccountStatus,
};