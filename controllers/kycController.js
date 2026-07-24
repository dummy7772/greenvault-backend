// controllers/kycController.js
const path  = require('path');
const fs    = require('fs');
const db    = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');

// ── One-time column migration ─────────────────────────────────────────────────
//
// If the users table was created before the kyc_status column was added to
// schema.sql, `CREATE TABLE IF NOT EXISTS` silently skips the full definition
// (including the new column) on every subsequent startup. This async function
// detects and repairs that situation automatically so no manual SQL is needed.

let _kycStatusColumnVerified = false;

async function ensureKycStatusColumn() {
  if (_kycStatusColumnVerified) return;

  try {
    const [rows] = await db.execute(
      `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'users'
          AND COLUMN_NAME  = 'kyc_status'
        LIMIT 1`
    );

    if (rows.length === 0) {
      console.warn(
        '[kyc] kyc_status column missing from users table — running migration…'
      );
      await db.execute(
        `ALTER TABLE users
           ADD COLUMN kyc_status
             ENUM('not_submitted','pending','approved','rejected')
             NOT NULL DEFAULT 'not_submitted'
           AFTER role`
      );
      console.log('[kyc] ✅  kyc_status column added to users table.');
    }

    _kycStatusColumnVerified = true;
  } catch (err) {
    // Non-fatal: log clearly so the developer knows, but don't crash the process.
    // The column update will simply be skipped in the functions below.
    console.error('[kyc] Migration check failed:', err.message);
  }
}

// Run once on module load (non-blocking)
ensureKycStatusColumn();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safely update kyc_status on the users row.
 * If the column is still missing (e.g. migration failed), logs a warning
 * and continues instead of crashing the whole request.
 */
async function setUserKycStatus(conn, userId, status) {
  try {
    await conn.execute(
      `UPDATE users SET kyc_status = ? WHERE id = ?`,
      [status, userId]
    );
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      console.warn(
        `[kyc] Could not set kyc_status for user ${userId} — column missing. ` +
        `Restart the server or run: ALTER TABLE users ADD COLUMN kyc_status ` +
        `ENUM('not_submitted','pending','approved','rejected') NOT NULL DEFAULT 'not_submitted' AFTER role;`
      );
      // Re-trigger migration so subsequent requests succeed
      _kycStatusColumnVerified = false;
      ensureKycStatusColumn();
    } else {
      throw err; // Re-throw unexpected errors
    }
  }
}

/**
 * Delete uploaded files — from Cloudinary if the path is a CDN URL,
 * or from local disk otherwise.
 * Called when a submission fails after files have already been written.
 */
function cleanupFiles(files) {
  if (!files) return;
  const cloudinary = (() => {
    try { return require('cloudinary').v2; } catch (_) { return null; }
  })();

  Object.values(files).forEach((arr) =>
    arr.forEach((f) => {
      try {
        if (f.path && f.path.startsWith('http') && cloudinary && f.filename) {
          // f.filename from multer-storage-cloudinary is the public_id
          cloudinary.uploader.destroy(f.filename).catch(() => {});
        } else {
          fs.unlinkSync(f.path);
        }
      } catch (_) { /* ignore */ }
    })
  );
}

/**
 * Build the public-facing URL for a stored file.
 *
 * - If the stored path is already a full URL (Cloudinary CDN), return it as-is.
 * - Otherwise build an absolute URL from BASE_URL / request host for locally
 *   stored files (local dev fallback).
 */
function fileUrl(relOrAbsPath, req) {
  if (!relOrAbsPath) return null;
  // Already a full URL (Cloudinary or any absolute URL stored in DB)
  if (relOrAbsPath.startsWith('http')) return relOrAbsPath;
  const relative = `/uploads/${relOrAbsPath}`;
  if (!req) return relative;
  const baseUrl = process.env.BASE_URL
    ? process.env.BASE_URL.replace(/\/$/, '')
    : `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}${relative}`;
}

