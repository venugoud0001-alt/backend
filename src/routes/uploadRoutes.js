const express = require('express');
const router = express.Router();
const multer = require('multer');
const storageService = require('../services/storage/storageService');
const { authenticateJWT } = require('../middleware/authenticate');
const { requireAdminRole } = require('../middleware/authorize');

// Multer memory storage configuration with 2 MB file size limit
const MAX_ALLOWED_BYTES = 2097152; // 2 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ALLOWED_BYTES
  },
  fileFilter: (req, file, cb) => {
    const validMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (validMimes.includes(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Invalid image MIME type. Only JPG, PNG, and WebP images are allowed.'));
    }
  }
});

// Multipart form-data image upload endpoint
router.post('/upload/image', authenticateJWT, requireAdminRole, (req, res, next) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(422).json({
          status: 'ERROR',
          message: 'Uploaded file size exceeds the maximum allowed limit of 2 MB.'
        });
      }
      return res.status(400).json({ status: 'ERROR', message: err.message });
    }

    try {
      let fileBuffer = null;
      let cleanMime = 'image/webp';
      let fileName = `img_${Date.now()}.webp`;

      if (req.file) {
        fileBuffer = req.file.buffer;
        cleanMime = req.file.mimetype;
        fileName = req.file.originalname;
      } else if (req.body && req.body.imageBase64) {
        const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
        fileBuffer = Buffer.from(base64Data, 'base64');
        cleanMime = req.body.mimeType || 'image/webp';
        fileName = req.body.fileName || fileName;
      }

      if (!fileBuffer) {
        return res.status(400).json({ status: 'ERROR', message: 'No image file or imageBase64 payload provided.' });
      }

      const fileSize = fileBuffer.length;

      if (fileSize > MAX_ALLOWED_BYTES) {
        return res.status(422).json({
          status: 'ERROR',
          message: `Uploaded file size (${(fileSize / 1024).toFixed(1)} KB) exceeds the maximum allowed limit of 2 MB.`
        });
      }

      const cleanFileName = fileName.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const storageKey = `uploads/images/${Date.now()}_${cleanFileName}`;

      const uploadResult = await storageService.upload(fileBuffer, storageKey, cleanMime);
      const finalUrl = uploadResult.video_url || storageService.getUrl(storageKey);

      return res.status(200).json({
        status: 'SUCCESS',
        message: 'Image uploaded successfully.',
        imageUrl: finalUrl,
        thumbnail_url: finalUrl,
        storageKey: storageKey,
        fileSizeKb: (fileSize / 1024).toFixed(1)
      });
    } catch (uploadErr) {
      next(uploadErr);
    }
  });
});

// Delete image endpoint
router.delete('/upload/image', authenticateJWT, requireAdminRole, async (req, res, next) => {
  try {
    const { storageKey } = req.body || req.query;
    if (storageKey) {
      await storageService.delete(storageKey);
    }
    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Image deleted successfully.'
    });
  } catch (err) {
    console.warn('Storage delete warning:', err.message);
    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Deletion operation completed.'
    });
  }
});

module.exports = router;
