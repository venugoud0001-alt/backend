/**
 * RBAC & Sub-User Management Routes
 */

const express = require('express');
const router = express.Router();
const rbacController = require('./rbac.controller');
const { authenticateJWT } = require('../../middleware/authenticate');
const { requireAdminRole, requireSuperAdmin, requirePermission } = require('../../middleware/authorize');

// 1. Get Permissions Catalog (Any Admin)
router.get(
  '/admin/permissions',
  authenticateJWT,
  requireAdminRole,
  rbacController.getPermissionsCatalog
);

// 2. Get Current Authenticated User's Permissions & Role
router.get(
  '/admin/my-permissions',
  authenticateJWT,
  rbacController.getMyPermissions
);

// 3. List Delegated Sub-Users (Requires admin.view permission)
router.get(
  '/admin/sub-users',
  authenticateJWT,
  requirePermission('admin.view'),
  rbacController.listSubUsers
);

// 4. Create Delegated Sub-User (SUPER_ADMIN Only)
router.post(
  '/admin/sub-users',
  authenticateJWT,
  requireSuperAdmin,
  rbacController.createSubUser
);

// 5. Update Sub-User Permissions & Scope (SUPER_ADMIN Only)
router.put(
  '/admin/sub-users/:id',
  authenticateJWT,
  requireSuperAdmin,
  rbacController.updateSubUser
);

// 6. Toggle Sub-User Status (SUPER_ADMIN Only)
router.patch(
  '/admin/sub-users/:id/status',
  authenticateJWT,
  requireSuperAdmin,
  rbacController.toggleStatus
);

// 7. Delete Sub-User Permanently (SUPER_ADMIN Only)
router.delete(
  '/admin/sub-users/:id',
  authenticateJWT,
  requireSuperAdmin,
  rbacController.deleteSubUser
);

// 8. Review Audit Logs (SUPER_ADMIN Only)
router.get(
  '/admin/audit-logs',
  authenticateJWT,
  requireSuperAdmin,
  rbacController.getAuditLogs
);

module.exports = router;