/**
 * Extract the storable path/URL from a multer file object.
 *
 * - Cloudinary storage sets `file.path` to the full HTTPS CDN URL.
 * - Disk storage sets `file.path` to the absolute local path.
 *
 * For Cloudinary files we store the full URL directly.
 * For disk files we strip the absolute prefix down to the relative
 * portion after 'uploads/' so fileUrl() can reconstruct it.
 */
function relPath(f) {
  // Cloudinary: multer-storage-cloudinary puts the CDN URL in f.path
  if (f.path && f.path.startsWith('http')) {
    return f.path; // store full URL as-is
  }
  // Local disk: strip everything up to and including 'uploads/'
  const normalized = f.path.replace(/\\/g, '/');
  const idx = normalized.indexOf('/uploads/');
  if (idx !== -1) {
    return normalized.slice(idx + '/uploads/'.length);
  }
  return f.path.replace(/^.*uploads[/\\]/, '');
}

// ── POST /api/kyc/submit ──────────────────────────────────────────────────────

async function submitKyc(req, res) {
  const userId = req.user.sub;

  // ── 1. Guard: only one pending/approved KYC per user ─────────────────────
  try {
    const [existing] = await db.execute(
      `SELECT id, status,
              aadhaar_front_path, aadhaar_back_path,
              pan_front_path, selfie_path
         FROM kyc_submissions
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );

    if (existing.length > 0) {
      const prev = existing[0];

      if (prev.status === 'approved') {
        cleanupFiles(req.files);
        return fail(res, 'Your KYC is already verified.', 409);
      }

      if (prev.status === 'pending') {
        const docPaths = [
          prev.aadhaar_front_path,
          prev.aadhaar_back_path,
          prev.pan_front_path,
          prev.selfie_path,
        ];
        const filesIntact = docPaths.every(
          (p) => p && fs.existsSync(path.join(__dirname, '..', 'uploads', p))
        );

        if (filesIntact) {
          cleanupFiles(req.files);
          return fail(
            res,
            'A KYC submission is already under review. Please wait for the outcome.',
            409
          );
        }

        console.warn(
          `[kyc:submit] Discarding broken KYC submission #${prev.id} for user ${userId} ` +
          `(documents missing from disk) — allowing resubmission.`
        );
        await db.execute('DELETE FROM kyc_submissions WHERE id = ?', [prev.id]);
        // status === 'rejected' — allow re-submission; fall through
      }
    }
  } catch (err) {
    console.error('[kyc:submit guard]', err.message);
    cleanupFiles(req.files);
    return fail(
      res,
      'Database error during KYC check. Please ensure the schema has been run (npm run db:init) and try again.',
      500
    );
  }

  // ── 2. Validate required files ────────────────────────────────────────────
  const files = req.files || {};

  const aadhaarFront = files['aadhaar_front']?.[0];
  const aadhaarBack  = files['aadhaar_back']?.[0];
  const panFront     = files['pan_front']?.[0];
  const selfie       = files['selfie']?.[0];

  const missingFiles = [];
  if (!aadhaarFront) missingFiles.push('aadhaar_front');
  if (!aadhaarBack)  missingFiles.push('aadhaar_back');
  if (!panFront)     missingFiles.push('pan_front');
  if (!selfie)       missingFiles.push('selfie');

  if (missingFiles.length > 0) {
    cleanupFiles(files);
    return fail(res, `Missing required files: ${missingFiles.join(', ')}`, 422);
  }

  // ── 3. Validate bank fields ───────────────────────────────────────────────
  const {
    accountHolderName = '',
    accountNumber     = '',
    ifscCode          = '',
    bankName          = '',
    bankBranch        = '',
    bankCity          = '',
    bankState         = '',
  } = req.body;

  if (
    !accountHolderName.trim() ||
    accountNumber.trim().length < 9 ||
    ifscCode.trim().length !== 11
  ) {
    cleanupFiles(files);
    return fail(res, 'Invalid bank details. Please check and resubmit.', 422);
  }

  // ── 4. Persist to DB ──────────────────────────────────────────────────────
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `INSERT INTO kyc_submissions
         (user_id,
          aadhaar_front_path, aadhaar_back_path,
          pan_front_path,     selfie_path,
          account_holder_name, account_number,
          ifsc_code, bank_name, bank_branch,
          bank_city, bank_state,
          status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        userId,
        relPath(aadhaarFront),
        relPath(aadhaarBack),
        relPath(panFront),
        relPath(selfie),
        accountHolderName.trim(),
        accountNumber.trim(),
        ifscCode.trim().toUpperCase(),
        bankName.trim(),
        bankBranch.trim(),
        bankCity.trim(),
        bankState.trim(),
      ]
    );

    // Update kyc_status on the users row (safe — handles missing column)
    await setUserKycStatus(connection, userId, 'pending');

    await connection.commit();

    createNotification(
      userId,
      'kyc',
      'KYC Submitted',
      'Your KYC documents have been submitted and are under review by admin.'
    ).catch(e => console.error('[kyc:submit] notify error:', e.message));

    return ok(res, 'KYC submitted successfully. Verification is in progress.', {
      kycId: result.insertId,
      status: 'pending',
    }, 201);
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) { /* ignore */ }
    }
    cleanupFiles(files);
    console.error('[kyc:submit insert]', err.message, err.code);

    let message = 'KYC submission failed. Please try again.';
    if (err.code === 'ER_NO_SUCH_TABLE') {
      message = 'Database tables not found. Please run: mysql -u root -p < config/schema.sql';
    } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      message = 'Database access denied. Check your DB credentials in .env';
    } else if (err.code === 'ECONNREFUSED') {
      message = 'Cannot connect to database. Is MySQL running?';
    }

    return fail(res, message, 500);
  } finally {
    if (connection) connection.release();
  }
}

// ── GET /api/kyc/status ───────────────────────────────────────────────────────

async function getKycStatus(req, res) {
  const userId = req.user.sub;

  try {
    const [rows] = await db.execute(
      `SELECT
         id, status, rejection_reason,
         aadhaar_front_path, aadhaar_back_path,
         pan_front_path, selfie_path,
         account_holder_name, account_number,
         ifsc_code, bank_name, bank_branch,
         bank_city, bank_state,
         created_at, reviewed_at
       FROM kyc_submissions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return ok(res, 'No KYC submission found', { status: 'not_submitted' });
    }

    const kyc = rows[0];

    const data = {
      ...kyc,
      aadhaar_front_url: fileUrl(kyc.aadhaar_front_path, req),
      aadhaar_back_url:  fileUrl(kyc.aadhaar_back_path,  req),
      pan_front_url:     fileUrl(kyc.pan_front_path,     req),
      selfie_url:        fileUrl(kyc.selfie_path,        req),
      aadhaar_front_path: undefined,
      aadhaar_back_path:  undefined,
      pan_front_path:     undefined,
      selfie_path:        undefined,
    };

    return ok(res, 'KYC status fetched', data);
  } catch (err) {
    console.error('[kyc:status]', err);
    return fail(res, 'Could not fetch KYC status', 500);
  }
}

