// routes/support.js
'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  createTicket,
  getUserTickets,
  getTicketDetail,
  userReply,
  sendSupportEmail,
  adminListTickets,
  adminGetTicket,
  adminReply,
  adminUpdateStatus,
} = require('../controllers/supportController');

const router = express.Router();

// ── User routes ───────────────────────────────────────────────────────────────

// POST   /api/support/tickets          — create ticket
router.post('/tickets', authenticate, createTicket);

// GET    /api/support/tickets          — list my tickets
router.get('/tickets', authenticate, getUserTickets);

// GET    /api/support/tickets/:id      — ticket detail + replies
router.get('/tickets/:id', authenticate, getTicketDetail);

// POST   /api/support/tickets/:id/reply  — user follow-up reply
router.post('/tickets/:id/reply', authenticate, userReply);

// POST   /api/support/email            — send email to support (from user's login email)
router.post('/email', authenticate, sendSupportEmail);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET    /api/support/admin/tickets              — list all tickets (filterable)
router.get('/admin/tickets', authenticate, requireAdmin, adminListTickets);

// GET    /api/support/admin/tickets/:id          — full ticket detail
router.get('/admin/tickets/:id', authenticate, requireAdmin, adminGetTicket);

// POST   /api/support/admin/tickets/:id/reply    — admin reply (+ optional status)
router.post('/admin/tickets/:id/reply', authenticate, requireAdmin, adminReply);

// PUT    /api/support/admin/tickets/:id/status   — change status only
router.put('/admin/tickets/:id/status', authenticate, requireAdmin, adminUpdateStatus);

module.exports = router;