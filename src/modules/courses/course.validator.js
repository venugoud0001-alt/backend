const { isValidSlug } = require('../../utils/slug');

const ALLOWED_STATUSES = ['DRAFT', 'PUBLISHED', 'UNPUBLISHED', 'ARCHIVED'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(id) {
  if (!id || typeof id !== 'string') return false;
  return UUID_REGEX.test(id) || /^mod_[a-z0-9_]+$/i.test(id);
}

/**
 * Validate course creation input
 */
function validateCreateCourse(req) {
  const {
    department_id,
    title,
    slug,
    short_description,
    description,
    thumbnail_url,
    image_url,
    duration,
    level,
    instructor_name,
    instructor_role,
    instructor_bio,
    skills,
    learning_outcomes,
    course_includes,
    prerequisites,
    target_audience,
    curriculum_modules,
    display_order,
    status
  } = req.body || {};

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return { isValid: false, error: 'Course title is required and must be a non-empty string.' };
  }

  if (!department_id || !isValidUUID(department_id)) {
    return { isValid: false, error: 'Valid department_id UUID is required.' };
  }

  if (slug && !isValidSlug(slug)) {
    return { isValid: false, error: 'Invalid slug format.' };
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
      department_id: department_id.trim(),
      title: title.trim(),
      slug: slug ? slug.trim().toLowerCase() : null,
      short_description: short_description ? short_description.trim() : '',
      description: description ? description.trim() : '',
      thumbnail_url: rawThumb ? String(rawThumb).trim() : '',
      duration: duration ? String(duration).trim() : '8 Weeks',
      level: level ? String(level).trim() : 'Beginner to Advanced',
      instructor_name: instructor_name ? String(instructor_name).trim() : 'Industry Expert',
      instructor_role: instructor_role ? String(instructor_role).trim() : '',
      instructor_bio: instructor_bio ? String(instructor_bio).trim() : '',
      skills: Array.isArray(skills) ? skills : [],
      learning_outcomes: Array.isArray(learning_outcomes) ? learning_outcomes : [],
      course_includes: Array.isArray(course_includes) ? course_includes : [],
      prerequisites: Array.isArray(prerequisites) ? prerequisites : [],
      target_audience: Array.isArray(target_audience) ? target_audience : [],
      curriculum_modules: Array.isArray(curriculum_modules) ? curriculum_modules : [],
      display_order: display_order !== undefined && display_order !== null ? Number(display_order) : 0,
      status: status ? status.toUpperCase() : 'DRAFT'
    }
  };
}

/**
 * Validate course update input
 */
function validateUpdateCourse(req) {
  const { id } = req.params;
  const {
    department_id,
    title,
    slug,
    short_description,
    description,
    thumbnail_url,
    image_url,
    duration,
    level,
    instructor_name,
    instructor_role,
    instructor_bio,
    skills,
    learning_outcomes,
    course_includes,
    prerequisites,
    target_audience,
    curriculum_modules,
    display_order,
    status
  } = req.body || {};

  if (!id || !isValidUUID(id)) {
    return { isValid: false, error: 'Valid Course UUID is required.' };
  }

  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
    return { isValid: false, error: 'Course title must be a non-empty string.' };
  }

  if (department_id !== undefined && !isValidUUID(department_id)) {
    return { isValid: false, error: 'Valid department_id UUID is required.' };
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
  if (department_id !== undefined) sanitizedData.department_id = department_id.trim();
  if (title !== undefined) sanitizedData.title = title.trim();
  if (slug !== undefined && slug !== null && slug !== '') sanitizedData.slug = slug.trim().toLowerCase();
  if (short_description !== undefined) sanitizedData.short_description = short_description.trim();
  if (description !== undefined) sanitizedData.description = description.trim();
  if (duration !== undefined) sanitizedData.duration = String(duration).trim();
  if (level !== undefined) sanitizedData.level = String(level).trim();
  if (instructor_name !== undefined) sanitizedData.instructor_name = String(instructor_name).trim();
  if (instructor_role !== undefined) sanitizedData.instructor_role = String(instructor_role).trim();
  if (instructor_bio !== undefined) sanitizedData.instructor_bio = String(instructor_bio).trim();
  if (skills !== undefined) sanitizedData.skills = Array.isArray(skills) ? skills : [];
  if (learning_outcomes !== undefined) sanitizedData.learning_outcomes = Array.isArray(learning_outcomes) ? learning_outcomes : [];
  if (course_includes !== undefined) sanitizedData.course_includes = Array.isArray(course_includes) ? course_includes : [];
  if (prerequisites !== undefined) sanitizedData.prerequisites = Array.isArray(prerequisites) ? prerequisites : [];
  if (target_audience !== undefined) sanitizedData.target_audience = Array.isArray(target_audience) ? target_audience : [];
  if (curriculum_modules !== undefined) sanitizedData.curriculum_modules = Array.isArray(curriculum_modules) ? curriculum_modules : [];
  
  const rawThumb = thumbnail_url !== undefined ? thumbnail_url : image_url;
  if (rawThumb !== undefined) sanitizedData.thumbnail_url = String(rawThumb).trim();

  if (display_order !== undefined) sanitizedData.display_order = Number(display_order);
  if (status !== undefined) sanitizedData.status = status.toUpperCase();

  return { isValid: true, sanitizedData };
}

/**
 * Validate course status update
 */
function validateCourseStatusUpdate(req) {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!id || !isValidUUID(id)) {
    return { isValid: false, error: 'Valid Course UUID is required.' };
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
  validateCreateCourse,
  validateUpdateCourse,
  validateCourseStatusUpdate,
  isValidUUID
};
