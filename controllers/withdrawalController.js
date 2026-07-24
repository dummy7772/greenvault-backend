// controllers/withdrawalController.js
const crypto = require('crypto');
const db     = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');

// ── One-time column migration ─────────────────────────────────────────────────
//
// If the users table was created before `balance` / `vault_balance` were
// added to schema.sql, `CREATE TABLE IF NOT EXISTS` silently skips the new
// columns on existing installs. This detects and repairs that automatically,
// the same way kycController/depositController do for their own columns.

let _columnsVerified = false;

async function ensureBalanceColumns() {
  if (_columnsVerified) return;

  try {
    const [rows] = await db.execute(
      `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'users'
          AND COLUMN_NAME IN ('balance', 'vault_balance')`
    );
    const present = new Set(rows.map((r) => r.COLUMN_NAME));

    if (!present.has('balance')) {
      console.warn('[withdrawal] balance column missing from users table — running migration…');
      await db.execute(`ALTER TABLE users ADD COLUMN balance DECIMAL(15,2) NOT NULL DEFAULT 0.00`);
      console.log('[withdrawal] ✅  balance column added to users table.');
    }
    if (!present.has('vault_balance')) {
      console.warn('[withdrawal] vault_balance column missing from users table — running migration…');
      await db.execute(`ALTER TABLE users ADD COLUMN vault_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00`);
      console.log('[withdrawal] ✅  vault_balance column added to users table.');
    }

    _columnsVerified = true;
  } catch (err) {
    console.error('[withdrawal] column migration check failed:', err.message);
  }
}

// Run once on module load (non-blocking)
ensureBalanceColumns();

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateReferenceId() {
  return 'WD' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function inr(amount) {
  return Number(amount).toLocaleString('en-IN');
}

/** Fetch the latest approved/pending KYC row (with bank details) for a user. */
async function getLatestKyc(userId) {
  const [rows] = await db.execute(
    `SELECT status, account_holder_name, account_number, ifsc_code, bank_name
       FROM kyc_submissions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// ── GET /api/withdrawal/kyc-status ────────────────────────────────────────────
// Adapter endpoint — reshapes the kyc_submissions row into the
// { is_verified, bank_detail } shape the Flutter KycStatus model expects.

async function getWithdrawalKycStatus(req, res) {
  const userId = req.user.sub;

  try {
    const kyc = await getLatestKyc(userId);

    if (!kyc || kyc.status !== 'approved') {
      return ok(res, 'KYC status fetched', { is_verified: false, bank_detail: null });
    }

    return ok(res, 'KYC status fetched', {
      is_verified: true,
      bank_detail: {
        account_name: kyc.account_holder_name,
        account_number: kyc.account_number,
        ifsc: kyc.ifsc_code,
        bank_name: kyc.bank_name,
        account_type: 'Savings',
      },
    });
  } catch (err) {
    console.error('[withdrawal:kyc-status]', err.message);
    return fail(res, 'Could not fetch KYC status.', 500);
  }
}

// ── GET /api/withdrawal/balances ──────────────────────────────────────────────
// Convenience endpoint so the app can show real wallet/vault balances
// instead of hardcoded demo values.
//
// IMPORTANT: `users.balance` / `users.vault_balance` are now debited the
// moment a withdrawal request is submitted (see walletWithdrawRequest /
// vaultWithdrawRequest below), so these columns already represent the
// TRUE spendable amount — money that is "Under Review" has already been
// removed from them. There is no need to subtract a separate "pending"
// total from the balance here anymore; doing so would double-count the
// lock. `pending_wallet` / `pending_vault` are still returned as
// informational figures (e.g. to show "₹500 locked & under review" in the
// UI) but they are NOT subtracted again from the spendable balance.

async function getBalances(req, res) {
  const userId = req.user.sub;
  try {
    const [rows] = await db.query(
      `SELECT COALESCE(balance, 0) AS balance, COALESCE(vault_balance, 0) AS vault_balance
         FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) return fail(res, 'User not found.', 404);

    const walletBalance = Number(rows[0].balance);
    const vaultBalance  = Number(rows[0].vault_balance);
    const pendingWallet = await getPendingWithdrawalTotal(userId, 'wallet');
    const pendingVault  = await getPendingWithdrawalTotal(userId, 'vault');

    return ok(res, 'Balances fetched', {
      wallet_balance: walletBalance,
      vault_balance: vaultBalance,
      // Informational only — the amount currently locked in "Under Review"
      // withdrawal requests. This money has ALREADY been removed from
      // wallet_balance / vault_balance above.
      pending_wallet: pendingWallet,
      pending_vault: pendingVault,
      locked_wallet: pendingWallet,
      locked_vault: pendingVault,
      // wallet_balance / vault_balance are already net of locked funds, so
      // the spendable amount IS the balance — no further subtraction.
      available_wallet: walletBalance,
      available_vault: vaultBalance,
    });
  } catch (err) {
    console.error('[withdrawal:balances]', err.message);
    return fail(res, 'Could not fetch balances.', 500);
  }
}

