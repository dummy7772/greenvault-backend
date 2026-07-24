// controllers/supportController.js
'use strict';

const db = require('../config/db');
const { ok, fail } = require('../utils/response');
const { createNotification } = require('./notificationController');

// ── Auto-migrate support tables on first load ─────────────────────────────────
let _tablesVerified = false;

async function ensureTables() {
  if (_tablesVerified) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        user_id     INT UNSIGNED  NOT NULL,
        subject     VARCHAR(255)  NOT NULL,
        message     TEXT          NOT NULL,
        status      ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
        created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_ticket_user   (user_id),
        KEY idx_ticket_status (status),
        CONSTRAINT fk_ticket_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS ticket_replies (
        id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
        ticket_id   INT UNSIGNED  NOT NULL,
        sender_id   INT UNSIGNED  NOT NULL,
        sender_type ENUM('user','admin') NOT NULL DEFAULT 'user',
        message     TEXT          NOT NULL,
        created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_reply_ticket (ticket_id),
        CONSTRAINT fk_reply_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE CASCADE,
        CONSTRAINT fk_reply_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    _tablesVerified = true;
    console.log('[support] Tables verified.');
  } catch (err) {
    console.error('[support] Table migration failed:', err.message);
  }
}

ensureTables();

// ── Helpers ───────────────────────────────────────────────────────────────────

function ticketDto(row) {
  return {
    id:         row.id,
    subject:    row.subject,
    message:    row.message,
    status:     row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // extras joined in admin list
    user_name:  row.user_name  ?? undefined,
    user_email: row.user_email ?? undefined,
    reply_count: row.reply_count ?? undefined,
  };
}

