const jwt = require('jsonwebtoken');
const { supabase, JWT_SECRET } = require('../config/supabase');
const { errorResponse } = require('../utils/response');
const rbacService = require('../modules/rbac/rbac.service');

/**
 * Middleware to authenticate JWT / Supabase session token
 * Strict security: Zero hardcoded bypass tokens.
 * Requires cryptographic verification via Supabase GoTrue or JWT_SECRET.
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

    // 1. Try standard Supabase auth.getUser(token)
    try {
      const { data: { user: sbUser }, error } = await supabase.auth.getUser(token);
      if (!error && sbUser) {
        user = sbUser;
      }
    } catch (sbErr) {}

    // 2. Try JWT_SECRET verification (local JWTs)
    if (!user && JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded) {
          const tokenRole = decoded.role || (decoded.user_metadata && decoded.user_metadata.role) || 'STUDENT';
          user = {
            id: decoded.id || decoded.sub || decoded.userId,
            email: decoded.email,
            user_metadata: {
              role: tokenRole,
              name: decoded.name || decoded.fullName || '',
              permissions: decoded.permissions || []
            }
          };
        }
      } catch (jwtErr) {
        // Token was tampered with, forged, or has an invalid/expired signature
      }
    }

    if (!user) {
      return errorResponse(res, 'Invalid or expired authentication session.', 401);
    }

    // 3. Authoritative Role and Permission Resolution via RBAC Service
    try {
      const rbacData = await rbacService.getUserRoleAndPermissions(user);
      user.user_metadata = {
        ...user.user_metadata,
        role: rbacData.role || 'STUDENT',
        permissions: rbacData.permissions || []
      };
      user.role = rbacData.role || 'STUDENT';
      user.permissions = rbacData.permissions || [];
    } catch (rbacErr) {
      console.warn('⚠️ [Auth Middleware] RBAC resolution notice:', rbacErr.message);
    }

    req.user = user;
    req.userRole = user.role || user.user_metadata?.role || 'STUDENT';
    req.user.role = req.userRole;
    return next();
  } catch (err) {
    return errorResponse(res, 'Authentication verification failed.', 401);
  }
}

/**
 * Optional JWT authentication middleware:
 * If Authorization header is present and valid, populates req.user.
 * If header is missing or token is invalid, sets req.user = null and continues without error.
 */
async function optionalAuthenticateJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      req.userRole = 'GUEST';
      return next();
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      req.user = null;
      req.userRole = 'GUEST';
      return next();
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
          const tokenRole = decoded.role || (decoded.user_metadata && decoded.user_metadata.role) || 'STUDENT';
          user = {
            id: decoded.id || decoded.sub || decoded.userId,
            email: decoded.email,
            user_metadata: {
              role: tokenRole,
              name: decoded.name || decoded.fullName || '',
              permissions: decoded.permissions || []
            }
          };
        }
      } catch (jwtErr) {}
    }

    if (user) {
      try {
        const rbacData = await rbacService.getUserRoleAndPermissions(user);
        user.user_metadata = {
          ...user.user_metadata,
          role: rbacData.role || 'STUDENT',
          permissions: rbacData.permissions || []
        };
        user.role = rbacData.role || 'STUDENT';
        user.permissions = rbacData.permissions || [];
      } catch (e) {}
    }

    req.user = user || null;
    req.userRole = user ? (user.role || user.user_metadata?.role || 'STUDENT') : 'GUEST';
    if (req.user) req.user.role = req.userRole;
    return next();
  } catch (err) {
    req.user = null;
    req.userRole = 'GUEST';
    return next();
  }
}

module.exports = {
  authenticateJWT,
  optionalAuthenticateJWT
};
