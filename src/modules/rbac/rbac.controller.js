/**
 * RBAC & Sub-User Management Controller
 */

const rbacService = require('./rbac.service');
const { PERMISSION_GROUPS, PERMISSION_PROFILES, PERMISSIONS } = require('./rbac.constants');
const { successResponse, errorResponse } = require('../../utils/response');

class RbacController {
  /**
   * GET /api/admin/permissions
   * Returns complete catalog of granular permissions grouped by module
   */
  async getPermissionsCatalog(req, res, next) {
    try {
      return successResponse(res, {
        groups: PERMISSION_GROUPS,
        profiles: PERMISSION_PROFILES,
        allPermissions: Object.values(PERMISSIONS)
      }, 'Permissions catalog retrieved.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/admin/my-permissions
   * Returns currently logged-in user's role, delegation, and granular permission array
   */
  async getMyPermissions(req, res, next) {
    try {
      const rbac = await rbacService.getUserRoleAndPermissions(req.user);
      return successResponse(res, {
        userId: rbac.userId,
        email: rbac.email,
        name: rbac.name,
        role: rbac.role,
        isSuperAdmin: rbac.isSuperAdmin,
        permissions: rbac.permissions,
        status: rbac.status,
        designation: rbac.designation
      }, 'Active permissions resolved.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/admin/sub-users
   * Returns all delegated administrators
   */
  async listSubUsers(req, res, next) {
    try {
      const list = await rbacService.listSubAdmins(req.user);
      return successResponse(res, list, 'Sub-users retrieved.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/admin/sub-users
   * Super Admin creates a new delegated administrator with assigned permissions
   */
  async createSubUser(req, res, next) {
    try {
      const created = await rbacService.createSubAdmin(req.user, req.body || {});
      return successResponse(res, created, 'Sub-user provisioned successfully with assigned permissions.', 201);
    } catch (err) {
      next(err);
    }
  }

  /**
   * PUT /api/admin/sub-users/:id
   * Super Admin updates an existing sub-user profile or assigned permissions
   */
  async updateSubUser(req, res, next) {
    try {
      const { id } = req.params;
      const updated = await rbacService.updateSubAdmin(req.user, id, req.body || {});
      return successResponse(res, updated, 'Sub-user permissions updated successfully.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/admin/sub-users/:id/status
   * Toggles sub-user active or disabled status
   */
  async toggleStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status } = req.body || {};
      const updated = await rbacService.updateSubAdmin(req.user, id, { status });
      return successResponse(res, updated, `Sub-user status updated to ${status}.`);
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/admin/sub-users/:id
   * Deactivates a sub-user
   */
  async deactivateSubUser(req, res, next) {
    try {
      const { id } = req.params;
      const result = await rbacService.deactivateSubAdmin(req.user, id);
      return successResponse(res, result, 'Sub-user account deactivated.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * DELETE /api/admin/sub-users/:id
   * Deletes a sub-user permanently
   */
  async deleteSubUser(req, res, next) {
    try {
      const { id } = req.params;
      const result = await rbacService.deleteSubAdmin(req.user, id);
      return successResponse(res, result, 'Sub-user account deleted permanently.');
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/admin/audit-logs
   * Super Admin reviews platform audit trail
   */
  async getAuditLogs(req, res, next) {
    try {
      const limit = parseInt(req.query.limit, 10) || 100;
      const logs = await rbacService.getAuditLogs(req.user, { limit });
      return successResponse(res, logs, 'Audit logs retrieved.');
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new RbacController();
