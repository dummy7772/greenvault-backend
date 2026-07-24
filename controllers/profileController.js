// controllers/profileController.js
'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');

// ── Constants ─────────────────────────────────────────────────────────────────
const VALID_GENDERS = new Set(['male', 'female', 'other', 'prefer_not_to_say']);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a MySQL DATE value (which arrives as a JS Date object or string)
 * into the "YYYY-MM-DD" string the Flutter client expects.
 */
function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }
  // Already a string — normalise to YYYY-MM-DD
  const str = String(value);
  const dt = new Date(str);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString().split('T')[0];
}

/**
 * Build the uniform profile payload sent to the client.
 */
function buildProfilePayload(u) {
  return {
    id:             u.id,
    member_id:      u.member_id || null,
    first_name:     u.first_name,
    last_name:      u.last_name,
    full_name:      `${u.first_name} ${u.last_name}`.trim(),
    email:          u.email,
    phone:          u.phone,
    phone_verified: u.phone_verified === 1 || u.phone_verified === true,
    email_verified: u.email_verified === 1 || u.email_verified === true,
    profile_image:  u.profile_image  || null,
    date_of_birth:  formatDate(u.date_of_birth),
    gender:         u.gender  || null,
    address:        u.address || null,
    created_at:     u.created_at || null,
  };
}

/**
 * Validate that a string is a valid ISO date (YYYY-MM-DD) and is not in the future.
 * Returns the normalised "YYYY-MM-DD" string or null if input is falsy.
 * Throws a descriptive Error on bad input.
 */
function validateDob(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    throw new Error('date_of_birth must be in YYYY-MM-DD format');
  }
  const dt = new Date(str);
  if (isNaN(dt.getTime())) {
    throw new Error('date_of_birth is not a valid date');
  }
  if (dt > new Date()) {
    throw new Error('date_of_birth cannot be in the future');
  }
  return str;
}

// ── One-time migration: add profile columns if schema is behind ───────────────
// This keeps the server self-healing on older DBs while schema.sql is the
// canonical source of truth going forward.
let _migrated = false;

async function ensureProfileColumns() {
  if (_migrated) return;
  const additions = [
    {
      col: 'profile_image',
      sql: `ALTER TABLE users ADD COLUMN profile_image VARCHAR(512) DEFAULT NULL`,
    },
    {
      col: 'date_of_birth',
      sql: `ALTER TABLE users ADD COLUMN date_of_birth DATE DEFAULT NULL`,
    },
    {
      col: 'gender',
      sql: `ALTER TABLE users ADD COLUMN gender ENUM('male','female','other','prefer_not_to_say') DEFAULT NULL`,
    },
    {
      col: 'address',
      sql: `ALTER TABLE users ADD COLUMN address TEXT DEFAULT NULL`,
    },
  ];

  for (const { col, sql } of additions) {
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
      console.log(`[profile] ✅ added column: ${col}`);
    }
  }
  _migrated = true;
}

// Run once at startup — non-fatal; individual handlers call it again as a guard.
ensureProfileColumns().catch(err =>
  console.error('[profile] startup migration error:', err.message)
);

// ── GET /api/profile ──────────────────────────────────────────────────────────
async function getProfile(req, res) {
  const userId = req.user.sub;

  try {
    await ensureProfileColumns();

    const [rows] = await db.execute(
      `SELECT id, member_id, first_name, last_name, email, phone,
              phone_verified, email_verified,
              profile_image, date_of_birth, gender, address,
              created_at
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found', 404);
    }

    return ok(res, 'Profile fetched', buildProfilePayload(rows[0]));
  } catch (err) {
    console.error('[profile] getProfile error:', err.message);
    return fail(res, 'Could not fetch profile', 500);
  }
}

// ── PUT /api/profile/update ───────────────────────────────────────────────────
async function updateProfile(req, res) {
  const userId = req.user.sub;
  const { first_name, last_name, date_of_birth, gender, address } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  const trimmedFirst = (first_name || '').trim();
  if (!trimmedFirst) {
    return fail(res, 'First name is required');
  }
  if (trimmedFirst.length > 60) {
    return fail(res, 'First name must not exceed 60 characters');
  }

  const trimmedLast = (last_name || '').trim();
  if (trimmedLast.length > 60) {
    return fail(res, 'Last name must not exceed 60 characters');
  }

  // Validate gender if provided
  const safeGender = gender ? String(gender).trim().toLowerCase() : null;
  if (safeGender && !VALID_GENDERS.has(safeGender)) {
    return fail(res, `gender must be one of: ${[...VALID_GENDERS].join(', ')}`);
  }

  // Validate and normalise date of birth
  let safeDob;
  try {
    safeDob = validateDob(date_of_birth);
  } catch (e) {
    return fail(res, e.message);
  }

  const safeAddress = (address || '').trim() || null;
  if (safeAddress && safeAddress.length > 500) {
    return fail(res, 'Address must not exceed 500 characters');
  }

  // ── Persist ─────────────────────────────────────────────────────────────────
  try {
    await ensureProfileColumns();

    await db.execute(
      `UPDATE users
          SET first_name    = ?,
              last_name     = ?,
              date_of_birth = ?,
              gender        = ?,
              address       = ?
        WHERE id = ?`,
      [trimmedFirst, trimmedLast, safeDob, safeGender, safeAddress, userId]
    );

    const [rows] = await db.execute(
      `SELECT id, member_id, first_name, last_name, email, phone,
              phone_verified, email_verified,
              profile_image, date_of_birth, gender, address
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [userId]
    );

    if (rows.length === 0) {
      return fail(res, 'User not found after update', 404);
    }

    createNotification(
      userId,
      'system',
      'Profile Updated',
      'Your profile details have been updated successfully.'
    ).catch(e => console.error('[profile] updateProfile notify error:', e.message));

    return ok(res, 'Profile updated successfully', buildProfilePayload(rows[0]));
  } catch (err) {
    console.error('[profile] updateProfile error:', err.message);
    return fail(res, 'Failed to update profile', 500);
  }
}

