/**
 * Video Pipeline Routes
 */

const express = require('express');
const router = express.Router();
const videoController = require('./video.controller');
const videoAnalyticsController = require('./video.analytics.controller');
const videoAnalyticsAdminController = require('./video.analytics.admin.controller');
const { authenticateJWT, optionalAuthenticateJWT } = require('../../middleware/authenticate');
const { requireAdminRole, requirePermission, requireAnyPermission } = require('../../middleware/authorize');
const { heavyVideoOpsLimiter } = require('../../middleware/rateLimiter');

// 1. Admin Requests Direct-to-S3 Single PUT Upload URL (< 100 MB)
router.post(
  '/video/upload-url',
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.requestUploadUrl
);

// 1B. Admin Initiates S3 Multipart Upload (>= 100 MB)
router.post(
  '/video/multipart/initiate',
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.initiateMultipartUpload
);

// 1C. Admin Completes S3 Multipart Upload & Triggers MediaConvert
router.post(
  '/video/multipart/complete',
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.completeMultipartUpload
);

// 1D. Admin Cancels Video Processing / Upload & Purges All Artifacts
router.post(
  '/video/cancel',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.cancelVideoJob
);

// 1D-2. Admin Aborts S3 Multipart Upload (on cancel or failure)
router.post(
  '/video/multipart/abort',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.abortMultipartUpload
);

// 1E. Admin Requests Refreshed Presigned URL for Single Part
router.get(
  '/video/multipart/part-url',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.getSinglePartPresignedUrl
);

// 1F. Admin Checks Existing Multipart Session for Resumable Upload
router.get(
  '/video/multipart/session/:lessonId',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.getMultipartSession
);

// 1G. Admin Queries All Active Background Video Jobs (Global Drawer)
router.get(
  '/video/admin/active-jobs',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.getActiveJobs
);

// 1H. Admin Dismisses / Deletes a Background Video Record
router.delete(
  '/video/admin/job/:lessonId',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.dismissJob
);

// 1I. Admin Removes Video from Course (Option A: 48h Grace Period)
router.post(
  '/video/remove-from-course',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.removeFromCourse
);

// 1J. Admin Deletes Video Permanently (Option B: Immediate Validated S3 Purge)
router.post(
  '/video/delete-permanently',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.deletePermanently
);

// 2. Admin Confirms Direct Upload & Triggers MediaConvert (Single PUT flow)
router.post(
  '/video/confirm-upload',
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.confirmUpload
);

// 2B. Admin Directly Starts Single Full-Video Transcoding
router.post(
  '/video/transcode-full',
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.transcodeFullVideo
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
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'video.retry', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.retry
);

// 5. Authenticated Student Requests Secure HLS Stream (Legacy Single Video / Free Preview)
router.get(
  '/video/stream/:courseId/:lessonId',
  optionalAuthenticateJWT,
  videoController.getPlaybackAuthorization
);
router.post(
  '/video/stream/:courseId/:lessonId',
  optionalAuthenticateJWT,
  videoController.getPlaybackAuthorization
);

// 5A-2. Authenticated Student Requests Secure Topic HLS Stream (Topic Stream / Free Preview)
router.get(
  '/video/stream/:courseId/:moduleId/:topicId',
  optionalAuthenticateJWT,
  videoController.getTopicPlaybackAuthorization
);
router.post(
  '/video/stream/:courseId/:moduleId/:topicId',
  optionalAuthenticateJWT,
  videoController.getTopicPlaybackAuthorization
);

// 5B. Authenticated Student Heartbeats Video Playback Session
router.post(
  '/video/session/heartbeat',
  authenticateJWT,
  videoController.heartbeatSession
);

// 5C. Authenticated Student Stops Video Playback Session
router.post(
  '/video/session/stop',
  authenticateJWT,
  videoController.stopSession
);

// 5D. Authenticated Student Ingests Video Analytics Event (Phase 2)
router.post(
  ['/video/analytics/events', '/video/analytics/event'],
  authenticateJWT,
  videoAnalyticsController.recordEvent
);

// =========================================================================
// ADMINISTRATIVE VIDEO ANALYTICS REPORTING APIS (Phase 3)
// =========================================================================

// A1. Platform Video Analytics Overview
router.get(
  ['/admin/analytics/video/overview', '/analytics/video/overview'],
  authenticateJWT,
  requireAdminRole,
  videoAnalyticsAdminController.getOverview
);

// A2. Course-level Video Analytics Breakdown
router.get(
  ['/admin/analytics/video/courses/:courseId', '/analytics/video/courses/:courseId'],
  authenticateJWT,
  requireAdminRole,
  videoAnalyticsAdminController.getCourseAnalytics
);

