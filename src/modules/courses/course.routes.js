const express = require('express');
const router = express.Router();
const courseController = require('./course.controller');
const { validateCreateCourse, validateUpdateCourse, validateCourseStatusUpdate } = require('./course.validator');
const { validate } = require('../../middleware/validate');
const { authenticateJWT } = require('../../middleware/authenticate');
const { requireAdminRole, requirePermission } = require('../../middleware/authorize');

// Public & Admin Routes
router.get(['/courses', '/courses/catalog'], courseController.getCourses);
router.get('/courses/id/:id', courseController.getCourseById);
router.get('/courses/slug/:slug', courseController.getCourseBySlug);
router.get('/courses/:identifier', courseController.getCourseByIdentifier);
router.get('/batches', courseController.getBatches);
router.get('/admin/academic-stats', courseController.getAcademicStats);
router.get('/academic-stats', courseController.getAcademicStats);

// Admin Protected Routes
router.post('/admin/create-batch', authenticateJWT, requirePermission('course.create'), courseController.createBatch);

router.post(
  '/courses',
  authenticateJWT,
  requirePermission('course.create'),
  validate(validateCreateCourse),
  courseController.createCourse
);

router.put(
  '/courses/:id',
  authenticateJWT,
  requirePermission('course.edit'),
  validate(validateUpdateCourse),
  courseController.updateCourse
);

router.patch(
  '/courses/:id/status',
  authenticateJWT,
  requirePermission('course.publish'),
  validate(validateCourseStatusUpdate),
  courseController.updateStatus
);

router.delete(
  '/courses/:id',
  authenticateJWT,
  requirePermission('course.archive'),
  courseController.deleteCourse
);

module.exports = router;
