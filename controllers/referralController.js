// controllers/referralController.js
const db = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');
const { assignReferralCode } = require('../utils/referralCode');

// ── Invite-5 task target & one-time reward amount ─────────────────────────────
const TASK_TARGET  = 5;
const TASK_REWARD  = 500.00;

// ── Referral bonus rate per plan type — applied to the FIRST month's
//    payment only, credited once per referred user. ─────────────────────────
const REFERRAL_BONUS_RATES = {
  '3_month':  0.0030, // 0.30%
  '6_month':  0.0035, // 0.35%
  '12_month': 0.0045, // 0.45%
};

const PLAN_LABELS = {
  '3_month':  '3 Month Plan',
  '6_month':  '6 Month Plan',
  '12_month': '12 Month Plan',
};

// Reverse lookup — turns the stored label ("3 Month Plan") back into the
// short code the "Referral Candidates" tab displays (e.g. "3M").
const PLAN_LABEL_TO_SHORT_CODE = {
  '3 Month Plan':  '3M',
  '6 Month Plan':  '6M',
  '12 Month Plan': '12M',
};

function planLabelToShortCode(label) {
  if (!label) return null;
  if (PLAN_LABEL_TO_SHORT_CODE[label]) return PLAN_LABEL_TO_SHORT_CODE[label];
  // Fallback for any future/unexpected label format — pull the leading
  // number out of the string, e.g. "9 Month Plan" -> "9M".
  const match = String(label).match(/(\d+)/);
  return match ? `${match[1]}M` : label;
}

// Turns the raw investment_plans.plan_type enum value ("3_month") into the
// short code the "Referral Candidates" tab displays ("3M").
const PLAN_TYPE_TO_SHORT_CODE = {
  '3_month':  '3M',
  '6_month':  '6M',
  '12_month': '12M',
};

function planTypeToShortCode(planType) {
  if (!planType) return null;
  if (PLAN_TYPE_TO_SHORT_CODE[planType]) return PLAN_TYPE_TO_SHORT_CODE[planType];
  const match = String(planType).match(/(\d+)/);
  return match ? `${match[1]}M` : planType;
}


// ── One-time migration: ensure referral columns + table exist ────────────────
let _schemasReady = false;
let _schemaPromise = null;

async function ensureReferralSchema() {
  if (_schemasReady) return;
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = _runSchemaMigration();
  try {
    await _schemaPromise;
    _schemasReady = true;
  } finally {
    _schemaPromise = null;
  }
}

