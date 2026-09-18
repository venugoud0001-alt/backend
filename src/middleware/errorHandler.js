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
  const appCode = typeof err.code === 'string' ? err.code : null;
  const isAppBusinessCode = Boolean(
    appCode && /^(COURSE_|PAYMENT_|AUTH_|ENROLLMENT_|MODULE_)/i.test(appCode)
  );
  const isPostgresCode = Boolean(err.code && /^[0-9A-Z]{5}$/.test(String(err.code)) && String(err.code).startsWith('23'));

  // Mask database / Supabase / Postgres error messages (never mask LMS business codes)
  if (
    !isAppBusinessCode &&
    (
      userMessage.includes('PGRST') ||
      userMessage.includes('postgres') ||
      userMessage.includes('schema cache') ||
      userMessage.includes('relation') ||
      userMessage.includes('column') ||
      isPostgresCode
    )
  ) {
    if (err.code === '23505') {
      userMessage = 'A resource with duplicate fields already exists.';
    } else {
      userMessage = 'A database error occurred while processing your request.';
    }
  }

  if (isProd && status === 500 && !isAppBusinessCode) {
    userMessage = 'An internal server error occurred.';
  }

  // Preserve LMS business fields so clients can distinguish SUSPENDED vs NOT_ENROLLED
  const details = {
    ...(err.details && typeof err.details === 'object' ? err.details : {})
  };
  if (err.field) details.field = err.field;
  if (appCode) details.code = appCode;
  if (err.suspension_reason) details.suspension_reason = err.suspension_reason;
  if (err.enrollment_id) details.enrollment_id = err.enrollment_id;
  if (err.amount_pending !== undefined) details.amount_pending = err.amount_pending;
  if (err.second_payment_due_at) details.second_payment_due_at = err.second_payment_due_at;

  const hasDetails = Object.keys(details).length > 0;
  const payloadExtras = isAppBusinessCode
    ? {
        code: appCode,
        suspension_reason: err.suspension_reason || undefined,
        amount_pending: err.amount_pending,
        second_payment_due_at: err.second_payment_due_at || undefined,
        enrollment_id: err.enrollment_id || undefined
      }
    : null;

  if (payloadExtras) {
    // Use explicit JSON so top-level `code` is available to VideoPlayer
    return res.status(status).json({
      status: 'ERROR',
      message: userMessage,
      ...payloadExtras,
      details: hasDetails ? details : undefined
    });
  }

  return errorResponse(res, userMessage, status, hasDetails ? details : null);
}

module.exports = {
  errorHandler
};
