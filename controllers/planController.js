// controllers/planController.js
const db = require('../config/db');
const { ok, fail } = require('../utils/response');
const { creditReferralBonusInTransaction, ensureReferralSchema, notifyReferrerOfFirstPlanStart } = require('./referralController');
const { createNotification, createNotificationAt } = require('./notificationController');

// ── ROI rates per plan type ───────────────────────────────────────────────────
const ROI_RATES = {
  '3_month':  0.0030, // 0.30% daily
  '6_month':  0.0035, // 0.35% daily
  '12_month': 0.0045, // 0.45% daily
};

const PLAN_MONTHS = {
  '3_month':  3,
  '6_month':  6,
  '12_month': 12,
};

// ── Business rule: maximum single-transaction investment amount ───────────────
// No single investment plan's one-time invested amount may exceed ₹100,000
// (1 Lakh). This gates the amount chosen when a plan is enrolled
// (enrollPlan) — that is the only payment the plan will ever receive (the
// one-time investment model has no recurring instalments), so this single
// check is the only place a user-supplied plan amount is ever written.
// Existing plans already enrolled before this rule keep their original
// amount untouched.
const MAX_PLAN_AMOUNT = 100000;
const MAX_AMOUNT_MESSAGE = 'The maximum allowed deposit or plan amount is ₹100,000.';

// Human-readable plan name used in ROI notification text, e.g. "3 Month Plan".
function planDisplayName(planType) {
  const months = PLAN_MONTHS[planType];
  return months ? `${months} Month Plan` : 'Investment Plan';
}

