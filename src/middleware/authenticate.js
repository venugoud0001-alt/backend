const jwt = require('jsonwebtoken');
const { supabase, JWT_SECRET } = require('../config/supabase');
const { errorResponse } = require('../utils/response');

/**
 * Middleware to authenticate JWT / Supabase session token
 */
async function authenticateJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(res, 'Authentication required. Authorization header missing.', 401);
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return errorResponse(res, 'Bearer token missing.', 401);
    }

    let user = null;
    try {
      const { data: { user: sbUser }, error } = await supabase.auth.getUser(token);
      if (!error && sbUser) {
        user = sbUser;
      }
    } catch (sbErr) {}

    if (!user && JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded) {
          user = {
            id: decoded.id || decoded.sub || 'admin-user',
            email: decoded.email || 'admin@internnetra.com',
            user_metadata: { role: decoded.role || 'ADMIN' }
          };
        }
      } catch (jwtErr) {
        // Signature verification failed - rejected safely without unverified fallback
      }
    }

    if (!user) {
      return errorResponse(res, 'Invalid or expired authentication session.', 401);
    }

    req.user = user;
    req.userRole = user.user_metadata?.role || (user.email?.toLowerCase().includes('admin') ? 'ADMIN' : 'STUDENT');
    return next();
  } catch (err) {
    return errorResponse(res, 'Authentication verification failed.', 401);
  }
}

module.exports = {
  authenticateJWT
};
