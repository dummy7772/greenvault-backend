// controllers/dashboardController.js
//
// Backend for the Admin Panel's Dashboard page (Dashboard.jsx). Replaces
// src/data/dashboardMockData.js on the frontend with one real, aggregated
// endpoint:
//
//   GET /api/dashboard/summary   [Admin only]
//
// No new tables are created — every figure here is computed from tables
// that already exist (users, deposits, withdrawals, investment_plans,
// kyc_submissions, support_tickets, referral_transactions, roi_daily_credits).
// This mirrors the read patterns already used in adminUsersController,
// depositController, withdrawalController, kycController, planController,
// supportController and referralController — just aggregated into the
// shapes the dashboard widgets need instead of paginated row lists.

const db = require('../config/db');
const { ok, fail } = require('../utils/response');
const { ensureReferralSchema } = require('./referralController');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safely run a query, returning `fallback` if the underlying table isn't
 * ready yet (e.g. a fresh install where a lazily-created table hasn't been
 * touched by its owning controller yet). Keeps one slow/missing table from
 * breaking the whole dashboard. */
async function safeQuery(sql, params, fallback) {
  try {
    const [rows] = await db.query(sql, params || []);
    return rows;
  } catch (err) {
    console.error('[dashboard] query failed:', err.message);
    return fallback;
  }
}

async function scalar(sql, params, key = 'v') {
  const rows = await safeQuery(sql, params, [{ [key]: 0 }]);
  const v = rows[0] ? rows[0][key] : 0;
  return Number(v) || 0;
}

/** % change helper for KPI trend chips. */
function pctDelta(current, previous) {
  current = Number(current) || 0;
  previous = Number(previous) || 0;
  if (previous <= 0) {
    if (current <= 0) return { delta: '0.0%', trend: 'flat' };
    return { delta: '+100.0%', trend: 'up' };
  }
  const change = ((current - previous) / previous) * 100;
  const rounded = Math.round(change * 10) / 10;
  const sign = rounded >= 0 ? '+' : '';
  return { delta: `${sign}${rounded.toFixed(1)}%`, trend: rounded >= 0 ? 'up' : 'down' };
}

function planLabel(planType) {
  const map = { '3_month': '3-Month Plan', '6_month': '6-Month Plan', '12_month': '12-Month Plan' };
  return map[planType] || planType;
}

function fullName(first, last) {
  return `${first || ''} ${last || ''}`.trim() || 'User';
}

