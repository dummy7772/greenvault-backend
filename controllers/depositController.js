// controllers/depositController.js
const path = require('path');
const fs   = require('fs');
const db   = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');

// ── One-time column migration ─────────────────────────────────────────────────
//
// If the users table was created before the `balance` column was added to
// schema.sql, `CREATE TABLE IF NOT EXISTS` silently skips the full definition
// (including the new column) on every subsequent startup. This detects and
// repairs that automatically so no manual SQL is needed.

let _balanceColumnVerified = false;

async function ensureBalanceColumn() {
  if (_balanceColumnVerified) return;

  try {
    const [rows] = await db.execute(
      `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'users'
          AND COLUMN_NAME  = 'balance'
        LIMIT 1`
    );

    if (rows.length === 0) {
      console.warn('[deposit] balance column missing from users table — running migration…');
      await db.execute(
        `ALTER TABLE users
           ADD COLUMN balance DECIMAL(15,2) NOT NULL DEFAULT 0.00`
      );
      console.log('[deposit] ✅  balance column added to users table.');
    }

    _balanceColumnVerified = true;
  } catch (err) {
    console.error('[deposit] balance column migration check failed:', err.message);
  }
}

// Run once on module load (non-blocking)
ensureBalanceColumn();

// ── Business rule: maximum single-transaction deposit amount ──────────────────
// No single deposit may exceed ₹100,000 (1 Lakh). This is the authoritative,
// always-enforced guard (applies to every existing and new database, unlike
// the CHECK constraint in config/schema.sql which only applies to brand-new
// installs — see the comment above that table definition for why).
const MAX_DEPOSIT_AMOUNT = 100000;
const MAX_AMOUNT_MESSAGE = 'The maximum allowed deposit or plan amount is ₹100,000.';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileUrl(storedPath) {
  if (!storedPath) return null;
  // Cloudinary URLs are stored as full https:// URLs — return as-is
  if (storedPath.startsWith('http')) return storedPath;
  return `/uploads/${storedPath}`;
}

function relPath(f) {
  // Cloudinary: multer-storage-cloudinary puts the CDN URL in f.path
  if (f.path && f.path.startsWith('http')) return f.path;
  // Local disk: strip everything up to and including 'uploads/'
  const normalized = f.path.replace(/\\/g, '/');
  const idx = normalized.indexOf('/uploads/');
  if (idx !== -1) return normalized.slice(idx + '/uploads/'.length);
  return f.path.replace(/^.*uploads[/\\]/, '');
}

// ── POST /api/deposit/upload ──────────────────────────────────────────────────
// Accepts a single image file, stores it, returns its URL.
// Flutter DepositRepository calls this first then uses the URL in createDeposit.

async function uploadScreenshot(req, res) {
  if (!req.file) {
    return fail(res, 'No file uploaded. Please attach a screenshot.', 422);
  }
  const url = fileUrl(relPath(req.file));
  return ok(res, 'Screenshot uploaded', { proof_image: url, url });
}

// ── POST /api/deposit/submit ──────────────────────────────────────────────────

