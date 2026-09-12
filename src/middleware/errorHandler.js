const { errorResponse } = require('../utils/response');

/**
 * Centralized Global Error Handler Middleware
 */
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  // Differentiate expected 4xx client/pipeline states from true 5xx internal server errors
  if (status >= 500) {
    console.error('🚨 [Internal Server Error 500]:', err);
  } else {
    console.log(`ℹ️ [API Notice ${status}]:`, err.message || err);
  }

  // Sanitized message logic to prevent database leak
  let userMessage = err.message || 'An internal server error occurred.';

  // Mask database / Supabase / Postgres error messages
  if (
    userMessage.includes('PGRST') ||
    userMessage.includes('postgres') ||
    userMessage.includes('schema cache') ||
    userMessage.includes('relation') ||
    userMessage.includes('column') ||
    err.code?.startsWith('23') // Postgres constraint codes
  ) {
    if (err.code === '23505') { // Unique violation
      userMessage = 'A resource with duplicate fields already exists.';
    } else {
      userMessage = 'A database error occurred while processing your request.';
    }
  }

  if (isProd && status === 500) {
    userMessage = 'An internal server error occurred.';
  }

  const details = (err.field || err.code) ? { field: err.field, code: err.code || 'VALIDATION_ERROR' } : null;
  return errorResponse(res, userMessage, status, details);
}

module.exports = {
  errorHandler
};