function replyDto(row) {
  return {
    id:          row.id,
    ticket_id:   row.ticket_id,
    sender_id:   row.sender_id,
    sender_type: row.sender_type,
    sender_name: row.sender_name ?? null,
    message:     row.message,
    created_at:  row.created_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// USER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/support/tickets
 * Body: { subject, message }
 * Creates a new ticket for the logged-in user.
 */
async function createTicket(req, res) {
  const userId  = req.user.sub;
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();

  if (!subject) return fail(res, 'Subject is required');
  if (!message) return fail(res, 'Message is required');
  if (subject.length > 255) return fail(res, 'Subject must be under 255 characters');

  try {
    const [result] = await db.execute(
      `INSERT INTO support_tickets (user_id, subject, message) VALUES (?, ?, ?)`,
      [userId, subject, message]
    );

    const [rows] = await db.execute(
      `SELECT * FROM support_tickets WHERE id = ?`,
      [result.insertId]
    );

    createNotification(
      userId,
      'system',
      'Support Ticket Submitted',
      `Your support ticket "${subject}" has been submitted. Our team will get back to you soon.`
    ).catch(e => console.error('[support] createTicket notify error:', e.message));

    return ok(res, 'Ticket created successfully', { ticket: ticketDto(rows[0]) }, 201);
  } catch (err) {
    console.error('[support] createTicket error:', err.message);
    return fail(res, 'Failed to create ticket', 500);
  }
}

/**
 * GET /api/support/tickets
 * Returns all tickets belonging to the logged-in user (newest first).
 */
async function getUserTickets(req, res) {
  const userId = req.user.sub;

  try {
    const [rows] = await db.execute(
      `SELECT
         t.*,
         (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id AND r.sender_type = 'admin') AS reply_count
       FROM support_tickets t
       WHERE t.user_id = ?
       ORDER BY t.updated_at DESC`,
      [userId]
    );

    return ok(res, 'Tickets fetched', { tickets: rows.map(ticketDto) });
  } catch (err) {
    console.error('[support] getUserTickets error:', err.message);
    return fail(res, 'Failed to fetch tickets', 500);
  }
}

/**
 * GET /api/support/tickets/:id
 * Returns one ticket + all its replies. Only the owning user can access.
 */
async function getTicketDetail(req, res) {
  const userId   = req.user.sub;
  const ticketId = parseInt(req.params.id, 10);

  if (!ticketId) return fail(res, 'Invalid ticket ID');

  try {
    const [[ticket]] = await db.execute(
      `SELECT * FROM support_tickets WHERE id = ? AND user_id = ?`,
      [ticketId, userId]
    );

    if (!ticket) return fail(res, 'Ticket not found', 404);

    const [replies] = await db.execute(
      `SELECT
         r.*,
         CONCAT(u.first_name, ' ', u.last_name) AS sender_name
       FROM ticket_replies r
       JOIN users u ON u.id = r.sender_id
       WHERE r.ticket_id = ?
       ORDER BY r.created_at ASC`,
      [ticketId]
    );

    return ok(res, 'Ticket detail fetched', {
      ticket:  ticketDto(ticket),
      replies: replies.map(replyDto),
    });
  } catch (err) {
    console.error('[support] getTicketDetail error:', err.message);
    return fail(res, 'Failed to fetch ticket', 500);
  }
}

/**
 * POST /api/support/tickets/:id/reply
 * Body: { message }
 * User adds a follow-up reply to their own ticket.
 */
async function userReply(req, res) {
  const userId   = req.user.sub;
  const ticketId = parseInt(req.params.id, 10);
  const message  = (req.body.message || '').trim();

  if (!ticketId) return fail(res, 'Invalid ticket ID');
  if (!message)  return fail(res, 'Message is required');

  try {
    // Verify ticket belongs to user
    const [[ticket]] = await db.execute(
      `SELECT id, status FROM support_tickets WHERE id = ? AND user_id = ?`,
      [ticketId, userId]
    );
    if (!ticket)           return fail(res, 'Ticket not found', 404);
    if (ticket.status === 'closed') return fail(res, 'This ticket is closed');

    const [result] = await db.execute(
      `INSERT INTO ticket_replies (ticket_id, sender_id, sender_type, message)
       VALUES (?, ?, 'user', ?)`,
      [ticketId, userId, message]
    );

    // Reopen ticket if it was resolved
    if (ticket.status === 'resolved') {
      await db.execute(
        `UPDATE support_tickets SET status = 'open' WHERE id = ?`,
        [ticketId]
      );
    } else {
      // Touch updated_at
      await db.execute(
        `UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [ticketId]
      );
    }

    const [[reply]] = await db.execute(
      `SELECT r.*, CONCAT(u.first_name, ' ', u.last_name) AS sender_name
       FROM ticket_replies r
       JOIN users u ON u.id = r.sender_id
       WHERE r.id = ?`,
      [result.insertId]
    );

    return ok(res, 'Reply sent', { reply: replyDto(reply) }, 201);
  } catch (err) {
    console.error('[support] userReply error:', err.message);
    return fail(res, 'Failed to send reply', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/support/admin/tickets
 * Query params: status (open|in_progress|resolved|closed), page, limit
 * Returns all tickets with user info and reply counts.
 */
async function adminListTickets(req, res) {
  const status = req.query.status || null;
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit  = Math.min(50, parseInt(req.query.limit || '20', 10));
  const offset = (page - 1) * limit;
  const userId = parseInt(req.query.user_id || '', 10);

  try {
    const whereClauses = [];
    const params       = [];

    if (status) {
      whereClauses.push('t.status = ?');
      params.push(status);
    }
    if (Number.isInteger(userId) && userId > 0) {
      whereClauses.push('t.user_id = ?');
      params.push(userId);
    }

    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [rows] = await db.execute(
      `SELECT
         t.*,
         CONCAT(u.first_name, ' ', u.last_name) AS user_name,
         u.email AS user_email,
         (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY
         CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         t.updated_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await db.execute(
      `SELECT COUNT(*) AS total FROM support_tickets t ${where}`,
      params
    );

    return ok(res, 'Tickets fetched', {
      tickets: rows.map(ticketDto),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error('[support] adminListTickets error:', err.message);
    return fail(res, 'Failed to fetch tickets', 500);
  }
}

/**
 * GET /api/support/admin/tickets/:id
 * Full ticket detail with all replies — for admin.
 */
async function adminGetTicket(req, res) {
  const ticketId = parseInt(req.params.id, 10);
  if (!ticketId) return fail(res, 'Invalid ticket ID');

  try {
    const [[ticket]] = await db.execute(
      `SELECT
         t.*,
         CONCAT(u.first_name, ' ', u.last_name) AS user_name,
         u.email AS user_email,
         u.phone AS user_phone
       FROM support_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
      [ticketId]
    );
    if (!ticket) return fail(res, 'Ticket not found', 404);

    const [replies] = await db.execute(
      `SELECT
         r.*,
         CONCAT(u.first_name, ' ', u.last_name) AS sender_name
       FROM ticket_replies r
       JOIN users u ON u.id = r.sender_id
       WHERE r.ticket_id = ?
       ORDER BY r.created_at ASC`,
      [ticketId]
    );

    return ok(res, 'Ticket detail fetched', {
      ticket:  ticketDto(ticket),
      replies: replies.map(replyDto),
    });
  } catch (err) {
    console.error('[support] adminGetTicket error:', err.message);
    return fail(res, 'Failed to fetch ticket', 500);
  }
}

/**
 * POST /api/support/admin/tickets/:id/reply
 * Body: { message, status? }
 * Admin replies to a ticket and optionally updates its status.
 */
async function adminReply(req, res) {
  const adminId  = req.user.sub;
  const ticketId = parseInt(req.params.id, 10);
  const message  = (req.body.message || '').trim();
  const newStatus = req.body.status || null;

  if (!ticketId) return fail(res, 'Invalid ticket ID');
  if (!message)  return fail(res, 'Message is required');

  const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
  if (newStatus && !VALID_STATUSES.includes(newStatus)) {
    return fail(res, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  try {
    const [[ticket]] = await db.execute(
      `SELECT id, user_id, subject, status FROM support_tickets WHERE id = ?`,
      [ticketId]
    );
    if (!ticket) return fail(res, 'Ticket not found', 404);

    // Insert the reply
    const [result] = await db.execute(
      `INSERT INTO ticket_replies (ticket_id, sender_id, sender_type, message)
       VALUES (?, ?, 'admin', ?)`,
      [ticketId, adminId, message]
    );

    // Update ticket status: if a specific new status is provided, use it;
    // otherwise auto-advance open → in_progress
    const statusToSet = newStatus
      ? newStatus
      : ticket.status === 'open' ? 'in_progress' : ticket.status;

    await db.execute(
      `UPDATE support_tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [statusToSet, ticketId]
    );

    createNotification(
      ticket.user_id,
      'system',
      'New Reply on Your Ticket',
      `Support replied to your ticket "${ticket.subject}". Tap to view the response.`
    ).catch(e => console.error('[support] adminReply notify error:', e.message));

    const [[reply]] = await db.execute(
      `SELECT r.*, CONCAT(u.first_name, ' ', u.last_name) AS sender_name
       FROM ticket_replies r
       JOIN users u ON u.id = r.sender_id
       WHERE r.id = ?`,
      [result.insertId]
    );

    return ok(res, 'Reply sent', {
      reply:      replyDto(reply),
      new_status: statusToSet,
    }, 201);
  } catch (err) {
    console.error('[support] adminReply error:', err.message);
    return fail(res, 'Failed to send reply', 500);
  }
}

/**
 * PUT /api/support/admin/tickets/:id/status
 * Body: { status }
 * Admin updates ticket status without adding a reply.
 */
async function adminUpdateStatus(req, res) {
  const ticketId  = parseInt(req.params.id, 10);
  const newStatus = (req.body.status || '').trim();

  if (!ticketId) return fail(res, 'Invalid ticket ID');

  const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
  if (!VALID_STATUSES.includes(newStatus)) {
    return fail(res, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  try {
    const [result] = await db.execute(
      `UPDATE support_tickets SET status = ? WHERE id = ?`,
      [newStatus, ticketId]
    );
    if (result.affectedRows === 0) return fail(res, 'Ticket not found', 404);

    return ok(res, `Ticket marked as ${newStatus}`);
  } catch (err) {
    console.error('[support] adminUpdateStatus error:', err.message);
    return fail(res, 'Failed to update status', 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SUPPORT ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/support/email
 * Body: { subject, message }
 * Authenticated. Sends an email TO manikandan.455.t@gmail.com
 * using the user's registered email as the Reply-To / From display.
 *
 * Requires env vars:
 *   MAIL_HOST, MAIL_PORT, MAIL_USER, MAIL_PASS
 *   SUPPORT_TO_EMAIL  (defaults to manikandan.455.t@gmail.com)
 */
async function sendSupportEmail(req, res) {
  const userId  = req.user.sub;
  const subject = (req.body.subject || '').trim();
  const message = (req.body.message || '').trim();

  if (!subject) return fail(res, 'Subject is required');
  if (!message) return fail(res, 'Message is required');
  if (subject.length > 255) return fail(res, 'Subject must be under 255 characters');

  try {
    // Fetch the user's email from DB
    const [[user]] = await db.execute(
      `SELECT id, email, CONCAT(first_name, ' ', last_name) AS full_name FROM users WHERE id = ?`,
      [userId]
    );
    if (!user) return fail(res, 'User not found', 404);

    const nodemailer  = require('nodemailer');
    const supportTo   = process.env.SUPPORT_TO_EMAIL || 'manikandan.455.t@gmail.com';

    const transporter = nodemailer.createTransport({
      host:   process.env.MAIL_HOST   || 'smtp.gmail.com',
      port:   parseInt(process.env.MAIL_PORT || '587', 10),
      secure: process.env.MAIL_PORT === '465',
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });

    // Gmail SMTP requires "from" to match the authenticated MAIL_USER account.
    // We display the user's identity in the subject/body/replyTo instead.
    await transporter.sendMail({
      from:    `"GreenVault Support" <${process.env.MAIL_USER}>`,
      replyTo: `"${user.full_name}" <${user.email}>`,
      to:      supportTo,
      subject: `[GreenVault Support] ${subject}`,
      text:    `From: ${user.full_name} (${user.email})\n\n${message}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#3D9E6A;padding:20px 24px;border-radius:8px 8px 0 0">
            <h2 style="color:#fff;margin:0;font-size:18px">GreenVault — Support Request</h2>
          </div>
          <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
            <p style="margin:0 0 8px 0;color:#374151"><strong>From:</strong> ${user.full_name} &lt;${user.email}&gt;</p>
            <p style="margin:0 0 16px 0;color:#374151"><strong>Subject:</strong> ${subject}</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>
            <p style="color:#111827;white-space:pre-wrap;line-height:1.6">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
          </div>
          <p style="color:#9ca3af;font-size:11px;margin-top:12px;text-align:center">
            Reply directly to this email to respond to the user.
          </p>
        </div>
      `,
    });

    return ok(res, 'Email sent successfully');
  } catch (err) {
    console.error('[support] sendSupportEmail error:', err.message);
    return fail(res, 'Failed to send email. Please try again later.', 500);
  }
}

module.exports = {
  // user
  createTicket,
  getUserTickets,
  getTicketDetail,
  userReply,
  sendSupportEmail,
  // admin
  adminListTickets,
  adminGetTicket,
  adminReply,
  adminUpdateStatus,
};