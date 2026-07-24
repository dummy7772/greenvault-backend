// controllers/historyController.js
//
// Unified transaction history endpoint.
// Aggregates deposits, withdrawals, plan ROI/instalment events, and
// referral bonus/task-reward credits into a single chronological feed
// with optional tab-based filtering, text search, date range, and
// pagination.
//
// Routes (all user-scoped, JWT required):
//   GET  /api/history            — paginated unified feed
//   GET  /api/history/summary    — totals card (deposited / withdrawn / roi)
//   GET  /api/history/deposits   — deposit-only feed
//   GET  /api/history/withdrawals — withdrawal-only feed
//   GET  /api/history/roi        — ROI / plan instalment feed
//   GET  /api/history/wallet     — wallet-type withdrawals only
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/db');
const { ok, fail } = require('../utils/response');

// ── Constants ─────────────────────────────────────────────────────────────────

const ROI_RATES = {
  '3_month':  0.0030,
  '6_month':  0.0035,
  '12_month': 0.0045,
};

const PLAN_MONTHS = {
  '3_month':  3,
  '6_month':  6,
  '12_month': 12,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse pagination params, clamped to sensible limits. */
function parsePagination(query) {
  const page     = Math.max(1, parseInt(query.page     || '1',  10));
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize || query.limit || '20', 10)));
  const offset   = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

/** Normalise status strings for frontend badge display. */
function normaliseStatus(raw) {
  if (!raw) return 'pending';
  const s = raw.toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'rejected') return 'rejected';
  return 'pending';
}

