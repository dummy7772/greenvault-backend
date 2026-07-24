// controllers/adminSettingsController.js
'use strict';

const os   = require('os');
const db   = require('../config/db');
const { ok, fail } = require('../utils/response');
const pkg  = require('../package.json');

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_NOTIFICATION_PREFS = {
  kyc_submissions:      true,
  deposit_requests:     true,
  withdrawal_requests:  true,
  plan_instalments:     true,
  support_tickets:      true,
  system_alerts:        true,
  weekly_summary_email: true,
  marketing_updates:    false,
  sound_on_new_alert:   false,
  channel:              'email', // 'email' | 'push' | 'both'
};

const DEFAULT_THEME_PREFS = {
  mode:          'light',       // 'light' | 'dark' | 'system'
  accent:        'sage',        // 'sage' | 'gold' | 'ocean' | 'violet'
  density:       'comfortable', // 'comfortable' | 'compact'
  sidebar_style: 'expanded',    // 'expanded' | 'icons'
};

const VALID_CHANNELS      = new Set(['email', 'push', 'both']);
const VALID_MODES         = new Set(['light', 'dark', 'system']);
const VALID_ACCENTS       = new Set(['sage', 'gold', 'ocean', 'violet']);
const VALID_DENSITIES     = new Set(['comfortable', 'compact']);
const VALID_SIDEBAR_STYLE = new Set(['expanded', 'icons']);

// ── One-time migration: add admin-settings columns if schema is behind ────────
let _migrated = false;

async function ensureAdminSettingsColumns() {
  if (_migrated) return;
  const additions = [
    { col: 'department',          sql: `ALTER TABLE users ADD COLUMN department VARCHAR(120) DEFAULT NULL` },
    { col: 'employee_id',         sql: `ALTER TABLE users ADD COLUMN employee_id VARCHAR(50) DEFAULT NULL` },
    { col: 'notification_prefs',  sql: `ALTER TABLE users ADD COLUMN notification_prefs JSON DEFAULT NULL` },
    { col: 'theme_prefs',         sql: `ALTER TABLE users ADD COLUMN theme_prefs JSON DEFAULT NULL` },
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
      console.log(`[admin-settings] ✅ added column: ${col}`);
    }
  }
  _migrated = true;
}

// Run once at startup — non-fatal; individual handlers call it again as a guard.
ensureAdminSettingsColumns().catch(err =>
  console.error('[admin-settings] startup migration error:', err.message)
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const dt = new Date(String(value));
  return isNaN(dt.getTime()) ? null : dt.toISOString().split('T')[0];
}

/** mysql2 already parses JSON columns into JS objects/arrays; guard against
 *  legacy string storage just in case. */
function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return { ...fallback };
  if (typeof value === 'object') return { ...fallback, ...value };
  try {
    return { ...fallback, ...JSON.parse(value) };
  } catch {
    return { ...fallback };
  }
}

function formatUptime(seconds) {
  const days  = Math.floor(seconds / 86400);
  const hrs   = Math.floor((seconds % 86400) / 3600);
  const mins  = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hrs || days) parts.push(`${hrs} hour${hrs === 1 ? '' : 's'}`);
  parts.push(`${mins} minute${mins === 1 ? '' : 's'}`);
  return parts.join(', ');
}