// ── PUT /api/kyc/:id/review  (admin only) ────────────────────────────────────

async function reviewKyc(req, res) {
  const { id } = req.params;
  const { action, reason = null } = req.body;

  if (!['approve', 'reject'].includes(action)) {
    return fail(res, "action must be 'approve' or 'reject'", 422);
  }

  if (action === 'reject' && (!reason || !reason.trim())) {
    return fail(res, 'A rejection reason is required', 422);
  }

  try {
    const [rows] = await db.execute(
      'SELECT id, user_id, status FROM kyc_submissions WHERE id = ? LIMIT 1',
      [id]
    );

    if (rows.length === 0) {
      return fail(res, 'KYC submission not found', 404);
    }

    const kyc = rows[0];

    if (kyc.status !== 'pending') {
      return fail(
        res,
        `Cannot review a submission that is already '${kyc.status}'`,
        409
      );
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await db.execute(
      `UPDATE kyc_submissions
         SET status = ?, rejection_reason = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [newStatus, action === 'reject' ? reason.trim() : null, id]
    );

    // Safe update — handles missing kyc_status column
    const conn = await db.getConnection();
    try {
      await setUserKycStatus(conn, kyc.user_id, newStatus);
    } finally {
      conn.release();
    }

    const message =
      action === 'approve'
        ? 'KYC approved successfully'
        : 'KYC rejected';

    createNotification(
      kyc.user_id,
      'kyc',
      action === 'approve' ? 'KYC Approved' : 'KYC Rejected',
      action === 'approve'
        ? 'Your KYC submission has been approved. You can now withdraw funds.'
        : `Your KYC submission was rejected.${reason ? ` Reason: ${reason.trim()}` : ''}`
    ).catch(e => console.error('[kyc:review] notify error:', e.message));

    return ok(res, message, { kycId: Number(id), status: newStatus });
  } catch (err) {
    console.error('[kyc:review]', err);
    return fail(res, 'Review action failed. Please try again.', 500);
  }
}

// ── GET /api/kyc/all  (admin only) ───────────────────────────────────────────

async function listKyc(req, res) {
  const { status } = req.query;

  // mysql2 prepared statements require true integer types for LIMIT/OFFSET
  const pageNum  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limitNum = Math.max(1, parseInt(req.query.limit || '20', 10));
  const offset   = (pageNum - 1) * limitNum;

  const allowedStatuses = ['pending', 'approved', 'rejected'];
  const userId = parseInt(req.query.user_id || '', 10);

  const clauses = [];
  const filterParams = [];
  if (status && allowedStatuses.includes(status)) {
    clauses.push('k.status = ?');
    filterParams.push(status);
  }
  if (Number.isInteger(userId) && userId > 0) {
    clauses.push('k.user_id = ?');
    filterParams.push(userId);
  }
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  try {
    // Use db.query() (non-prepared) instead of db.execute() for the paginated
    // SELECT. mysql2's prepared-statement executor (execute) rejects LIMIT/OFFSET
    // bound parameters with ER_WRONG_ARGUMENTS on some MySQL versions.
    // Injecting the integers directly is safe because they are validated above
    // via parseInt() and are guaranteed to be non-negative integers.
    const limitOffsetSql = `LIMIT ${limitNum} OFFSET ${offset}`;

    const [rows] = await db.query(
      `SELECT
         k.id, k.user_id, k.status, k.rejection_reason,
         k.account_holder_name, k.account_number, k.ifsc_code,
         k.bank_name, k.bank_branch, k.bank_city, k.bank_state,
         k.aadhaar_front_path, k.aadhaar_back_path,
         k.pan_front_path, k.selfie_path,
         k.created_at, k.reviewed_at,
         u.first_name, u.last_name, u.email, u.phone
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       ${whereClause}
       ORDER BY k.created_at DESC
       ${limitOffsetSql}`,
      filterParams   // only the optional status filter param — safe, user-supplied enum
    );

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM kyc_submissions k ${whereClause}`,
      filterParams
    );

    return ok(res, 'KYC list fetched', {
      submissions: rows,
      pagination: {
        page:  pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('[kyc:list]', err);
    return fail(res, 'Could not fetch KYC list', 500);
  }
}

// ── GET /api/kyc/:id  (admin only) ───────────────────────────────────────────

async function getKycById(req, res) {
  const { id } = req.params;

  try {
    const [rows] = await db.execute(
      `SELECT
         k.id, k.user_id, k.status, k.rejection_reason,
         k.account_holder_name, k.account_number, k.ifsc_code,
         k.bank_name, k.bank_branch, k.bank_city, k.bank_state,
         k.aadhaar_front_path, k.aadhaar_back_path,
         k.pan_front_path, k.selfie_path,
         k.created_at, k.reviewed_at,
         u.first_name, u.last_name, u.email, u.phone
       FROM kyc_submissions k
       JOIN users u ON u.id = k.user_id
       WHERE k.id = ?
       LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return fail(res, 'KYC submission not found', 404);
    }

    return ok(res, 'KYC submission fetched', rows[0]);
  } catch (err) {
    console.error('[kyc:getById]', err);
    return fail(res, 'Could not fetch KYC submission', 500);
  }
}

module.exports = { submitKyc, getKycStatus, reviewKyc, listKyc, getKycById };