const { isValidSlug } = require('../../utils/slug');

const ALLOWED_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'];

/**
 * Validate department creation input
 */
function validateCreateDepartment(req) {
  const { name, slug, description, thumbnail_url, image_url, display_order, status } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return { isValid: false, error: 'Department name is required and must be a non-empty string.' };
  }

  if (slug && !isValidSlug(slug)) {
    return { isValid: false, error: 'Invalid slug format. Use lowercase alphanumeric characters and hyphens only.' };
  }

  if (display_order !== undefined && display_order !== null) {
    const parsedOrder = Number(display_order);
    if (isNaN(parsedOrder) || parsedOrder < 0 || !Number.isInteger(parsedOrder)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  if (status && !ALLOWED_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(', ')}.` };
  }

  const rawThumb = thumbnail_url !== undefined ? thumbnail_url : image_url;

  return {
    isValid: true,
    sanitizedData: {
      name: name.trim(),
      slug: slug ? slug.trim().toLowerCase() : null,
      description: description ? description.trim() : '',
      thumbnail_url: rawThumb ? String(rawThumb).trim() : '',
      image_url: rawThumb ? String(rawThumb).trim() : '',
      display_order: display_order !== undefined && display_order !== null ? Number(display_order) : 0,
      status: status ? status.toUpperCase() : 'ACTIVE'
    }
  };
}

/**
 * Validate department update input
 */
function validateUpdateDepartment(req) {
  const { id } = req.params;
  const { name, slug, description, thumbnail_url, image_url, display_order, status } = req.body || {};

  if (!id) {
    return { isValid: false, error: 'Department ID is required in URL path.' };
  }

  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
    return { isValid: false, error: 'Department name must be a non-empty string.' };
  }

  if (slug !== undefined && slug !== null && slug !== '' && !isValidSlug(slug)) {
    return { isValid: false, error: 'Invalid slug format.' };
  }

  if (display_order !== undefined && display_order !== null) {
    const parsedOrder = Number(display_order);
    if (isNaN(parsedOrder) || parsedOrder < 0 || !Number.isInteger(parsedOrder)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  if (status !== undefined && !ALLOWED_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(', ')}.` };
  }

  const sanitizedData = {};
  if (name !== undefined) sanitizedData.name = name.trim();
  if (slug !== undefined && slug !== null && slug !== '') sanitizedData.slug = slug.trim().toLowerCase();
  if (description !== undefined) sanitizedData.description = description.trim();

  const rawThumb = thumbnail_url !== undefined ? thumbnail_url : image_url;
  if (rawThumb !== undefined) {
    sanitizedData.thumbnail_url = String(rawThumb).trim();
    sanitizedData.image_url = String(rawThumb).trim();
  }

  if (display_order !== undefined) sanitizedData.display_order = Number(display_order);
  if (status !== undefined) sanitizedData.status = status.toUpperCase();

  return { isValid: true, sanitizedData };
}

/**
 * Validate department status update
 */
function validateStatusUpdate(req) {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!id) {
    return { isValid: false, error: 'Department ID is required.' };
  }

  if (!status || !ALLOWED_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(', ')}.` };
  }

  return {
    isValid: true,
    sanitizedData: { status: status.toUpperCase() }
  };
}

module.exports = {
  validateCreateDepartment,
  validateUpdateDepartment,
  validateStatusUpdate
};
