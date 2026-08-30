const { authenticateJWT } = require('../src/middleware/authenticate');
const { requireAdminRole, requireSuperAdmin, requirePermission, requireAnyPermission } = require('../src/middleware/authorize');

module.exports = {
  authenticateJWT,
  requireAdminRole,
  requireSuperAdmin,
  requirePermission,
  requireAnyPermission
};