// ── GET /api/admin/settings/profile ───────────────────────────────────────────
async function getAdminProfile(req, res) {
  const adminId = req.user.sub;

  try {
    await ensureAdminSettingsColumns();

    const [rows] = await db.execute(
      `SELECT id, first_name, last_name, email, phone, role,
              department, employee_id, profile_image,
              date_of_birth, gender, address, created_at
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [adminId]
    );

    if (rows.length === 0) {
      return fail(res, 'Admin account not found', 404);
    }

    const u = rows[0];

    // Self-heal a stable, human-readable Employee ID the first time this
    // admin's profile is ever fetched — avoids requiring a manual DB edit.
    let employeeId = u.employee_id;
    if (!employeeId) {
      employeeId = `MT-ADM-${String(u.id).padStart(3, '0')}`;
      await db.execute('UPDATE users SET employee_id = ? WHERE id = ?', [employeeId, u.id]);
    }

    // Best-effort last login lookup — login_history is populated by the
    // existing POST /api/security/login-history/record endpoint.
    let lastLogin = null;
    try {
      const [loginRows] = await db.execute(
        `SELECT created_at FROM login_history
          WHERE user_id = ? AND success = 1
          ORDER BY created_at DESC LIMIT 1`,
        [adminId]
      );
      lastLogin = loginRows[0]?.created_at || null;
    } catch {
      // login_history table not yet created — ignore, non-fatal.
    }

    return ok(res, 'Admin profile fetched', {
      id:             u.id,
      first_name:     u.first_name,
      last_name:      u.last_name,
      full_name:      `${u.first_name} ${u.last_name}`.trim(),
      email:          u.email,
      phone:          u.phone,
      role:           u.role,
      department:     u.department || null,
      employee_id:    employeeId,
      profile_image:  u.profile_image || null,
      date_of_birth:  formatDate(u.date_of_birth),
      gender:         u.gender || null,
      address:        u.address || null,
      joined_date:    formatDate(u.created_at),
      last_login:     lastLogin,
    });
  } catch (err) {
    console.error('[admin-settings] getAdminProfile error:', err.message);
    return fail(res, 'Could not fetch admin profile', 500);
  }
}

// ── PUT /api/admin/settings/profile ───────────────────────────────────────────
async function updateAdminProfile(req, res) {
  const adminId = req.user.sub;
  const { first_name, last_name, email, phone, department } = req.body;

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

  const trimmedEmail = (email || '').trim().toLowerCase();
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return fail(res, 'A valid email address is required');
  }

  const trimmedPhone = (phone || '').trim();
  if (trimmedPhone && !/^\+?[0-9\s-]{7,15}$/.test(trimmedPhone)) {
    return fail(res, 'Enter a valid phone number');
  }

  const trimmedDept = (department || '').trim() || null;
  if (trimmedDept && trimmedDept.length > 120) {
    return fail(res, 'Department must not exceed 120 characters');
  }

  try {
    await ensureAdminSettingsColumns();

    const [emailOwner] = await db.execute(
      'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1',
      [trimmedEmail, adminId]
    );
    if (emailOwner.length > 0) {
      return fail(res, 'This email address is already in use', 409);
    }

    await db.execute(
      `UPDATE users
          SET first_name = ?, last_name = ?, email = ?, phone = ?, department = ?
        WHERE id = ?`,
      [trimmedFirst, trimmedLast, trimmedEmail, trimmedPhone || null, trimmedDept, adminId]
    );

    return getAdminProfile(req, res);
  } catch (err) {
    console.error('[admin-settings] updateAdminProfile error:', err.message);
    return fail(res, 'Failed to update admin profile', 500);
  }
}

// ── GET /api/admin/settings/notifications ─────────────────────────────────────
async function getNotificationPreferences(req, res) {
  try {
    await ensureAdminSettingsColumns();

    const [rows] = await db.execute(
      'SELECT notification_prefs FROM users WHERE id = ? LIMIT 1',
      [req.user.sub]
    );
    if (rows.length === 0) return fail(res, 'Admin account not found', 404);

    return ok(res, 'Notification preferences fetched',
      parseJsonColumn(rows[0].notification_prefs, DEFAULT_NOTIFICATION_PREFS));
  } catch (err) {
    console.error('[admin-settings] getNotificationPreferences error:', err.message);
    return fail(res, 'Could not fetch notification preferences', 500);
  }
}

// ── PUT /api/admin/settings/notifications ─────────────────────────────────────
async function updateNotificationPreferences(req, res) {
  const adminId = req.user.sub;

  try {
    await ensureAdminSettingsColumns();

    const [rows] = await db.execute(
      'SELECT notification_prefs FROM users WHERE id = ? LIMIT 1',
      [adminId]
    );
    if (rows.length === 0) return fail(res, 'Admin account not found', 404);

    const current = parseJsonColumn(rows[0].notification_prefs, DEFAULT_NOTIFICATION_PREFS);
    const body    = req.body || {};

    if (body.channel !== undefined && !VALID_CHANNELS.has(body.channel)) {
      return fail(res, `channel must be one of: ${[...VALID_CHANNELS].join(', ')}`);
    }

    const booleanKeys = [
      'kyc_submissions', 'deposit_requests', 'withdrawal_requests', 'plan_instalments',
      'support_tickets', 'system_alerts', 'weekly_summary_email', 'marketing_updates',
      'sound_on_new_alert',
    ];
    const updated = { ...current };
    for (const key of booleanKeys) {
      if (body[key] !== undefined) updated[key] = !!body[key];
    }
    if (body.channel !== undefined) updated.channel = body.channel;

    await db.execute(
      'UPDATE users SET notification_prefs = ? WHERE id = ?',
      [JSON.stringify(updated), adminId]
    );

    return ok(res, 'Notification preferences saved', updated);
  } catch (err) {
    console.error('[admin-settings] updateNotificationPreferences error:', err.message);
    return fail(res, 'Failed to save notification preferences', 500);
  }
}

// ── GET /api/admin/settings/theme ─────────────────────────────────────────────
async function getThemePreferences(req, res) {
  try {
    await ensureAdminSettingsColumns();

    const [rows] = await db.execute(
      'SELECT theme_prefs FROM users WHERE id = ? LIMIT 1',
      [req.user.sub]
    );
    if (rows.length === 0) return fail(res, 'Admin account not found', 404);

    return ok(res, 'Theme preferences fetched',
      parseJsonColumn(rows[0].theme_prefs, DEFAULT_THEME_PREFS));
  } catch (err) {
    console.error('[admin-settings] getThemePreferences error:', err.message);
    return fail(res, 'Could not fetch theme preferences', 500);
  }
}

// ── PUT /api/admin/settings/theme ─────────────────────────────────────────────
async function updateThemePreferences(req, res) {
  const adminId = req.user.sub;
  const { mode, accent, density, sidebar_style } = req.body || {};

  if (mode !== undefined && !VALID_MODES.has(mode)) {
    return fail(res, `mode must be one of: ${[...VALID_MODES].join(', ')}`);
  }
  if (accent !== undefined && !VALID_ACCENTS.has(accent)) {
    return fail(res, `accent must be one of: ${[...VALID_ACCENTS].join(', ')}`);
  }
  if (density !== undefined && !VALID_DENSITIES.has(density)) {
    return fail(res, `density must be one of: ${[...VALID_DENSITIES].join(', ')}`);
  }
  if (sidebar_style !== undefined && !VALID_SIDEBAR_STYLE.has(sidebar_style)) {
    return fail(res, `sidebar_style must be one of: ${[...VALID_SIDEBAR_STYLE].join(', ')}`);
  }

  try {
    await ensureAdminSettingsColumns();

    const [rows] = await db.execute(
      'SELECT theme_prefs FROM users WHERE id = ? LIMIT 1',
      [adminId]
    );
    if (rows.length === 0) return fail(res, 'Admin account not found', 404);

    const current = parseJsonColumn(rows[0].theme_prefs, DEFAULT_THEME_PREFS);
    const updated = {
      mode:          mode          !== undefined ? mode          : current.mode,
      accent:        accent        !== undefined ? accent        : current.accent,
      density:       density       !== undefined ? density       : current.density,
      sidebar_style: sidebar_style !== undefined ? sidebar_style : current.sidebar_style,
    };

    await db.execute(
      'UPDATE users SET theme_prefs = ? WHERE id = ?',
      [JSON.stringify(updated), adminId]
    );

    return ok(res, 'Theme preferences saved', updated);
  } catch (err) {
    console.error('[admin-settings] updateThemePreferences error:', err.message);
    return fail(res, 'Failed to save theme preferences', 500);
  }
}

// ── GET /api/admin/settings/system-info ───────────────────────────────────────
async function getSystemInfo(req, res) {
  let databaseStatus = 'Healthy';
  try {
    await db.execute('SELECT 1');
  } catch {
    databaseStatus = 'Unreachable';
  }

  const apiBaseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;

  return ok(res, 'System information fetched', {
    app_name:        'Moneytries Admin Console',
    app_version:      pkg.version || '1.0.0',
    environment:      process.env.NODE_ENV || 'development',
    api_base_url:     apiBaseUrl,
    node_version:      process.version,
    server_region:     process.env.SERVER_REGION || 'Not configured',
    database_status:   databaseStatus,
    uptime:            formatUptime(process.uptime()),
    server_time:       new Date().toISOString(),
    hostname:          os.hostname(),
    support_email:     process.env.SUPPORT_EMAIL || 'support@moneytries.app',
  });
}

module.exports = {
  getAdminProfile,
  updateAdminProfile,
  getNotificationPreferences,
  updateNotificationPreferences,
  getThemePreferences,
  updateThemePreferences,
  getSystemInfo,
};