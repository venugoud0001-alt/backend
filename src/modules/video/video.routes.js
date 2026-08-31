/**
 * Video Pipeline Routes
 */

const express = require('express');
const router = express.Router();
const videoController = require('./video.controller');
const { authenticateJWT } = require('../../middleware/authenticate');
const { requireAdminRole, requirePermission, requireAnyPermission } = require('../../middleware/authorize');

// 1. Admin Requests Direct-to-S3 Upload URL
router.post(
  '/video/upload-url',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.requestUploadUrl
);

// 2. Admin Confirms Direct Upload & Triggers MediaConvert
router.post(
  '/video/confirm-upload',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.confirmUpload
);

// 3. Authenticated Users Check Video Status & Manifest
router.get(
  '/video/status/:lessonId',
  authenticateJWT,
  videoController.getStatus
);

// 4. Admin Retries Failed Transcode Job
router.post(
  '/video/retry/:lessonId',
  authenticateJWT,
  requirePermission('video.retry'),
  videoController.retry
);

// 5. Authenticated Student Requests Secure HLS Stream (Validates Enrollment & Signed Access)
router.get(
  '/video/stream/:courseId/:lessonId',
  authenticateJWT,
  videoController.getPlaybackAuthorization
);

// 6. AWS MediaConvert EventBridge Webhook Callback
router.post(
  '/video/webhook',
  videoController.handleWebhook
);

// 7. Secure HLS Video Streaming Proxy (Direct zero-403 streaming)
router.get(
  '/video/hls-stream/*',
  videoController.streamHlsFile
);

module.exports = router;
