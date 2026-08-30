const { errorResponse } = require('../utils/response');

/**
 * Centralized Global Error Handler Middleware
 */
function errorHandler(err, req, res, next) {
  // Always log detailed server error for debugging
  console.error('🚨 [Server Exception]:', err);

  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

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
