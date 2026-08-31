/**
 * Validation and Sanitization for Coupon APIs
 */

const ALLOWED_DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT'];
const ALLOWED_STATUSES = ['ACTIVE', 'DISABLED', 'EXPIRED', 'SCHEDULED', 'EXHAUSTED'];
const ALLOWED_APPLICABILITY = ['GLOBAL', 'COURSE', 'DEPARTMENT'];

function sanitizeExpiryDate(dateStr) {
  if (!dateStr) return null;
  const str = String(dateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(`${str}T23:59:59.999Z`).toISOString();
  }
  return new Date(str).toISOString();
}

/**
 * Validate coupon creation input
 */
function validateCreateCoupon(req) {
  const {
    code,
    description,
    discount_type,
    discount_value,
    status,
    starts_at,
    expires_at,
    usage_limit,
    per_user_limit,
    minimum_course_amount,
    maximum_discount_amount,
    applicability,
    course_id,
    department_id
  } = req.body || {};

  if (!code || typeof code !== 'string' || code.trim().length === 0) {
    return { isValid: false, error: 'Coupon code is required and must be a non-empty string.' };
  }

  const cleanCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9_\-\/]{2,50}$/.test(cleanCode)) {
    return { isValid: false, error: 'Coupon code must contain only letters, numbers, hyphens, underscores, or slashes (2-50 chars).' };
  }

  const type = (discount_type || 'PERCENTAGE').toUpperCase();
  if (!ALLOWED_DISCOUNT_TYPES.includes(type)) {
    return { isValid: false, error: `Invalid discount_type. Must be one of: ${ALLOWED_DISCOUNT_TYPES.join(', ')}.` };
  }

  const val = Number(discount_value);
  if (isNaN(val) || val < 0) {
    return { isValid: false, error: 'discount_value must be a non-negative number.' };
  }

  if (type === 'PERCENTAGE' && val > 100) {
    return { isValid: false, error: 'Percentage discount cannot exceed 100%.' };
  }

  const app = (applicability || 'GLOBAL').toUpperCase();
  if (!ALLOWED_APPLICABILITY.includes(app)) {
    return { isValid: false, error: `Invalid applicability. Must be one of: ${ALLOWED_APPLICABILITY.join(', ')}.` };
  }

  if (app === 'COURSE' && !course_id) {
    return { isValid: false, error: 'course_id is required for COURSE specific coupons.' };
  }

  if (app === 'DEPARTMENT' && !department_id) {
    return { isValid: false, error: 'department_id is required for DEPARTMENT specific coupons.' };
  }

  const currentStatus = (status || 'ACTIVE').toUpperCase();
  if (!ALLOWED_STATUSES.includes(currentStatus)) {
    return { isValid: false, error: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(', ')}.` };
  }

  const parsedStartsAt = starts_at ? new Date(starts_at).toISOString() : new Date().toISOString();
  const parsedExpiresAt = expires_at ? sanitizeExpiryDate(expires_at) : null;

  if (parsedExpiresAt && parsedStartsAt && new Date(parsedExpiresAt) < new Date(parsedStartsAt)) {
    return { isValid: false, error: 'expires_at cannot be earlier than starts_at.' };
  }

  return {
    isValid: true,
    sanitizedData: {
      code: cleanCode,
      description: description ? description.trim() : '',
      discount_type: type,
      discount_value: val,
      status: currentStatus,
      starts_at: parsedStartsAt,
      expires_at: parsedExpiresAt,
      usage_limit: usage_limit !== undefined && usage_limit !== null && usage_limit !== '' ? Math.max(1, Number(usage_limit)) : null,
      per_user_limit: per_user_limit !== undefined && per_user_limit !== null && per_user_limit !== '' ? Math.max(1, Number(per_user_limit)) : 1,
      minimum_course_amount: minimum_course_amount !== undefined ? Math.max(0, Number(minimum_course_amount)) : 0,
      maximum_discount_amount: maximum_discount_amount !== undefined && maximum_discount_amount !== null && maximum_discount_amount !== '' ? Math.max(0, Number(maximum_discount_amount)) : null,
      applicability: app,
      course_id: course_id || null,
      department_id: department_id || null,
      is_visible_on_site: req.body.is_visible_on_site !== undefined 
        ? Boolean(req.body.is_visible_on_site) 
        : (req.body.show_on_site !== undefined ? Boolean(req.body.show_on_site) : true)
    }
  };
}

/**
 * Validate coupon update input
 */
function validateUpdateCoupon(req) {
  const { id } = req.params;
  const body = req.body || {};

  if (!id) {
    return { isValid: false, error: 'Coupon ID is required.' };
  }

  const sanitizedData = {};

  if (body.is_visible_on_site !== undefined) {
    sanitizedData.is_visible_on_site = Boolean(body.is_visible_on_site);
  } else if (body.show_on_site !== undefined) {
    sanitizedData.is_visible_on_site = Boolean(body.show_on_site);
  }

  if (body.code !== undefined) {
    if (typeof body.code !== 'string' || body.code.trim().length === 0) {
      return { isValid: false, error: 'Coupon code cannot be empty.' };
    }
    const cleanCode = body.code.trim().toUpperCase();
    if (!/^[A-Z0-9_\-\/]{2,50}$/.test(cleanCode)) {
      return { isValid: false, error: 'Invalid coupon code format.' };
    }
    sanitizedData.code = cleanCode;
  }

  if (body.description !== undefined) sanitizedData.description = body.description.trim();

  if (body.discount_type !== undefined) {
    const type = body.discount_type.toUpperCase();
    if (!ALLOWED_DISCOUNT_TYPES.includes(type)) {
      return { isValid: false, error: 'Invalid discount_type.' };
    }
    sanitizedData.discount_type = type;
  }

  if (body.discount_value !== undefined) {
    const val = Number(body.discount_value);
    if (isNaN(val) || val < 0) {
      return { isValid: false, error: 'discount_value must be non-negative.' };
    }
    const currentType = sanitizedData.discount_type || body.discount_type || 'PERCENTAGE';
    if (currentType.toUpperCase() === 'PERCENTAGE' && val > 100) {
      return { isValid: false, error: 'Percentage discount cannot exceed 100%.' };
    }
    sanitizedData.discount_value = val;
  }

  if (body.status !== undefined) {
    const st = body.status.toUpperCase();
    if (!ALLOWED_STATUSES.includes(st)) {
      return { isValid: false, error: 'Invalid status.' };
    }
    sanitizedData.status = st;
  }

  if (body.starts_at !== undefined) sanitizedData.starts_at = body.starts_at ? new Date(body.starts_at).toISOString() : new Date().toISOString();
  if (body.expires_at !== undefined) sanitizedData.expires_at = body.expires_at ? sanitizeExpiryDate(body.expires_at) : null;
  if (sanitizedData.starts_at && sanitizedData.expires_at && new Date(sanitizedData.expires_at) < new Date(sanitizedData.starts_at)) {
    return { isValid: false, error: 'expires_at cannot be earlier than starts_at.' };
  }
  if (body.usage_limit !== undefined) sanitizedData.usage_limit = body.usage_limit ? Math.max(1, Number(body.usage_limit)) : null;
  if (body.per_user_limit !== undefined) sanitizedData.per_user_limit = Math.max(1, Number(body.per_user_limit));
  if (body.minimum_course_amount !== undefined) sanitizedData.minimum_course_amount = Math.max(0, Number(body.minimum_course_amount));
  if (body.maximum_discount_amount !== undefined) sanitizedData.maximum_discount_amount = body.maximum_discount_amount ? Math.max(0, Number(body.maximum_discount_amount)) : null;

  if (body.applicability !== undefined) {
    const app = body.applicability.toUpperCase();
    if (!ALLOWED_APPLICABILITY.includes(app)) {
      return { isValid: false, error: 'Invalid applicability.' };
    }
    sanitizedData.applicability = app;
    if (app === 'COURSE') sanitizedData.course_id = body.course_id;
    if (app === 'DEPARTMENT') sanitizedData.department_id = body.department_id;
  }

  return { isValid: true, sanitizedData };
}

/**
 * Validate public coupon validation API input
 */
function validatePublicValidation(req) {
  const body = req.body || {};
  const code = body.code || body.coupon_code || body.couponCode;
  const courseId = body.courseId || body.course_id;
  const paymentMode = body.paymentMode || body.payment_mode || 'FULL';

  if (!code || typeof code !== 'string' || String(code).trim().length === 0) {
    return { isValid: false, error: 'Coupon code is required.' };
  }

  if (!courseId) {
    return { isValid: false, error: 'courseId is required to validate coupon eligibility.' };
  }

  return {
    isValid: true,
    sanitizedData: {
      code: String(code).trim().toUpperCase(),
      courseId: String(courseId).trim(),
      paymentMode: String(paymentMode).toUpperCase()
    }
  };
}

module.exports = {
  validateCreateCoupon,
  validateUpdateCoupon,
  validatePublicValidation
};
