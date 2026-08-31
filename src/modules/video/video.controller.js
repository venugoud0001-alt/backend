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

  /**
   * GET /api/video/hls-stream/*
   * High-Performance S3 HLS Streaming Proxy
   * Streams master.m3u8, variant playlists, and .ts video chunks with zero 403 errors
   */
  async streamHlsFile(req, res, next) {
    try {
      const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
      const env = require('../../config/env');
      const s3 = new S3Client({
        region: env.AWS_REGION || 'ap-south-1',
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY
        }
      });

      let rawParam = req.params[0] || req.query.key || '';
      let s3Key = decodeURIComponent(rawParam).replace(/^\/+/, '');

      if (!s3Key) {
        return res.status(400).send('S3 key is required.');
      }

      const bucket = env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an';
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
      const s3Res = await s3.send(cmd);

      // Handle M3U8 Playlists: Rewrite relative URLs to route through /api/video/hls-stream/
      if (s3Key.endsWith('.m3u8')) {
        const rawContent = await s3Res.Body.transformToString();
        const basePath = s3Key.substring(0, s3Key.lastIndexOf('/') + 1);

        const rewritten = rawContent.split('\n').map(line => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            return `/api/video/hls-stream/${basePath}${trimmed}`;
          }
          return line;
        }).join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(rewritten);
      }

      // Handle TS Video Chunks: Stream binary directly with byte ranges
      if (s3Res.ContentLength) {
        res.setHeader('Content-Length', s3Res.ContentLength);
      }
      res.setHeader('Content-Type', s3Res.ContentType || 'video/mp2t');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');

      s3Res.Body.pipe(res);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return res.status(404).send('Video segment not found.');
      }
      console.error('❌ [HLS Stream Proxy Error]:', err.message);
      return res.status(500).send('Error streaming video segment.');
    }
  }
}

module.exports = new VideoController();