// ── Shared validation ──────────────────────────────────────────────────────────

/**
 * Informational total of currently-locked ("pending") withdrawal requests.
 * Since balance is now debited at request time, this is no longer used to
 * gate new withdrawals (the balance column itself already excludes locked
 * funds) — it's kept for UI display purposes only (e.g. "₹500 locked").
 */
async function getPendingWithdrawalTotal(userId, type) {
  const [rows] = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS pending
       FROM withdrawals
      WHERE user_id = ?
        AND type = ?
        AND status = 'pending'`,
    [userId, type]
  );
  return Number(rows[0]?.pending || 0);
}

async function validateRequest(req, res, { requireBalanceColumn, type }) {
  const userId = req.user.sub;
  const { amount } = req.body;

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    fail(res, 'Invalid amount.', 422);
    return null;
  }

  const kyc = await getLatestKyc(userId);
  if (!kyc || kyc.status !== 'approved') {
    fail(res, 'KYC verification is required to withdraw.', 403);
    return null;
  }

  const [rows] = await db.query(
    `SELECT id, ${requireBalanceColumn} AS avail FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (rows.length === 0) {
    fail(res, 'User not found.', 404);
    return null;
  }

  // `avail` already excludes any amount locked by a prior pending
  // withdrawal, since that amount was deducted from the balance column
  // the moment it was requested. No need to subtract pending totals here.
  const available = Number(rows[0].avail) || 0;

  if (available <= 0 || Number(amount) > available) {
    fail(res, 'Amount exceeds your available balance.', 422);
    return null;
  }

  return { userId, amount: Number(amount), kyc };
}

// ── POST /api/withdrawal/wallet ────────────────────────────────────────────────
// Withdraws from the user's main wallet balance to their KYC bank account.
//
// The requested amount is LOCKED immediately: it is deducted from
// users.balance the instant the request is inserted (status = 'pending'),
// in the same DB transaction. This guarantees the same money can never be
// spent twice — e.g. used to fund a new investment plan, a wallet
// transfer, or a second withdrawal — while the original request is still
// "Under Review".
//
//   submit  → balance -= amount   (locked, status = 'pending')
//   approve → balance unchanged   (already deducted; amount is paid out to
//                                   the user's bank account)
//   reject  → balance += amount   (locked amount is refunded automatically)