async function _runSchemaMigration() {
  try {
    const userColumnChecks = [
      {
        col: 'my_referral_code',
        sql: `ALTER TABLE users ADD COLUMN my_referral_code VARCHAR(20) DEFAULT NULL`,
      },
      {
        // Total users who signed up using this user's referral code.
        col: 'referral_count',
        sql: `ALTER TABLE users ADD COLUMN referral_count INT UNSIGNED NOT NULL DEFAULT 0`,
      },
      {
        // How many of those referred users have activated a plan
        // (first payment approved). Drives the 0/5 ... 5/5 task bar.
        col: 'referral_task_progress',
        sql: `ALTER TABLE users ADD COLUMN referral_task_progress INT UNSIGNED NOT NULL DEFAULT 0`,
      },
      {
        // Guards the ₹500 "Invite 5 Users" reward so it can only be
        // claimed once.
        col: 'referral_reward_claimed',
        sql: `ALTER TABLE users ADD COLUMN referral_reward_claimed TINYINT(1) NOT NULL DEFAULT 0`,
      },
      {
        // Guards the per-referred-user bonus so a user's first plan
        // payment can only ever credit their referrer once — even if
        // they later start additional plans of other durations.
        col: 'referral_bonus_credited',
        sql: `ALTER TABLE users ADD COLUMN referral_bonus_credited TINYINT(1) NOT NULL DEFAULT 0`,
      },
    ];

    for (const { col, sql } of userColumnChecks) {
      const [rows] = await db.execute(
        `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = 'users'
            AND COLUMN_NAME  = ?
          LIMIT 1`,
        [col]
      );
      if (rows.length === 0) {
        await db.execute(sql);
        console.log(`[referral] ✅ added users.${col}`);
      }
    }

    // ── referral_transactions ────────────────────────────────────────────
    // One row per credited event — either a per-referred-user bonus or the
    // one-time ₹500 task reward. Powers the "Referral" tab in Transaction
    // History with the exact fields the app needs (referred user, plan,
    // first payment, bonus, date/time).
    await db.execute(`
      CREATE TABLE IF NOT EXISTS referral_transactions (
        id                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
        referrer_id           INT UNSIGNED NOT NULL,
        referred_user_id      INT UNSIGNED DEFAULT NULL,
        type                  ENUM('referral_bonus','task_reward') NOT NULL,
        referred_user_name    VARCHAR(121) DEFAULT NULL,
        selected_plan         VARCHAR(30)  DEFAULT NULL,
        first_payment_amount  DECIMAL(15,2) DEFAULT NULL,
        amount                DECIMAL(15,2) NOT NULL,
        created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_referrer (referrer_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (err) {
    console.error('[referral] migration error:', err.message);
    throw err;
  }
}

// Returns the user's existing my_referral_code. A user only ever reaches
// this function's fallback branch if my_referral_code is NULL — meaning
// either a genuinely old pre-MT-format account, or (previously) a brand-new
// user whose registration-time assignReferralCode() call failed (e.g. a
// missing referral_code_sequence table on a fresh deploy). Either way, the
// fallback now calls the SAME MT<seq><FirstInitial><LastInitial> generator
// used at registration (utils/referralCode.js → assignReferralCode), so a
// legacy "GV" code can never be freshly assigned again — that generator is
// retired. Users who already have ANY code (GV or MT) are returned as-is
// and are never touched, preserving every existing user's code exactly.
async function getOrCreateReferralCode(userId) {
  const [rows] = await db.execute(
    'SELECT my_referral_code, first_name, last_name FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  const existing = rows[0]?.my_referral_code;
  if (existing) return existing;

  return assignReferralCode(
    userId,
    rows[0]?.first_name || '',
    rows[0]?.last_name || ''
  );
}

// ── GET /api/referral/info ────────────────────────────────────────────────────
async function getReferralInfo(req, res) {
  const userId = req.user.sub;
  try {
    await ensureReferralSchema();
    const code = await getOrCreateReferralCode(userId);

    const [rows] = await db.execute(
      `SELECT referral_count, referral_task_progress, referral_reward_claimed
         FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) return fail(res, 'User not found', 404);

    const u = rows[0];
    const progress = Math.min(parseInt(u.referral_task_progress || 0, 10), TASK_TARGET);

    // Lifetime referral earnings — there is no separate Referral Wallet
    // anymore, so this is purely a display figure derived from the sum of
    // every referral_transactions row (bonuses + the ₹500 task reward),
    // all of which have already been credited straight to users.balance
    // (the Main Wallet) at the time they were earned/claimed.
    const [[earningsRow]] = await db.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM referral_transactions WHERE referrer_id = ?`,
      [userId]
    );

    return ok(res, 'Referral info fetched', {
      my_referral_code: code,
      total_earnings: parseFloat(earningsRow.total || 0),
      total_refers: parseInt(u.referral_count || 0, 10),
      task_progress: progress,
      task_target: TASK_TARGET,
      task_completed: progress >= TASK_TARGET,
      reward_claimed: u.referral_reward_claimed === 1,
    });
  } catch (err) {
    console.error('[referral] getReferralInfo error:', err.message);
    return fail(res, 'Could not fetch referral info', 500);
  }
}

// ── POST /api/referral/claim-reward ───────────────────────────────────────────
// Claims the one-time ₹500 "Invite 5 Users" reward and credits it to the
// user's main Wallet Balance. Locked behind a row lock so a double-tap /
// concurrent request can never claim it twice.
async function claimReward(req, res) {
  const userId = req.user.sub;

  try {
    await ensureReferralSchema();
  } catch (err) {
    console.error('[referral] claimReward schema error:', err.message);
    return fail(res, 'Could not process reward claim. Please try again.', 500);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[user]] = await conn.execute(
      `SELECT referral_task_progress, referral_reward_claimed, balance
         FROM users WHERE id = ? LIMIT 1 FOR UPDATE`,
      [userId]
    );

    if (!user) {
      await conn.rollback();
      return fail(res, 'User not found', 404);
    }
    if (user.referral_reward_claimed === 1) {
      await conn.rollback();
      return fail(res, 'Reward has already been claimed.', 409);
    }
    if (parseInt(user.referral_task_progress || 0, 10) < TASK_TARGET) {
      await conn.rollback();
      return fail(res, `Invite ${TASK_TARGET} users who activate a plan to unlock this reward.`, 400);
    }

    await conn.execute(
      `UPDATE users
          SET balance                 = balance + ?,
              referral_reward_claimed = 1
        WHERE id = ?`,
      [TASK_REWARD, userId]
    );

    await conn.execute(
      `INSERT INTO referral_transactions
         (referrer_id, type, amount, created_at)
       VALUES (?, 'task_reward', ?, NOW())`,
      [userId, TASK_REWARD]
    );

    await conn.commit();

    createNotification(
      userId,
      'referral',
      'Task Reward Claimed',
      `You claimed your ₹${TASK_REWARD.toLocaleString('en-IN')} referral task reward. It's now in your wallet.`
    ).catch(e => console.error('[referral] claimReward notify error:', e.message));

    const newBalance = parseFloat(user.balance || 0) + TASK_REWARD;
    return ok(res, 'Reward claimed! ₹500 added to your Wallet.', {
      wallet_balance: newBalance,
      reward_claimed: true,
    });
  } catch (err) {
    await conn.rollback();
    console.error('[referral] claimReward error:', err.message);
    return fail(res, 'Failed to claim reward. Please try again.', 500);
  } finally {
    conn.release();
  }
}

