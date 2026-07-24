// scripts/backfill_roi_withdrawals.js
//
// ── ONE-TIME REPAIR SCRIPT ───────────────────────────────────────────────────
// Fixes plans whose ROI withdrawal history was collapsed into a single
// "legacy" placeholder row because the individual withdrawals happened
// before per-transaction ROI logging existed. This does NOT change any
// balances — it only splits the existing legacy total into real,
// separately-dated rows so Transaction History displays them correctly
// (grouped by date, one card per withdrawal).
//
// Going forward, every new "Withdraw to Wallet" click already inserts its
// own row automatically (see withdrawRoi() in controllers/planController.js)
// — this script is only needed for OLD data that predates that fix.
//
// HOW TO USE
// ──────────
// 1. Edit the ENTRIES array below:
//      - planId: the investment_plans.id whose history needs splitting
//                (find it via: SELECT id, user_id, withdrawn_roi FROM investment_plans;)
//      - entries: the real withdrawals, in the order they actually happened,
//                 each with its real amount and real date/time.
//    The amounts in `entries` MUST sum to the plan's current withdrawn_roi
//    value — the script checks this and refuses to run if they don't match,
//    so it can never accidentally change how much money the user has
//    withdrawn.
//
// 2. Run once from the backend folder:
//      node scripts/backfill_roi_withdrawals.js
//
// 3. Restart the backend server afterwards (so any in-memory caches refresh).
//
// It is safe to re-run: if the plan already has real (non-legacy) rows
// summing to the target total, the script skips it instead of duplicating.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('../config/db');

// ── EDIT THIS SECTION ────────────────────────────────────────────────────────
const ENTRIES = [
  {
    planId: 1, // <-- replace with the real plan id
    entries: [
      { amount: 16.50, date: '2026-06-24 18:00:00' }, // "yesterday"
      { amount: 9.00,  date: '2026-06-25 09:00:00' }, // "today" #1
      { amount: 9.00,  date: '2026-06-25 14:00:00' }, // "today" #2
    ],
  },
];
// ──────────────────────────────────────────────────────────────────────────────

async function run() {
  for (const { planId, entries } of ENTRIES) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      const [[plan]] = await conn.execute(
        `SELECT id, user_id, withdrawn_roi FROM investment_plans WHERE id = ? FOR UPDATE`,
        [planId]
      );
      if (!plan) {
        console.error(`[skip] Plan #${planId} not found.`);
        await conn.rollback();
        continue;
      }

      const [realRows] = await conn.execute(
        `SELECT id, amount FROM roi_withdrawals WHERE plan_id = ? AND is_legacy = 0`,
        [planId]
      );
      const realTotal = realRows.reduce((s, r) => s + Number(r.amount), 0);
      const entriesTotal = entries.reduce((s, e) => s + Number(e.amount), 0);
      const planTotal = Number(plan.withdrawn_roi);

      const round2 = n => Math.round(n * 100) / 100;

      if (round2(realTotal) >= round2(planTotal) - 0.01) {
        console.log(
          `[skip] Plan #${planId} already has real withdrawal rows summing to ₹${realTotal.toFixed(2)} ` +
          `(withdrawn_roi = ₹${planTotal.toFixed(2)}). Nothing to backfill.`
        );
        await conn.rollback();
        continue;
      }

      if (round2(entriesTotal) !== round2(planTotal)) {
        console.error(
          `[abort] Plan #${planId}: entries sum to ₹${entriesTotal.toFixed(2)} but ` +
          `withdrawn_roi is ₹${planTotal.toFixed(2)}. Fix the ENTRIES array so they match exactly ` +
          `— refusing to run to avoid corrupting the withdrawn total.`
        );
        await conn.rollback();
        continue;
      }

      // Remove the single consolidated legacy placeholder row(s) for this plan.
      await conn.execute(
        `DELETE FROM roi_withdrawals WHERE plan_id = ? AND is_legacy = 1`,
        [planId]
      );

      // Insert the real, individually-dated rows.
      for (const e of entries) {
        await conn.execute(
          `INSERT INTO roi_withdrawals (plan_id, user_id, amount, is_legacy, created_at)
           VALUES (?, ?, ?, 0, ?)`,
          [planId, plan.user_id, e.amount, e.date]
        );
      }

      await conn.commit();
      console.log(
        `[done] Plan #${planId}: split ₹${planTotal.toFixed(2)} into ${entries.length} separate transactions.`
      );
    } catch (err) {
      await conn.rollback();
      console.error(`[error] Plan #${planId}:`, err.message);
    } finally {
      conn.release();
    }
  }

  process.exit(0);
}

run().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});