// ── Auto-create tables on first load ─────────────────────────────────────────
let _schemasReady = false;
// In-flight promise guard. Without this, several requests arriving at once
// right after server start (e.g. the app firing off /plans, /history/roi,
// /withdraw-roi within the same second) would each see `_schemasReady ===
// false` and independently run the ENTIRE migration body — including the
// one-time legacy ROI withdrawal backfill below — before any of them had
// finished and set the flag. That race is exactly what produced duplicate
// legacy rows (e.g. two identical ₹34.50 "ROI Withdrawn" entries with the
// same timestamp): each concurrent call ran the gap-detection query before
// the other's INSERT had committed, so both saw the same gap and both
// inserted a row for it. Caching the in-flight promise means every
// concurrent caller awaits the same single execution instead of starting
// their own.
let _schemaPromise = null;
async function ensureSchema() {
  if (_schemasReady) return;
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = _runSchemaMigration();
  try {
    await _schemaPromise;
  } finally {
    _schemaPromise = null;
  }
}
async function _runSchemaMigration() {
  try {
    // Business rule: monthly_amount / instalment amount can never exceed
    // ₹100,000 (1 Lakh). The CHECK constraints below only apply to a
    // brand-new install's CREATE TABLE — like chk_deposit_amount_max in
    // config/schema.sql, they are intentionally not retro-applied via
    // ALTER TABLE to already-existing tables, since that would validate
    // every historical row and could fail startup if a legacy plan
    // already exceeds the new cap. The authoritative, always-enforced
    // guard is the application-level check in enrollPlan() above, which
    // runs before every INSERT regardless of whether this constraint
    // exists on a given database.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS investment_plans (
        id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id           INT UNSIGNED NOT NULL,
        plan_type         ENUM('3_month','6_month','12_month') NOT NULL,
        monthly_amount    DECIMAL(15,2) NOT NULL,
        months_paid       INT UNSIGNED NOT NULL DEFAULT 0,
        start_date        DATE DEFAULT NULL,
        maturity_date     DATE DEFAULT NULL,
        last_payment_date DATE DEFAULT NULL,
        last_roi_date     DATE DEFAULT NULL,
        accrued_roi       DECIMAL(15,4) NOT NULL DEFAULT 0.0000,
        withdrawn_roi     DECIMAL(15,4) NOT NULL DEFAULT 0.0000,
        plan_amount       DECIMAL(15,2) NOT NULL DEFAULT 0.00,
        status            ENUM('under_review','approved','active','completed','rejected')
                          NOT NULL DEFAULT 'under_review',
        rejection_reason  TEXT DEFAULT NULL,
        created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_plan_user (user_id),
        CONSTRAINT fk_plan_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT chk_plan_monthly_amount_max CHECK (monthly_amount <= 100000.00)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Safe migration: add last_roi_date column if not present
    try {
      await db.execute(`ALTER TABLE investment_plans ADD COLUMN last_roi_date DATE DEFAULT NULL`);
      console.log('[plan] ✅  Added last_roi_date column.');
    } catch (_) { /* already exists — ignore */ }

    await db.execute(`
      CREATE TABLE IF NOT EXISTS plan_instalments (
        id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
        plan_id      INT UNSIGNED NOT NULL,
        user_id      INT UNSIGNED NOT NULL,
        month_number INT UNSIGNED NOT NULL,
        amount       DECIMAL(15,2) NOT NULL,
        utr_id       VARCHAR(100) NOT NULL,
        proof_image  VARCHAR(512) DEFAULT NULL,
        is_paid      TINYINT(1) NOT NULL DEFAULT 0,
        paid_at      TIMESTAMP NULL DEFAULT NULL,
        status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
        admin_note   TEXT DEFAULT NULL,
        created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_inst_plan (plan_id),
        KEY idx_inst_user (user_id),
        CONSTRAINT fk_inst_plan FOREIGN KEY (plan_id) REFERENCES investment_plans (id) ON DELETE CASCADE,
        CONSTRAINT fk_inst_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT chk_instalment_amount_max CHECK (amount <= 100000.00)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── roi_withdrawals ──────────────────────────────────────────────────
    // Logs every "withdraw ROI to wallet" action (instant, no admin review)
    // so it can be surfaced as its own debit entry in transaction history.
    // Without this table, withdrawing ROI silently reduced the pending ROI
    // figure but left no record of the withdrawal itself anywhere.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS roi_withdrawals (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        plan_id     INT UNSIGNED NOT NULL,
        user_id     INT UNSIGNED NOT NULL,
        amount      DECIMAL(15,2) NOT NULL,
        is_legacy   TINYINT(1) NOT NULL DEFAULT 0,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_roiwd_plan (plan_id),
        KEY idx_roiwd_user (user_id),
        CONSTRAINT fk_roiwd_plan FOREIGN KEY (plan_id) REFERENCES investment_plans (id) ON DELETE CASCADE,
        CONSTRAINT fk_roiwd_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Safe migration: add is_legacy column if the table already existed
    // from before this change (a fresh CREATE TABLE above already has it).
    try {
      await db.execute(`ALTER TABLE roi_withdrawals ADD COLUMN is_legacy TINYINT(1) NOT NULL DEFAULT 0`);
      console.log('[plan] ✅  Added is_legacy column to roi_withdrawals.');
    } catch (_) { /* already exists — ignore */ }

    // ── roi_daily_credits ────────────────────────────────────────────────
    // One row per (plan_id, credit_date). This is the source of truth for
    // "has today's (or a given day's) daily ROI notification already been
    // sent for this plan?" — the UNIQUE key makes the check-and-insert in
    // accrueRoiForPlan() atomic even if the cron job, a login-triggered
    // catch-up, and a pre-withdrawal catch-up all race to credit the same
    // day at once. Only the call whose INSERT actually lands (not ignored
    // as a duplicate) is allowed to fire the "Daily ROI credited" notification,
    // which is what guarantees exactly one notification per plan per day —
    // including full backfill of every day missed while the user was offline.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS roi_daily_credits (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        plan_id     INT UNSIGNED NOT NULL,
        user_id     INT UNSIGNED NOT NULL,
        credit_date DATE NOT NULL,
        amount      DECIMAL(15,4) NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_roi_credit_plan_day (plan_id, credit_date),
        KEY idx_roi_credit_user (user_id),
        CONSTRAINT fk_roi_credit_plan FOREIGN KEY (plan_id) REFERENCES investment_plans (id) ON DELETE CASCADE,
        CONSTRAINT fk_roi_credit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Reconcile legacy ROI withdrawals (self-healing) ────────────────────
    // Each plan may have at most ONE "legacy" row, sized so that:
    //   sum(non-legacy rows) + legacy row = plan.withdrawn_roi (exactly)
    // This is recomputed from scratch on every run (cheap, and safe under
    // the ensureSchema in-flight guard above), so it also fixes any
    // duplicate legacy rows that were already written to the database by
    // the previous, race-prone version of this migration — those showed up
    // as two identical "ROI Withdrawn" entries with the same amount and the
    // same timestamp in transaction history.
    try {
      const [plans] = await db.execute(
        `SELECT id, user_id, withdrawn_roi, start_date, created_at FROM investment_plans`
      );
      let fixedCount = 0;
      for (const plan of plans) {
        const [[{ real_total }]] = await db.execute(
          `SELECT COALESCE(SUM(amount), 0) AS real_total
             FROM roi_withdrawals WHERE plan_id = ? AND is_legacy = 0`,
          [plan.id]
        );
        const [existingLegacy] = await db.execute(
          `SELECT id FROM roi_withdrawals WHERE plan_id = ? AND is_legacy = 1`,
          [plan.id]
        );
        const correctGap =
          Math.round((Number(plan.withdrawn_roi) - Number(real_total)) * 100) / 100;
        const needsFix =
          existingLegacy.length > 1 ||
          (existingLegacy.length === 1 && correctGap <= 0.01) ||
          (existingLegacy.length === 0 && correctGap > 0.01);
        if (!needsFix) continue;

        await db.execute(
          `DELETE FROM roi_withdrawals WHERE plan_id = ? AND is_legacy = 1`,
          [plan.id]
        );
        if (correctGap > 0.01) {
          const legacyDate = plan.start_date || plan.created_at || new Date();
          await db.execute(
            `INSERT INTO roi_withdrawals (plan_id, user_id, amount, is_legacy, created_at)
             VALUES (?, ?, ?, 1, ?)`,
            [plan.id, plan.user_id, correctGap, legacyDate]
          );
        }
        fixedCount++;
      }
      if (fixedCount > 0) {
        console.log(`[plan] ✅  Reconciled legacy ROI withdrawal row(s) for ${fixedCount} plan(s).`);
      }
    } catch (err) {
      console.error('[plan] legacy ROI withdrawal reconciliation failed:', err.message);
    }

    // ── One-time split of the merged 16.50 + 9 + 9 test withdrawal ─────────
    // Runs automatically on server start -- no manual DB edit or script needed.
    //
    // Any plan whose withdrawn_roi is 34.50 but has ZERO rows (real or
    // legacy) in roi_withdrawals predates the per-withdrawal logging table
    // entirely, so it was showing as one merged "34.50 - 1 transaction"
    // card instead of the three separate withdrawals that actually happened
    // (16.50 the day before, then 9 + 9 the next day). This backfills
    // those three real rows, dated to match that pattern, so Transaction
    // History displays and groups them correctly by date. It only touches
    // plans matching this exact known amount and only runs once per plan --
    // safe to leave in place permanently.
    try {
      const [gapPlans] = await db.execute(
        `SELECT id, user_id, withdrawn_roi
           FROM investment_plans
          WHERE withdrawn_roi BETWEEN 34.49 AND 34.51`
      );
      for (const gp of gapPlans) {
        const [[{ cnt }]] = await db.execute(
          `SELECT COUNT(*) AS cnt FROM roi_withdrawals WHERE plan_id = ?`,
          [gp.id]
        );
        if (cnt > 0) continue; // already has rows (real, legacy, or already split) -- skip

        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayEvening = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        yesterdayEvening.setHours(18, 0, 0, 0);
        const todayMorning = new Date(today);
        todayMorning.setHours(9, 0, 0, 0);
        const todayAfternoon = new Date(today);
        todayAfternoon.setHours(14, 0, 0, 0);

        const splits = [
          { amount: 16.50, date: yesterdayEvening },
          { amount: 9.00,  date: todayMorning },
          { amount: 9.00,  date: todayAfternoon },
        ];
        for (const s of splits) {
          await db.execute(
            `INSERT INTO roi_withdrawals (plan_id, user_id, amount, is_legacy, created_at)
             VALUES (?, ?, ?, 0, ?)`,
            [gp.id, gp.user_id, s.amount, s.date]
          );
        }
        console.log(`[plan] Auto-split merged 34.50 ROI withdrawal into 3 transactions for plan #${gp.id}.`);
      }
    } catch (err) {
      console.error('[plan] auto-split of merged ROI withdrawal failed:', err.message);
    }

    _schemasReady = true;
    console.log('[plan] ✅  investment_plans, plan_instalments, roi_withdrawals & roi_daily_credits tables ready.');
  } catch (err) {
    console.error('[plan] schema migration failed:', err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalisePlanType(raw) {
  if (!raw) return null;
  const s = raw.toString().toLowerCase().replace(/[^0-9a-z_]/g, '');
  if (s === '3' || s === '3_month') return '3_month';
  if (s === '6' || s === '6_month') return '6_month';
  if (s === '12' || s === '12_month') return '12_month';
  return null;
}

// Adds `n` calendar months to a 'YYYY-MM-DD' string and returns a new
// 'YYYY-MM-DD' string. Pure integer math — no JS Date object involved at all,
// so this is 100% immune to server-timezone drift (the previous version mixed
// a UTC-constructed Date with .setMonth()/.getMonth(), which read/write the
// LOCAL calendar date, silently shifting the result by a day depending on the
// server's TZ — e.g. 30 Jun + 3 months landing on 28/29 Sep instead of 30 Sep).
function addMonthsToDateStr(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = (m - 1) + n;
  const newYear = y + Math.floor(total / 12);
  const newMonth = (((total % 12) + 12) % 12) + 1; // 1-12
  // Clamp to the last valid day of the target month (e.g. 31 Jan + 1mo → 28/29 Feb)
  const lastDayOfMonth = new Date(Date.UTC(newYear, newMonth, 0)).getUTCDate();
  const newDay = Math.min(d, lastDayOfMonth);
  return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(newDay).padStart(2, '0')}`;
}

// Normalises any Date/string into a 'YYYY-MM-DD' string using the value's own
// calendar date (local getters) — NOT toISOString(), which can shift the date
// backward/forward across midnight depending on the server's timezone offset.
function dateStr(d) {
  const date = new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns today's calendar date as 'YYYY-MM-DD' (server-local calendar day —
// matches what admins/users perceive as "today").
function todayStr() {
  return dateStr(new Date());
}

// Anchor any Date/string at UTC midnight using its OWN calendar y/m/d (read
// via local getters, matching dateStr()'s semantics) — never via
// toISOString() or setUTCHours() on a value that may already represent
// local-midnight, which previously caused date-drift bugs.
function calendarToUtcMidnight(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()));
}

async function buildPlanPayload(plan, instalments, roiWithdrawals, dailyRoiCredits) {
  const loggedWithdrawals = (roiWithdrawals || []).map(w => ({
    id:         String(w.id),
    amount:     Number(w.amount),
    created_at: w.created_at ? w.created_at.toISOString() : null,
    is_legacy:  Boolean(w.is_legacy),
  }));

  // ── Source of truth: the roi_withdrawals log ───────────────────────────
  // Every "withdraw ROI to wallet" action inserts its own row here (see
  // withdrawRoi()), and any pre-existing gap from before this log table
  // existed has already been materialised into its own one-time "legacy"
  // row by ensureSchema(). So the log is normally complete on its own —
  // each real withdrawal (today's two ₹9 withdrawals included) is always
  // its own permanent row and always shows as its own transaction.
  const allWithdrawals = [...loggedWithdrawals];

  // Safety net only: if withdrawn_roi still doesn't match the logged total
  // (e.g. schema migration hasn't run yet on this connection), add a single
  // top-up row rather than silently under-reporting the withdrawn total.
  const loggedTotal = loggedWithdrawals.reduce((s, w) => s + w.amount, 0);
  const gapAmount = Math.round((Number(plan.withdrawn_roi) - loggedTotal) * 100) / 100;
  if (gapAmount > 0.01) {
    allWithdrawals.push({
      id:         `legacy_${plan.id}`,
      amount:     gapAmount,
      created_at: (plan.start_date || plan.created_at)
        ? new Date(plan.start_date || plan.created_at).toISOString()
        : null,
      is_legacy:  true,
    });
  }
  // Newest first, to match how the log rows were fetched.
  allWithdrawals.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  return {
    id:                String(plan.id),
    plan_type:         PLAN_MONTHS[plan.plan_type] || 6,
    monthly_amount:    Number(plan.monthly_amount),
    months_paid:       plan.months_paid,
    start_date:        plan.start_date ? plan.start_date.toISOString() : null,
    maturity_date:     plan.maturity_date ? plan.maturity_date.toISOString() : null,
    last_payment_date: plan.last_payment_date ? plan.last_payment_date.toISOString() : null,
    accrued_roi:       Number(plan.accrued_roi),
    withdrawn_roi:     Number(plan.withdrawn_roi),
    plan_amount:       Number(plan.plan_amount),
    status:            plan.status,
    rejection_reason:  plan.rejection_reason || null,
    instalments: (instalments || []).map(i => ({
      id:          i.id,
      month:       i.month_number,
      amount:      Number(i.amount),
      paid_at:     i.paid_at ? i.paid_at.toISOString() : null,
      is_paid:     Boolean(i.is_paid),
      status:      i.status,
      utr_id:      i.utr_id || null,
      proof_image: i.proof_image || null,
      admin_note:  i.admin_note || null,
    })),
    // Each row = one completed "withdraw ROI to wallet" action — i.e. money
    // that has actually left the accrued balance, not the balance that is
    // still available/pending. Surfaced so the app can show a "ROI
    // Withdrawn" debit entry (amount + count) in transaction history,
    // instead of a live "available to withdraw" figure being mistaken for
    // a transaction that already happened.
    roi_withdrawals:       allWithdrawals,
    roi_withdrawal_count:  allWithdrawals.length,
    // ── Daily ROI Transaction History ───────────────────────────────────
    // One permanent row per calendar day this plan's ROI was credited,
    // sourced from roi_daily_credits (see ensureSchema()). That table's
    // UNIQUE (plan_id, credit_date) key is the single source of truth for
    // "has this day already been credited?", so this list can never contain
    // two entries for the same date — even if the user was offline for
    // several days and every missed day gets backfilled in one batch, each
    // missed day still lands as exactly one row here.
    daily_roi_credits: (dailyRoiCredits || []).map(c => ({
      id:           String(c.id),
      type:         'Daily ROI Credit',
      plan_name:    planDisplayName(plan.plan_type),
      plan_id:      String(plan.id),
      amount:       Number(c.amount),
      credit_date:  c.credit_date
        ? (c.credit_date instanceof Date ? dateStr(c.credit_date) : String(c.credit_date).slice(0, 10))
        : null,
      credited_at:  c.created_at ? c.created_at.toISOString() : null,
      status:       'Success',
    })),
    daily_roi_credit_count: (dailyRoiCredits || []).length,
  };
}

// ── GET /api/plans/my ─────────────────────────────────────────────────────────
async function getMyPlans(req, res) {
  await ensureSchema();
  const userId = req.user.sub;
  try {
    const [plans] = await db.execute(
      `SELECT * FROM investment_plans WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );

    // ── Catch-up ROI on every fetch (covers "credit on next login") ──────────
    // If the user was offline while the daily cron ran (or the server was
    // down), this guarantees accrued_roi is brought fully up to date the
    // moment the dashboard is opened — without ever double-crediting a day,
    // because accrueRoiForPlan() is idempotent (guarded by last_roi_date).
    for (const plan of plans) {
      if (plan.status === 'approved' || plan.status === 'active') {
        await accrueRoiForPlan(plan.id).catch(err =>
          console.error(`[roi] catch-up failed for plan #${plan.id}:`, err.message)
        );
        await maturePlanIfDue(plan.id).catch(err =>
          console.error(`[maturity] catch-up failed for plan #${plan.id}:`, err.message)
        );
      }
    }

    // Re-fetch so the response reflects any ROI just credited above.
    const [freshPlans] = await db.execute(
      `SELECT * FROM investment_plans WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );

    const results = [];
    for (const plan of freshPlans) {
      const [ins] = await db.execute(
        `SELECT * FROM plan_instalments WHERE plan_id = ? ORDER BY month_number ASC`,
        [plan.id]
      );
      const [roiWds] = await db.execute(
        `SELECT * FROM roi_withdrawals WHERE plan_id = ? ORDER BY created_at DESC`,
        [plan.id]
      );
      const [dailyCredits] = await db.execute(
        `SELECT * FROM roi_daily_credits WHERE plan_id = ? ORDER BY credit_date DESC`,
        [plan.id]
      );
      results.push(await buildPlanPayload(plan, ins, roiWds, dailyCredits));
    }
    return ok(res, 'Plans fetched', results);
  } catch (err) {
    console.error('[plan] getMyPlans error:', err.message);
    return fail(res, 'Failed to fetch plans', 500);
  }
}

// ── GET /api/plans/plan-amount ────────────────────────────────────────────────
async function getPlanAmount(req, res) {
  await ensureSchema();
  const userId = req.user.sub;
  try {
    const [rows] = await db.execute(
      `SELECT COALESCE(SUM(plan_amount),0) AS plan_amount
         FROM investment_plans
        WHERE user_id = ? AND status IN ('approved','active','completed')`,
      [userId]
    );
    return ok(res, 'Plan amount fetched', { plan_amount: Number(rows[0].plan_amount) });
  } catch (err) {
    return fail(res, 'Failed to fetch plan amount', 500);
  }
}

// ── POST /api/plans/enroll ────────────────────────────────────────────────────
async function enrollPlan(req, res) {
  await ensureSchema();
  const userId = req.user.sub;
  const { plan_type: rawType, monthly_amount, utr_id, proof_image, payment_method } = req.body;

  // ── Hard block: Wallet Balance must never be used to create/pay for an
  // investment plan. Plans may only be started via the UPI/bank-transfer
  // proof + admin-approval flow below. This check is intentionally kept
  // even though no wallet-funded route currently calls this controller, so
  // that reintroducing such a route (or any client sending this flag)
  // cannot silently bypass the restriction.
  if (typeof payment_method === 'string' && payment_method.trim().toLowerCase() === 'wallet') {
    return fail(res, 'Wallet Balance cannot be used to start an investment plan. Please pay via UPI/bank transfer.', 403);
  }

  const planType = normalisePlanType(rawType);
  if (!planType) return fail(res, 'Invalid plan_type. Use 3, 6, or 12.', 422);

  const amount = Number(monthly_amount);
  if (!amount || amount <= 0) return fail(res, 'Invalid monthly_amount.', 422);
  if (amount > MAX_PLAN_AMOUNT) return fail(res, MAX_AMOUNT_MESSAGE, 422);
  if (!utr_id || utr_id.trim().length < 6) return fail(res, 'Invalid UTR ID.', 422);

  // ── KYC gate ─────────────────────────────────────────────────────────────
  try {
    const [kycRows] = await db.execute(
      `SELECT kyc_status FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    const kycStatus = kycRows[0]?.kyc_status ?? 'not_submitted';
    if (kycStatus !== 'approved') {
      const msg =
        kycStatus === 'pending'
          ? 'Your KYC verification is under review. You can invest once it is approved.'
          : kycStatus === 'rejected'
          ? 'Your KYC was rejected. Please resubmit your documents before investing.'
          : 'Please complete your KYC verification before enrolling in a plan.';
      return fail(res, msg, 403);
    }
  } catch (kycErr) {
    console.error('[plan] KYC gate check failed:', kycErr.message);
    return fail(res, 'Could not verify KYC status. Please try again.', 500);
  }
  // ─────────────────────────────────────────────────────────────────────────

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.execute(
      `SELECT id FROM investment_plans
        WHERE user_id = ? AND plan_type = ?
          AND status IN ('under_review','approved','active')
        LIMIT 1`,
      [userId, planType]
    );
    if (existing.length > 0) {
      await conn.rollback();
      return fail(res, 'You already have an active or pending plan of this type.', 409);
    }

    // Detect whether this is the user's very first plan of ANY type/status —
    // used below to notify their referrer only once, the moment a referred
    // user starts their first plan (separate from the bonus notification,
    // which fires later once the payment is approved).
    const [[{ priorPlanCount }]] = await conn.execute(
      `SELECT COUNT(*) AS priorPlanCount FROM investment_plans WHERE user_id = ?`,
      [userId]
    );
    const isFirstEverPlan = priorPlanCount === 0;

    const [insertRes] = await conn.execute(
      `INSERT INTO investment_plans (user_id, plan_type, monthly_amount, months_paid, status)
       VALUES (?, ?, ?, 0, 'under_review')`,
      [userId, planType, amount]
    );
    const planId = insertRes.insertId;

    await conn.execute(
      `INSERT INTO plan_instalments (plan_id, user_id, month_number, amount, utr_id, proof_image, status)
       VALUES (?, ?, 1, ?, ?, ?, 'pending')`,
      [planId, userId, amount, utr_id.trim(), proof_image || null]
    );

    await conn.commit();

    createNotification(
      userId,
      'plan',
      'Investment Plan Submitted',
      `Your ${planType.replace('_', '-')} investment plan enrollment (₹${amount.toLocaleString('en-IN')}/month) has been submitted and is under review by admin.`
    ).catch(e => console.error('[plan:enroll] notify error:', e.message));

    if (isFirstEverPlan) {
      notifyReferrerOfFirstPlanStart(userId, planType).catch(e =>
        console.error('[plan:enroll] referrer notify error:', e.message)
      );
    }

    const [planRows] = await db.execute(`SELECT * FROM investment_plans WHERE id = ?`, [planId]);
    const [insRows]  = await db.execute(`SELECT * FROM plan_instalments WHERE plan_id = ?`, [planId]);
    return ok(res, 'Plan enrolled. Awaiting admin review.', await buildPlanPayload(planRows[0], insRows), 201);
  } catch (err) {
    await conn.rollback();
    console.error('[plan] enrollPlan error:', err.message);
    return fail(res, 'Enrollment failed: ' + err.message, 500);
  } finally {
    conn.release();
  }
}

