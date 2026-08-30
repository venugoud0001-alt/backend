const { errorResponse } = require('../utils/response');

/**
 * Validation Middleware Wrapper
 * Executes a validation function against the express request object.
 *
 * @param {Function} validatorFn Function returning { isValid: boolean, error: string, data: object }
 */
function validate(validatorFn) {
  return (req, res, next) => {
    const result = validatorFn(req);
    if (!result.isValid) {
      return errorResponse(res, result.error || 'Validation failed.', 400, result.details || null);
    }
    // Attach sanitized data to request if available
    if (result.sanitizedData) {
      req.validatedData = result.sanitizedData;
    }
    next();
  };
}

module.exports = {
  validate
};
