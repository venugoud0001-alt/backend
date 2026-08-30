const courseService = require('./course.service');
const { successResponse } = require('../../utils/response');

class CourseController {
  /**
   * GET /api/courses
   */
  async getCourses(req, res, next) {
    try {
      console.log('\n📥 [COURSE READ FLOW] GET /api/courses');
      const isAdmin = req.query.includeAll === 'true' || req.userRole === 'ADMIN';
      const courses = await courseService.getCourses(isAdmin);
      console.log(` 📚 [COURSE READ FLOW] Returning ${courses.length} courses.`);
      return successResponse(res, { courses });
    } catch (err) {
      console.error(' ❌ [COURSE GET ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * GET /api/courses/id/:id
   */
  async getCourseById(req, res, next) {
    try {
      const { id } = req.params;
      console.log(`\n📥 [COURSE READ FLOW] GET /api/courses/id/${id}`);
      const isAdmin = req.query.includeAll === 'true' || req.userRole === 'ADMIN';
      const course = await courseService.getCourseById(id, isAdmin);
      if (!course) {
        return res.status(404).json({ status: 'ERROR', message: `Course not found with id '${id}'.` });
      }
      return successResponse(res, { course });
    } catch (err) {
      console.error(' ❌ [COURSE GET BY ID ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * GET /api/courses/slug/:slug
   */
  async getCourseBySlug(req, res, next) {
    try {
      const { slug } = req.params;
      console.log(`\n📥 [COURSE READ FLOW] GET /api/courses/slug/${slug}`);
      const isAdmin = req.query.includeAll === 'true' || req.userRole === 'ADMIN';
      const course = await courseService.getCourseBySlug(slug, isAdmin);
      if (!course) {
        return res.status(404).json({ status: 'ERROR', message: `Course not found with slug '${slug}'.` });
      }
      return successResponse(res, { course });
    } catch (err) {
      console.error(' ❌ [COURSE GET BY SLUG ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * GET /api/courses/:identifier
   */
  async getCourseByIdentifier(req, res, next) {
    try {
      const { identifier } = req.params;
      console.log(`\n📥 [COURSE READ FLOW] GET /api/courses/${identifier}`);
      const isAdmin = req.query.includeAll === 'true' || req.userRole === 'ADMIN';
      const course = await courseService.getCourseByIdentifier(identifier, isAdmin);
      if (!course) {
        return res.status(404).json({ status: 'ERROR', message: `Course not found with identifier '${identifier}'.` });
      }
      return successResponse(res, { course });
    } catch (err) {
      console.error(' ❌ [COURSE GET BY IDENTIFIER ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * POST /api/courses
   */
  async createCourse(req, res, next) {
    try {
      console.log('\n============================================================');
      console.log(' 📚 [COURSE CREATE DATA FLOW] Incoming Payload:');
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const course = await courseService.createCourse(req.validatedData);
      console.log(' 📚 [COURSE CREATE DATA FLOW] Result in DB:');
      console.log(JSON.stringify(course, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { course }, 201, 'Course created successfully.');
    } catch (err) {
      console.error(' ❌ [COURSE CREATE ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * PUT /api/courses/:id
   */
  async updateCourse(req, res, next) {
    try {
      const { id } = req.params;
      console.log('\n============================================================');
      console.log(` 📚 [COURSE UPDATE DATA FLOW] ID: ${id}, Payload:`);
      console.log(JSON.stringify(req.validatedData || req.body, null, 2));
      const course = await courseService.updateCourse(id, req.validatedData);
      console.log(' 📚 [COURSE UPDATE DATA FLOW] Updated in DB:');
      console.log(JSON.stringify(course, null, 2));
      console.log('============================================================\n');
      return successResponse(res, { course }, 200, 'Course updated successfully.');
    } catch (err) {
      console.error(' ❌ [COURSE UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * PATCH /api/courses/:id/status
   */
  async updateStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.validatedData;
      console.log(`\n📚 [COURSE STATUS DATA FLOW] ID: ${id}, Status: ${status}`);
      const course = await courseService.updateCourseStatus(id, status);
      return successResponse(res, { course }, 200, 'Course status updated successfully.');
    } catch (err) {
      console.error(' ❌ [COURSE STATUS UPDATE ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * DELETE /api/courses/:id
   */
  async deleteCourse(req, res, next) {
    try {
      const { id } = req.params;
      const cascade = req.query.cascade === 'true' || req.query.force === 'true' || req.body?.cascade === true;
      console.log(`\n📚 [COURSE DELETE DATA FLOW] ID: ${id} (Cascade: ${cascade})`);
      await courseService.deleteCourse(id, cascade);
      console.log(` 📚 [COURSE DELETE DATA FLOW] Deleted Course ID: ${id}`);
      return successResponse(res, null, 200, 'Course deleted successfully.');
    } catch (err) {
      console.error(' ❌ [COURSE DELETE ERROR]:', err.message || err);
      next(err);
    }
  }

  /**
   * GET /api/batches
   */
  async getBatches(req, res, next) {
    try {
      const batches = await courseService.getBatches();
      return successResponse(res, { batches });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/admin/create-batch
   */
  async createBatch(req, res, next) {
    try {
      const { batchName, courseId, startDate, capacity } = req.body;
      if (!batchName || !courseId) {
        return res.status(400).json({ status: 'ERROR', message: 'batchName and courseId are required.' });
      }
      const batch = await courseService.createBatch({ batchName, courseId, startDate, capacity });
      return successResponse(res, { batch });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/admin/academic-stats
   */
  async getAcademicStats(req, res, next) {
    try {
      const stats = await courseService.getAcademicStats();
      return successResponse(res, { stats });
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new CourseController();