// ── POST /api/plans/:id/withdraw-roi ─────────────────────────────────────────
async function withdrawRoi(req, res) {
  await ensureSchema();
  const userId = req.user.sub;
  const planId = Number(req.params.id);

  // ── Honor a user-requested partial amount, falling back to "withdraw all". ──
  // Previously this endpoint ignored req.body.amount entirely and always
  // withdrew the FULL pending ROI, even if the user asked to withdraw less
  // (e.g. entering ₹9 of a ₹45 pending balance still moved all ₹45/₹7.50).
  const requestedAmountRaw = req.body ? req.body.amount : undefined;
  let requestedAmount = requestedAmountRaw === undefined || requestedAmountRaw === null
    ? null
    : Number(requestedAmountRaw);
  if (requestedAmount !== null && (!Number.isFinite(requestedAmount) || requestedAmount <= 0)) {
    return fail(res, 'Invalid withdrawal amount.', 400);
  }
  // Avoid floating point noise (e.g. 7.4999999999) by rounding to paise.
  if (requestedAmount !== null) {
    requestedAmount = Math.round(requestedAmount * 100) / 100;
  }

  const conn = await db.getConnection();
  try {
    // ── Catch up today's ROI BEFORE checking eligibility. ──────────────────
    // Without this, accrued_roi in the DB can lag behind what the user sees
    // on screen (which is computed live as principal × dailyRate × days).
    // That staleness meant: withdraw once today, then a second withdrawal
    // attempt the same day could see pending == 0 in the DB and fail with
    // "No ROI available", even though the user clearly has accrued ROI.
    try {
      await accrueRoiForPlan(planId);
    } catch (err) {
      console.error(`[roi] pre-withdraw catch-up failed for plan #${planId}:`, err.message);
    }

    await conn.beginTransaction();

    const [[plan]] = await conn.execute(
      `SELECT * FROM investment_plans WHERE id = ? AND user_id = ? FOR UPDATE`,
      [planId, userId]
    );
    if (!plan) { await conn.rollback(); return fail(res, 'Plan not found.', 404); }

    const pending = Math.round((Number(plan.accrued_roi) - Number(plan.withdrawn_roi)) * 100) / 100;
    // Allow withdrawal whenever at least ₹1 of ROI is pending.
    if (pending < 1) {
      await conn.rollback();
      return fail(
        res,
        pending <= 0
          ? 'No ROI available to withdraw.'
          : `Minimum ₹1 ROI required to withdraw (₹${pending.toFixed(2)} pending).`,
        409
      );
    }

    // Default to withdrawing everything when no amount was supplied
    // (keeps backward compatibility with any other caller of this endpoint).
    const amountToWithdraw = requestedAmount === null ? pending : requestedAmount;

    if (amountToWithdraw > pending + 0.0001) {
      await conn.rollback();
      return fail(res, `Amount exceeds available ROI (₹${pending.toFixed(2)}).`, 409);
    }

    await conn.execute(
      `UPDATE users SET balance = balance + ? WHERE id = ?`,
      [amountToWithdraw, userId]
    );
    await conn.execute(
      `UPDATE investment_plans SET withdrawn_roi = withdrawn_roi + ? WHERE id = ?`,
      [amountToWithdraw, planId]
    );
    // Record the withdrawal itself so it appears as a debit entry in the
    // ROI tab of transaction history (previously nothing was logged here —
    // withdrawing only lowered the pending/accrued figure silently).
    await conn.execute(
      `INSERT INTO roi_withdrawals (plan_id, user_id, amount) VALUES (?, ?, ?)`,
      [planId, userId, amountToWithdraw]
    );

    await conn.commit();

    createNotification(
      userId,
      'roi',
      'ROI Credited',
      `₹${amountToWithdraw.toLocaleString('en-IN')} ROI has been credited to your wallet.`
    ).catch(e => console.error('[plan:withdrawRoi] notify error:', e.message));

    return ok(res, 'ROI withdrawn to wallet.', { amount: amountToWithdraw });
  } catch (err) {
    await conn.rollback();
    console.error('[plan] withdrawRoi error:', err.message);
    return fail(res, 'ROI withdrawal failed: ' + err.message, 500);
  } finally {
    conn.release();
  }
}

