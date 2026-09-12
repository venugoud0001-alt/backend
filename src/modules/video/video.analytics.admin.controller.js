/**
 * Video Analytics Admin REST Controller
 * Phase 3: Handles HTTP endpoints for administrator video analytics dashboards.
 */

const videoAnalyticsAdminService = require('./video.analytics.admin.service');
const { successResponse, errorResponse } = require('../../utils/response');

class VideoAnalyticsAdminController {
  /**
   * GET /api/admin/analytics/video/overview
   */
  async getOverview(req, res, next) {
    try {
      const { dateFilter, startDate, endDate } = req.query || {};
      const result = await videoAnalyticsAdminService.getOverviewMetrics({
        dateFilter,
        startDate,
        endDate
      });
      return successResponse(res, result, 200, 'Video analytics overview retrieved successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  }

  /**
   * GET /api/admin/analytics/video/courses/:courseId
   */
  async getCourseAnalytics(req, res, next) {
    try {
      const { courseId } = req.params;
      const { dateFilter, startDate, endDate } = req.query || {};
      const result = await videoAnalyticsAdminService.getCourseAnalytics(courseId, {
        dateFilter,
        startDate,
        endDate
      });
      return successResponse(res, result, 200, 'Course video analytics retrieved successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  }

  /**
   * GET /api/admin/analytics/video/modules/:moduleId
   */
  async getModuleAnalytics(req, res, next) {
    try {
      const { moduleId } = req.params;
      const { dateFilter, startDate, endDate } = req.query || {};
      const result = await videoAnalyticsAdminService.getModuleAnalytics(moduleId, {
        dateFilter,
        startDate,
        endDate
      });
      return successResponse(res, result, 200, 'Module video analytics retrieved successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  }

  /**
   * GET /api/admin/analytics/video/topics/:topicId
   */
  async getTopicAnalytics(req, res, next) {
    try {
      const { topicId } = req.params;
      const { dateFilter, startDate, endDate } = req.query || {};
      const result = await videoAnalyticsAdminService.getTopicMetrics(topicId, {
        dateFilter,
        startDate,
        endDate
      });
      return successResponse(res, result, 200, 'Topic video analytics retrieved successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  }

  /**
   * GET /api/admin/analytics/video/students
   */
  async getStudents(req, res, next) {
    try {
      const { dateFilter, startDate, endDate, page, limit, search } = req.query || {};
      const result = await videoAnalyticsAdminService.getStudentsAnalytics({
        dateFilter,
        startDate,
        endDate,
        page,
        limit,
        search
      });
      return successResponse(res, result, 200, 'Students video analytics retrieved successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  }

  /**
   * GET /api/admin/analytics/video/students/:studentId
   */
  async getStudentById(req, res, next) {
    try {
      const { studentId } = req.params;
      const { dateFilter, startDate, endDate } = req.query || {};
      const result = await videoAnalyticsAdminService.getSingleStudentAnalytics(studentId, {
        dateFilter,
        startDate,
        endDate
      });
      return successResponse(res, result, 200, 'Student video analytics profile retrieved successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  }

  /**
   * GET /api/admin/analytics/video/trends
   */
  async getTrends(req, res, next) {
    try {
      const { dateFilter, startDate, endDate } = req.query || {};
      const result = await videoAnalyticsAdminService.getTrendsAnalytics({
        dateFilter,
        startDate,
        endDate
      });
      return successResponse(res, result, 200, 'Video analytics trends retrieved successfully.');
    } catch (err) {
      if (err.statusCode && err.statusCode < 500) {
        return errorResponse(res, err.message, err.statusCode);
      }
      next(err);
    }
  }
}

module.exports = new VideoAnalyticsAdminController();
