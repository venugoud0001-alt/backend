/**
 * Standardized API Response Utilities
 */

/**
 * Standard Success Response
 * @param {Response} res Express response object
 * @param {Object|Array} data Payload data
 * @param {number} statusCode HTTP status code (default: 200)
 * @param {string|null} message Optional success message
 */
function successResponse(res, data = null, statusCode = 200, message = null) {
  if (typeof statusCode === 'string') {
    const tempMsg = statusCode;
    statusCode = typeof message === 'number' ? message : 200;
    message = tempMsg;
  }

  const payload = {
    status: 'SUCCESS'
  };

  if (message) {
    payload.message = message;
  }

  if (data !== null && data !== undefined) {
    if (typeof data === 'object' && !Array.isArray(data) && data.status) {
      // Merge if data already contains properties or return directly
      Object.assign(payload, data);
    } else {
      payload.data = data;
    }
  }

  return res.status(Number(statusCode) || 200).json(payload);
}

/**
 * Standard Error Response
 * @param {Response} res Express response object
 * @param {string} message Error description (user safe)
 * @param {number} statusCode HTTP status code (default: 500)
 * @param {Object|null} details Optional details or validation field map
 */
function errorResponse(res, message = 'An error occurred.', statusCode = 500, details = null) {
  const payload = {
    status: 'ERROR',
    message: message || 'An internal server error occurred.'
  };

  if (details) {
    payload.details = details;
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  successResponse,
  errorResponse
};