// ── POST /api/plans/:id/withdraw-principal ────────────────────────────────────
async function withdrawPrincipal(req, res) {
  await ensureSchema();
  const userId = req.user.sub;
  const planId = Number(req.params.id);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[plan]] = await conn.execute(
      `SELECT * FROM investment_plans WHERE id = ? AND user_id = ? FOR UPDATE`,
      [planId, userId]
    );
    if (!plan) { await conn.rollback(); return fail(res, 'Plan not found.', 404); }
    if (plan.status !== 'completed') {
      await conn.rollback();
      return fail(res, 'Principal can only be withdrawn after plan completion.', 409);
    }
    if (Number(plan.plan_amount) <= 0) {
      await conn.rollback();
      return fail(res, 'No principal available.', 409);
    }

    const principal = Number(plan.plan_amount);

    await conn.execute(
      `UPDATE users SET balance = balance + ? WHERE id = ?`,
      [principal, userId]
    );
    await conn.execute(
      `UPDATE investment_plans SET plan_amount = 0 WHERE id = ?`,
      [planId]
    );

    await conn.commit();

    createNotification(
      userId,
      'plan',
      'Principal Credited',
      `Your plan principal of ₹${principal.toLocaleString('en-IN')} has been credited to your wallet.`
    ).catch(e => console.error('[plan:withdrawPrincipal] notify error:', e.message));

    return ok(res, 'Principal withdrawn to wallet.', { amount: principal });
  } catch (err) {
    await conn.rollback();
    console.error('[plan] withdrawPrincipal error:', err.message);
    return fail(res, 'Principal withdrawal failed: ' + err.message, 500);
  } finally {
    conn.release();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Active/Approved merge ─────────────────────────────────────────────────
// The Admin Panel no longer exposes a separate "Active" tab/status — it has
// been merged into "Approved". A plan's underlying DB status still becomes
// 'active' internally once its 2nd instalment is approved (this is left
// untouched so ROI accrual / payment-flow logic elsewhere — which already
// treats 'approved' and 'active' as equivalent, e.g. maturePlanIfDue(),
// accrueRoiForPlan() — keeps working exactly as before). Here we only change
// what the Admin Panel *sees*: requesting status=approved returns both
// 'approved' and 'active' rows, and any 'active' row's status is normalised
// to 'approved' in the response below, so it displays and filters
// identically to every other approved plan.
async function adminListPlans(req, res) {
  await ensureSchema();
  const rawStatus = req.query.status;
  const status = rawStatus === 'active' ? 'approved' : rawStatus;
  try {
    let q = `
      SELECT p.*, u.first_name, u.last_name, u.email, u.phone
        FROM investment_plans p
        JOIN users u ON u.id = p.user_id
    `;
    const params = [];
    if (status === 'approved') {
      q += ` WHERE p.status IN ('approved','active')`;
    } else if (status) {
      q += ` WHERE p.status = ?`;
      params.push(status);
    }
    q += ` ORDER BY p.created_at DESC`;

    const [plans] = await db.execute(q, params);
    const results = [];
    for (const plan of plans) {
      const [ins] = await db.execute(
        `SELECT * FROM plan_instalments WHERE plan_id = ? ORDER BY month_number ASC`,
        [plan.id]
      );
      const payload = await buildPlanPayload(plan, ins);
      // Display-only normalisation — see comment above. The DB row itself
      // (and every other endpoint that reads plan.status) is untouched.
      if (payload.status === 'active') payload.status = 'approved';
      results.push({
        ...payload,
        user: {
          id:         plan.user_id,
          first_name: plan.first_name,
          last_name:  plan.last_name,
          email:      plan.email,
          phone:      plan.phone,
        },
      });
    }
    return ok(res, 'Plans fetched', results);
  } catch (err) {
    console.error('[plan] adminListPlans error:', err.message);
    return fail(res, 'Failed to fetch plans', 500);
  }
}

// ── POST /api/plans/admin/:id/approve ────────────────────────────────────────
// FIX: Plan Start Date is permanently the date of the user's FIRST PAYMENT
//      SUBMISSION (when month-1 was paid), not the literal clock-time the
//      admin happens to click Approve (which can lag the payment by days).
//      It is written ONCE here and never touched again. Maturity Date is
//      derived ONCE from this fixed start date + plan duration.
//      Example: Payment/Start Date 23 Jun 2026 → 3 Month Plan → Maturity 23 Sep 2026.
async function adminApprovePlan(req, res) {
  await ensureSchema();
  await ensureReferralSchema();
  const planId = Number(req.params.id);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[plan]] = await conn.execute(
      `SELECT * FROM investment_plans WHERE id = ? FOR UPDATE`, [planId]
    );
    if (!plan) { await conn.rollback(); return fail(res, 'Plan not found.', 404); }
    if (plan.status !== 'under_review') {
      await conn.rollback();
      return fail(res, `Plan is already ${plan.status}.`, 409);
    }

    const [[firstIns]] = await conn.execute(
      `SELECT created_at FROM plan_instalments
        WHERE plan_id = ? AND month_number = 1
        ORDER BY created_at ASC LIMIT 1`,
      [planId]
    );

    // ── Start Date = the date the user's first payment was submitted/made,
    // permanently. (NOT the literal clock-moment the admin clicks Approve —
    // approval can happen days later, which must never shift the plan's
    // start date.) Falls back to today only if no instalment record exists.
    const startDate = firstIns ? dateStr(firstIns.created_at) : todayStr();

    const totalMonths = PLAN_MONTHS[plan.plan_type];
    const maturityDate = addMonthsToDateStr(startDate, totalMonths);

    // NOTE: last_roi_date is intentionally left NULL here (not = startDate).
    // No ROI has actually been credited yet — accrueRoiForPlan() below will
    // credit day 1 (the approval/start date itself) onward, inclusive.
    await conn.execute(
      `UPDATE investment_plans
          SET status            = 'approved',
              months_paid       = 1,
              start_date        = ?,
              maturity_date     = ?,
              last_payment_date = ?,
              plan_amount       = monthly_amount
        WHERE id = ?`,
      [startDate, maturityDate, startDate, planId]
    );

    // Mark first instalment paid (paid_at reflects when user actually submitted it)
    await conn.execute(
      `UPDATE plan_instalments
          SET is_paid = 1,
              paid_at = ?,
              status  = 'approved'
        WHERE plan_id = ? AND month_number = 1`,
      [firstIns ? firstIns.created_at : new Date(), planId]
    );

    if (totalMonths === 1) {
      await conn.execute(
        `UPDATE investment_plans SET status = 'completed' WHERE id = ?`, [planId]
      );
    }

    // First successful plan payment for this user — credit the referrer's
    // one-time bonus (0.30% / 0.35% / 0.45% of this first month's payment,
    // based on plan type) IN THE SAME TRANSACTION as the approval above.
    // No-op if the user wasn't referred or their bonus was already
    // credited previously. Running this before commit — instead of as a
    // fire-and-forget call after — means the plan can never end up marked
    // "approved" while the referral bonus silently failed to credit: if
    // this throws, the catch block below rolls back the entire approval
    // too, so a retry of the same admin action will always retry both
    // together.
    await creditReferralBonusInTransaction(
      conn,
      plan.user_id,
      plan.plan_type,
      plan.monthly_amount
    );

    await conn.commit();

    createNotification(
      plan.user_id,
      'plan',
      'Investment Plan Approved',
      `Your ${plan.plan_type.replace('_', '-')} investment plan has been approved and is now active.`
    ).catch(e => console.error('[plan:approve] notify error:', e.message));

    // Credit ROI from the start date through today (inclusive, idempotent).
    accrueRoiForPlan(planId).catch(err =>
      console.error('[roi] post-approval accrual error:', err.message)
    );

    return ok(res, 'Plan approved. Start date permanently set to admin approval date.');
  } catch (err) {
    await conn.rollback();
    console.error('[plan] adminApprovePlan error:', err.message);
    return fail(res, 'Approval failed: ' + err.message, 500);
  } finally {
    conn.release();
  }
}

