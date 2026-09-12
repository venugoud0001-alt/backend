/**
 * Video Analytics REST Controller
 * Phase 2: Ingests video telemetry events with strict non-blocking safety.
 */

const videoAnalyticsService = require('./video.analytics.service');
const { successResponse, errorResponse } = require('../../utils/response');

class VideoAnalyticsController {
  /**
   * POST /api/video/analytics/events
   * Ingests a video lifecycle analytics event.
   */
  async recordEvent(req, res, next) {
    try {
      const result = await videoAnalyticsService.ingestEvent(req.user, req.body || {});

      if (result.status === 'DUPLICATE') {
        return successResponse(res, result, 200, result.message);
      }

      return successResponse(res, result, 201, 'Video analytics event recorded successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      console.error('⚠️ [Video Analytics Controller Error]:', err.message || err);
      return errorResponse(res, 'Failed to process video analytics event.', 500);
    }
  }
}

module.exports = new VideoAnalyticsController();
