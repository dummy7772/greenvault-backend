// routes/push.js
const express = require('express');
const router  = express.Router();

const { authenticate } = require('../middleware/auth');
const { registerToken, unregisterToken } = require('../controllers/pushController');

// All routes require a valid JWT
router.use(authenticate);

// POST /api/push/register-token    — save/refresh this device's FCM token
router.post('/register-token',   registerToken);

// POST /api/push/unregister-token  — remove this device's FCM token (logout)
router.post('/unregister-token', unregisterToken);

module.exports = router;