const { errorResponse } = require('../utils/response');
const rbacService = require('../modules/rbac/rbac.service');

/**
 * 1. Require General Administrative Privilege (SUPER_ADMIN or active ADMIN)
 */
async function requireAdminRole(req, res, next) {
  try {
    if (!req.user) {
      return errorResponse(res, 'Authentication required.', 401);
    }

    const rbac = await rbacService.getUserRoleAndPermissions(req.user);
    req.rbac = rbac;

    if (rbac.role === 'STUDENT') {
      return errorResponse(res, 'Forbidden: Administrative privilege required.', 403);
    }

    if (rbac.status === 'Disabled') {
      return errorResponse(res, 'Forbidden: Administrative account has been deactivated.', 403);
    }

    return next();
  } catch (err) {
    return errorResponse(res, 'Authorization verification failed.', 500);
  }
}

/**
 * 2. Require Strict SUPER_ADMIN Role (Platform Owner / Administrative Delegator)
 */
async function requireSuperAdmin(req, res, next) {
  try {
    if (!req.user) {
      return errorResponse(res, 'Authentication required.', 401);
    }

    const rbac = await rbacService.getUserRoleAndPermissions(req.user);
    req.rbac = rbac;

    if (rbac.role !== 'SUPER_ADMIN') {
      return errorResponse(res, 'Forbidden: Super Administrator privilege required.', 403);
    }

    return next();
  } catch (err) {
    return errorResponse(res, 'Authorization verification failed.', 500);
  }
}

/**
 * 3. Enforce Granular Permission (e.g. 'course.create', 'payment.view')
 * SUPER_ADMIN has implicit full access. ADMIN must explicitly possess permissionCode.
 */
function requirePermission(permissionCode) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required.', 401);
      }

      const rbac = req.rbac || (await rbacService.getUserRoleAndPermissions(req.user));
      req.rbac = rbac;

      if (rbac.role === 'STUDENT') {
        return errorResponse(res, 'Forbidden: Administrative privilege required.', 403);
      }

      if (rbac.status === 'Disabled') {
        return errorResponse(res, 'Forbidden: Administrative account has been deactivated.', 403);
      }

      if (!rbacService.hasPermission(rbac, permissionCode)) {
        return errorResponse(res, `Forbidden: Missing required permission '${permissionCode}'.`, 403);
      }

      return next();
    } catch (err) {
      return errorResponse(res, 'Authorization verification failed.', 500);
    }
  };
}

/**
 * 4. Require At Least One Permission from List
 */
function requireAnyPermission(permissionCodes = []) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return errorResponse(res, 'Authentication required.', 401);
      }

      const rbac = req.rbac || (await rbacService.getUserRoleAndPermissions(req.user));
      req.rbac = rbac;

      if (rbac.role === 'STUDENT') {
        return errorResponse(res, 'Forbidden: Administrative privilege required.', 403);
      }

      if (rbac.status === 'Disabled') {
        return errorResponse(res, 'Forbidden: Administrative account has been deactivated.', 403);
      }

      if (rbac.role === 'SUPER_ADMIN') {
        return next();
      }

      const hasAny = permissionCodes.some(p => rbacService.hasPermission(rbac, p));
      if (!hasAny) {
        return errorResponse(res, `Forbidden: Missing required permission from [${permissionCodes.join(', ')}].`, 403);
      }

      return next();
    } catch (err) {
      return errorResponse(res, 'Authorization verification failed.', 500);
    }
  };
}

module.exports = {
  requireAdminRole,
  requireSuperAdmin,
  requirePermission,
  requireAnyPermission
};
