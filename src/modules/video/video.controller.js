/**
 * Video Pipeline REST Controller
 */

const videoService = require('./video.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { classifyIdentifier } = require('../../utils/idValidator');

class VideoController {
  /**
   * POST /api/video/upload-url
   * Authenticated Admin: Generates S3 direct presigned upload URL
   */
  async requestUploadUrl(req, res, next) {
    try {
      const { courseId, moduleId, lessonId, fileName, contentType, fileSizeBytes, title, durationSeconds } = req.body || {};
      const result = await videoService.requestUpload(req.user, {
        courseId,
        moduleId,
        lessonId,
        fileName,
        contentType,
        fileSizeBytes,
        title,
        durationSeconds
      });
      return successResponse(res, result, 201, 'Presigned S3 direct upload URL generated successfully.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/multipart/initiate
   * Authenticated Admin: Initializes S3 multipart upload and generates presigned part URLs
   */
  async initiateMultipartUpload(req, res, next) {
    try {
      const { courseId, moduleId, lessonId, fileName, contentType, fileSizeBytes, title, partSizeBytes, durationSeconds } = req.body || {};
      const result = await videoService.initiateMultipartUpload(req.user, {
        courseId,
        moduleId,
        lessonId,
        fileName,
        contentType,
        fileSizeBytes,
        title,
        partSizeBytes,
        durationSeconds
      });
      return successResponse(res, result, 201, 'S3 Multipart Upload initialized successfully.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/multipart/complete
   * Authenticated Admin: Completes S3 multipart upload and dispatches MediaConvert
   */
  async completeMultipartUpload(req, res, next) {
    try {
      const { videoAssetId, lessonId, uploadId, s3Key, parts, durationSeconds, courseId } = req.body || {};
      if ((!videoAssetId && !lessonId) || !parts || !Array.isArray(parts)) {
        return errorResponse(res, 'videoAssetId/lessonId and parts array are required.', 400);
      }

      const result = await videoService.completeMultipartUploadAndStartProcessing(req.user, {
        videoAssetId,
        lessonId,
        uploadId,
        s3Key,
        parts,
        durationSeconds,
        courseId
      });
      return successResponse(res, result, 200, 'S3 Multipart upload completed and MediaConvert transcoding dispatched.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/cancel
   * Authenticated Admin: Completely cancels and purges video upload/transcoding job and all AWS/DB resources
   */
  async cancelVideoJob(req, res, next) {
    try {
      const { videoAssetId, lessonId, courseId, moduleId } = req.body || {};
      const result = await videoService.cancelAndPurgeVideoJob(req.user, {
        videoAssetId,
        lessonId,
        courseId,
        moduleId
      });
      return successResponse(res, result, 200, 'Video upload and transcoding stopped and cleaned up.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/multipart/abort
   * Authenticated Admin: Aborts an active S3 multipart upload
   */
  async abortMultipartUpload(req, res, next) {
    try {
      const { videoAssetId, lessonId, uploadId, s3Key, courseId, moduleId } = req.body || {};
      const result = await videoService.cancelAndPurgeVideoJob(req.user, {
        videoAssetId,
        lessonId,
        courseId,
        moduleId
      });
      return successResponse(res, result, 200, 'Video upload aborted and resources cleaned up.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/video/multipart/part-url
   * Authenticated Admin: Generates a refreshed presigned URL for a single part
   */
  async getSinglePartPresignedUrl(req, res, next) {
    try {
      const { videoAssetId, lessonId, uploadId, s3Key, partNumber } = req.query || {};
      const result = await videoService.getSinglePartPresignedUrl(req.user, {
        videoAssetId,
        lessonId,
        uploadId,
        s3Key,
        partNumber
      });
      return successResponse(res, result, 200, 'Presigned part URL generated.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/video/multipart/session/:lessonId
   * Authenticated Admin: Retrieves existing multipart upload session for resumable upload
   */
  async getMultipartSession(req, res, next) {
    try {
      const { lessonId } = req.params;
      const { fingerprint } = req.query;
      const courseId = req.query.courseId || req.query.course_id;
      const result = await videoService.getMultipartSession(req.user, { lessonId, fingerprint, courseId });
      return successResponse(res, result, 200, 'Multipart session details retrieved.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/video/admin/active-jobs
   * Authenticated Admin: Retrieves all active transcoding and upload jobs for the global drawer
   */
  async getActiveJobs(req, res, next) {
    try {
      const result = await videoService.listActiveTranscodingJobs(req.user);
      return successResponse(res, result, 200, 'Active video jobs retrieved successfully.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/video/admin/job/:lessonId
   * Authenticated Admin: Dismisses and deletes a video upload/transcoding record
   */
  async dismissJob(req, res, next) {
    try {
      const { lessonId } = req.params;
      const result = await videoService.dismissVideoJob(req.user, { lessonId });
      return successResponse(res, result, 200, 'Video job dismissed successfully.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/remove-from-course
   * Option A: Removes video assignment from course, sets 48-hour deletion grace timer
   */
  async removeFromCourse(req, res, next) {
    try {
      const { courseId, moduleId, lessonId, videoAssetId } = req.body || {};
      const result = await videoService.removeFromCourse(req.user, {
        courseId,
        moduleId,
        lessonId,
        videoAssetId
      });
      return successResponse(res, result, 200, 'Video removed from course. Stored file will be deleted after 48 hours if unused.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/delete-permanently
   * Option B: Explicit permanent deletion of video assets after full safety validation
   */
  async deletePermanently(req, res, next) {
    try {
      const { courseId, moduleId, lessonId, videoAssetId, forceDelete } = req.body || {};
      const result = await videoService.deletePermanently(req.user, {
        courseId,
        moduleId,
        lessonId,
        videoAssetId,
        forceDelete
      });

      if (result.blocked) {
        return errorResponse(res, result.message, 400, result);
      }

      return successResponse(res, result, 200, 'Video permanently deleted from course and cloud storage.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/confirm-upload
   * Authenticated Admin: Confirms browser S3 upload finished, dispatches MediaConvert job
   */
  async confirmUpload(req, res, next) {
    try {
      const { videoAssetId, lessonId, durationSeconds, courseId } = req.body || {};
      if (!videoAssetId && !lessonId) {
        return errorResponse(res, 'videoAssetId or lessonId is required.', 400);
      }

      const result = await videoService.confirmUploadAndStartProcessing(req.user, {
        videoAssetId,
        lessonId,
        durationSeconds,
        courseId
      });
      return successResponse(res, result, 200, 'MediaConvert transcoding job initiated.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/transcode-full
   * Authenticated Admin: Explicitly starts single full-video MediaConvert transcoding
   */
  async transcodeFullVideo(req, res, next) {
    try {
      const { moduleId, courseId, videoAssetId, lessonId } = req.body || {};
      const result = await videoService.startFullVideoTranscoding(req.user, {
        moduleId,
        courseId,
        videoAssetId,
        lessonId
      });
      return successResponse(res, result, 200, 'Full-video MediaConvert transcoding started successfully.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/video/status/:lessonId
   * Authenticated User: Returns transcoding status, HLS playlist, and metadata
   */
  async getStatus(req, res, next) {
    try {
      const { lessonId } = req.params;
      const courseId = req.query.courseId || req.query.course_id;
      if (!lessonId) {
        return errorResponse(res, 'lessonId parameter is required.', 400);
      }

      const status = await videoService.getVideoStatus(lessonId, courseId);
      return successResponse(res, status, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/retry/:lessonId
   * Authenticated Admin: Retries a failed transcoding job
   */
  async retry(req, res, next) {
    try {
      const { lessonId } = req.params;
      let { courseId, videoAssetId } = { ...(req.query || {}), ...(req.body || {}) };
      if (typeof courseId === 'object' && courseId !== null) {
        courseId = courseId.courseId || courseId.id || null;
      }
      if (typeof courseId === 'string' && courseId.includes('[object')) {
        courseId = null;
      }
      if (typeof videoAssetId === 'object' && videoAssetId !== null) {
        videoAssetId = videoAssetId.videoAssetId || videoAssetId.id || null;
      }
      const result = await videoService.retryProcessing(req.user, { lessonId, videoAssetId, courseId });
      return successResponse(res, result, 200, 'Transcoding retry job initiated.');
    } catch (err) {
      if (err.statusCode || err.status) {
        return errorResponse(res, err.message || 'Retry failed.', err.statusCode || err.status);
      }
      next(err);
    }
  }

  /**
   * GET /api/video/stream/:courseId/:lessonId
   * Authenticated Student / Admin: Validates enrollment & active access, sets CloudFront signed cookies, returns HLS stream
   */
  async getPlaybackAuthorization(req, res, next) {
    try {
      const { courseId, lessonId } = req.params;
      if (!courseId || !lessonId) {
        return errorResponse(res, 'courseId and lessonId parameters are required.', 400);
      }

      const authData = await videoService.authorizeStudentPlayback(req.user, {
        courseId,
        lessonId
      });

      // Set CloudFront Signed Cookies on response
      if (authData.cookies) {
        const cookieOpts = {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'None',
          domain: process.env.COOKIE_DOMAIN || undefined,
          expires: new Date(authData.expiresEpoch * 1000)
        };

        for (const [key, val] of Object.entries(authData.cookies)) {
          res.cookie(key, val, cookieOpts);
        }
      }

      return successResponse(res, authData, 200, 'Playback authorized.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/webhook
   * MediaConvert EventBridge / SNS callback handler
   * Hardened with 9-Step Security Invariant (CRIT-03)
   */
  async handleWebhook(req, res, next) {
    try {
      const crypto = require('crypto');
      const env = require('../../config/env');
      const { supabase } = require('../../config/supabase');
      const videoSessionService = require('./video.session.service');

      // ─── STEP 1: AUTHENTICATE BEFORE ANY DATABASE LOOKUP ──────────────────
      const dotenv = require('dotenv');
      const path = require('path');
      dotenv.config({ path: path.join(__dirname, '../../../.env') });
      dotenv.config({ path: path.join(__dirname, '../../../../.env') });
      const configuredSecret = process.env.AWS_WEBHOOK_SECRET || env.AWS_WEBHOOK_SECRET || '';

      if (process.env.NODE_ENV === 'production' && !configuredSecret) {
        console.error('❌ [MediaConvert Webhook Config Error]: AWS_WEBHOOK_SECRET is not configured in production.');
        return res.status(500).json({
          success: false,
          code: 'CONFIGURATION_ERROR',
          message: 'Webhook authentication is not configured on server.'
        });
      }

      const providedSecret = req.headers['x-webhook-secret'] ||
        (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : null);

      if (!providedSecret || !configuredSecret) {
        videoSessionService.logSecurityEvent('WEBHOOK_AUTH_FAILED', {
          reason: 'MISSING_CREDENTIALS',
          hasHeader: Boolean(providedSecret),
          ip: req.ip
        });
        return res.status(401).json({
          success: false,
          code: 'UNAUTHORIZED_WEBHOOK',
          message: 'Unauthorized: Valid webhook authentication required.'
        });
      }

      const providedBuf = Buffer.from(String(providedSecret));
      const configBuf = Buffer.from(String(configuredSecret));

      if (providedBuf.length !== configBuf.length || !crypto.timingSafeEqual(providedBuf, configBuf)) {
        videoSessionService.logSecurityEvent('WEBHOOK_AUTH_FAILED', {
          reason: 'INVALID_SECRET',
          ip: req.ip
        });
        return res.status(401).json({
          success: false,
          code: 'UNAUTHORIZED_WEBHOOK',
          message: 'Unauthorized: Invalid webhook secret.'
        });
      }

      // ─── STEP 2: MANDATORY JOB ID VALIDATION ──────────────────────────────
      const event = req.body || {};
      const detail = event.detail || event;
      const rawJobId = detail.jobId || event.jobId;

      if (!rawJobId || typeof rawJobId !== 'string' || !rawJobId.trim()) {
        return res.status(400).json({
          success: false,
          code: 'JOB_ID_REQUIRED',
          message: 'Missing mandatory jobId in webhook payload.'
        });
      }

      const jobId = rawJobId.trim();
      const status = detail.status; // 'COMPLETE' | 'ERROR'
      const userMetadata = detail.userMetadata || {};

      // ─── STEP 3: AUTHORITATIVE DB LOOKUP & DUPLICATE COLLISION CHECK ─────
      const { data: topicRows } = await supabase
        .from('topics')
        .select('id, course_id, module_id, mediaconvert_job_id, processing_status, hls_prefix, hls_master_url')
        .eq('mediaconvert_job_id', jobId);

      const { data: lessonRows } = await supabase
        .from('lesson_videos')
        .select('id, lesson_id, course_id, module_id, mediaconvert_job_id, status, hls_master_url')
        .eq('mediaconvert_job_id', jobId);

      const hasTopic = Array.isArray(topicRows) && topicRows.length > 0;
      const hasLesson = Array.isArray(lessonRows) && lessonRows.length > 0;

      // Duplicate MediaConvert Job ID Integrity Check
      if (hasTopic && hasLesson) {
        videoSessionService.logSecurityEvent('DUPLICATE_MEDIACONVERT_JOB_ID', {
          jobId,
          topicId: topicRows[0].id,
          lessonId: lessonRows[0].lesson_id,
          ip: req.ip
        });
        console.error(`🚨 [Security Anomaly] Duplicate MediaConvert jobId ${jobId} found in BOTH topics and lesson_videos! Aborting with zero mutations.`);
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_MEDIACONVERT_JOB_ID',
          message: 'Data integrity violation: Job ID exists across multiple resource types.'
        });
      }

      // If unknown job (neither in topics nor lesson_videos)
      if (!hasTopic && !hasLesson) {
        videoSessionService.logSecurityEvent('WEBHOOK_UNKNOWN_JOB', { jobId, ip: req.ip });
        return res.status(404).json({
          success: false,
          code: 'UNKNOWN_JOB_ID',
          message: 'No registered video processing job matches the provided jobId.'
        });
      }

      const isTopicJob = hasTopic;
      const storedRecord = isTopicJob ? topicRows[0] : lessonRows[0];

      // ─── STEPS 4, 5, 6, 7: OWNERSHIP & METADATA CONSISTENCY CHECKS ─────────
      // Helper for metadata mismatch rejection
      const failMetadataMismatch = (field, expected, received) => {
        videoSessionService.logSecurityEvent('WEBHOOK_METADATA_MISMATCH', {
          jobId,
          field,
          expectedId: String(expected),
          receivedId: String(received),
          ip: req.ip
        });
        console.warn(`⚠️ [MediaConvert Webhook] Metadata mismatch for job ${jobId}: ${field} (expected: ${expected}, received: ${received})`);
        return res.status(403).json({
          success: false,
          code: 'WEBHOOK_METADATA_MISMATCH',
          message: 'Webhook metadata does not match authoritative database record.'
        });
      };

      // Verify course ownership
      if (userMetadata.courseId && String(storedRecord.course_id) !== String(userMetadata.courseId)) {
        return failMetadataMismatch('courseId', storedRecord.course_id, userMetadata.courseId);
      }

      // Verify module ownership
      if (userMetadata.moduleId && String(storedRecord.module_id) !== String(userMetadata.moduleId)) {
        return failMetadataMismatch('moduleId', storedRecord.module_id, userMetadata.moduleId);
      }

      // Verify topic or lesson ID ownership based on job type
      if (isTopicJob && userMetadata.topicId && String(storedRecord.id) !== String(userMetadata.topicId)) {
        return failMetadataMismatch('topicId', storedRecord.id, userMetadata.topicId);
      }

      if (!isTopicJob && userMetadata.lessonId && String(storedRecord.lesson_id) !== String(userMetadata.lessonId)) {
        return failMetadataMismatch('lessonId', storedRecord.lesson_id, userMetadata.lessonId);
      }

      // ─── STEP 8 & 9: STATE TRANSITION VALIDATION & IDEMPOTENCY ───────────
      const currentStatus = isTopicJob ? storedRecord.processing_status : storedRecord.status;

      if (currentStatus === 'READY') {
        // Prevent rollback from terminal READY state
        if (status === 'ERROR' || status === 'FAILED') {
          console.warn(`⚠️ [MediaConvert Webhook] Rejected attempt to roll back terminal READY state for job ${jobId}`);
          return res.status(409).json({
            success: false,
            code: 'INVALID_STATE_TRANSITION',
            message: 'Cannot transition video from terminal READY state to ERROR.'
          });
        }

        // Idempotent completion handling: Harmless no-op without duplicate side effects
        if (status === 'COMPLETE') {
          return res.status(200).json({
            status: 'SUCCESS',
            code: 'ALREADY_COMPLETED',
            message: 'Job already completed (idempotent)',
            received: true
          });
        }
      }

      if (currentStatus === 'FAILED' && status === 'PROCESSING') {
        return res.status(409).json({
          success: false,
          code: 'INVALID_STATE_TRANSITION',
          message: 'Cannot transition video from terminal FAILED state to PROCESSING.'
        });
      }

      // ─── STEP 10: EXECUTE AUTHORITATIVE BUSINESS LOGIC (DB IDs ONLY) ──────
      console.log(`📡 [MediaConvert Webhook] Verified Job ${jobId} status update: ${status} (Authoritative resource: ${isTopicJob ? 'topic ' + storedRecord.id : 'lesson ' + storedRecord.lesson_id})`);

      const jobSubmittedTime = detail.createdAt || detail.jobSubmittedTime || detail.submitTime || null;
      const jobStartedTime = detail.startTime || detail.jobStartedTime || null;
      const jobFinishedTime = detail.finishTime || detail.jobFinishedTime || detail.completedTime || null;

      if (isTopicJob) {
        if (status === 'COMPLETE') {
          await videoService.handleTopicProcessingCompleted({
            jobId,
            topicId: storedRecord.id,
            sourceVideoId: userMetadata.sourceVideoId || storedRecord.source_video_id,
            moduleId: storedRecord.module_id,
            courseId: storedRecord.course_id,
            jobSubmittedTime,
            jobStartedTime,
            jobFinishedTime
          });
        } else if (status === 'ERROR') {
          await videoService.handleTopicProcessingFailed({
            jobId,
            topicId: storedRecord.id,
            sourceVideoId: userMetadata.sourceVideoId || storedRecord.source_video_id,
            moduleId: storedRecord.module_id,
            courseId: storedRecord.course_id,
            errorDetails: { message: detail.errorMessage || 'MediaConvert topic transcode error' },
            jobSubmittedTime,
            jobStartedTime,
            jobFinishedTime
          });
        }
      } else {
        if (status === 'COMPLETE') {
          await videoService.handleProcessingCompleted({
            jobId,
            videoAssetId: storedRecord.id,
            lessonId: storedRecord.lesson_id,
            jobSubmittedTime,
            jobStartedTime,
            jobFinishedTime
          });
        } else if (status === 'ERROR') {
          await videoService.handleProcessingFailed({
            jobId,
            videoAssetId: storedRecord.id,
            lessonId: storedRecord.lesson_id,
            errorDetails: { message: detail.errorMessage || 'MediaConvert transcode error' },
            jobSubmittedTime,
            jobStartedTime,
            jobFinishedTime
          });
        }
      }

      return res.status(200).json({ status: 'SUCCESS', received: true });
    } catch (err) {
      console.error('❌ [MediaConvert Webhook Error]:', err.message);
      return res.status(500).json({ status: 'ERROR', message: err.message });
    }
  }

  /**
   * POST /api/modules/:moduleId/topics/validate
   * Admin: Validates topic timeline boundaries, overlaps, and gap policy
   */
  async validateTopicTimeline(req, res, next) {
    try {
      const { moduleId } = req.params;
      const { topics, sourceDurationSeconds, requireContinuousTopics } = req.body || {};
      const result = videoService.validateTopicTimeline({
        topics,
        sourceDurationSeconds,
        requireContinuousTopics
      });
      return successResponse(res, result, 200, result.isValid ? 'Timeline valid.' : 'Timeline validation errors found.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/modules/:moduleId/topics
   * Admin: Saves topic definitions and boundary timecodes for a module
   */
  async saveModuleTopics(req, res, next) {
    try {
      const { moduleId } = req.params;
      const { courseId, sourceVideoId, topics, requireContinuousTopics } = req.body || {};
      const result = await videoService.saveModuleTopics(req.user, {
        moduleId,
        courseId,
        sourceVideoId,
        topics,
        requireContinuousTopics
      });
      return successResponse(res, result, 200, 'Module topics and clipping boundaries saved successfully.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/modules/:moduleId/topics
   * Authenticated: Returns all topics with duration, boundaries, and processing statuses
   */
  async getModuleTopics(req, res, next) {
    try {
      const { moduleId } = req.params;
      const courseId = req.query.courseId || req.query.course_id || req.body?.courseId;
      const result = await videoService.getModuleTopics(req.user, { moduleId, courseId });
      return successResponse(res, result, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/modules/:moduleId/topics/process
   * Admin: Starts controlled MediaConvert transcoding queue for module topics
   */
  async startTopicBatchProcessing(req, res, next) {
    try {
      const { moduleId } = req.params;
      const { courseId, sourceVideoId, topicIds } = req.body || {};
      const result = await videoService.startTopicBatchProcessing(req.user, {
        moduleId,
        courseId,
        sourceVideoId,
        topicIds
      });
      return successResponse(res, result, 200, 'MediaConvert topic batch processing initiated.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/topics/:topicId/status
   * Authenticated: Returns topic transcoding status, HLS master URL, and segment count
   */
  async getTopicStatus(req, res, next) {
    try {
      const { topicId } = req.params;
      const topic = await videoService.getVideoRecord(`topic_${topicId}`) || await videoService.getVideoRecord(topicId);
      if (!topic) {
        return errorResponse(res, 'Topic record not found.', 404);
      }
      return successResponse(res, topic, 200);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/topics/:topicId/retry
   * Admin: Retries a single failed topic MediaConvert job
   */
  async retryTopicProcessing(req, res, next) {
    try {
      const { topicId } = req.params;
      const result = await videoService.retryTopicProcessing(req.user, { topicId });
      return successResponse(res, result, 200, 'Topic transcoding retry dispatched.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/topics/:topicId
   * Admin: Cancels topic MediaConvert job and purges topic HLS files
   */
  async deleteTopicVideo(req, res, next) {
    try {
      const { topicId } = req.params;
      const courseId = req.query.courseId || req.query.course_id || req.body?.courseId || req.body?.course_id;
      const moduleId = req.query.moduleId || req.query.module_id || req.body?.moduleId || req.body?.module_id;
      const result = await videoService.deleteTopicVideo(req.user, { topicId, courseId, moduleId });
      return successResponse(res, result, 200, 'Topic video cleaned up.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/video/stream/:courseId/:moduleId/:topicId
   * Authenticated Student: Authorizes topic playback and returns signed stream
   */
  async getTopicPlaybackAuthorization(req, res, next) {
    try {
      const { courseId, moduleId, topicId } = req.params;
      const result = await videoService.authorizeTopicPlayback(req.user, {
        courseId,
        moduleId,
        topicId
      });
      return successResponse(res, result, 200, 'Topic playback authorized.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/session/heartbeat
   * Authenticated Student: Heartbeats active playback session
   */
  async heartbeatSession(req, res, next) {

    try {
      const { sessionId } = req.body || {};
      const videoSessionService = require('./video.session.service');
      const userId = req.user?.id || req.user?.email;
      const ok = await videoSessionService.heartbeatSession(sessionId, userId);
      return res.status(200).json({ success: ok, active: ok });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/video/session/stop
   * Authenticated Student: Explicitly stops / terminates a playback session
   */
  async stopSession(req, res, next) {
    try {
      const { sessionId } = req.body || {};
      const videoSessionService = require('./video.session.service');
      const userId = req.user?.id || req.user?.email;
      await videoSessionService.endSession(sessionId, userId);
      return res.status(200).json({ success: true, message: 'Playback session ended.' });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/video/hls-stream/*
   * Hardened Level 1-2 HLS Streaming Proxy
   * Enforces JWT/Token validation, path traversal prevention, MP4 block, and CORS isolation
   */
  async streamHlsFile(req, res, next) {
    try {
      const env = require('../../config/env');
      const videoSessionService = require('./video.session.service');
      const jwt = require('jsonwebtoken');

      // 1. CORS & Origin Validation
      const origin = req.headers.origin;
      const allowedOrigins = env.ALLOWED_STREAMING_ORIGINS || [];
      if (origin && (allowedOrigins.includes(origin) || allowedOrigins.includes('*') || origin.includes('localhost') || origin.includes('127.0.0.1'))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      } else if (!origin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0] || 'https://internnetra.com');
      } else {
        videoSessionService.logSecurityEvent('VIDEO_PROXY_UNAUTHORIZED', { reason: 'CORS_REJECTED', origin });
        return res.status(403).json({ success: false, message: 'Unauthorized origin.' });
      }

      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }

      // 2. Path & Key Extraction
      let rawParam = req.params[0] || req.query.key || '';
      let s3Key = decodeURIComponent(rawParam).replace(/^\/+/, '');

      if (!s3Key) {
        return res.status(400).json({ success: false, message: 'S3 key is required.' });
      }

      // Level 1: Strict Path Traversal Prevention
      if (
        s3Key.includes('..') ||
        s3Key.includes('\\') ||
        rawParam.includes('%2e%2e') ||
        rawParam.includes('%2E%2E') ||
        !s3Key.startsWith('courses/')
      ) {
        videoSessionService.logSecurityEvent('VIDEO_PATH_REJECTED', { s3Key, rawParam, ip: req.ip });
        return res.status(400).json({ success: false, message: 'Invalid path format.' });
      }

      const lowerKey = s3Key.toLowerCase();

      // Level 1: Strict Source MP4 Blocking
      if (
        lowerKey.endsWith('.mp4') ||
        lowerKey.endsWith('.mov') ||
        lowerKey.endsWith('.avi') ||
        lowerKey.endsWith('.mkv') ||
        lowerKey.endsWith('.webm') ||
        lowerKey.endsWith('.m4v')
      ) {
        videoSessionService.logSecurityEvent('VIDEO_SOURCE_ACCESS_BLOCKED', { s3Key, ip: req.ip });
        return res.status(403).json({
          success: false,
          code: 'SOURCE_VIDEO_FORBIDDEN',
          message: 'Source video access is forbidden'
        });
      }

      // Level 1: Only HLS Resources Permitted (.m3u8 and .ts)
      if (!lowerKey.endsWith('.m3u8') && !lowerKey.endsWith('.ts')) {
        return res.status(403).json({ success: false, message: 'Invalid video resource request.' });
      }

      // 3. Level 2: Mandatory Token / Authentication Verification
      const token = req.query.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : null);

      if (!token) {
        videoSessionService.logSecurityEvent('VIDEO_ACCESS_DENIED', { reason: 'MISSING_TOKEN', s3Key, ip: req.ip });
        return res.status(401).json({
          success: false,
          code: 'PLAYBACK_TOKEN_REQUIRED',
          message: 'Access denied: Valid playback authorization token is required.'
        });
      }

      if (!env.JWT_SECRET) {
        return res.status(500).json({
          success: false,
          code: 'SERVER_CONFIG_ERROR',
          message: 'Server security configuration error.'
        });
      }

      let verifiedToken = null;
      try {
        verifiedToken = jwt.verify(token, env.JWT_SECRET);
      } catch (jwtErr) {
        // Token expired or invalid
        videoSessionService.logSecurityEvent('VIDEO_ACCESS_EXPIRED', { s3Key, error: jwtErr.message, ip: req.ip });
        return res.status(403).json({
          success: false,
          code: 'VIDEO_ACCESS_EXPIRED',
          message: 'Video playback authorization expired or invalid. Please refresh player.'
        });
      }

      // Reject non-playback JWTs (e.g. standard login auth tokens)
      if (!verifiedToken || (verifiedToken.type !== 'VIDEO_PLAYBACK' && verifiedToken.type !== 'TOPIC_PLAYBACK')) {
        videoSessionService.logSecurityEvent('VIDEO_PROXY_UNAUTHORIZED', {
          reason: 'INVALID_TOKEN_TYPE',
          s3Key,
          tokenType: verifiedToken?.type,
          ip: req.ip
        });
        return res.status(403).json({
          success: false,
          code: 'INVALID_TOKEN_TYPE',
          message: 'Access denied: Dedicated video playback token is required.'
        });
      }

      // Extract resource segments from S3 key
      const courseMatch = s3Key.match(/^courses\/([^\/]+)/i);
      const pathCourse = courseMatch ? courseMatch[1].toLowerCase() : '';
      const topicMatchInKey = s3Key.match(/\/topics\/([0-9a-f-]{36}|[^\/]+)/i);
      const pathTopicId = topicMatchInKey ? topicMatchInKey[1] : '';

      const authorizedCourseId = verifiedToken.courseId ? String(verifiedToken.courseId).toLowerCase() : '';
      let authorizedCourseSlug = verifiedToken.courseSlug ? String(verifiedToken.courseSlug).toLowerCase() : '';

      const { supabase } = require('../../config/supabase');

      if (!authorizedCourseSlug && authorizedCourseId) {
        try {
          const { data: cRow } = await supabase.from('courses').select('slug').eq('id', authorizedCourseId).maybeSingle();
          if (cRow && cRow.slug) {
            authorizedCourseSlug = cRow.slug.toLowerCase();
          }
        } catch (_) {}
      }

      // Multi-tier Course Isolation Check: Even for ADMIN, token must match the course scope
      const matchesCourse =
        (authorizedCourseSlug && pathCourse === authorizedCourseSlug) ||
        (authorizedCourseId && (pathCourse === authorizedCourseId || lowerKey.includes(authorizedCourseId)));

      if (!matchesCourse) {
        videoSessionService.logSecurityEvent('VIDEO_PROXY_UNAUTHORIZED', {
          reason: 'COURSE_MISMATCH',
          s3Key,
          authorizedCourseSlug,
          authorizedCourseId,
          pathCourse,
          ip: req.ip
        });
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN_COURSE_MISMATCH',
          message: 'Unauthorized: Playback token is not valid for this course video.'
        });
      }

      // Topic-level ownership verification
      if (verifiedToken.topicId && pathTopicId) {
        const tokenTopicId = String(verifiedToken.topicId).toLowerCase();
        const normPathTopicId = pathTopicId.toLowerCase();

        if (tokenTopicId !== normPathTopicId) {
          try {
            const topicClass = classifyIdentifier(pathTopicId);
            let pathTopic = null;
            if (topicClass === 'UUID') {
              const { data } = await supabase
                .from('topics')
                .select('id, course_id')
                .eq('id', pathTopicId)
                .maybeSingle();
              pathTopic = data;
            } else if (topicClass === 'SLUG') {
              const { data } = await supabase
                .from('topics')
                .select('id, course_id')
                .eq('topic_id', pathTopicId)
                .maybeSingle();
              pathTopic = data;
            }

            if (!pathTopic || (authorizedCourseId && String(pathTopic.course_id).toLowerCase() !== authorizedCourseId)) {
              videoSessionService.logSecurityEvent('VIDEO_PROXY_UNAUTHORIZED', {
                reason: 'TOPIC_MISMATCH',
                s3Key,
                tokenTopicId,
                pathTopicId,
                ip: req.ip
              });
              return res.status(403).json({
                success: false,
                code: 'FORBIDDEN_TOPIC_MISMATCH',
                message: 'Unauthorized: Playback token is not valid for this topic video.'
              });
            }
          } catch (_) {
            return res.status(403).json({
              success: false,
              code: 'FORBIDDEN_TOPIC_MISMATCH',
              message: 'Unauthorized: Topic verification failed.'
            });
          }
        }
      }

      // 4. Fetch from Private S3
      const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({
        region: env.AWS_REGION || 'ap-south-1',
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY
        }
      });

      const bucket = env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';
      const range = req.headers.range;
      let s3Res;
      try {
        const cmd = new GetObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Range: range || undefined
        });
        s3Res = await s3.send(cmd);
      } catch (s3Err) {
        if (s3Err.name === 'NoSuchKey' || s3Err.Code === 'NoSuchKey') {
          // Attempt fallback resolution for topic prefix mismatch (strictly course-scoped)
          let fallbackKey = null;
          const topicMatch = s3Key.match(/\/topics\/([0-9a-f-]{36})\/hls\/(.+)$/i);
          if (topicMatch) {
            const topicId = topicMatch[1];
            const subFile = topicMatch[2];
            const { data: topic } = await supabase.from('topics').select('id, course_id, hls_prefix').eq('id', topicId).maybeSingle();
            if (topic && topic.hls_prefix && authorizedCourseId && String(topic.course_id).toLowerCase() === authorizedCourseId) {
              fallbackKey = `${topic.hls_prefix.replace(/^\/+/, '').replace(/\/+$/, '')}/${subFile}`;
            } else if (topic && authorizedCourseId && String(topic.course_id).toLowerCase() !== authorizedCourseId) {
              console.warn(`⚠️ [HLS Proxy] Fallback rejected: topic ${topicId} course (${topic.course_id}) !== authorized course (${authorizedCourseId})`);
            }
          }
          if (fallbackKey && fallbackKey !== s3Key) {
            console.log(`ℹ️ [HLS Proxy] Resolved S3 fallback key: ${s3Key} -> ${fallbackKey}`);
            s3Key = fallbackKey;
            const retryCmd = new GetObjectCommand({
              Bucket: bucket,
              Key: fallbackKey,
              Range: range || undefined
            });
            s3Res = await s3.send(retryCmd);
          } else {
            throw s3Err;
          }
        } else {
          throw s3Err;
        }
      }

      // Handle M3U8 Manifests
      if (s3Key.endsWith('.m3u8')) {
        let rawContent = await s3Res.Body.transformToString();

        // If token is present, append token to child playlists and TS segment URLs in manifest
        if (token) {
          rawContent = rawContent.replace(/^([^#\r\n].*\.(m3u8|ts))$/gm, (match) => {
            const delim = match.includes('?') ? '&' : '?';
            return `${match}${delim}token=${token}`;
          });
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.send(rawContent);
      }

      // Handle TS Video Chunks & Progressive Video
      if (s3Res.ContentRange) {
        res.setHeader('Content-Range', s3Res.ContentRange);
        res.status(206);
      } else if (s3Res.ContentLength) {
        res.setHeader('Content-Length', s3Res.ContentLength);
        res.status(200);
      }

      res.setHeader('Content-Type', s3Res.ContentType || (s3Key.endsWith('.ts') ? 'video/mp2t' : 'video/mp4'));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=86400');

      s3Res.Body.pipe(res);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ success: false, message: 'Video segment not found.' });
      }
      console.error('❌ [HLS Stream Proxy Error]:', err.message);
      return res.status(500).json({ success: false, message: 'Error streaming video segment.' });
    }
  }
}

module.exports = new VideoController();
