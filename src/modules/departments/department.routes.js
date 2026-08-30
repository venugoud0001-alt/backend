const express = require('express');
const router = express.Router();
const departmentController = require('./department.controller');
const { validateCreateDepartment, validateUpdateDepartment, validateStatusUpdate } = require('./department.validator');
const { validate } = require('../../middleware/validate');
const { authenticateJWT } = require('../../middleware/authenticate');
const { requireAdminRole, requirePermission } = require('../../middleware/authorize');

// Public Routes
router.get('/departments', departmentController.getDepartments);
router.get('/departments/id/:id', departmentController.getDepartmentById);
router.get('/departments/slug/:slug', departmentController.getDepartmentBySlug);
router.get('/departments/:identifier', departmentController.getDepartmentByIdentifier);

// Admin Protected Routes
router.post(
  '/departments',
  authenticateJWT,
  requirePermission('department.create'),
  validate(validateCreateDepartment),
  departmentController.createDepartment
);

router.put(
  '/departments/:id',
  authenticateJWT,
  requirePermission('department.edit'),
  validate(validateUpdateDepartment),
  departmentController.updateDepartment
);

router.patch(
  '/departments/:id/status',
  authenticateJWT,
  requirePermission('department.edit'),
  validate(validateStatusUpdate),
  departmentController.updateStatus
);

router.delete(
  '/departments/:id',
  authenticateJWT,
  requirePermission('department.delete'),
  departmentController.deleteDepartment
);

module.exports = router;