// ── GET /api/referral/transactions ────────────────────────────────────────────
async function getReferralTransactions(req, res) {
  const userId = req.user.sub;
  try {
    await ensureReferralSchema();
    const [rows] = await db.execute(
      `SELECT id, type, referred_user_name, selected_plan,
              first_payment_amount, amount, created_at
         FROM referral_transactions
        WHERE referrer_id = ?
        ORDER BY created_at DESC`,
      [userId]
    );

    const data = rows.map((r) => ({
      id: r.id,
      type: r.type,
      referred_user_name: r.referred_user_name,
      selected_plan: r.selected_plan,
      first_payment_amount:
        r.first_payment_amount !== null ? Number(r.first_payment_amount) : null,
      amount: Number(r.amount),
      created_at: r.created_at,
    }));

    return ok(res, 'Referral transactions fetched', data);
  } catch (err) {
    console.error('[referral] getReferralTransactions error:', err.message);
    return fail(res, 'Could not fetch referral transactions', 500);
  }
}

// ── GET /api/referral/candidates ──────────────────────────────────────────────
// Powers the "Referral Candidates" tab on the Referral screen — EVERY user
// who signed up with the current user's referral code, regardless of
// whether they've started an investment plan yet. Newest-registered first.
//
// For each referred user we look up their most recent investment_plans row
// (if any) plus their referral_transactions bonus row (if the referrer has
// already been credited for them), and derive a single dynamic `status`:
//
//   pending_plan             — registered, but no investment plan started yet
//   under_review             — plan submitted, awaiting admin review
//   first_payment_completed  — plan's first instalment has been approved
//                               (investment_plans.status is 'approved',
//                               'active', or 'completed') but the referral
//                               bonus for this user hasn't landed yet
//   reward_credited          — the referrer's bonus for this user has been
//                               credited (the common/steady-state case,
//                               since the bonus is normally credited in the
//                               same flow as the first-payment approval)
//   rejected                 — the referred user's plan was rejected
//
// This list is meant to be re-fetched (tab switch / pull-to-refresh /
// periodic poll from the client) so a candidate's status keeps moving
// forward automatically as their plan progresses — nothing here is cached
// beyond the lifetime of a single request.
async function getReferralCandidates(req, res) {
  const userId = req.user.sub;
  try {
    await ensureReferralSchema();
    const myCode = await getOrCreateReferralCode(userId);

    const [rows] = await db.execute(
      `SELECT
          u.id                      AS referred_user_id,
          u.first_name              AS first_name,
          u.last_name               AS last_name,
          u.phone                   AS referred_phone,
          u.created_at              AS registered_at,
          u.referral_bonus_credited AS bonus_credited_flag,
          p.id                      AS plan_id,
          p.plan_type               AS plan_type,
          p.status                  AS plan_status,
          p.months_paid             AS months_paid,
          p.monthly_amount          AS monthly_amount,
          p.start_date              AS plan_start_date,
          p.created_at              AS plan_created_at,
          rt.amount                 AS bonus_amount,
          rt.first_payment_amount   AS bonus_first_payment_amount,
          rt.selected_plan          AS bonus_selected_plan,
          rt.created_at             AS bonus_credited_at
        FROM users u
        LEFT JOIN investment_plans p
          ON p.id = (
               SELECT p2.id FROM investment_plans p2
                WHERE p2.user_id = u.id
                ORDER BY p2.created_at DESC
                LIMIT 1
             )
        LEFT JOIN referral_transactions rt
          ON rt.referred_user_id = u.id
         AND rt.referrer_id      = ?
         AND rt.type             = 'referral_bonus'
       WHERE u.referral_code = ?
       ORDER BY u.created_at DESC`,
      [userId, myCode]
    );

    const data = rows.map((r) => {
      const userName =
        `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Moneytries User';
      const phone = r.referred_phone ? String(r.referred_phone) : null;
      const bonusCredited =
        r.bonus_credited_flag === 1 && r.bonus_amount !== null;

      let status;
      if (bonusCredited) {
        status = 'reward_credited';
      } else if (r.plan_status === 'rejected') {
        status = 'rejected';
      } else if (
        r.plan_status === 'approved' ||
        r.plan_status === 'active' ||
        r.plan_status === 'completed'
      ) {
        status = 'first_payment_completed';
      } else if (r.plan_status === 'under_review') {
        status = 'under_review';
      } else {
        // No investment_plans row for this referred user at all.
        status = 'pending_plan';
      }

      const monthsPaid = r.months_paid !== null ? Number(r.months_paid) : 0;

      const firstPaymentAmount = bonusCredited
        ? (r.bonus_first_payment_amount !== null
            ? Number(r.bonus_first_payment_amount)
            : (r.monthly_amount !== null ? Number(r.monthly_amount) : null))
        : (monthsPaid >= 1 && r.monthly_amount !== null
            ? Number(r.monthly_amount)
            : null);

      const firstPaymentDate = bonusCredited
        ? r.bonus_credited_at
        : (monthsPaid >= 1 ? (r.plan_start_date || r.plan_created_at) : null);

      const selectedPlan =
        planTypeToShortCode(r.plan_type) ||
        planLabelToShortCode(r.bonus_selected_plan);

      return {
        id: r.plan_id ? `plan_${r.plan_id}` : `user_${r.referred_user_id}`,
        referred_user_id: r.referred_user_id,
        user_name: userName,
        selected_plan: selectedPlan,
        plan_status: r.plan_status,
        months_paid: monthsPaid,
        first_payment_amount: firstPaymentAmount,
        first_payment_date: firstPaymentDate,
        registered_at: r.registered_at,
        mobile_last4: phone && phone.length >= 4 ? phone.slice(-4) : null,
        bonus_earned: bonusCredited ? Number(r.bonus_amount) : 0,
        status,
      };
    });

    return ok(res, 'Referral candidates fetched', data);
  } catch (err) {
    console.error('[referral] getReferralCandidates error:', err.message);
    return fail(res, 'Could not fetch referral candidates', 500);
  }
}


// Only validates the code and grows the referrer's "Total Referred Users"
// count. No bonus is credited here — bonuses are earned only once the
// referred user completes their first plan payment (see
// processReferralOnFirstPlanPayment below).
async function processReferralOnSignup(newUserId, referralCode) {
  if (!referralCode) return;

  try {
    await ensureReferralSchema();

    const [referrerRows] = await db.execute(
      'SELECT id FROM users WHERE my_referral_code = ? LIMIT 1',
      [referralCode.trim().toUpperCase()]
    );
    if (referrerRows.length === 0) return; // invalid code, silently skip

    const referrerId = referrerRows[0].id;

    await db.execute(
      'UPDATE users SET referral_count = referral_count + 1 WHERE id = ?',
      [referrerId]
    );

    const [[newUser]] = await db.execute(
      'SELECT first_name, last_name FROM users WHERE id = ? LIMIT 1',
      [newUserId]
    );
    const newUserName = newUser
      ? `${newUser.first_name || ''} ${newUser.last_name || ''}`.trim()
      : null;

    createNotification(
      referrerId,
      'referral',
      'New Referral Joined',
      `${newUserName || 'A new user'} just joined using your referral code!`
    ).catch(e => console.error('[referral] signup notify error:', e.message));
  } catch (err) {
    console.error('[referral] processReferralOnSignup error:', err.message);
  }
}

// ── Notify a referrer the moment their referred user starts (enrolls in)
//    their very first investment plan — distinct from the bonus-credited
//    notification, which only fires later once the payment is approved. ────
async function notifyReferrerOfFirstPlanStart(referredUserId, planType) {
  try {
    const [[referredUser]] = await db.execute(
      `SELECT first_name, last_name, referral_code FROM users WHERE id = ? LIMIT 1`,
      [referredUserId]
    );
    if (!referredUser || !referredUser.referral_code) return;

    const [[referrer]] = await db.execute(
      `SELECT id FROM users WHERE my_referral_code = ? LIMIT 1`,
      [referredUser.referral_code.trim().toUpperCase()]
    );
    if (!referrer) return;

    const referredName =
      `${referredUser.first_name || ''} ${referredUser.last_name || ''}`.trim();

    createNotification(
      referrer.id,
      'referral',
      'Referral Started a Plan',
      `${referredName || 'Your referral'} just started their first ${PLAN_LABELS[planType] || 'investment'} plan!`
    ).catch(e => console.error('[referral] firstPlanStart notify error:', e.message));
  } catch (err) {
    console.error('[referral] notifyReferrerOfFirstPlanStart error:', err.message);
  }
}

// ── Core referral-bonus crediting logic — TRANSACTION-SCOPED ────────────────
// Does no transaction management of its own (no beginTransaction/commit/
// rollback) — it runs entirely on the `conn` the caller passes in, so it can
// be composed into the SAME transaction as a plan/instalment approval. That
// is the whole point: if this throws, the caller's catch block rolls back
// the approval too, so a payment can never end up "approved" while the
// referrer's bonus silently failed to credit. Every early-exit path below is
// an expected no-op (not referred, already credited, unknown plan type,
// referrer not found) and returns normally rather than throwing, so a user
// who simply wasn't referred never blocks their own payment approval.
async function creditReferralBonusInTransaction(
  conn,
  referredUserId,
  planType,
  firstPaymentAmount
) {
  const rate = REFERRAL_BONUS_RATES[planType];
  if (!rate) {
    console.warn(
      `[referral] skip: unknown plan type "${planType}" for user ${referredUserId}`
    );
    return { credited: false, reason: 'unknown_plan_type' };
  }

  const [[referredUser]] = await conn.execute(
    `SELECT id, first_name, last_name, referral_code, referral_bonus_credited
       FROM users WHERE id = ? LIMIT 1 FOR UPDATE`,
    [referredUserId]
  );

  if (!referredUser) {
    console.warn(`[referral] skip: user ${referredUserId} not found`);
    return { credited: false, reason: 'user_not_found' };
  }
  if (!referredUser.referral_code) {
    console.log(
      `[referral] skip: user ${referredUserId} did not register with a referral code`
    );
    return { credited: false, reason: 'no_referral_code' };
  }
  if (referredUser.referral_bonus_credited === 1) {
    console.log(
      `[referral] skip: bonus already credited once for user ${referredUserId}`
    );
    return { credited: false, reason: 'already_credited' };
  }

  const [[referrer]] = await conn.execute(
    `SELECT id FROM users WHERE my_referral_code = ? LIMIT 1 FOR UPDATE`,
    [referredUser.referral_code.trim().toUpperCase()]
  );
  if (!referrer) {
    console.warn(
      `[referral] skip: code "${referredUser.referral_code}" on user ${referredUserId} does not resolve to any referrer`
    );
    return { credited: false, reason: 'referrer_not_found' };
  }

  const amount = Number(firstPaymentAmount) || 0;
  const bonus = Math.round(amount * rate * 100) / 100; // round to paise

  // No Referral Wallet — the bonus is credited straight to the referrer's
  // Main Wallet Balance (users.balance), the same balance used for
  // deposits, ROI credits, and withdrawals.
  await conn.execute(
    `UPDATE users
        SET balance                = balance + ?,
            referral_task_progress = referral_task_progress + 1
      WHERE id = ?`,
    [bonus, referrer.id]
  );

  await conn.execute(
    `UPDATE users SET referral_bonus_credited = 1 WHERE id = ?`,
    [referredUserId]
  );

  const referredName =
    `${referredUser.first_name || ''} ${referredUser.last_name || ''}`.trim();

  await conn.execute(
    `INSERT INTO referral_transactions
       (referrer_id, referred_user_id, type, referred_user_name,
        selected_plan, first_payment_amount, amount, created_at)
     VALUES (?, ?, 'referral_bonus', ?, ?, ?, ?, NOW())`,
    [
      referrer.id,
      referredUserId,
      referredName || 'Moneytries User',
      PLAN_LABELS[planType] || planType,
      amount,
      bonus,
    ]
  );

  console.log(
    `[referral] credited ₹${bonus} to referrer ${referrer.id} for referred user ${referredUserId}'s first ${planType} payment`
  );

  createNotification(
    referrer.id,
    'referral',
    'Referral Bonus Credited',
    `You earned ₹${bonus.toLocaleString('en-IN')} referral bonus from ${referredName || 'your referral'}'s first plan payment.`
  ).catch(e => console.error('[referral] notify error:', e.message));

  return { credited: true, referrerId: referrer.id, bonus };
}

// ── Standalone wrapper around creditReferralBonusInTransaction ──────────────
// Opens and manages its own connection/transaction. Used by the backfill
// tool below (each missed user gets credited in its own transaction) and by
// any other caller that isn't already inside a DB transaction of its own.
// Plan/instalment approval no longer use this — they call
// creditReferralBonusInTransaction() directly on their existing `conn` so
// the credit is atomic with the approval itself (see planController.js).
async function processReferralOnFirstPlanPayment(newUserId, planType, firstPaymentAmount) {
  try {
    await ensureReferralSchema();
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const result = await creditReferralBonusInTransaction(
        conn,
        newUserId,
        planType,
        firstPaymentAmount
      );
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('[referral] processReferralOnFirstPlanPayment error:', err.message);
    return { credited: false, reason: 'error', error: err.message };
  }
}

// ── Admin backfill — retroactively credits any referred user whose plan
//    was already approved/active/completed but who somehow never got their
//    referrer's bonus (e.g. from before the atomic-transaction fix above,
//    or a transient failure in the old fire-and-forget hook). Safe to run
//    repeatedly: creditReferralBonusInTransaction() is guarded by
//    users.referral_bonus_credited, so anyone already credited is skipped.
async function adminBackfillReferralBonuses(req, res) {
  try {
    await ensureReferralSchema();

    // Every referred user (has a referral_code) whose most recent plan has
    // reached at least "approved" and who hasn't been credited yet.
    const [candidates] = await db.execute(
      `SELECT u.id AS user_id, p.plan_type, p.monthly_amount, p.id AS plan_id
         FROM users u
         JOIN investment_plans p
           ON p.id = (
                SELECT p2.id FROM investment_plans p2
                 WHERE p2.user_id = u.id
                 ORDER BY p2.created_at DESC
                 LIMIT 1
              )
        WHERE u.referral_code IS NOT NULL
          AND u.referral_bonus_credited = 0
          AND p.status IN ('approved', 'active', 'completed')`
    );

    const results = [];
    for (const c of candidates) {
      // Prefer the actual month-1 instalment amount (matches what the
      // normal approval flow credits on) — fall back to the plan's
      // monthly_amount if that instalment row is missing for any reason.
      const [[firstIns]] = await db.execute(
        `SELECT amount FROM plan_instalments
          WHERE plan_id = ? AND month_number = 1
          ORDER BY created_at ASC LIMIT 1`,
        [c.plan_id]
      );
      const firstPaymentAmount =
        firstIns?.amount != null ? firstIns.amount : c.monthly_amount;

      const result = await processReferralOnFirstPlanPayment(
        c.user_id,
        c.plan_type,
        firstPaymentAmount
      );
      results.push({ user_id: c.user_id, plan_id: c.plan_id, ...result });
    }

    const creditedCount = results.filter((r) => r.credited).length;

    return ok(res, `Backfill complete: credited ${creditedCount}/${results.length} missed referral bonus(es).`, {
      scanned: candidates.length,
      credited: creditedCount,
      results,
    });
  } catch (err) {
    console.error('[referral] adminBackfillReferralBonuses error:', err.message);
    return fail(res, 'Backfill failed: ' + err.message, 500);
  }
}

module.exports = {
  ensureReferralSchema,
  getReferralInfo,
  claimReward,
  getReferralTransactions,
  getReferralCandidates,
  processReferralOnSignup,
  processReferralOnFirstPlanPayment,
  creditReferralBonusInTransaction,
  notifyReferrerOfFirstPlanStart,
  adminBackfillReferralBonuses,
};