async function createDeposit(req, res) {
  const userId = req.user.sub;
  const { amount, utr_id, proof_image } = req.body;

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    return fail(res, 'Invalid amount.', 422);
  }
  if (Number(amount) > MAX_DEPOSIT_AMOUNT) {
    return fail(res, MAX_AMOUNT_MESSAGE, 422);
  }
  if (!utr_id || String(utr_id).trim().length < 6) {
    return fail(res, 'Invalid UTR / Transaction ID.', 422);
  }
  if (!proof_image || String(proof_image).trim() === '') {
    return fail(res, 'Payment screenshot is required.', 422);
  }

  try {
    const [result] = await db.query(
      `INSERT INTO deposits
         (user_id, amount, utr_id, proof_image, order_status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [userId, Number(amount), String(utr_id).trim(), String(proof_image).trim()]
    );

    createNotification(
      userId,
      'deposit',
      'Deposit Submitted',
      `Your deposit of ₹${Number(amount).toLocaleString('en-IN')} has been submitted and is under review by admin.`
    ).catch(e => console.error('[deposit:create] notify error:', e.message));

    return ok(res, 'Deposit request submitted successfully.', {
      order_id: result.insertId,
      message:  'Your deposit is under review. It will be credited within 24 hours.',
    }, 201);
  } catch (err) {
    console.error('[deposit:create]', err.message);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return fail(res, 'Deposits table not found. Please restart the server to run migrations.', 500);
    }
    return fail(res, 'Deposit submission failed. Please try again.', 500);
  }
}

// ── POST /api/deposit/list  (user's own history) ─────────────────────────────

async function listDeposits(req, res) {
  const userId = req.user.sub;
  const pageNo   = Math.max(1, parseInt(req.body.pageNo   || req.query.pageNo   || '1',  10));
  const pageSize = Math.max(1, parseInt(req.body.pageSize || req.query.pageSize || '10', 10));
  const offset   = (pageNo - 1) * pageSize;
  const { status, search } = req.body;

  let where  = 'WHERE user_id = ?';
  const params = [userId];

  if (status && ['pending','approved','rejected'].includes(status)) {
    where += ' AND order_status = ?';
    params.push(status);
  }
  if (search && String(search).trim()) {
    where += ' AND utr_id LIKE ?';
    params.push(`%${String(search).trim()}%`);
  }

  try {
    const [rows] = await db.query(
      `SELECT id, amount, utr_id, proof_image, order_status, rejection_reason, created_at
         FROM deposits
         ${where}
         ORDER BY created_at DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM deposits ${where}`,
      params
    );

    return ok(res, 'Deposit list fetched', {
      pageNo,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      data: rows.map(r => ({
        ...r,
        proof_image: r.proof_image ? fileUrl(r.proof_image.replace(/^\/uploads\//, '')) : null,
      })),
    });
  } catch (err) {
    console.error('[deposit:list]', err.message);
    return fail(res, 'Could not fetch deposit history.', 500);
  }
}

// ── GET /api/deposit/admin/all  (admin) ──────────────────────────────────────

async function adminListDeposits(req, res) {
  const pageNum  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limitNum = Math.max(1, parseInt(req.query.limit || '20', 10));
  const offset   = (pageNum - 1) * limitNum;
  const { status } = req.query;
  const userId = parseInt(req.query.user_id || '', 10);

  const clauses = [];
  const params = [];
  if (status && ['pending','approved','rejected'].includes(status)) {
    clauses.push('d.order_status = ?');
    params.push(status);
  }
  if (Number.isInteger(userId) && userId > 0) {
    clauses.push('d.user_id = ?');
    params.push(userId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    const [rows] = await db.query(
      `SELECT
         d.id, d.user_id, d.amount, d.utr_id, d.proof_image,
         d.order_status, d.rejection_reason, d.created_at, d.reviewed_at,
         u.first_name, u.last_name, u.email, u.phone
       FROM deposits d
       JOIN users u ON u.id = d.user_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT ${limitNum} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM deposits d ${where}`,
      params
    );

    return ok(res, 'Deposit list fetched', {
      submissions: rows.map(r => ({
        ...r,
        proof_image_url: r.proof_image ? fileUrl(r.proof_image.replace(/^\/uploads\//, '')) : null,
      })),
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    console.error('[deposit:admin:list]', err.message);
    return fail(res, 'Could not fetch deposit list.', 500);
  }
}

// ── GET /api/deposit/admin/:id  (admin) ──────────────────────────────────────
// Fetch a single deposit by id, with user details — used by the admin
// detail/review modal (mirrors kycController.getKycById).

async function getDepositById(req, res) {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT
         d.id, d.user_id, d.amount, d.utr_id, d.proof_image,
         d.order_status, d.rejection_reason, d.created_at, d.reviewed_at,
         u.first_name, u.last_name, u.email, u.phone
       FROM deposits d
       JOIN users u ON u.id = d.user_id
       WHERE d.id = ?
       LIMIT 1`,
      [id]
    );

    if (rows.length === 0) return fail(res, 'Deposit not found.', 404);

    const row = rows[0];
    return ok(res, 'Deposit fetched', {
      ...row,
      proof_image_url: row.proof_image ? fileUrl(row.proof_image.replace(/^\/uploads\//, '')) : null,
    });
  } catch (err) {
    console.error('[deposit:admin:getById]', err.message);
    return fail(res, 'Could not fetch deposit.', 500);
  }
}

// ── PUT /api/deposit/admin/:id/review  (admin) ───────────────────────────────

async function adminReviewDeposit(req, res) {
  const { id } = req.params;
  const { action, reason = null } = req.body;

  if (!['approve', 'reject'].includes(action)) {
    return fail(res, "action must be 'approve' or 'reject'", 422);
  }
  if (action === 'reject' && (!reason || !String(reason).trim())) {
    return fail(res, 'A rejection reason is required.', 422);
  }

  try {
    const [rows] = await db.query(
      'SELECT id, user_id, amount, order_status FROM deposits WHERE id = ? LIMIT 1',
      [id]
    );

    if (rows.length === 0) return fail(res, 'Deposit not found.', 404);

    const deposit = rows[0];
    if (deposit.order_status !== 'pending') {
      return fail(res, `Cannot review a deposit that is already '${deposit.order_status}'.`, 409);
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      // Re-check status inside the transaction to guard against a race where
      // two admins review the same deposit at the same time.
      const [locked] = await conn.query(
        'SELECT order_status FROM deposits WHERE id = ? LIMIT 1 FOR UPDATE',
        [id]
      );
      if (locked.length === 0 || locked[0].order_status !== 'pending') {
        await conn.rollback();
        return fail(res, 'This deposit has already been reviewed.', 409);
      }

      await conn.query(
        `UPDATE deposits
           SET order_status = ?, rejection_reason = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [newStatus, action === 'reject' ? String(reason).trim() : null, id]
      );

      // If approved, credit the deposit amount to the user's wallet balance.
      if (action === 'approve') {
        try {
          await conn.query(
            `UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE id = ?`,
            [deposit.amount, deposit.user_id]
          );
        } catch (balErr) {
          if (balErr.code === 'ER_BAD_FIELD_ERROR') {
            // balance column missing — add it, then retry the credit
            console.warn('[deposit:review] balance column missing — adding it now and retrying.');
            await conn.query(
              `ALTER TABLE users ADD COLUMN balance DECIMAL(15,2) NOT NULL DEFAULT 0.00`
            );
            _balanceColumnVerified = true;
            await conn.query(
              `UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE id = ?`,
              [deposit.amount, deposit.user_id]
            );
          } else {
            throw balErr;
          }
        }
      }

      await conn.commit();
    } catch (txErr) {
      try { await conn.rollback(); } catch (_) { /* ignore */ }
      throw txErr;
    } finally {
      conn.release();
    }

    _notifyDepositReviewed(deposit, newStatus, action === 'reject' ? String(reason).trim() : null)
      .catch(e => console.error('[deposit:review] notify error:', e.message));

    return ok(res, action === 'approve' ? 'Deposit approved.' : 'Deposit rejected.', {
      depositId: Number(id),
      status: newStatus,
    });
  } catch (err) {
    console.error('[deposit:admin:review]', err.message);
    return fail(res, 'Review action failed. Please try again.', 500);
  }
}

// Fire this after the response above — a failure here must never affect the
// review outcome itself, so it's kept out of the try/catch and DB
// transaction that just committed.
async function _notifyDepositReviewed(deposit, newStatus, reason) {
  if (newStatus === 'approved') {
    await createNotification(
      deposit.user_id,
      'deposit',
      'Deposit Approved',
      `Your deposit of ₹${Number(deposit.amount).toLocaleString('en-IN')} has been approved and credited to your wallet.`
    );
  } else {
    await createNotification(
      deposit.user_id,
      'deposit',
      'Deposit Rejected',
      `Your deposit of ₹${Number(deposit.amount).toLocaleString('en-IN')} was rejected.${reason ? ` Reason: ${reason}` : ''}`
    );
  }
}

module.exports = { uploadScreenshot, createDeposit, listDeposits, adminListDeposits, getDepositById, adminReviewDeposit };