async function walletWithdrawRequest(req, res) {
  const validated = await validateRequest(req, res, { requireBalanceColumn: 'balance', type: 'wallet' });
  if (!validated) return;
  const { userId, amount, kyc } = validated;

  const referenceId = generateReferenceId();
  let conn;

  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [locked] = await conn.query(
      'SELECT COALESCE(balance, 0) AS balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [userId]
    );
    if (locked.length === 0) {
      await conn.rollback();
      return fail(res, 'User not found.', 404);
    }

    // Re-check against the row-locked, up-to-the-millisecond balance so two
    // simultaneous withdrawal requests (or a withdrawal racing a spend)
    // can never both succeed against the same money.
    const available = Number(locked[0].balance) || 0;
    if (available <= 0 || amount > available) {
      await conn.rollback();
      return fail(res, 'Amount exceeds your available balance.', 422);
    }

    // Lock the funds immediately — deduct from the wallet balance right now,
    // not at admin-approval time. This is what prevents the amount from
    // being double-spent while the request sits "Under Review".
    await conn.query(
      'UPDATE users SET balance = balance - ? WHERE id = ?',
      [amount, userId]
    );

    const [result] = await conn.query(
      `INSERT INTO withdrawals
         (user_id, type, amount, reference_id,
          account_holder_name, account_number, ifsc_code, bank_name, status)
       VALUES (?, 'wallet', ?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, amount, referenceId, kyc.account_holder_name, kyc.account_number, kyc.ifsc_code, kyc.bank_name]
    );

    await conn.commit();

    createNotification(
      userId,
      'withdrawal',
      'Withdrawal Request Submitted',
      `Your withdrawal request of ₹${inr(amount)} has been submitted. ₹${inr(amount)} has been locked from your Wallet Balance and is now Under Review.`
    ).catch(e => console.error('[withdrawal:wallet] notify error:', e.message));

    return ok(res, 'Withdrawal request submitted successfully.', {
      reference_id: referenceId,
      withdrawal_id: result.insertId,
      locked_amount: amount,
      message: 'Your withdrawal request has been submitted. The amount has been locked from your wallet balance and is awaiting admin approval.',
    }, 201);
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (_) {} }
    console.error('[withdrawal:wallet]', err.message);
    return fail(res, 'Wallet withdrawal failed. Please try again.', 500);
  } finally {
    if (conn) conn.release();
  }
}

// ── POST /api/withdrawal/vault ─────────────────────────────────────────────────
// Requests moving vault (mining earnings) balance into the main wallet.
//
// Same locking rule as the wallet withdrawal above: the requested amount is
// deducted from users.vault_balance the instant the request is submitted,
// so it can't be double-spent (e.g. used against a second vault transfer)
// while the request is "Under Review".
//
//   submit  → vault_balance -= amount  (locked, status = 'pending')
//   approve → vault_balance unchanged (already deducted); balance += amount
//             (the locked amount is moved into the main wallet)
//   reject  → vault_balance += amount  (locked amount is refunded automatically)

async function vaultWithdrawRequest(req, res) {
  const validated = await validateRequest(req, res, { requireBalanceColumn: 'vault_balance', type: 'vault' });
  if (!validated) return;
  const { userId, amount, kyc } = validated;

  const referenceId = generateReferenceId();
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [locked] = await conn.query(
      'SELECT COALESCE(vault_balance, 0) AS vault_balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [userId]
    );
    if (locked.length === 0) {
      await conn.rollback();
      return fail(res, 'User not found.', 404);
    }

    const available = Number(locked[0].vault_balance) || 0;
    if (available <= 0 || amount > available) {
      await conn.rollback();
      return fail(res, 'Amount exceeds your available vault balance.', 422);
    }

    // Lock the funds immediately.
    await conn.query(
      'UPDATE users SET vault_balance = vault_balance - ? WHERE id = ?',
      [amount, userId]
    );

    const [result] = await conn.query(
      `INSERT INTO withdrawals
         (user_id, type, amount, reference_id,
          account_holder_name, account_number, ifsc_code, bank_name, status)
       VALUES (?, 'vault', ?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, amount, referenceId, kyc.account_holder_name, kyc.account_number, kyc.ifsc_code, kyc.bank_name]
    );

    await conn.commit();

    createNotification(
      userId,
      'withdrawal',
      'Withdrawal Request Submitted',
      `Your request to move ₹${inr(amount)} from your mining vault to your wallet has been submitted. ₹${inr(amount)} has been locked and is now Under Review.`
    ).catch(e => console.error('[withdrawal:vault] notify error:', e.message));

    return ok(res, 'Request submitted for admin review.', {
      reference_id: referenceId,
      withdrawal_id: result.insertId,
      locked_amount: amount,
      message: 'Your mining earnings will be moved to your main wallet after admin approval. This typically takes 1–2 business days.',
    }, 201);
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (_) {} }
    console.error('[withdrawal:vault]', err.message);
    return fail(res, 'Move wallet request failed. Please try again.', 500);
  } finally {
    if (conn) conn.release();
  }
}