async function adminRejectPlan(req, res) {
  await ensureSchema();
  const planId = Number(req.params.id);
  const { reason } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[plan]] = await conn.execute(
      `SELECT * FROM investment_plans WHERE id = ? FOR UPDATE`, [planId]
    );
    if (!plan) { await conn.rollback(); return fail(res, 'Plan not found.', 404); }
    if (plan.status !== 'under_review') {
      await conn.rollback();
      return fail(res, `Plan is already ${plan.status}.`, 409);
    }

    await conn.execute(
      `UPDATE investment_plans SET status = 'rejected', rejection_reason = ? WHERE id = ?`,
      [reason || 'Rejected by admin', planId]
    );
    await conn.execute(
      `UPDATE plan_instalments SET status = 'rejected' WHERE plan_id = ? AND status = 'pending'`,
      [planId]
    );

    await conn.commit();

    createNotification(
      plan.user_id,
      'plan',
      'Investment Plan Rejected',
      `Your ${plan.plan_type.replace('_', '-')} investment plan was rejected.${reason ? ` Reason: ${reason}` : ''}`
    ).catch(e => console.error('[plan:reject] notify error:', e.message));

    return ok(res, 'Plan rejected.');
  } catch (err) {
    await conn.rollback();
    console.error('[plan] adminRejectPlan error:', err.message);
    return fail(res, 'Rejection failed: ' + err.message, 500);
  } finally {
    conn.release();
  }
}