// A3. Module-level Video Analytics Breakdown
router.get(
  ['/admin/analytics/video/modules/:moduleId', '/analytics/video/modules/:moduleId'],
  authenticateJWT,
  requireAdminRole,
  videoAnalyticsAdminController.getModuleAnalytics
);

// A4. Topic-level Video Analytics Breakdown
router.get(
  ['/admin/analytics/video/topics/:topicId', '/analytics/video/topics/:topicId'],
  authenticateJWT,
  requireAdminRole,
  videoAnalyticsAdminController.getTopicAnalytics
);

// A5. Paginated Students Video Analytics Summary
router.get(
  ['/admin/analytics/video/students', '/analytics/video/students'],
  authenticateJWT,
  requireAdminRole,
  videoAnalyticsAdminController.getStudents
);

// A6. Single Student Video Analytics Deep Dive
router.get(
  ['/admin/analytics/video/students/:studentId', '/analytics/video/students/:studentId'],
  authenticateJWT,
  requireAdminRole,
  videoAnalyticsAdminController.getStudentById
);

// A7. Time-series Video Trends
router.get(
  ['/admin/analytics/video/trends', '/analytics/video/trends'],
  authenticateJWT,
  requireAdminRole,
  videoAnalyticsAdminController.getTrends
);

// =========================================================================
// TOPIC-BASED VIDEO PIPELINE (MediaConvert Input Clipping)
// =========================================================================

// T1. Admin Validates Topic Timeline
router.post(
  ['/modules/:moduleId/topics/validate', '/video/modules/:moduleId/topics/validate'],
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.validateTopicTimeline
);

// T2. Admin Saves Module Topics and Boundary Timestamps
router.post(
  ['/modules/:moduleId/topics', '/video/modules/:moduleId/topics'],
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.saveModuleTopics
);

// T3. Get All Topics for a Module with Status and Timecodes
router.get(
  ['/modules/:moduleId/topics', '/video/modules/:moduleId/topics'],
  authenticateJWT,
  videoController.getModuleTopics
);

// T4. Admin Dispatches Controlled MediaConvert InputClipping Queue
router.post(
  ['/modules/:moduleId/topics/process', '/video/modules/:moduleId/topics/process'],
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.startTopicBatchProcessing
);

// T5. Get Single Topic Processing Status & HLS URLs
router.get(
  ['/topics/:topicId/status', '/video/topics/:topicId/status'],
  authenticateJWT,
  videoController.getTopicStatus
);

// T6. Admin Retries Failed Topic Transcoding Job
router.post(
  ['/topics/:topicId/retry', '/video/topics/:topicId/retry'],
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'video.retry', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.retryTopicProcessing
);

// T7. Admin Deletes Topic Video
router.delete(
  ['/topics/:topicId', '/video/topics/:topicId'],
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.deleteTopicVideo
);

// T7A. Admin Removes Topic Video from Course (Option A: 48-Hour Grace Period)
router.post(
  ['/topics/:topicId/remove-from-course', '/video/topics/:topicId/remove-from-course'],
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.removeTopicVideoFromCourse
);

// T7B. Admin Permanently Deletes Topic Video from AWS S3 (Option B: Immediate S3 Purge)
router.post(
  ['/topics/:topicId/delete-permanently', '/video/topics/:topicId/delete-permanently'],
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.deleteTopicVideoPermanently
);

// T8. Admin Requests Presigned Direct S3 PUT Upload URL for Single Topic (< 100 MB)
router.post(
  ['/topics/:topicId/upload-url', '/video/topics/:topicId/upload-url'],
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.requestTopicUploadUrl
);

// T9. Admin Initiates S3 Multipart Upload for Single Topic (>= 100 MB)
router.post(
  ['/topics/:topicId/multipart/initiate', '/video/topics/:topicId/multipart/initiate'],
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.initiateTopicMultipartUpload
);

// T10. Admin Completes S3 Multipart Upload for Single Topic & Starts MediaConvert
router.post(
  ['/topics/:topicId/multipart/complete', '/video/topics/:topicId/multipart/complete'],
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.completeTopicMultipartUpload
);

// T11. Admin Confirms Single PUT Upload for Single Topic & Starts MediaConvert
router.post(
  ['/topics/:topicId/confirm-upload', '/video/topics/:topicId/confirm-upload'],
  heavyVideoOpsLimiter,
  authenticateJWT,
  requireAnyPermission(['video.upload', 'course.edit', 'curriculum.create', 'curriculum.edit', 'course.create']),
  videoController.confirmTopicUpload
);


// 6. AWS MediaConvert EventBridge Webhook Callback
router.post(
  '/video/webhook',
  videoController.handleWebhook
);

// 7. Secure HLS Video Streaming Proxy (Direct zero-403 streaming with Level 1-2 token & path validation)
router.options('/video/hls-stream/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(204);
});
router.get(
  '/video/hls-stream/*',
  videoController.streamHlsFile
);

module.exports = router;

