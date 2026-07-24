// routes/deposit.js
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const { authenticate }  = require('../middleware/auth');
const { requireAdmin }  = require('../middleware/admin');
const {
  uploadScreenshot,
  createDeposit,
  listDeposits,
  adminListDeposits,
  getDepositById,
  adminReviewDeposit,
} = require('../controllers/depositController');

const router = express.Router();

// ── Cloudinary configuration ──────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Multer storage for deposit screenshots ────────────────────────────────────

const useCloudinary =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let storage;

if (useCloudinary) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: (req, file) => ({
      folder: `deposits/${req.user?.sub || 'unknown'}`,
      public_id: `screenshot-${Date.now()}`,
      resource_type: 'image',
      format: undefined,
    }),
  });
} else {
  storage = multer.diskStorage({
    destination(req, _file, cb) {
      const userId = req.user?.sub || 'unknown';
      const dir = path.join(__dirname, '..', 'uploads', 'deposits', String(userId));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `screenshot-${Date.now()}${ext}`);
    },
  });
}

// Image extensions that are always acceptable regardless of reported MIME type.
// Android devices frequently send application/octet-stream for gallery images,
// so we validate by extension as the primary signal.
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.bmp', '.gif']);

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'image/heic', 'image/heif', 'image/bmp', 'image/gif',
  // Android image picker sometimes reports these generic types
  'application/octet-stream',
  'application/jpeg',
]);

function fileFilter(_req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();

  // Accept if either the extension OR the MIME type is on the allow-list.
  // This handles Android sending application/octet-stream for real images.
  if (ALLOWED_EXTENSIONS.has(ext) || ALLOWED_MIMES.has(mime)) {
    cb(null, true);
  } else {
    cb(null, false); // silently reject — uploadScreenshot will return 422
  }
}

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

// ── User routes ───────────────────────────────────────────────────────────────

// POST /api/deposit/upload  — upload payment screenshot, get back its URL
router.post('/upload', authenticate, upload.single('file'), uploadScreenshot);

// POST /api/deposit/submit  — submit deposit with amount, UTR, proof URL
router.post('/submit', authenticate, createDeposit);

// POST /api/deposit/list  — user's own deposit history (matches Flutter body format)
router.post('/list', authenticate, listDeposits);

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET  /api/deposit/admin/all
router.get('/admin/all', authenticate, requireAdmin, adminListDeposits);

// GET  /api/deposit/admin/:id  — single deposit detail (admin review modal)
router.get('/admin/:id', authenticate, requireAdmin, getDepositById);

// PUT  /api/deposit/admin/:id/review
router.put('/admin/:id/review', authenticate, requireAdmin, adminReviewDeposit);

module.exports = router;