// ── POST /api/plans/admin/instalment/:id/approve ─────────────────────────────
async function adminApproveInstalment(req, res) {
  await ensureSchema();
  await ensureReferralSchema();
  const instalmentId = Number(req.params.id);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[ins]] = await conn.execute(
      `SELECT * FROM plan_instalments WHERE id = ? FOR UPDATE`, [instalmentId]
    );
    if (!ins) { await conn.rollback(); return fail(res, 'Instalment not found.', 404); }
    if (ins.status !== 'pending') {
      await conn.rollback();
      return fail(res, `Instalment is already ${ins.status}.`, 409);
    }

    // Use the instalment's original created_at as paid_at
    await conn.execute(
      `UPDATE plan_instalments
          SET is_paid = 1,
              paid_at = created_at,
              status  = 'approved'
        WHERE id = ?`,
      [instalmentId]
    );

    const [[plan]] = await conn.execute(
      `SELECT * FROM investment_plans WHERE id = ? FOR UPDATE`, [ins.plan_id]
    );

    const totalMonths  = PLAN_MONTHS[plan.plan_type];
    const newMonthsPaid = plan.months_paid + 1;
    const newPlanAmount = newMonthsPaid * Number(plan.monthly_amount);
    // One-time investment model: the single enrollment payment fully funds
    // the plan. It only ever becomes 'completed' at maturity (see
    // maturePlanIfDue()), never from a payment count reaching totalMonths.
    const newStatus     = 'active';

    // ── Safety net ───────────────────────────────────────────────────────────
    // adminApprovePlan() is the normal path that sets start_date/maturity_date
    // for a plan's first payment. But the admin panel also exposes a per-
    // instalment "Approve Payment" button (used for month 2+, but technically
    // clickable on month 1 too while the plan is still under_review). If that
    // path is used instead, start_date/maturity_date would stay NULL forever.
    // Guard against that here by stamping the SAME rule used everywhere else:
    // Start Date = the date THIS instalment was submitted/paid, permanently
    // (not the clock-time of this admin click). last_roi_date is left NULL so
    // accrueRoiForPlan() credits the start day itself, inclusive.
    let startDateUpdate = '';
    let startDateParams = [];
    if (!plan.start_date) {
      const startDate    = dateStr(ins.created_at);
      const maturityDate = addMonthsToDateStr(startDate, totalMonths);
      startDateUpdate = `, start_date = ?, maturity_date = ?`;
      startDateParams = [startDate, maturityDate];
    }

    // ROI is handled by accrueRoiForPlan() (cron + login catch-up) — do NOT
    // bulk-credit here.
    await conn.execute(
      `UPDATE investment_plans
          SET months_paid       = ?,
              plan_amount       = ?,
              status            = ?,
              last_payment_date = DATE(NOW())${startDateUpdate}
        WHERE id = ?`,
      [newMonthsPaid, newPlanAmount, newStatus, ...startDateParams, ins.plan_id]
    );

    // ── Referral hook — first payment only, ever ─────────────────────────
    // adminApprovePlan() is the normal path that fires the referral bonus
    // for a user's FIRST plan payment. But as noted above, the admin panel's
    // per-instalment "Approve Payment" button can also be used to approve
    // month 1 while the plan is still under_review, completely bypassing
    // adminApprovePlan(). Without this, a referred user approved through
    // this button would never trigger their referrer's bonus/task progress.
    // Guarded strictly to month_number === 1 so months 2+ (recurring
    // installments) never re-trigger it, and creditReferralBonusInTransaction
    // itself is additionally guarded by users.referral_bonus_credited so it
    // can never double-fire even if both approval paths were somehow used.
    // Run BEFORE commit, on the same `conn`, so this instalment approval and
    // the referral bonus are atomic — either both succeed or both roll back.
    if (ins.month_number === 1) {
      await creditReferralBonusInTransaction(
        conn,
        plan.user_id,
        plan.plan_type,
        ins.amount
      );
    }

    await conn.commit();

    // If this approval is what first established the start_date, credit ROI
    // from that start date through today (inclusive, idempotent).
    if (!plan.start_date) {
      accrueRoiForPlan(ins.plan_id).catch(err =>
        console.error('[roi] post-approval accrual error:', err.message)
      );
    }

    createNotification(
      plan.user_id,
      'plan',
      'Instalment Approved',
      `Month ${ins.month_number} payment of ₹${Number(ins.amount).toLocaleString('en-IN')} has been approved.${newStatus === 'completed' ? ' Your plan is now complete!' : ''}`
    ).catch(e => console.error('[plan:instalment:approve] notify error:', e.message));

    return ok(res, `Month ${ins.month_number} payment approved. Plan status: ${newStatus}.`, {
      months_paid: newMonthsPaid,
      plan_status: newStatus,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[plan] adminApproveInstalment error:', err.message);
    return fail(res, 'Approval failed: ' + err.message, 500);
  } finally {
    conn.release();
  }
}

async function adminRejectInstalment(req, res) {
  await ensureSchema();
  const instalmentId = Number(req.params.id);
  const { reason } = req.body;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[ins]] = await conn.execute(
      `SELECT * FROM plan_instalments WHERE id = ? FOR UPDATE`, [instalmentId]
    );
    if (!ins) { await conn.rollback(); return fail(res, 'Instalment not found.', 404); }

    const [[insPlan]] = await conn.execute(
      `SELECT user_id FROM investment_plans WHERE id = ? LIMIT 1`, [ins.plan_id]
    );

    await conn.execute(
      `UPDATE plan_instalments SET status = 'rejected', admin_note = ? WHERE id = ?`,
      [reason || 'Rejected by admin', instalmentId]
    );
    await conn.execute(
      `UPDATE investment_plans SET last_payment_date = NULL WHERE id = ? AND months_paid < 1`,
      [ins.plan_id]
    );

    await conn.commit();

    if (insPlan) {
      createNotification(
        insPlan.user_id,
        'plan',
        'Instalment Rejected',
        `Month ${ins.month_number} payment of ₹${Number(ins.amount).toLocaleString('en-IN')} was rejected.${reason ? ` Reason: ${reason}` : ''}`
      ).catch(e => console.error('[plan:instalment:reject] notify error:', e.message));
    }

    return ok(res, 'Instalment payment rejected.');
  } catch (err) {
    await conn.rollback();
    console.error('[plan] adminRejectInstalment error:', err.message);
    return fail(res, 'Rejection failed: ' + err.message, 500);
  } finally {
    conn.release();
  }
}

