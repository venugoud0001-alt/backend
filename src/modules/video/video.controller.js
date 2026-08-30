/**
 * Video Pipeline REST Controller
 */

const videoService = require('./video.service');
const { successResponse, errorResponse } = require('../../utils/response');

class VideoController {
  /**
   * POST /api/video/upload-url
   * Authenticated Admin: Generates S3 direct presigned upload URL
   */
  async requestUploadUrl(req, res, next) {
    try {
      const { courseId, moduleId, lessonId, fileName, contentType, fileSizeBytes, title } = req.body || {};
      const result = await videoService.requestUpload(req.user, {
        courseId,
        moduleId,
        lessonId,
        fileName,
        contentType,
        fileSizeBytes,
        title
      });
      return successResponse(res, result, 201, 'Presigned S3 direct upload URL generated successfully.');
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
      const { videoAssetId, lessonId } = req.body || {};
      if (!videoAssetId && !lessonId) {
        return errorResponse(res, 'videoAssetId or lessonId is required.', 400);
      }

      const result = await videoService.confirmUploadAndStartProcessing(req.user, {
        videoAssetId,
        lessonId
      });
      return successResponse(res, result, 200, 'MediaConvert transcoding job initiated.');
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
      if (!lessonId) {
        return errorResponse(res, 'lessonId parameter is required.', 400);
      }

      const status = await videoService.getVideoStatus(lessonId);
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
      const result = await videoService.retryProcessing(req.user, { lessonId });
      return successResponse(res, result, 200, 'Transcoding retry job initiated.');
    } catch (err) {
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
   */
  async handleWebhook(req, res, next) {
    try {
      const event = req.body || {};
      const detail = event.detail || {};
      const jobId = detail.jobId;
      const status = detail.status; // 'COMPLETE' | 'ERROR'
      const userMetadata = detail.userMetadata || {};

      console.log(`📡 [MediaConvert Webhook] Job ${jobId} status update: ${status}`);

      if (status === 'COMPLETE') {
        await videoService.handleProcessingCompleted({
          jobId,
          videoAssetId: userMetadata.videoAssetId,
          lessonId: userMetadata.lessonId
        });
      } else if (status === 'ERROR') {
        await videoService.handleProcessingFailed({
          jobId,
          videoAssetId: userMetadata.videoAssetId,
          lessonId: userMetadata.lessonId,
          errorDetails: { message: detail.errorMessage || 'MediaConvert transcode error' }
        });
      }

      return res.status(200).json({ status: 'SUCCESS', received: true });
    } catch (err) {
      console.error('❌ [MediaConvert Webhook Error]:', err.message);
      return res.status(200).json({ status: 'ERROR', message: err.message });
    }
  }
}

module.exports = new VideoController();