/** Build the proof-image public URL from the stored relative path. */
function fileUrl(relPath) {
  if (!relPath) return null;
  const clean = relPath.replace(/^\/uploads\//, '');
  return `/uploads/${clean}`;
}

/**
 * Turns logged roi_withdrawals rows into feed events — one event per row.
 *
 * Each "withdraw ROI to wallet" action inserts its own permanent row (see
 * withdrawRoi() in planController.js), and any pre-existing gap from before
 * that log table existed has already been materialised into its own
 * one-time "legacy" row by ensureSchema(). So every individual withdrawal —
 * old or new — is its own row here and always renders as its own separate
 * transaction (e.g. two ₹9 withdrawals made on the same day show as two
 * distinct entries, not merged into one).
 *
 * A small safety-net top-up event is still added if withdrawn_roi doesn't
 * match the logged total (e.g. the schema migration hasn't run yet), so the
 * withdrawn total shown never silently drops below what was actually taken.
 */
function buildRoiWithdrawalEvents(plans, planMap, roiWithdrawalRows) {
  // Group all rows by plan_id first
  const rowsByPlan = {};
  for (const wd of roiWithdrawalRows) {
    (rowsByPlan[wd.plan_id] = rowsByPlan[wd.plan_id] || []).push(wd);
  }

  const events = [];
  const seenIds = new Set(); // deduplicate by row id

  for (const plan of plans) {
    const allRows    = rowsByPlan[plan.id] || [];
    const planMonths = PLAN_MONTHS[plan.plan_type];
    const planName   = `${planMonths}M Investment Plan`;
    const planLabel  = `${planMonths} Month Plan`;

    // Separate real rows from legacy migration rows
    const realRows   = allRows.filter(w => !w.is_legacy && Number(w.amount) > 0);
    const legacyRows = allRows.filter(w =>  w.is_legacy && Number(w.amount) > 0);

    if (realRows.length > 0) {
      // Individual per-withdrawal records exist � show each one.
      // Legacy rows are intentionally skipped to avoid double-counting.
      for (const wd of realRows) {
        const key = `roi_wd_${wd.id}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        events.push({
          id:        key,
          type:      'roi',
          subtype:   'roi_withdrawal',
          title:     'ROI Withdrawn',
          subtitle:  `${planLabel} � To Wallet`,
          plan_name: planName,
          amount:    Number(wd.amount),
          is_credit: false,
          status:    'approved',
          plan_id:   String(plan.id),
          plan_type: plan.plan_type,
          month:     null,
          date:      wd.created_at,
        });
      }
    } else if (legacyRows.length > 0) {
      // No individual records � show ONE consolidated legacy entry only.
      // (Multiple legacy rows are duplicates from repeated schema runs; use first.)
      const wd  = legacyRows[0];
      const key = `roi_wd_${wd.id}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        events.push({
          id:        key,
          type:      'roi',
          subtype:   'roi_withdrawal',
          title:     'ROI Withdrawn',
          subtitle:  `${planLabel} � To Wallet`,
          plan_name: planName,
          amount:    Number(wd.amount),
          is_credit: false,
          status:    'approved',
          plan_id:   String(plan.id),
          plan_type: plan.plan_type,
          month:     null,
          date:      wd.created_at,
        });
      }
    } else if (Number(plan.withdrawn_roi) > 0.01) {
      // No rows at all but withdrawn_roi is non-zero � schema migration hasn't
      // run yet. Show one synthetic entry so the total never under-reports.
      const key = `roi_wd_legacy_${plan.id}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        events.push({
          id:        key,
          type:      'roi',
          subtype:   'roi_withdrawal',
          title:     'ROI Withdrawn',
          subtitle:  `${planLabel} � To Wallet`,
          plan_name: planName,
          amount:    Number(plan.withdrawn_roi),
          is_credit: false,
          status:    'approved',
          plan_id:   String(plan.id),
          plan_type: plan.plan_type,
          month:     null,
          date:      plan.start_date || plan.created_at || new Date().toISOString(),
        });
      }
    }
  }
  return events;
}

/**
 * Turns logged roi_daily_credits rows into feed events — one event per row.
 *
 * roi_daily_credits is the authoritative "has day X already been credited
 * for plan Y?" ledger (see ensureSchema()/accrueRoiForPlan() in
 * planController.js): every calendar day a plan's ROI is credited inserts
 * exactly one row here, guarded by a UNIQUE (plan_id, credit_date) key via
 * INSERT IGNORE, so this function can never surface two transactions for
 * the same plan on the same date — including when a user was offline for
 * several days and every missed day gets backfilled in a single catch-up
 * run, each missed day still only ever has one row.
 */
function buildDailyRoiCreditEvents(planMap, dailyCreditRows) {
  const events = [];
  for (const row of dailyCreditRows) {
    const plan = planMap[row.plan_id];
    if (!plan) continue;
    const planMonths = PLAN_MONTHS[plan.plan_type];
    const planLabel  = planMonths ? `${planMonths} Month Plan` : 'Investment Plan';
    const planName   = planMonths ? `${planMonths}M Investment Plan` : 'Investment Plan';
    const creditDate = row.credit_date instanceof Date
      ? row.credit_date.toISOString().slice(0, 10)
      : String(row.credit_date).slice(0, 10);

    events.push({
      id:          `roi_daily_${row.id}`,
      type:        'roi',
      subtype:     'daily_roi_credit',
      title:       'Daily ROI Credit',
      subtitle:    `${planLabel} · ${creditDate}`,
      plan_name:   planName,
      amount:      Number(row.amount),
      is_credit:   true,
      status:      'approved',
      status_label: 'Success',
      plan_id:     String(plan.id),
      plan_type:   plan.plan_type,
      credit_date: creditDate,
      date:        row.created_at || row.credit_date,
    });
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/summary
//
// Returns aggregated totals for the earnings card:
//   total_deposited   – sum of approved deposits
//   total_withdrawn   – sum of approved withdrawals
//   total_roi_accrued – sum of accrued_roi across all active/approved/completed plans
//   pending_deposits  – count of pending deposits
//   pending_withdrawals – count of pending withdrawals
// ─────────────────────────────────────────────────────────────────────────────

async function getSummary(req, res) {
  const userId = req.user.sub;

  try {
    // Parallel queries for all totals
    const [
      [depositRows],
      [withdrawRows],
      [roiRows],
      [pendingDepRows],
      [pendingWdRows],
    ] = await Promise.all([
      db.execute(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM deposits
          WHERE user_id = ? AND order_status = 'approved'`,
        [userId]
      ),
      db.execute(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM withdrawals
          WHERE user_id = ? AND status = 'approved'`,
        [userId]
      ),
      db.execute(
        `SELECT COALESCE(SUM(accrued_roi), 0) AS total
           FROM investment_plans
          WHERE user_id = ? AND status IN ('approved','active','completed')`,
        [userId]
      ),
      db.execute(
        `SELECT COUNT(*) AS cnt
           FROM deposits
          WHERE user_id = ? AND order_status = 'pending'`,
        [userId]
      ),
      db.execute(
        `SELECT COUNT(*) AS cnt
           FROM withdrawals
          WHERE user_id = ? AND status = 'pending'`,
        [userId]
      ),
    ]);

    const totalDeposited   = Number(depositRows[0]?.total  || 0);
    const totalWithdrawn   = Number(withdrawRows[0]?.total || 0);
    const totalRoiAccrued  = Number(roiRows[0]?.total      || 0);
    const pendingDeposits  = Number(pendingDepRows[0]?.cnt  || 0);
    const pendingWithdrawals = Number(pendingWdRows[0]?.cnt || 0);

    return ok(res, 'Summary fetched', {
      total_deposited:    totalDeposited,
      total_withdrawn:    totalWithdrawn,
      total_roi_accrued:  totalRoiAccrued,
      net_balance:        totalDeposited - totalWithdrawn,
      pending_deposits:   pendingDeposits,
      pending_withdrawals: pendingWithdrawals,
    });
  } catch (err) {
    console.error('[history:summary]', err.message);
    return fail(res, 'Could not fetch summary.', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/deposits
//
// Query params:
//   page, pageSize  – pagination
//   status          – pending | approved | rejected
//   search          – matches against utr_id
//   from, to        – ISO date strings (YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────────────────────

async function getDepositHistory(req, res) {
  const userId = req.user.sub;
  const { page, pageSize, offset } = parsePagination(req.query);
  const { status, search, from, to } = req.query;

  const clauses = ['user_id = ?'];
  const params  = [userId];

  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    clauses.push('order_status = ?');
    params.push(status);
  }
  if (search && search.trim()) {
    clauses.push('utr_id LIKE ?');
    params.push(`%${search.trim()}%`);
  }
  if (from) {
    clauses.push('DATE(created_at) >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('DATE(created_at) <= ?');
    params.push(to);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;

  try {
    const [rows] = await db.execute(
      `SELECT id, amount, utr_id, proof_image, order_status AS status,
              rejection_reason, created_at
         FROM deposits
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM deposits ${where}`,
      params
    );

    return ok(res, 'Deposit history fetched', {
      page,
      pageSize,
      total: Number(total),
      totalPages: Math.ceil(Number(total) / pageSize),
      data: rows.map(r => ({
        id:               String(r.id),
        type:             'deposit',
        title:            'Bank Deposit',
        subtitle:         r.utr_id ? `UTR: ${r.utr_id}` : 'Bank Transfer',
        amount:           Number(r.amount),
        is_credit:        true,
        status:           normaliseStatus(r.status),
        rejection_reason: r.rejection_reason || null,
        proof_image:      fileUrl(r.proof_image),
        date:             r.created_at,
      })),
    });
  } catch (err) {
    console.error('[history:deposits]', err.message);
    return fail(res, 'Could not fetch deposit history.', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/withdrawals
//
// Query params:
//   page, pageSize  – pagination
//   type            – wallet | vault (optional filter)
//   status          – pending | approved | rejected
//   search          – matches against reference_id
//   from, to        – ISO date strings
// ─────────────────────────────────────────────────────────────────────────────

async function getWithdrawalHistory(req, res) {
  const userId = req.user.sub;
  const { page, pageSize, offset } = parsePagination(req.query);
  const { type, status, search, from, to } = req.query;

  const clauses = ['user_id = ?'];
  const params  = [userId];

  if (type && ['wallet', 'vault'].includes(type)) {
    clauses.push('type = ?');
    params.push(type);
  }
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (search && search.trim()) {
    clauses.push('reference_id LIKE ?');
    params.push(`%${search.trim()}%`);
  }
  if (from) {
    clauses.push('DATE(created_at) >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('DATE(created_at) <= ?');
    params.push(to);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;

  try {
    const [rows] = await db.execute(
      `SELECT id, type, amount, reference_id, status,
              admin_remarks, created_at, reviewed_at
         FROM withdrawals
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM withdrawals ${where}`,
      params
    );

    return ok(res, 'Withdrawal history fetched', {
      page,
      pageSize,
      total: Number(total),
      totalPages: Math.ceil(Number(total) / pageSize),
      data: rows.map(r => ({
        id:            String(r.id),
        type:          'withdrawal',
        subtype:       r.type,        // 'wallet' or 'vault'
        title:         r.type === 'vault' ? 'Vault Withdrawal' : 'Wallet Withdrawal',
        subtitle:      r.reference_id ? `Ref: ${r.reference_id}` : 'Bank Transfer',
        amount:        Number(r.amount),
        is_credit:     false,
        status:        normaliseStatus(r.status),
        admin_remarks: r.admin_remarks || null,
        reference_id:  r.reference_id || null,
        date:          r.created_at,
        reviewed_at:   r.reviewed_at || null,
      })),
    });
  } catch (err) {
    console.error('[history:withdrawals]', err.message);
    return fail(res, 'Could not fetch withdrawal history.', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/wallet
//
// Convenience alias: withdrawals of type='wallet' only.
// ─────────────────────────────────────────────────────────────────────────────

async function getWalletHistory(req, res) {
  req.query.type = 'wallet';
  return getWithdrawalHistory(req, res);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history/roi
//
// Returns a per-plan ROI breakdown:
//   - Each credited calendar day is surfaced as its own "Daily ROI Credit"
//     transaction (sourced from roi_daily_credits — never duplicated for
//     the same plan + date).
//   - Each "withdraw ROI to wallet" action is its own debit event.
//
// Query params:
//   page, pageSize – pagination
//   from, to       – date range against instalment paid_at / plan created_at
// ─────────────────────────────────────────────────────────────────────────────

async function getRoiHistory(req, res) {
  const userId = req.user.sub;
  const { page, pageSize, offset } = parsePagination(req.query);
  const { from, to } = req.query;

  try {
    // ── 1. All plans for this user ────────────────────────────────────────
    const [plans] = await db.execute(
      `SELECT id, plan_type, monthly_amount, months_paid,
              accrued_roi, withdrawn_roi, status, start_date, created_at
         FROM investment_plans
        WHERE user_id = ?
        ORDER BY created_at DESC`,
      [userId]
    );

    // ── 2. Daily ROI credits + ROI withdrawals for those plans ────────────
    const planIds = plans.map(p => p.id);
    let dailyCredits = [];
    let roiWithdrawals = [];

    if (planIds.length > 0) {
      const placeholders = planIds.map(() => '?').join(',');

      // ── 2a. Every individual daily ROI credit (Daily ROI Credit txns) ────
      let dcClause = `WHERE plan_id IN (${placeholders})`;
      const dcParams = [...planIds];
      if (from) { dcClause += ' AND credit_date >= ?'; dcParams.push(from); }
      if (to)   { dcClause += ' AND credit_date <= ?'; dcParams.push(to);   }

      const [dcRows] = await db.execute(
        `SELECT id, plan_id, user_id, credit_date, amount, created_at
           FROM roi_daily_credits
           ${dcClause}
           ORDER BY credit_date DESC`,
        dcParams
      );
      dailyCredits = dcRows;

      // ── 2b. All "withdraw ROI to wallet" actions for those plans ─────────
      let wdClause = `WHERE plan_id IN (${placeholders})`;
      const wdParams = [...planIds];
      if (from) { wdClause += ' AND DATE(created_at) >= ?'; wdParams.push(from); }
      if (to)   { wdClause += ' AND DATE(created_at) <= ?'; wdParams.push(to);   }

      const [wdRows] = await db.execute(
        `SELECT id, plan_id, amount, is_legacy, created_at
           FROM roi_withdrawals
           ${wdClause}
           ORDER BY created_at DESC`,
        wdParams
      );
      roiWithdrawals = wdRows;
    }

    // ── 3. Build plan lookup map ──────────────────────────────────────────
    const planMap = {};
    for (const p of plans) planMap[p.id] = p;

    // ── 4. Build ROI event list ───────────────────────────────────────────
    const events = [];

    // 4a. One event per credited calendar day (Daily ROI Credit transaction).
    // Sourced from roi_daily_credits, which guarantees exactly one row per
    // (plan_id, credit_date) — so duplicate transactions for the same date
    // are impossible even after an offline-catch-up backfill.
    events.push(...buildDailyRoiCreditEvents(planMap, dailyCredits));

    // 4b. ROI withdrawn to wallet — one separate debit event per completed
    // withdrawal. Each row in roi_withdrawals is its own permanent record, so
    // two ₹9 withdrawals on the same day will always appear as two distinct
    // transactions grouped under that date. The legacy safety-net event
    // covers any pre-log withdrawn_roi that hasn't been materialised yet.
    const withdrawalEvents = buildRoiWithdrawalEvents(plans, planMap, roiWithdrawals);
    events.push(...withdrawalEvents);

    // ── 5. Sort newest first, then paginate ───────────────────────────────
    events.sort((a, b) => new Date(b.date) - new Date(a.date));
    const total     = events.length;
    const paginated = events.slice(offset, offset + pageSize);

    // ── 6. ROI summary — computed from the actual withdrawal event list ────
    // total_withdrawn is the sum of every withdrawal event amount (including
    // the legacy safety-net row if present). This matches exactly what the
    // transaction list displays, so the card totals are always consistent
    // with the individual rows shown beneath them.
    const totalAccrued     = plans.reduce((s, p) => s + Number(p.accrued_roi  || 0), 0);
    const totalWithdrawnFromRows = withdrawalEvents.reduce((s, e) => s + e.amount, 0);
    // Also pull from plan column as the authoritative source (roi_withdrawals rows
    // may be filtered by date range, so use plan totals for the summary card).
    const totalWithdrawnFromPlan = plans.reduce((s, p) => s + Number(p.withdrawn_roi || 0), 0);
    // Use the larger of the two in case of any rounding edge, but they should match.
    const totalWithdrawn   = Math.max(totalWithdrawnFromPlan, totalWithdrawnFromRows);
    const withdrawalCount  = withdrawalEvents.length;
    const availableToWithdraw = Math.max(0, totalAccrued - totalWithdrawn);

    return ok(res, 'ROI history fetched', {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      total_accrued:         Number(totalAccrued.toFixed(4)),
      total_withdrawn:       Number(totalWithdrawn.toFixed(4)),
      available_to_withdraw: Number(availableToWithdraw.toFixed(4)),
      withdrawal_count:      withdrawalCount,
      pending_roi:           Number(availableToWithdraw.toFixed(4)),
      data: paginated,
    });
  } catch (err) {
    console.error('[history:roi]', err.message);
    return fail(res, 'Could not fetch ROI history.', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history
//
// Unified feed: merges deposits + withdrawals + ROI events, sorted newest-first.
//
// Query params:
//   page, pageSize  – pagination (default page=1, pageSize=20)
//   tab             – deposit | withdrawal | roi | wallet | referral (filters by type)
//   status          – pending | approved | rejected
//   search          – text filter on title/subtitle/reference
//   from, to        – ISO date strings (YYYY-MM-DD)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Core unified-feed builder, shared by the user-scoped endpoint
 * (GET /api/history) and the admin-scoped endpoint
 * (GET /api/history/admin/:userId). Both just supply a different userId —
 * the one from the JWT for the user's own view, or a param for the admin
 * User Details "Transactions" tab.
 */
async function buildUnifiedHistory(userId, query) {
  const { page, pageSize, offset } = parsePagination(query);
  const { tab, status, search, from, to } = query;

  {
    const allEvents = [];

    // ── Deposits ───────────────────────────────────────────────────────────
    if (!tab || tab === 'deposit') {
      const clauses = ['user_id = ?'];
      const params  = [userId];

      if (status && ['pending', 'approved', 'rejected'].includes(status)) {
        clauses.push('order_status = ?');
        params.push(status);
      }
      if (search && search.trim()) {
        clauses.push(`(utr_id LIKE ? OR CAST(amount AS CHAR) LIKE ?)`);
        const s = `%${search.trim()}%`;
        params.push(s, s);
      }
      if (from) { clauses.push('DATE(created_at) >= ?'); params.push(from); }
      if (to)   { clauses.push('DATE(created_at) <= ?'); params.push(to);   }

      const [rows] = await db.execute(
        `SELECT id, amount, utr_id, proof_image, order_status, rejection_reason, created_at
           FROM deposits WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        params
      );

      for (const r of rows) {
        allEvents.push({
          id:               `dep_${r.id}`,
          type:             'deposit',
          title:            'Bank Deposit',
          subtitle:         r.utr_id ? `UTR: ${r.utr_id}` : 'Bank Transfer',
          amount:           Number(r.amount),
          is_credit:        true,
          status:           normaliseStatus(r.order_status),
          rejection_reason: r.rejection_reason || null,
          proof_image:      fileUrl(r.proof_image),
          date:             r.created_at,
        });
      }
    }

    // ── Withdrawals ────────────────────────────────────────────────────────
    if (!tab || tab === 'withdrawal' || tab === 'wallet') {
      const clauses = ['user_id = ?'];
      const params  = [userId];

      if (tab === 'wallet') {
        clauses.push("type = 'wallet'");
      }
      if (status && ['pending', 'approved', 'rejected'].includes(status)) {
        clauses.push('status = ?');
        params.push(status);
      }
      if (search && search.trim()) {
        clauses.push(`(reference_id LIKE ? OR CAST(amount AS CHAR) LIKE ?)`);
        const s = `%${search.trim()}%`;
        params.push(s, s);
      }
      if (from) { clauses.push('DATE(created_at) >= ?'); params.push(from); }
      if (to)   { clauses.push('DATE(created_at) <= ?'); params.push(to);   }

      const [rows] = await db.execute(
        `SELECT id, type, amount, reference_id, status, admin_remarks, created_at, reviewed_at
           FROM withdrawals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        params
      );

      for (const r of rows) {
        // The withdrawal amount is locked (debited) from the wallet/vault
        // balance the moment the request is submitted — see
        // withdrawalController.js. That debit is represented here as a
        // single debit event, dated at submission time, regardless of the
        // request's current status (pending/approved/rejected).
        allEvents.push({
          id:            `wd_${r.id}`,
          type:          'withdrawal',
          subtype:       r.type,
          title:         r.type === 'vault' ? 'Vault Withdrawal' : 'Wallet Withdrawal',
          subtitle:      r.reference_id ? `Ref: ${r.reference_id}` : 'Bank Transfer',
          amount:        Number(r.amount),
          is_credit:     false,
          status:        normaliseStatus(r.status),
          admin_remarks: r.admin_remarks || null,
          reference_id:  r.reference_id || null,
          date:          r.created_at,
        });

        // If the request was rejected, the locked amount is automatically
        // refunded back to the wallet/vault balance — surface that refund
        // as its own credit event (dated at the review time) so the ledger
        // accurately reflects both balance movements that actually
        // happened: the initial lock and the subsequent refund.
        if (r.status === 'rejected') {
          allEvents.push({
            id:            `wd_${r.id}_refund`,
            type:          'withdrawal',
            subtype:       'refund',
            title:         r.type === 'vault' ? 'Vault Withdrawal Refund' : 'Wallet Withdrawal Refund',
            subtitle:      r.reference_id ? `Ref: ${r.reference_id} • Rejected` : 'Rejected — Amount Refunded',
            amount:        Number(r.amount),
            is_credit:     true,
            status:        'approved',
            admin_remarks: r.admin_remarks || null,
            reference_id:  r.reference_id || null,
            date:          r.reviewed_at || r.created_at,
          });
        }
      }
    }

    // ── ROI ────────────────────────────────────────────────────────────────
    if (!tab || tab === 'roi') {
      const [plans] = await db.execute(
        `SELECT id, plan_type, monthly_amount, accrued_roi, withdrawn_roi, status, start_date
           FROM investment_plans
          WHERE user_id = ?`,
        [userId]
      );

      if (plans.length > 0) {
        const planMap   = Object.fromEntries(plans.map(p => [p.id, p]));
        const planIds   = plans.map(p => p.id);
        const ph        = planIds.map(() => '?').join(',');

        // ── Daily ROI Credit transactions ────────────────────────────────
        // One row per credited calendar day, sourced from roi_daily_credits
        // (UNIQUE on plan_id + credit_date), so duplicate same-date entries
        // are structurally impossible even after a multi-day catch-up.
        if (!status || status === 'approved') {
          const dcClause = [`plan_id IN (${ph})`];
          const dcParams = [...planIds];
          if (from) { dcClause.push('credit_date >= ?'); dcParams.push(from); }
          if (to)   { dcClause.push('credit_date <= ?'); dcParams.push(to);   }

          const [dcRows] = await db.execute(
            `SELECT id, plan_id, user_id, credit_date, amount, created_at
               FROM roi_daily_credits
              WHERE ${dcClause.join(' AND ')}
              ORDER BY credit_date DESC LIMIT 200`,
            dcParams
          );

          for (const ev of buildDailyRoiCreditEvents(planMap, dcRows)) {
            if (search && search.trim() && !ev.subtitle.toLowerCase().includes(search.toLowerCase())) continue;
            allEvents.push(ev);
          }
        }

        // ROI withdrawn to wallet — debit events (instant, always "approved").
        // Includes a backfilled "legacy" event for any withdrawn_roi that
        // predates the roi_withdrawals log table, so the total/count shown
        // always matches what was actually withdrawn — not the live
        // "available to withdraw" balance, which isn't a transaction.
        if (!status || status === 'approved') {
          const wdClause = [`plan_id IN (${ph})`];
          const wdParams = [...planIds];
          if (from) { wdClause.push('DATE(created_at) >= ?'); wdParams.push(from); }
          if (to)   { wdClause.push('DATE(created_at) <= ?'); wdParams.push(to);   }

          const [roiWdRows] = await db.execute(
            `SELECT id, plan_id, amount, is_legacy, created_at
               FROM roi_withdrawals
              WHERE ${wdClause.join(' AND ')}
              ORDER BY created_at DESC LIMIT 200`,
            wdParams
          );

          for (const ev of buildRoiWithdrawalEvents(plans, planMap, roiWdRows)) {
            if (search && search.trim() && !ev.subtitle.toLowerCase().includes(search.toLowerCase())) continue;
            allEvents.push(ev);
          }
        }
      }
    }

    // ── Referral (bonus credits + task reward claims) ───────────────────────
    // Credited straight to the Main Wallet balance at the moment they're
    // earned/claimed (see referralController.js), so — exactly like
    // deposits, withdrawals, and ROI credits — they belong in this unified
    // feed. Previously omitted here, which is why a referral bonus never
    // showed up in the Home screen's "Recent Transactions" card even though
    // it had already landed in the wallet.
    if (!tab || tab === 'referral') {
      const clauses = ['referrer_id = ?'];
      const params  = [userId];

      if (from) { clauses.push('DATE(created_at) >= ?'); params.push(from); }
      if (to)   { clauses.push('DATE(created_at) <= ?'); params.push(to);   }

      const [rows] = await db.execute(
        `SELECT id, type, referred_user_name, selected_plan,
                first_payment_amount, amount, created_at
           FROM referral_transactions WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC LIMIT 200`,
        params
      );

      for (const r of rows) {
        const isTaskReward = r.type === 'task_reward';
        const title = isTaskReward
          ? 'Invite 5 Users Reward'
          : `Referral Bonus — ${r.referred_user_name || 'New user'}`;
        const subtitle = isTaskReward
          ? 'Referral task completed • Added to Wallet'
          : `${r.selected_plan || '—'} • First Payment ₹${Number(r.first_payment_amount || 0).toFixed(2)}`;

        if (search && search.trim() && !subtitle.toLowerCase().includes(search.toLowerCase()) &&
            !title.toLowerCase().includes(search.toLowerCase())) continue;
        // Referral credits are only ever inserted once already-committed —
        // there is no pending/rejected state — so they only surface for an
        // unfiltered feed or an explicit status=approved filter, matching
        // the same "approved only" rule used for ROI credits above.
        if (status && status !== 'approved') continue;

        allEvents.push({
          id:        isTaskReward ? `ref_reward_${r.id}` : `ref_bonus_${r.id}`,
          type:      'referral',
          title,
          subtitle,
          amount:    Number(r.amount),
          is_credit: true,
          status:    'approved',
          date:      r.created_at,
        });
      }
    }

    // ── Sort, paginate, return ─────────────────────────────────────────────
    allEvents.sort((a, b) => new Date(b.date) - new Date(a.date));
    const total     = allEvents.length;
    const paginated = allEvents.slice(offset, offset + pageSize);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      data: paginated,
    };
  }
}

// GET /api/history — unified feed for the logged-in user.
async function getUnifiedHistory(req, res) {
  try {
    const result = await buildUnifiedHistory(req.user.sub, req.query);
    return ok(res, 'History fetched', result);
  } catch (err) {
    console.error('[history:unified]', err.message);
    return fail(res, 'Could not fetch history.', 500);
  }
}

// GET /api/history/admin/:userId — same unified feed, but for any user,
// [Admin only]. Powers the "Transactions" tab on the admin User Details page.
async function adminGetUserHistory(req, res) {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return fail(res, 'Invalid user id', 400);
  }
  try {
    const result = await buildUnifiedHistory(userId, req.query);
    return ok(res, 'History fetched', result);
  } catch (err) {
    console.error('[history:admin-unified]', err.message);
    return fail(res, 'Could not fetch history.', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getSummary,
  getUnifiedHistory,
  adminGetUserHistory,
  getDepositHistory,
  getWithdrawalHistory,
  getWalletHistory,
  getRoiHistory,
};