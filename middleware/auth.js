const { authenticateJWT, optionalAuthenticateJWT } = require('../src/middleware/authenticate');
const { requireAdminRole, requireSuperAdmin, requirePermission, requireAnyPermission } = require('../src/middleware/authorize');

module.exports = {
  authenticateJWT,
  optionalAuthenticateJWT,
  requireAdminRole,
  requireSuperAdmin,
  requirePermission,
  requireAnyPermission
};