// ── POST /api/withdrawal/list  (user's own history) ───────────────────────────

async function listWithdrawals(req, res) {
  const userId = req.user.sub;
  const pageNo   = Math.max(1, parseInt(req.body.pageNo   || req.query.pageNo   || '1',  10));
  const pageSize = Math.max(1, parseInt(req.body.pageSize || req.query.pageSize || '10', 10));
  const offset   = (pageNo - 1) * pageSize;
  const { type, status } = req.body;

  let where = 'WHERE user_id = ?';
  const params = [userId];

  if (type && ['wallet', 'vault'].includes(type)) {
    where += ' AND type = ?';
    params.push(type);
  }
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    where += ' AND status = ?';
    params.push(status);
  }

  try {
    const [rows] = await db.query(
      `SELECT id, type, amount, reference_id, status, admin_remarks, created_at, reviewed_at
         FROM withdrawals
         ${where}
         ORDER BY created_at DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM withdrawals ${where}`,
      params
    );

    return ok(res, 'Withdrawal list fetched', {
      pageNo,
      pageSize,
      totalRecords: total,
      totalPages: Math.ceil(total / pageSize),
      data: rows,
    });
  } catch (err) {
    console.error('[withdrawal:list]', err.message);
    return fail(res, 'Could not fetch withdrawal history.', 500);
  }
}

// ── GET /api/withdrawal/admin/all  (admin) ────────────────────────────────────

