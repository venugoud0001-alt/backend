const express = require('express');
const router = express.Router();
const curriculumController = require('./curriculum.controller');
const {
  validateCreateVersion,
  validateUpdateVersion,
  validateCreateModule,
  validateUpdateModule,
  validateCreateLesson,
  validateUpdateLesson,
  validateCreateTopic,
  validateUpdateTopic,
  validateReorder
} = require('./curriculum.validator');
const { validate } = require('../../middleware/validate');
const { authenticateJWT } = require('../../middleware/authenticate');
const { requireAdminRole, requirePermission } = require('../../middleware/authorize');

// ==========================================
// 1. PUBLIC UNIFIED CURRICULUM ENDPOINT
// ==========================================
router.get('/courses/:slug/curriculum', curriculumController.getPublicCurriculum);

// ==========================================
// 2. COURSE VERSIONS (ADMIN)
// ==========================================
router.get(
  '/courses/:courseId/versions',
  authenticateJWT,
  requirePermission('curriculum.view'),
  curriculumController.getVersions
);

router.post(
  '/courses/:courseId/versions',
  authenticateJWT,
  requirePermission('curriculum.create'),
  validate(validateCreateVersion),
  curriculumController.createVersion
);

router.put(
  '/course-versions/:id',
  authenticateJWT,
  requirePermission('curriculum.edit'),
  validate(validateUpdateVersion),
  curriculumController.updateVersion
);

router.patch(
  '/course-versions/:id/status',
  authenticateJWT,
  requirePermission('curriculum.edit'),
  curriculumController.updateVersionStatus
);

// ==========================================
// 3. MODULES (ADMIN & PUBLIC LISTING)
// ==========================================
router.get('/course-versions/:versionId/modules', curriculumController.getModules);
router.get('/modules/:id', curriculumController.getModule);

router.post(
  '/course-versions/:versionId/modules',
  authenticateJWT,
  requirePermission('curriculum.create'),
  validate(validateCreateModule),
  curriculumController.createModule
);

router.put(
  '/modules/:id',
  authenticateJWT,
  requirePermission('curriculum.edit'),
  validate(validateUpdateModule),
  curriculumController.updateModule
);

router.patch(
  '/modules/:id/status',
  authenticateJWT,
  requirePermission('curriculum.edit'),
  curriculumController.updateModuleStatus
);

router.patch(
  '/modules/:id/reorder',
  authenticateJWT,
  requirePermission('curriculum.reorder'),
  validate(validateReorder),
  curriculumController.reorderModule
);

router.delete(
  '/modules/:id',
  authenticateJWT,
  requirePermission('curriculum.delete'),
  curriculumController.deleteModule
);

// ==========================================
// 4. LESSONS / VIDEOS (ADMIN & PUBLIC LISTING)
// ==========================================
router.get('/modules/:moduleId/lessons', curriculumController.getLessons);
router.get('/lessons/:id', curriculumController.getLesson);

router.post(
  '/modules/:moduleId/lessons',
  authenticateJWT,
  requirePermission('curriculum.create'),
  validate(validateCreateLesson),
  curriculumController.createLesson
);

router.put(
  '/lessons/:id',
  authenticateJWT,
  requirePermission('curriculum.edit'),
  validate(validateUpdateLesson),
  curriculumController.updateLesson
);

router.patch(
  '/lessons/:id/status',
  authenticateJWT,
  requirePermission('curriculum.edit'),
  curriculumController.updateLessonStatus
);

router.patch(
  '/lessons/:id/reorder',
  authenticateJWT,
  requirePermission('curriculum.reorder'),
  validate(validateReorder),
  curriculumController.reorderLesson
);

router.delete(
  '/lessons/:id',
  authenticateJWT,
  requirePermission('curriculum.delete'),
  curriculumController.deleteLesson
);

// ==========================================
// 5. LESSON TOPICS (ADMIN & PUBLIC LISTING)
// ==========================================
router.get('/lessons/:lessonId/topics', curriculumController.getTopics);

router.post(
  '/lessons/:lessonId/topics',
  authenticateJWT,
  requirePermission('curriculum.create'),
  validate(validateCreateTopic),
  curriculumController.createTopic
);

router.put(
  '/topics/:id',
  authenticateJWT,
  requirePermission('curriculum.edit'),
  validate(validateUpdateTopic),
  curriculumController.updateTopic
);

router.patch(
  '/topics/:id/reorder',
  authenticateJWT,
  requirePermission('curriculum.reorder'),
  validate(validateReorder),
  curriculumController.reorderTopic
);

router.delete(
  '/topics/:id',
  authenticateJWT,
  requirePermission('curriculum.delete'),
  curriculumController.deleteTopic
);

module.exports = router;