// ── POST /api/profile/avatar ──────────────────────────────────────────────────
async function uploadAvatar(req, res) {
  const userId = req.user.sub;

  if (!req.file) {
    return fail(res, 'No image file provided', 422);
  }

  // If Cloudinary is active, f.path holds the CDN URL; store it directly.
  // For local disk, build the relative path as before.
  const storedValue = req.file.path && req.file.path.startsWith('http')
    ? req.file.path
    : `avatars/${userId}/${req.file.filename}`;

  try {
    await ensureProfileColumns();

    // Delete old avatar (Cloudinary or disk)
    const [rows] = await db.execute(
      'SELECT profile_image FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    const oldStored = rows[0]?.profile_image;
    if (oldStored) {
      if (oldStored.startsWith('http')) {
        // Cloudinary: extract public_id and destroy
        try {
          const cloudinary = require('cloudinary').v2;
          // public_id is everything after the last slash, minus the extension
          const urlParts = oldStored.split('/');
          const folder   = urlParts.slice(-2, -1)[0]; // e.g. "7"
          const file     = urlParts[urlParts.length - 1].split('.')[0]; // e.g. "avatar-123"
          await cloudinary.uploader.destroy(`avatars/${folder}/${file}`);
        } catch (_) { /* non-fatal */ }
      } else {
        const oldFull = path.join(__dirname, '..', 'uploads', oldStored);
        if (fs.existsSync(oldFull)) {
          fs.unlinkSync(oldFull);
        }
      }
    }

    await db.execute(
      'UPDATE users SET profile_image = ? WHERE id = ?',
      [storedValue, userId]
    );

    createNotification(
      userId,
      'system',
      'Profile Photo Updated',
      'Your profile photo has been updated successfully.'
    ).catch(e => console.error('[profile] uploadAvatar notify error:', e.message));

    return ok(res, 'Avatar uploaded', { profile_image: storedValue });
  } catch (err) {
    // If DB update fails, clean up the newly uploaded file
    if (storedValue.startsWith('http')) {
      try {
        const cloudinary = require('cloudinary').v2;
        if (req.file.filename) await cloudinary.uploader.destroy(req.file.filename);
      } catch (_) {}
    } else {
      const newFull = path.join(__dirname, '..', 'uploads', storedValue);
      if (fs.existsSync(newFull)) {
        try { fs.unlinkSync(newFull); } catch (_) {}
      }
    }
    console.error('[profile] uploadAvatar error:', err.message);
    return fail(res, 'Failed to save avatar', 500);
  }
}

// ── DELETE /api/profile/avatar ────────────────────────────────────────────────
async function deleteAvatar(req, res) {
  const userId = req.user.sub;

  try {
    await ensureProfileColumns();

    const [rows] = await db.execute(
      'SELECT profile_image FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    const storedValue = rows[0]?.profile_image;

    if (storedValue) {
      if (storedValue.startsWith('http')) {
        // Cloudinary: extract public_id and destroy
        try {
          const cloudinary = require('cloudinary').v2;
          const urlParts = storedValue.split('/');
          const folder   = urlParts.slice(-2, -1)[0];
          const file     = urlParts[urlParts.length - 1].split('.')[0];
          await cloudinary.uploader.destroy(`avatars/${folder}/${file}`);
        } catch (_) { /* non-fatal */ }
      } else {
        const fullPath = path.join(__dirname, '..', 'uploads', storedValue);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
    }

    await db.execute(
      'UPDATE users SET profile_image = NULL WHERE id = ?',
      [userId]
    );

    createNotification(
      userId,
      'system',
      'Profile Photo Removed',
      'Your profile photo has been removed.'
    ).catch(e => console.error('[profile] deleteAvatar notify error:', e.message));

    return ok(res, 'Avatar removed');
  } catch (err) {
    console.error('[profile] deleteAvatar error:', err.message);
    return fail(res, 'Failed to remove avatar', 500);
  }
}

module.exports = { getProfile, updateProfile, uploadAvatar, deleteAvatar };