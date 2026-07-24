// routes/profile.js
'use strict';

const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const { authenticate } = require('../middleware/auth');
const {
  getProfile,
  updateProfile,
  uploadAvatar,
  deleteAvatar,
} = require('../controllers/profileController');

const router = express.Router();

// ── Cloudinary configuration ──────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Rate limiter for avatar uploads (prevents abuse) ─────────────────────────
const avatarUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour
  max: 10,                      // max 10 avatar uploads per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many avatar uploads. Try again later.' },
});

// ── Multer storage for profile avatars ───────────────────────────────────────

const useCloudinary =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let storage;

if (useCloudinary) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: (req, file) => ({
      folder: `avatars/${req.user?.sub || 'unknown'}`,
      public_id: `avatar-${Date.now()}`,
      resource_type: 'image',
      format: undefined,
    }),
  });
} else {
  storage = multer.diskStorage({
    destination(req, _file, cb) {
      const userId = req.user?.sub || 'unknown';
      const dir = path.join(__dirname, '..', 'uploads', 'avatars', String(userId));
      try {
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `avatar-${Date.now()}${ext}`);
    },
  });
}

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const ALLOWED_MIMES      = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  // Some Android devices send octet-stream for HEIC
  'application/octet-stream',
]);

function fileFilter(_req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext) || ALLOWED_MIMES.has(mime)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPEG, PNG, WebP and HEIC images are allowed'));
  }
}

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },  // 5 MB
  fileFilter,
});

// Wrap multer so we can return a consistent JSON error instead of a raw 500
function handleAvatarUpload(req, res, next) {
  upload.single('avatar')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be under 5 MB'
        : err.message || 'File upload error';
      return res.status(422).json({ success: false, message: msg });
    }
    return res.status(500).json({ success: false, message: 'Upload failed' });
  });
}

// ── All profile routes require authentication ─────────────────────────────────
router.use(authenticate);

// GET  /api/profile          — fetch current user's full profile
router.get('/', getProfile);

// PUT  /api/profile/update   — update name, date of birth, gender, address
router.put('/update', updateProfile);

// POST /api/profile/avatar   — upload or replace profile picture
router.post('/avatar', avatarUploadLimiter, handleAvatarUpload, uploadAvatar);

// DELETE /api/profile/avatar — remove profile picture
router.delete('/avatar', deleteAvatar);

module.exports = router;