/** Formats a Date/ISO-string into a compact "Xm ago" / "Xh ago" / "Xd ago" label. */
function timeAgo(date) {
  if (!date) return '';
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function inr(n) {
  return `₹${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// ── GET /api/dashboard/summary ────────────────────────────────────────────────
async function getDashboardSummary(_req, res) {
  try {
    await ensureReferralSchema().catch(() => {});

    // ── KPI row ────────────────────────────────────────────────────────────
    const [
      totalUsers, usersBaseline, newUsersToday,
      depositsThisMonth, depositsPrevMonth,
      activePlans, activePlansBaseline,
      pendingWithdrawals, newPendingWd24h, resolvedWd24h,
      roiThisMonth, roiPrevMonth,
      openTickets, ticketsThisWeek, ticketsPrevWeek,
      pendingKyc, pendingDeposits,
    ] = await Promise.all([
      scalar(`SELECT COUNT(*) v FROM users WHERE role='user'`),
      scalar(`SELECT COUNT(*) v FROM users WHERE role='user' AND created_at <= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
      scalar(`SELECT COUNT(*) v FROM users WHERE role='user' AND DATE(created_at) = CURDATE()`),
      scalar(`SELECT COALESCE(SUM(amount),0) v FROM deposits WHERE order_status='approved' AND DATE_FORMAT(created_at,'%Y-%m') = DATE_FORMAT(NOW(),'%Y-%m')`),
      scalar(`SELECT COALESCE(SUM(amount),0) v FROM deposits WHERE order_status='approved' AND DATE_FORMAT(created_at,'%Y-%m') = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH),'%Y-%m')`),
      // 'active' is a plan that has simply had its 2nd+ instalment approved —
      // the Admin Panel no longer treats it as a separate status from
      // 'approved' (the two are merged/displayed as one "Approved" bucket
      // throughout the panel), so both are counted together here too.
      scalar(`SELECT COUNT(*) v FROM investment_plans WHERE status IN ('approved','active')`),
      scalar(`SELECT COUNT(*) v FROM investment_plans WHERE status IN ('approved','active') AND created_at <= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
      scalar(`SELECT COUNT(*) v FROM withdrawals WHERE status='pending'`),
      scalar(`SELECT COUNT(*) v FROM withdrawals WHERE status='pending' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`),
      scalar(`SELECT COUNT(*) v FROM withdrawals WHERE status IN ('approved','rejected') AND reviewed_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`),
      scalar(`SELECT COALESCE(SUM(amount),0) v FROM roi_daily_credits WHERE DATE_FORMAT(credit_date,'%Y-%m') = DATE_FORMAT(NOW(),'%Y-%m')`),
      scalar(`SELECT COALESCE(SUM(amount),0) v FROM roi_daily_credits WHERE DATE_FORMAT(credit_date,'%Y-%m') = DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH),'%Y-%m')`),
      scalar(`SELECT COUNT(*) v FROM support_tickets WHERE status IN ('open','in_progress')`),
      scalar(`SELECT COUNT(*) v FROM support_tickets WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`),
      scalar(`SELECT COUNT(*) v FROM support_tickets WHERE created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`),
      scalar(`SELECT COUNT(*) v FROM kyc_submissions WHERE status='pending'`),
      scalar(`SELECT COUNT(*) v FROM deposits WHERE order_status='pending'`),
    ]);

    const usersDelta = pctDelta(totalUsers, usersBaseline);
    const depositsDelta = pctDelta(depositsThisMonth, depositsPrevMonth);
    const activePlansDelta = pctDelta(activePlans, activePlansBaseline);
    const roiDelta = pctDelta(roiThisMonth, roiPrevMonth);
    const ticketsDelta = pctDelta(ticketsThisWeek, ticketsPrevWeek);

    const wdNet = newPendingWd24h - resolvedWd24h;
    const withdrawalsDelta = {
      delta: `${wdNet >= 0 ? '+' : ''}${wdNet} since yesterday`,
      trend: wdNet <= 0 ? 'down' : 'up',
    };

    const kpiStats = [
      {
        id: 'users', label: 'Total Users', value: totalUsers.toLocaleString('en-IN'),
        delta: usersDelta.delta, trend: usersDelta.trend, tone: 'blu', icon: 'users',
      },
      {
        id: 'deposits', label: 'Deposits (This Month)', value: inr(depositsThisMonth),
        delta: depositsDelta.delta, trend: depositsDelta.trend, tone: 'em', icon: 'wallet',
      },
      {
        id: 'active-plans', label: 'Approved Investment Plans', value: activePlans.toLocaleString('en-IN'),
        delta: activePlansDelta.delta, trend: activePlansDelta.trend, tone: 'vio', icon: 'trend',
      },
      {
        id: 'pending-withdrawals', label: 'Pending Withdrawals', value: pendingWithdrawals.toLocaleString('en-IN'),
        delta: withdrawalsDelta.delta, trend: withdrawalsDelta.trend, tone: 'amb', icon: 'arrow-down-left',
      },
      {
        id: 'roi-payout', label: 'ROI Payout (This Month)', value: inr(roiThisMonth),
        delta: roiDelta.delta, trend: roiDelta.trend, tone: 'gold', icon: 'banknote',
      },
      {
        id: 'support-tickets', label: 'Open Support Tickets', value: openTickets.toLocaleString('en-IN'),
        delta: ticketsDelta.delta, trend: 'up-is-bad-down-is-good', tone: 'red', icon: 'headset',
      },
    ];

    // ── Deposits vs Withdrawals — last 14 days (raw ₹ amounts) ──────────────
    const [depRows, wdRows] = await Promise.all([
      safeQuery(
        `SELECT DATE(created_at) d, SUM(amount) s FROM deposits
          WHERE order_status='approved' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
          GROUP BY DATE(created_at)`, [], []
      ),
      safeQuery(
        `SELECT DATE(created_at) d, SUM(amount) s FROM withdrawals
          WHERE status='approved' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
          GROUP BY DATE(created_at)`, [], []
      ),
    ]);
    // ── ROOT CAUSE of the chart showing no data ──────────────────────────────
    // `DATE(created_at) AS d` above comes back from mysql2 as a JS Date
    // object (this pool never sets `dateStrings`), not a plain string. The
    // previous code did `String(r.d)`, which calls Date.prototype.toString()
    // and produces something like "Sat Jul 11 2026 00:00:00 GMT+0000 ..." —
    // that NEVER matches a "YYYY-MM-DD" key, so depByDay/wdByDay lookups
    // below always missed and every bucket silently fell back to 0, no
    // matter how much real approved deposit/withdrawal data existed. Using
    // .toISOString().slice(0,10) turns it into the same "YYYY-MM-DD" shape
    // used for the day-bucket keys further down, so real rows actually match.
    // (The pooled connection's session time_zone is pinned to UTC in
    // config/db.js, so this stays consistent with the UTC day math below —
    // the same convention already used for dates in planController.js.)
    function dbDateKey(d) {
      if (!d) return null;
      const dt = d instanceof Date ? d : new Date(d);
      return dt.toISOString().slice(0, 10);
    }
    const depByDay = {};
    depRows.forEach((r) => { depByDay[dbDateKey(r.d)] = Number(r.s) || 0; });
    const wdByDay = {};
    wdRows.forEach((r) => { wdByDay[dbDateKey(r.d)] = Number(r.s) || 0; });

    const now = new Date();
    const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const msPerDay = 24 * 60 * 60 * 1000;

    // Real amounts here are typically small (test/early-stage transactions,
    // often well under ₹1,000). The previous version divided every value by
    // 1000 and rounded to a whole number, which silently floors anything
    // under ₹500 to 0 — so the chart could show a flat, empty line even
    // though real approved deposits/withdrawals existed in the window. Send
    // the true rupee amounts instead and let the frontend format them, so
    // the chart always reflects the real numbers regardless of scale.
    const revenueTrend = [];
    for (let i = 13; i >= 0; i--) {
      const dayDate = new Date(todayUtcMidnight - i * msPerDay);
      const key = dayDate.toISOString().slice(0, 10);
      const label = dayDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });
      revenueTrend.push({
        date: label,
        deposits: depByDay[key] || 0,
        withdrawals: wdByDay[key] || 0,
      });
    }

    // ── Plan distribution (by approved subscribers — 'active' merged in) ────
    const planDistRows = await safeQuery(
      `SELECT plan_type, COUNT(*) c FROM investment_plans WHERE status IN ('approved','active') GROUP BY plan_type`, [], []
    );
    const PLAN_COLORS = { '3_month': 'var(--blue-400)', '6_month': 'var(--em-600)', '12_month': 'var(--gold-400)' };
    const planDistribution = planDistRows.map((r) => ({
      label: planLabel(r.plan_type),
      value: Number(r.c) || 0,
      color: PLAN_COLORS[r.plan_type] || 'var(--blue-400)',
    }));

    // ── Top performing plans (approved + completed — 'active' merged in) ────
    const topPlanRows = await safeQuery(
      `SELECT plan_type, COUNT(*) subscribers, COALESCE(SUM(plan_amount),0) aum
         FROM investment_plans WHERE status IN ('approved','active','completed') GROUP BY plan_type`, [], []
    );
    const PLAN_ROI_LABEL = { '3_month': '0.30%/day', '6_month': '0.35%/day', '12_month': '0.45%/day' };
    const totalAumForShare = topPlanRows.reduce((sum, r) => sum + (Number(r.aum) || 0), 0);
    const topPlans = topPlanRows
      .map((r, i) => {
        const aumNum = Number(r.aum) || 0;
        return {
          id: i + 1,
          name: planLabel(r.plan_type),
          subscribers: Number(r.subscribers) || 0,
          aum: inr(aumNum),
          avgRoi: PLAN_ROI_LABEL[r.plan_type] || '—',
          share: totalAumForShare > 0 ? Math.round((aumNum / totalAumForShare) * 100) : 0,
        };
      })
      .sort((a, b) => b.subscribers - a.subscribers);

    // ── Recent activity feed (unified, last 8 events) ────────────────────────
    const [
      depActivity, kycActivity, wdActivity, userActivity,
      planActivity, supportActivity, referralActivity, roiActivity,
    ] = await Promise.all([
      safeQuery(
        `SELECT d.id, d.amount, COALESCE(d.reviewed_at, d.created_at) AS ts, u.first_name, u.last_name
           FROM deposits d JOIN users u ON u.id = d.user_id
          WHERE d.order_status='approved' ORDER BY ts DESC LIMIT 5`, [], []
      ),
      safeQuery(
        `SELECT k.id, k.created_at AS ts, u.first_name, u.last_name
           FROM kyc_submissions k JOIN users u ON u.id = k.user_id
          ORDER BY ts DESC LIMIT 5`, [], []
      ),
      safeQuery(
        `SELECT w.id, w.amount, w.created_at AS ts, u.first_name, u.last_name
           FROM withdrawals w JOIN users u ON u.id = w.user_id
          ORDER BY ts DESC LIMIT 5`, [], []
      ),
      safeQuery(
        `SELECT id, created_at AS ts, first_name, last_name
           FROM users WHERE role='user' ORDER BY ts DESC LIMIT 5`, [], []
      ),
      safeQuery(
        `SELECT p.id, p.plan_amount, p.plan_type, p.created_at AS ts, u.first_name, u.last_name
           FROM investment_plans p JOIN users u ON u.id = p.user_id
          WHERE p.status IN ('approved','active','completed') ORDER BY ts DESC LIMIT 5`, [], []
      ),
      safeQuery(
        `SELECT t.id, t.created_at AS ts, u.first_name, u.last_name
           FROM support_tickets t JOIN users u ON u.id = t.user_id
          ORDER BY ts DESC LIMIT 5`, [], []
      ),
      safeQuery(
        `SELECT rt.id, rt.amount, rt.created_at AS ts, u.first_name, u.last_name
           FROM referral_transactions rt JOIN users u ON u.id = rt.referrer_id
          ORDER BY ts DESC LIMIT 5`, [], []
      ),
      safeQuery(
        `SELECT rc.id, rc.amount, rc.created_at AS ts, u.first_name, u.last_name
           FROM roi_daily_credits rc JOIN users u ON u.id = rc.user_id
          ORDER BY ts DESC LIMIT 5`, [], []
      ),
    ]);

    const activityEvents = [
      ...depActivity.map((r) => ({
        id: `dep-${r.id}`, type: 'deposit', tone: 'em', ts: r.ts,
        message: 'Deposit approved for', user: fullName(r.first_name, r.last_name), amount: inr(r.amount),
      })),
      ...kycActivity.map((r) => ({
        id: `kyc-${r.id}`, type: 'kyc', tone: 'blu', ts: r.ts,
        message: 'New KYC submitted by', user: fullName(r.first_name, r.last_name), amount: null,
      })),
      ...wdActivity.map((r) => ({
        id: `wd-${r.id}`, type: 'withdrawal', tone: 'amb', ts: r.ts,
        message: 'Withdrawal requested by', user: fullName(r.first_name, r.last_name), amount: inr(r.amount),
      })),
      ...userActivity.map((r) => ({
        id: `user-${r.id}`, type: 'user', tone: 'vio', ts: r.ts,
        message: 'New user registered:', user: fullName(r.first_name, r.last_name), amount: null,
      })),
      ...planActivity.map((r) => ({
        id: `plan-${r.id}`, type: 'plan', tone: 'em', ts: r.ts,
        message: `${planLabel(r.plan_type)} enrolled by`, user: fullName(r.first_name, r.last_name), amount: inr(r.plan_amount),
      })),
      ...supportActivity.map((r) => ({
        id: `sup-${r.id}`, type: 'support', tone: 'red', ts: r.ts,
        message: 'Support ticket raised by', user: fullName(r.first_name, r.last_name), amount: null,
      })),
      ...referralActivity.map((r) => ({
        id: `ref-${r.id}`, type: 'referral', tone: 'gold', ts: r.ts,
        message: 'Referral bonus claimed by', user: fullName(r.first_name, r.last_name), amount: inr(r.amount),
      })),
      ...roiActivity.map((r) => ({
        id: `roi-${r.id}`, type: 'roi', tone: 'em', ts: r.ts,
        message: 'Daily ROI credited to', user: fullName(r.first_name, r.last_name), amount: inr(r.amount),
      })),
    ]
      .filter((e) => e.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 8)
      .map((e) => ({ ...e, time: timeAgo(e.ts) }));

    // ── Notifications panel (derived from real pending/recent items) ────────
    const [latestPendingWd, latestPendingDep, latestOpenTicket, latestReferral] = await Promise.all([
      safeQuery(
        `SELECT w.amount, w.created_at, u.first_name, u.last_name
           FROM withdrawals w JOIN users u ON u.id = w.user_id
          WHERE w.status='pending' ORDER BY w.created_at DESC LIMIT 1`, [], []
      ),
      safeQuery(
        `SELECT d.created_at, u.first_name, u.last_name
           FROM deposits d JOIN users u ON u.id = d.user_id
          WHERE d.order_status='pending' ORDER BY d.created_at DESC LIMIT 1`, [], []
      ),
      safeQuery(
        `SELECT t.id, t.subject, t.created_at FROM support_tickets t
          WHERE t.status='open' ORDER BY t.created_at DESC LIMIT 1`, [], []
      ),
      safeQuery(
        `SELECT rt.amount, rt.created_at, u.first_name, u.last_name
           FROM referral_transactions rt JOIN users u ON u.id = rt.referrer_id
          ORDER BY rt.created_at DESC LIMIT 1`, [], []
      ),
    ]);

    const notifications = [];
    let notifId = 1;
    if (pendingKyc > 0) {
      notifications.push({
        id: notifId++, title: 'KYC pending review',
        message: `${pendingKyc} submission${pendingKyc === 1 ? '' : 's'} waiting for approval`,
        time: timeAgo(new Date()), tone: 'blu', read: false,
      });
    }
    if (latestPendingWd[0]) {
      const w = latestPendingWd[0];
      notifications.push({
        id: notifId++, title: 'Withdrawal awaiting approval',
        message: `${fullName(w.first_name, w.last_name)} requested ${inr(w.amount)}`,
        time: timeAgo(w.created_at), tone: 'amb', read: false,
      });
    }
    if (latestOpenTicket[0]) {
      const t = latestOpenTicket[0];
      notifications.push({
        id: notifId++, title: 'Support ticket open',
        message: `Ticket #${t.id}: ${t.subject}`,
        time: timeAgo(t.created_at), tone: 'red', read: false,
      });
    }
    if (latestPendingDep[0]) {
      const d = latestPendingDep[0];
      notifications.push({
        id: notifId++, title: 'Deposit proof uploaded',
        message: `${fullName(d.first_name, d.last_name)} submitted a payment screenshot`,
        time: timeAgo(d.created_at), tone: 'em', read: true,
      });
    }
    if (latestReferral[0]) {
      const r = latestReferral[0];
      notifications.push({
        id: notifId++, title: 'Referral bonus credited',
        message: `${fullName(r.first_name, r.last_name)} earned ${inr(r.amount)} in referral bonus`,
        time: timeAgo(r.created_at), tone: 'gold', read: true,
      });
    }

    // ── Quick actions (route to existing pages — sub counts are real) ───────
    const quickActions = [
      { id: 'kyc', label: 'Review KYC', sub: `${pendingKyc} pending`, to: '/kyc', icon: 'file-check', tone: 'blu' },
      { id: 'deposit', label: 'Approve Deposits', sub: `${pendingDeposits} pending`, to: '/deposit', icon: 'wallet', tone: 'em' },
      { id: 'withdrawal', label: 'Process Withdrawals', sub: `${pendingWithdrawals} pending`, to: '/withdrawal', icon: 'arrow-down-left', tone: 'amb' },
      { id: 'plan', label: 'Manage Plans', sub: `${activePlans} approved`, to: '/plan', icon: 'trend', tone: 'vio' },
      { id: 'support', label: 'Support Tickets', sub: `${openTickets} open`, to: '/support', icon: 'headset', tone: 'red' },
      { id: 'users', label: 'View Users', sub: `${totalUsers.toLocaleString('en-IN')} total`, to: '/users', icon: 'users', tone: 'gold' },
    ];

    // ── Summary strip ─────────────────────────────────────────────────────
    const totalAum = await scalar(
      `SELECT COALESCE(SUM(plan_amount),0) v FROM investment_plans WHERE status IN ('approved','active','completed')`
    );
    const dashboardSummary = {
      greetingSub: "Here's what's happening across Moneytries today.",
      totalAum: inr(totalAum),
      newUsersToday,
      pendingReviews: pendingWithdrawals + pendingKyc + pendingDeposits,
    };

    return ok(res, 'Dashboard data fetched', {
      kpiStats,
      revenueTrend,
      planDistribution,
      recentActivity: activityEvents,
      notifications,
      quickActions,
      topPlans,
      dashboardSummary,
    });
  } catch (err) {
    console.error('[dashboard:summary]', err);
    return fail(res, 'Could not fetch dashboard data', 500);
  }
}

module.exports = { getDashboardSummary };