async function adminListWithdrawals(req, res) {
  const pageNum  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limitNum = Math.max(1, parseInt(req.query.limit || '20', 10));
  const offset   = (pageNum - 1) * limitNum;
  const { status, type } = req.query;
  const userId = parseInt(req.query.user_id || '', 10);

  const clauses = [];
  const params  = [];
  if (status && ['pending', 'approved', 'rejected'].includes(status)) {
    clauses.push('w.status = ?');
    params.push(status);
  }
  if (type && ['wallet', 'vault'].includes(type)) {
    clauses.push('w.type = ?');
    params.push(type);
  }
  if (Number.isInteger(userId) && userId > 0) {
    clauses.push('w.user_id = ?');
    params.push(userId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const [rows] = await db.query(
      `SELECT
         w.id, w.user_id, w.type, w.amount, w.reference_id,
         w.account_holder_name, w.account_number, w.ifsc_code, w.bank_name,
         w.status, w.admin_remarks, w.created_at, w.reviewed_at,
         u.first_name, u.last_name, u.email, u.phone
       FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       ${where}
       ORDER BY w.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM withdrawals w ${where}`,
      params
    );

    return ok(res, 'Withdrawal list fetched', {
      submissions: rows,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    console.error('[withdrawal:admin:list]', err.message);
    return fail(res, 'Could not fetch withdrawal list.', 500);
  }
}

// ── GET /api/withdrawal/admin/:id  (admin) ────────────────────────────────────

async function getWithdrawalById(req, res) {
  const { id } = req.params;
  try {
    const [rows] = await db.query(
      `SELECT
         w.id, w.user_id, w.type, w.amount, w.reference_id,
         w.account_holder_name, w.account_number, w.ifsc_code, w.bank_name,
         w.status, w.admin_remarks, w.created_at, w.reviewed_at,
         u.first_name, u.last_name, u.email, u.phone
       FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       WHERE w.id = ?
       LIMIT 1`,
      [id]
    );
    if (rows.length === 0) return fail(res, 'Withdrawal not found.', 404);
    return ok(res, 'Withdrawal fetched', rows[0]);
  } catch (err) {
    console.error('[withdrawal:admin:getById]', err.message);
    return fail(res, 'Could not fetch withdrawal.', 500);
  }
}

// ── PUT /api/withdrawal/admin/:id/review  (admin) ─────────────────────────────
//
// The requested amount was already deducted (locked) from the user's
// balance/vault_balance at submission time — see walletWithdrawRequest /
// vaultWithdrawRequest above. This handler NEVER deducts a second time.
//
// wallet type:
//   approve → balance stays as-is (already debited). Amount is paid out to
//             the user's bank account outside the app; we just mark it done.
//   reject  → REFUND: balance += amount (locked amount goes back to the
//             user's Wallet Balance automatically).
//
// vault type:
//   approve → vault_balance stays as-is (already debited). balance += amount
//             (locked amount is moved into the main wallet).
//   reject  → REFUND: vault_balance += amount (locked amount goes back to
//             the vault automatically).

async function adminReviewWithdrawal(req, res) {
  const { id } = req.params;
  const { action, reason = null } = req.body;

  if (!['approve', 'reject'].includes(action)) {
    return fail(res, "action must be 'approve' or 'reject'", 422);
  }
  if (action === 'reject' && (!reason || !String(reason).trim())) {
    return fail(res, 'A rejection reason is required.', 422);
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, user_id, type, amount, status FROM withdrawals WHERE id = ? LIMIT 1 FOR UPDATE',
      [id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return fail(res, 'Withdrawal not found.', 404);
    }

    const wd = rows[0];
    if (wd.status !== 'pending') {
      await conn.rollback();
      return fail(res, `Cannot review a withdrawal that is already '${wd.status}'.`, 409);
    }

    // Lock the user's row for update before mutating any balances below.
    await conn.query('SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE', [wd.user_id]);

    if (action === 'approve') {
      if (wd.type === 'vault') {
        // The vault_balance was already debited at request time. Approving
        // means the locked amount now moves into the user's main wallet.
        await conn.query(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [wd.amount, wd.user_id]
        );
      }
      // wallet type: balance was already debited at request time and is
      // being paid out to the bank account — no further balance change.
    } else {
      // action === 'reject' → automatically refund the locked amount back
      // to wherever it was taken from.
      if (wd.type === 'wallet') {
        await conn.query(
          'UPDATE users SET balance = balance + ? WHERE id = ?',
          [wd.amount, wd.user_id]
        );
      } else {
        await conn.query(
          'UPDATE users SET vault_balance = vault_balance + ? WHERE id = ?',
          [wd.amount, wd.user_id]
        );
      }
    }

    await conn.query(
      `UPDATE withdrawals
         SET status = ?, admin_remarks = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [action === 'approve' ? 'approved' : 'rejected', action === 'reject' ? String(reason).trim() : null, id]
    );

    await conn.commit();

    const notifTitle = action === 'approve'
      ? 'Withdrawal Approved'
      : 'Withdrawal Rejected (Amount Refunded)';
    const notifMsg = action === 'approve'
      ? (wd.type === 'vault'
          ? `Your request to move ₹${inr(wd.amount)} from your mining vault to your wallet has been approved and credited to your Wallet Balance.`
          : `Your withdrawal request of ₹${inr(wd.amount)} has been approved and transferred to your bank account.`)
      : `Your withdrawal request of ₹${inr(wd.amount)} was rejected.${reason ? ` Reason: ${String(reason).trim()}` : ''} The locked amount of ₹${inr(wd.amount)} has been refunded to your ${wd.type === 'vault' ? 'Vault' : 'Wallet'} Balance.`;
    createNotification(wd.user_id, 'withdrawal', notifTitle, notifMsg)
      .catch(e => console.error('[withdrawal:admin:review] notify error:', e.message));

    return ok(res, action === 'approve' ? 'Withdrawal approved.' : 'Withdrawal rejected. Amount refunded.', {
      withdrawalId: Number(id),
      status: action === 'approve' ? 'approved' : 'rejected',
      refunded: action === 'reject',
      refunded_amount: action === 'reject' ? Number(wd.amount) : 0,
    });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (_) {} }
    console.error('[withdrawal:admin:review]', err.message);
    return fail(res, 'Review action failed. Please try again.', 500);
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  getWithdrawalKycStatus,
  getBalances,
  walletWithdrawRequest,
  vaultWithdrawRequest,
  listWithdrawals,
  adminListWithdrawals,
  getWithdrawalById,
  adminReviewWithdrawal,
};