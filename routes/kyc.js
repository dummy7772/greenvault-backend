// routes/kyc.js
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const { authenticate }                      = require('../middleware/auth');
const { requireAdmin }                      = require('../middleware/admin');
const { submitKyc, getKycStatus, reviewKyc, listKyc, getKycById } = require('../controllers/kycController');

const router = express.Router();

// ── Cloudinary configuration ──────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Multer storage ────────────────────────────────────────────────────────────

/**
 * When Cloudinary env vars are present, files are uploaded directly to
 * Cloudinary (persistent, CDN-backed).  Falls back to local disk storage for
 * local development when the vars are not set.
 *
 * Cloudinary path:  kyc/<userId>/<fieldname>-<timestamp>
 * Local path:       uploads/kyc/<userId>/<fieldname>-<timestamp>.<ext>
 */
const useCloudinary =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET;

let storage;

if (useCloudinary) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: (req, file) => ({
      folder: `kyc/${req.user?.sub || 'unknown'}`,
      public_id: `${file.fieldname}-${Date.now()}`,
      resource_type: 'image',
      // Keep originals; let Cloudinary detect format
      format: undefined,
    }),
  });
} else {
  storage = multer.diskStorage({
    destination(req, _file, cb) {
      const userId = req.user?.sub || 'unknown';
      const dir    = path.join(__dirname, '..', 'uploads', 'kyc', String(userId));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
      const name = `${file.fieldname}-${Date.now()}${ext}`;
      cb(null, name);
    },
  });
}

/**
 * Accept all common image formats that mobile devices can produce:
 * JPEG, PNG, WEBP, HEIC/HEIF (iPhone), BMP, TIFF, GIF.
 * Max 5 MB each.
 */
function fileFilter(_req, file, cb) {
  const allowed = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/bmp',
    'image/tiff',
    'image/gif',
  ];

  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
});

/**
 * Field map that mirrors the Flutter KycFormData / _submitKyc multipart request:
 *   aadhaar_front  — Aadhaar card front image
 *   aadhaar_back   — Aadhaar card back image
 *   pan_front      — PAN card front image
 *   selfie         — Selfie / liveness photo
 */
const kycUpload = upload.fields([
  { name: 'aadhaar_front', maxCount: 1 },
  { name: 'aadhaar_back',  maxCount: 1 },
  { name: 'pan_front',     maxCount: 1 },
  { name: 'selfie',        maxCount: 1 },
]);

/**
 * Wraps kycUpload so multer errors are forwarded to the Express error pipeline
 * and caught by handleMulterError below.
 */
function kycUploadMiddleware(req, res, next) {
  kycUpload(req, res, (err) => {
    if (err) return handleMulterError(err, req, res, next);
    next();
  });
}

// ── Multer error handler ──────────────────────────────────────────────────────

function handleMulterError(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(422).json({
        success: false,
        message: `File too large. Maximum allowed size is 5 MB.`,
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(422).json({
        success: false,
        message: `Invalid file type. Please upload a JPEG, PNG, or WEBP image.`,
      });
    }
    return res.status(422).json({ success: false, message: err.message });
  }
  next(err);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/kyc/submit
 * Authenticated user submits their KYC documents.
 *
 * multipart/form-data fields:
 *   Files  : aadhaar_front, aadhaar_back, pan_front, selfie
 *   Text   : accountHolderName, accountNumber, ifscCode,
 *            bankName, bankBranch, bankCity, bankState
 */
router.post(
  '/submit',
  authenticate,
  kycUploadMiddleware,
  submitKyc
);

/**
 * GET /api/kyc/status
 * Returns the current KYC submission status for the authenticated user.
 */
router.get('/status', authenticate, getKycStatus);

/**
 * PUT /api/kyc/:id/review   [Admin only]
 * Approve or reject a KYC submission.
 *
 * Body: { action: 'approve' | 'reject', reason?: string }
 */
router.put('/:id/review', authenticate, requireAdmin, reviewKyc);

/**
 * GET /api/kyc/all   [Admin only]
 * List all KYC submissions.
 *
 * Query: ?status=pending|approved|rejected&page=1&limit=20
 */
router.get('/all', authenticate, requireAdmin, listKyc);

/**
 * GET /api/kyc/:id   [Admin only]
 * Fetch a single KYC submission by id, with full document paths and bank
 * details — used by the admin detail/review modal.
 */
router.get('/:id', authenticate, requireAdmin, getKycById);

module.exports = router;