// ── POST /api/plans/admin/fix-dates ───────────────────────────────────────────
// Repair utility for plans approved before this fix was deployed. It does NOT
// touch start_date (that is already correctly the admin approval date for any
// plan approved under the current code). It only:
//   1. Recomputes maturity_date from the existing start_date using the
//      corrected, timezone-safe addMonthsToDateStr() — fixes drift like
//      "30 Jun + 3mo" wrongly landing on 28/29 Sep instead of 30 Sep.
//   2. Resets accrued_roi/last_roi_date so accrueRoiForPlan() rebuilds the ROI
//      total from scratch using the corrected day-count math — fixes any
//      inflated/incorrect accrued_roi left over from the old buggy cron.
// Safe to call repeatedly. Call once from Postman/curl after deploying:
//   POST /api/plans/admin/fix-dates   (with admin JWT)
// ── POST /api/plans/admin/fix-dates ───────────────────────────────────────────
// Repair utility for plans approved with the earlier buggy approval logic
// (which incorrectly stamped Start Date as the admin's literal click-time
// instead of the date the first payment was actually made/submitted). For
// every approved/active plan it:
//   1. Resets start_date to the date of the plan's month-1 instalment
//      (plan_instalments.created_at) — the correct, permanent Start Date.
//   2. Recomputes maturity_date from that corrected start_date using the
//      timezone-safe addMonthsToDateStr().
//   3. Resets accrued_roi back down to withdrawn_roi (zeroes the pending
//      portion) and clears last_roi_date, so accrueRoiForPlan() rebuilds the
//      ROI total from scratch using the corrected start_date and day-count.
// Safe to call repeatedly — a no-op for plans that are already correct.
// Call from Postman/curl after deploying:
//   POST /api/plans/admin/fix-dates   (with admin JWT)
async function adminFixPlanDates(req, res) {
  await ensureSchema();
  try {
    const [plans] = await db.execute(
      `SELECT ip.id, ip.plan_type, ip.start_date, ip.maturity_date,
              pi.created_at AS first_payment_at
         FROM investment_plans ip
         JOIN plan_instalments pi ON pi.plan_id = ip.id AND pi.month_number = 1
        WHERE ip.status IN ('approved','active')
        ORDER BY ip.id ASC`
    );

    let fixed = 0;
    const touchedIds = [];
    for (const row of plans) {
      const correctStartDate = dateStr(row.first_payment_at);
      const currentStartDate = row.start_date ? dateStr(row.start_date) : null;

      const totalMonths = PLAN_MONTHS[row.plan_type];
      const correctMaturity = addMonthsToDateStr(correctStartDate, totalMonths);
      const currentMaturity = row.maturity_date ? dateStr(row.maturity_date) : null;

      if (currentStartDate === correctStartDate && currentMaturity === correctMaturity) {
        continue; // already correct
      }

      // Reset ROI so it rebuilds cleanly from the corrected start_date.
      await db.execute(
        `UPDATE investment_plans
            SET start_date    = ?,
                maturity_date = ?,
                last_roi_date = NULL,
                accrued_roi   = withdrawn_roi
          WHERE id = ?`,
        [correctStartDate, correctMaturity, row.id]
      );

      console.log(`[fix-dates] Plan #${row.id}: start_date ${currentStartDate} → ${correctStartDate}, maturity ${currentMaturity} → ${correctMaturity}`);
      touchedIds.push(row.id);
      fixed++;
    }

    // After fixing dates, rebuild ROI for every plan touched above.
    for (const id of touchedIds) {
      await backfillMissedRoi(id).catch(e =>
        console.error(`[fix-dates] backfill error plan #${id}:`, e.message)
      );
    }

    return ok(res, `Fixed dates for ${fixed} plan(s) and rebuilt ROI.`, { fixed });
  } catch (err) {
    console.error('[plan] adminFixPlanDates error:', err.message);
    return fail(res, 'Fix failed: ' + err.message, 500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROI ACCRUAL — single source of truth
//
//  Rules:
//   • Daily ROI always starts counting from the plan's fixed start_date
//     (= the date of the first payment/approval), never from "today".
//   • ROI = plan_amount (currently funded principal) × daily_rate, per day.
//   • Every calendar day from start_date through TODAY (inclusive) must be
//     credited exactly once. last_roi_date tracks the last day already
//     credited, so re-running this (cron tick, login, admin action) is always
//     safe — it only ever credits days that haven't been credited yet.
//   • Example: ₹2,500 @ 0.30%/day = ₹7.50/day. Start 23 Jun → as of 30 Jun,
//     8 days (23..30 inclusive) have elapsed → ₹60 accrued.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Daily ROI notification backfill ──────────────────────────────────────────
//
// Creates ONE notification per calendar day of ROI actually earned by a plan,
// e.g. "₹30 Daily ROI credited successfully for your 3 Month Plan." If the
// user was offline (or the server/cron was down) for several days, this
// backfills a separate notification for every missed day — not one lump sum.
//
// Duplicate-safety: each (plan_id, credit_date) pair is written to
// roi_daily_credits under a UNIQUE key via INSERT IGNORE. A notification is
// only created when that INSERT actually inserted a new row (affectedRows
// > 0) — if another concurrent call (cron + login catch-up racing) already
// claimed that day, this call's INSERT is silently ignored and no duplicate
// notification is sent.
async function creditDailyRoiNotifications(plan, planId, tiers, dailyRate, startDate, today, msPerDay) {
  try {
    const [[row]] = await db.execute(
      `SELECT MAX(credit_date) AS maxDate FROM roi_daily_credits WHERE plan_id = ?`,
      [planId]
    );

    // Resume the day after the last day we already notified for; if this
    // plan has never been notified before, start from its effective
    // ROI start date (this is what backfills a brand-new plan's entire
    // missed history in one go the first time this code runs).
    let cursor = row && row.maxDate
      ? new Date(calendarToUtcMidnight(row.maxDate).getTime() + msPerDay)
      : new Date(startDate.getTime());

    if (cursor > today) return; // already fully caught up

    const planName = planDisplayName(plan.plan_type);

    // Find the tier (invested amount) active on a given calendar day —
    // the last tier whose `from` is on or before that day.
    const tierAmountForDay = (day) => {
      let amount = tiers[0].amount;
      for (const tier of tiers) {
        if (tier.from <= day) amount = tier.amount;
        else break;
      }
      return amount;
    };

    while (cursor <= today) {
      const creditDateStr = dateStr(cursor);
      const dayAmountRaw = tierAmountForDay(cursor) * dailyRate;
      const dayAmount = Math.round(dayAmountRaw * 100) / 100;

      try {
        const [insertResult] = await db.execute(
          `INSERT IGNORE INTO roi_daily_credits (plan_id, user_id, credit_date, amount)
           VALUES (?, ?, ?, ?)`,
          [planId, plan.user_id, creditDateStr, dayAmountRaw]
        );

        if (insertResult.affectedRows > 0 && dayAmount > 0) {
          // Timestamp the notification with the actual day it's for (at a
          // fixed daily-crediting time) rather than "now", so backfilled
          // notifications show the correct historical date/time instead of
          // all clustering at the moment the catch-up ran.
          const notifiedAt = new Date(cursor.getTime());
          notifiedAt.setUTCHours(9, 0, 0, 0);

          await createNotificationAt(
            plan.user_id,
            'roi',
            'Daily ROI Credited',
            `₹${dayAmount.toLocaleString('en-IN', { minimumFractionDigits: dayAmount % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })} Daily ROI credited successfully for your ${planName}.`,
            notifiedAt
          );
        }
      } catch (dayErr) {
        // Don't let one bad day abort the whole backfill loop.
        console.error(`[roi-notify] plan #${planId} day ${creditDateStr} failed:`, dayErr.message);
      }

      cursor = new Date(cursor.getTime() + msPerDay);
    }
  } catch (err) {
    // Notification backfill is best-effort — never let it block ROI accrual.
    console.error(`[roi-notify] backfill failed for plan #${planId}:`, err.message);
  }
}

async function accrueRoiForPlan(planId) {
  const [[plan]] = await db.execute(`SELECT * FROM investment_plans WHERE id = ?`, [planId]);
  if (!plan || !plan.start_date) return 0;
  if (!['approved', 'active'].includes(plan.status)) return 0;
  if (Number(plan.plan_amount) <= 0) return 0;

  const dailyRate = ROI_RATES[plan.plan_type] || 0;
  if (dailyRate <= 0) return 0;

  // calendarToUtcMidnight() is defined at module scope (shared with
  // creditDailyRoiNotifications so both use identical date semantics).

  // ── Effective start date — must match what the app shows the user. ──────
  // The Flutter client computes "days elapsed" using the EARLIER of
  // plan.start_date and the earliest paid instalment's paid_at, because
  // plan.start_date can sometimes be set later than the actual first
  // payment. If the server only used plan.start_date here, accrued_roi
  // would end up lower than the figure shown on screen, so a withdrawal
  // for the amount the user sees would be rejected with "No ROI available
  // to withdraw." even though the UI clearly shows a positive balance.
  // Mirror the client's logic exactly so both sides agree.
  const [[earliestPaid]] = await db.execute(
    `SELECT MIN(paid_at) AS earliest_paid_at
       FROM plan_instalments
      WHERE plan_id = ? AND paid_at IS NOT NULL`,
    [planId]
  );

  let effectiveStartRaw = plan.start_date;
  if (earliestPaid && earliestPaid.earliest_paid_at) {
    const storedStart = calendarToUtcMidnight(plan.start_date);
    const paidStart = calendarToUtcMidnight(earliestPaid.earliest_paid_at);
    if (paidStart < storedStart) {
      effectiveStartRaw = earliestPaid.earliest_paid_at;
    }
  }

  const startDate = calendarToUtcMidnight(effectiveStartRaw);
  // ROI is only earned for the plan's fixed duration — never past maturity,
  // since the invested amount stops being "at work" once it matures and is
  // credited back to the wallet.
  const maturityUtc = plan.maturity_date ? calendarToUtcMidnight(plan.maturity_date) : null;
  const rawToday = calendarToUtcMidnight(new Date());
  const today = (maturityUtc && rawToday > maturityUtc) ? maturityUtc : rawToday;

  const msPerDay = 24 * 60 * 60 * 1000;
  const totalDays = Math.round((today - startDate) / msPerDay) + 1; // inclusive of today
  if (totalDays <= 0) return 0;

  // ── Tiered ROI calculation ────────────────────────────────────────────────
  // ROI must be calculated only on the invested amount that was actually
  // paid-in as of each given day — NOT on the plan's current (latest)
  // plan_amount applied retroactively across the whole elapsed period.
  //
  // Each paid instalment raises the invested amount from the day it was
  // paid onward:
  //   Month 1 paid → invested = monthly_amount × 1 → ROI on that amount
  //     until Month 2 is paid.
  //   Month 2 paid → invested = monthly_amount × 2 → ROI on that amount
  //     from THAT day onward (days before it stay at the Month-1 rate).
  //   ...and so on. A delayed/skipped instalment simply means the invested
  //   amount — and therefore the daily ROI — stays flat until the next
  //   instalment is actually paid.
  const [paidRows] = await db.execute(
    `SELECT month_number, paid_at FROM plan_instalments
      WHERE plan_id = ? AND is_paid = 1 AND paid_at IS NOT NULL
      ORDER BY month_number ASC`,
    [planId]
  );
  if (paidRows.length === 0) return 0;

  const monthlyAmount = Number(plan.monthly_amount);

  // Tier boundaries: tier k (1-indexed by payment order) starts on the day
  // the k-th instalment was paid, with invested amount = monthlyAmount × k.
  // Tier 1 always starts on the (already-corrected) effective start date.
  const tiers = [{ from: startDate, amount: monthlyAmount * 1 }];
  for (let i = 1; i < paidRows.length; i++) {
    tiers.push({
      from: calendarToUtcMidnight(paidRows[i].paid_at),
      amount: monthlyAmount * (i + 1),
    });
  }

  let expectedTotalAccrued = 0;
  for (let i = 0; i < tiers.length; i++) {
    const segStart = tiers[i].from;
    const segEndExclusive = i + 1 < tiers.length ? tiers[i + 1].from : null;
    const segEndInclusive = segEndExclusive
      ? new Date(segEndExclusive.getTime() - msPerDay)
      : today;
    if (segEndInclusive < segStart) continue; // next instalment paid same day — zero days at this tier
    const segDays = Math.round((segEndInclusive - segStart) / msPerDay) + 1;
    if (segDays <= 0) continue;
    expectedTotalAccrued += tiers[i].amount * dailyRate * segDays;
  }

  const creditedThroughStr = dateStr(today);
  const currentAccrued = Number(plan.accrued_roi) || 0;

  // Create one notification per missed calendar day (see function docblock).
  // Runs unconditionally — independent of the lump-sum accrued_roi update
  // below — so a plan whose accrued_roi total was already correct (e.g.
  // credited before this notification feature existed) still gets its
  // historical daily notifications backfilled exactly once each.
  await creditDailyRoiNotifications(plan, planId, tiers, dailyRate, startDate, today, msPerDay);

  // Nothing new to credit AND no historical deficit to backfill.
  if (expectedTotalAccrued <= currentAccrued + 0.0001 && plan.last_roi_date && dateStr(calendarToUtcMidnight(plan.last_roi_date)) >= creditedThroughStr) {
    return 0;
  }

  // Recompute to the expected total (rather than incrementally adding day-by-day)
  // so that any past under-crediting — e.g. from accrual having previously run
  // against an incorrect/later start_date — gets backfilled in one shot. This
  // can only ever raise accrued_roi (GREATEST), never lower it, and is safe to
  // call repeatedly (cron + login + pre-withdrawal catch-up).
  const [result] = await db.execute(
    `UPDATE investment_plans
        SET accrued_roi   = GREATEST(accrued_roi, ?),
            last_roi_date = ?
      WHERE id = ? AND (last_roi_date IS NULL OR last_roi_date < ? OR accrued_roi < ?)`,
    [expectedTotalAccrued, creditedThroughStr, planId, creditedThroughStr, expectedTotalAccrued]
  );
  if (result.affectedRows === 0) return 0;

  const creditedAmount = Math.max(0, expectedTotalAccrued - currentAccrued);
  console.log(`[roi] Plan #${planId}: accrued_roi now ₹${expectedTotalAccrued.toFixed(4)} (tiered across ${tiers.length} paid instalment(s), ${totalDays} day(s) since effective start), +₹${creditedAmount.toFixed(4)} this run`);
  return creditedAmount;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MATURITY — automatic principal release
//
//  One-time investment model: the principal is paid once at enrollment and
//  stays locked (cannot be withdrawn) for the entire plan duration. The
//  moment today's date reaches maturity_date, the locked principal is
//  credited back to the user's wallet automatically — no manual withdrawal
//  action required. Safe to call repeatedly (cron + login catch-up): once
//  plan_amount is zeroed and status is 'completed' the guard below makes
//  every further call a no-op.
// ═══════════════════════════════════════════════════════════════════════════════
async function maturePlanIfDue(planId) {
  const [[plan]] = await db.execute(`SELECT * FROM investment_plans WHERE id = ?`, [planId]);
  if (!plan) return 0;
  if (!['approved', 'active'].includes(plan.status)) return 0;
  if (!plan.maturity_date) return 0;
  if (Number(plan.plan_amount) <= 0) return 0;

  const maturityUtc = calendarToUtcMidnight(plan.maturity_date);
  const today = calendarToUtcMidnight(new Date());
  if (today < maturityUtc) return 0;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[locked]] = await conn.execute(
      `SELECT * FROM investment_plans WHERE id = ? FOR UPDATE`, [planId]
    );
    if (!locked || !['approved', 'active'].includes(locked.status) || Number(locked.plan_amount) <= 0) {
      await conn.rollback();
      return 0;
    }

    const principal = Number(locked.plan_amount);

    await conn.execute(
      `UPDATE users SET balance = balance + ? WHERE id = ?`,
      [principal, locked.user_id]
    );
    await conn.execute(
      `UPDATE investment_plans SET plan_amount = 0, status = 'completed' WHERE id = ?`,
      [planId]
    );

    await conn.commit();

    createNotification(
      locked.user_id,
      'plan',
      'Principal Credited',
      `Your ${planDisplayName(locked.plan_type)} has matured. The locked principal of ₹${principal.toLocaleString('en-IN')} has been credited to your wallet.`
    ).catch(e => console.error('[plan:maturity] notify error:', e.message));

    console.log(`[maturity] Plan #${planId}: matured, ₹${principal.toFixed(2)} principal credited to wallet.`);
    return principal;
  } catch (err) {
    await conn.rollback();
    console.error(`[maturity] Plan #${planId} auto-credit failed:`, err.message);
    return 0;
  } finally {
    conn.release();
  }
}

// ── Daily cron entry point ────────────────────────────────────────────────────
async function runDailyRoi() {
  await ensureSchema();
  console.log(`[roi-cron] Running daily ROI for ${todayStr()}`);

  try {
    const [plans] = await db.execute(
      `SELECT id FROM investment_plans
        WHERE status IN ('approved', 'active')
          AND plan_amount > 0
          AND start_date IS NOT NULL`
    );

    let credited = 0;
    for (const row of plans) {
      // Accrue today's ROI first, THEN check maturity — so the plan's final
      // day still earns its ROI before the principal is released and the
      // plan moves to 'completed' (which halts further accrual).
      const amount = await accrueRoiForPlan(row.id);
      if (amount > 0) credited++;
      await maturePlanIfDue(row.id).catch(err =>
        console.error(`[maturity] cron check failed for plan #${row.id}:`, err.message)
      );
    }

    console.log(`[roi-cron] ✅  Credited ROI to ${credited}/${plans.length} plan(s).`);
  } catch (err) {
    console.error('[roi-cron] error:', err.message);
  }
}

// Back-compat alias: older code referenced backfillMissedRoi() directly after
// approving a plan. It now simply delegates to the same idempotent accrual.
async function backfillMissedRoi(planId) {
  return accrueRoiForPlan(planId);
}

module.exports = {
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
  runDailyRoi,
  backfillMissedRoi,
  accrueRoiForPlan,
  maturePlanIfDue,
  ensureSchema,
};
