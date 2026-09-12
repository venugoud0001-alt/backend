const { isValidUUID } = require('../courses/course.validator');
const { isValidSlug } = require('../../utils/slug');

const ALLOWED_LESSON_TYPES = ['VIDEO', 'PDF', 'ARTICLE', 'QUIZ', 'ASSIGNMENT', 'LIVE'];
const ALLOWED_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const ALLOWED_MODULE_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];
const ALLOWED_LESSON_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'];

/**
 * Course Version Validation
 */
function validateCreateVersion(req) {
  const { courseId } = req.params;
  const { version_number, title, description, status } = req.body || {};

  if (!courseId || !isValidUUID(courseId)) {
    return { isValid: false, error: 'Valid courseId UUID is required.' };
  }

  const vNum = Number(version_number);
  if (isNaN(vNum) || vNum <= 0 || !Number.isInteger(vNum)) {
    return { isValid: false, error: 'version_number must be an integer greater than 0.' };
  }

  if (status && !ALLOWED_VERSION_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: `Invalid version status. Allowed: ${ALLOWED_VERSION_STATUSES.join(', ')}` };
  }

  return {
    isValid: true,
    sanitizedData: {
      course_id: courseId,
      version_number: vNum,
      title: title ? title.trim() : `Version ${vNum}`,
      description: description ? description.trim() : '',
      status: status ? status.toUpperCase() : 'DRAFT'
    }
  };
}

function validateUpdateVersion(req) {
  const { id } = req.params;
  const { version_number, title, description, status } = req.body || {};

  if (!id || !isValidUUID(id)) {
    return { isValid: false, error: 'Valid Version UUID is required.' };
  }

  const sanitizedData = {};

  if (version_number !== undefined) {
    const vNum = Number(version_number);
    if (isNaN(vNum) || vNum <= 0 || !Number.isInteger(vNum)) {
      return { isValid: false, error: 'version_number must be an integer greater than 0.' };
    }
    sanitizedData.version_number = vNum;
  }

  if (title !== undefined) sanitizedData.title = title.trim();
  if (description !== undefined) sanitizedData.description = description.trim();
  if (status !== undefined) {
    if (!ALLOWED_VERSION_STATUSES.includes(status.toUpperCase())) {
      return { isValid: false, error: 'Invalid version status.' };
    }
    sanitizedData.status = status.toUpperCase();
  }

  return { isValid: true, sanitizedData };
}

/**
 * Helper to sanitize embedded lessons & topics array
 */
function sanitizeLessonsArray(rawLessons) {
  if (!Array.isArray(rawLessons)) return [];
  return rawLessons.map((l, idx) => {
    if (typeof l === 'string') {
      return {
        id: `les_${Date.now()}_${idx}`,
        title: l.trim(),
        duration: '1 hr',
        duration_minutes: 60,
        lesson_type: 'VIDEO',
        topics: []
      };
    }
    const topicsArr = Array.isArray(l.topics)
      ? l.topics.map((t, tIdx) => {
          if (typeof t === 'string') {
            return { id: `top_${Date.now()}_${tIdx}`, title: t.trim() };
          }
          return {
            id: t.id || `top_${Date.now()}_${tIdx}`,
            title: (t.title || t.name || '').trim(),
            lesson_id: l.id
          };
        }).filter(t => Boolean(t.title))
      : [];

    return {
      id: l.id || `les_${Date.now()}_${idx}`,
      module_id: l.module_id,
      title: (l.title || l.name || `Lesson ${idx + 1}`).trim(),
      description: l.description ? l.description.trim() : '',
      duration: l.duration || '1 hr',
      duration_minutes: l.duration_minutes !== undefined ? Number(l.duration_minutes) : 60,
      lesson_type: (l.lesson_type || 'VIDEO').toUpperCase(),
      video_url: l.video_url ? l.video_url.trim() : '',
      thumbnail_url: l.thumbnail_url ? l.thumbnail_url.trim() : '',
      is_preview: Boolean(l.is_preview),
      topics: topicsArr
    };
  });
}

/**
 * Module Validation
 */
function validateCreateModule(req) {
  const { versionId } = req.params;
  const {
    name,
    title,
    slug,
    description,
    display_order,
    status,
    lessons,
    topics,
    duration,
    duration_minutes,
    duration_hours,
    video_url,
    video_status,
    video_title,
    video_asset_id,
    video_error_message,
    is_preview,
    is_free_preview,
    is_published
  } = req.body || {};

  if (!versionId || !isValidUUID(versionId)) {
    return { isValid: false, error: 'Valid versionId UUID is required.' };
  }

  const moduleName = name || title;
  if (!moduleName || typeof moduleName !== 'string' || moduleName.trim().length === 0) {
    return { isValid: false, error: 'Module name is required.' };
  }

  if (slug && !isValidSlug(slug)) {
    return { isValid: false, error: 'Invalid slug format.' };
  }

  if (display_order !== undefined && display_order !== null) {
    const order = Number(display_order);
    if (isNaN(order) || order < 0 || !Number.isInteger(order)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  if (status && !ALLOWED_MODULE_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: `Invalid module status. Allowed: ${ALLOWED_MODULE_STATUSES.join(', ')}` };
  }

  const effectivePreview = is_preview !== undefined ? is_preview : is_free_preview;

  return {
    isValid: true,
    sanitizedData: {
      course_version_id: versionId,
      name: moduleName.trim(),
      title: moduleName.trim(),
      slug: slug ? slug.trim().toLowerCase() : null,
      description: description ? description.trim() : '',
      duration: duration ? duration.trim() : undefined,
      duration_minutes: duration_minutes !== undefined ? Number(duration_minutes) : (duration_hours ? Math.round(Number(duration_hours) * 60) : undefined),
      display_order: display_order !== undefined && display_order !== null ? Number(display_order) : 0,
      status: status ? status.toUpperCase() : 'PUBLISHED',
      lessons: Array.isArray(lessons) ? sanitizeLessonsArray(lessons) : undefined,
      topics: Array.isArray(topics) ? topics : undefined,
      video_url: video_url !== undefined ? String(video_url).trim() : undefined,
      video_status: video_status !== undefined ? String(video_status).trim().toUpperCase() : undefined,
      video_title: video_title !== undefined ? String(video_title).trim() : undefined,
      video_asset_id: video_asset_id !== undefined ? video_asset_id : undefined,
      video_error_message: video_error_message !== undefined ? String(video_error_message).trim() : undefined,
      is_preview: effectivePreview !== undefined ? Boolean(effectivePreview) : undefined,
      is_published: is_published !== undefined ? Boolean(is_published) : undefined
    }
  };
}

function validateUpdateModule(req) {
  const { id } = req.params;
  const {
    name,
    title,
    slug,
    description,
    display_order,
    status,
    lessons,
    topics,
    duration,
    duration_minutes,
    duration_hours,
    video_url,
    video_status,
    video_title,
    video_asset_id,
    video_error_message,
    is_preview,
    is_free_preview,
    is_published
  } = req.body || {};

  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    return { isValid: false, error: 'Valid Module ID is required.' };
  }

  const moduleName = name || title;
  if (moduleName !== undefined && (typeof moduleName !== 'string' || moduleName.trim().length === 0)) {
    return { isValid: false, error: 'Module name must be a non-empty string.' };
  }

  if (slug !== undefined && slug !== null && slug !== '' && !isValidSlug(slug)) {
    return { isValid: false, error: 'Invalid slug format.' };
  }

  if (display_order !== undefined && display_order !== null) {
    const order = Number(display_order);
    if (isNaN(order) || order < 0 || !Number.isInteger(order)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  if (status !== undefined && !ALLOWED_MODULE_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: 'Invalid module status.' };
  }

  const sanitizedData = {};
  if (moduleName !== undefined) {
    sanitizedData.name = moduleName.trim();
    sanitizedData.title = moduleName.trim();
  }
  if (slug !== undefined && slug !== null && slug !== '') sanitizedData.slug = slug.trim().toLowerCase();
  if (description !== undefined) sanitizedData.description = description.trim();
  if (duration !== undefined) sanitizedData.duration = duration.trim();
  if (duration_minutes !== undefined) sanitizedData.duration_minutes = Number(duration_minutes);
  if (duration_hours !== undefined) sanitizedData.duration_hours = Number(duration_hours);
  if (display_order !== undefined) sanitizedData.display_order = Number(display_order);
  if (status !== undefined) sanitizedData.status = status.toUpperCase();
  if (Array.isArray(lessons)) sanitizedData.lessons = sanitizeLessonsArray(lessons);
  if (Array.isArray(topics)) sanitizedData.topics = topics;

  // Video fields (critical for Add, Update, Replace, and Remove Video operations)
  if (video_url !== undefined) sanitizedData.video_url = String(video_url).trim();
  if (video_status !== undefined) sanitizedData.video_status = String(video_status).trim().toUpperCase();
  if (video_title !== undefined) sanitizedData.video_title = String(video_title).trim();
  if (video_asset_id !== undefined) sanitizedData.video_asset_id = video_asset_id;
  if (video_error_message !== undefined) sanitizedData.video_error_message = String(video_error_message).trim();
  const effectiveUpdatePreview = is_preview !== undefined ? is_preview : is_free_preview;
  if (effectiveUpdatePreview !== undefined) sanitizedData.is_preview = Boolean(effectiveUpdatePreview);
  if (is_published !== undefined) sanitizedData.is_published = Boolean(is_published);

  // Preserve course_id if passed in body or query
  const effectiveCourseId = req.body?.course_id || req.body?.courseId || req.query?.courseId || req.query?.course_id;
  if (effectiveCourseId !== undefined && effectiveCourseId !== null && String(effectiveCourseId).trim()) {
    sanitizedData.course_id = String(effectiveCourseId).trim();
  }

  return { isValid: true, sanitizedData };
}

/**
 * Lesson Validation
 */
function validateCreateLesson(req) {
  const { moduleId } = req.params;
  const { title, description, lesson_type, video_url, thumbnail_url, duration_minutes, display_order, is_preview, status } = req.body || {};

  if (!moduleId || typeof moduleId !== 'string' || moduleId.trim().length === 0) {
    return { isValid: false, error: 'Valid moduleId is required.' };
  }

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return { isValid: false, error: 'Lesson title is required.' };
  }

  if (lesson_type && !ALLOWED_LESSON_TYPES.includes(lesson_type.toUpperCase())) {
    return { isValid: false, error: `Invalid lesson_type. Allowed: ${ALLOWED_LESSON_TYPES.join(', ')}` };
  }

  if (duration_minutes !== undefined && duration_minutes !== null) {
    const dur = Number(duration_minutes);
    if (isNaN(dur) || dur < 0) {
      return { isValid: false, error: 'duration_minutes must be >= 0.' };
    }
  }

  if (display_order !== undefined && display_order !== null) {
    const order = Number(display_order);
    if (isNaN(order) || order < 0 || !Number.isInteger(order)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  if (status && !ALLOWED_LESSON_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: 'Invalid lesson status.' };
  }

  return {
    isValid: true,
    sanitizedData: {
      module_id: moduleId,
      title: title.trim(),
      description: description ? description.trim() : '',
      lesson_type: lesson_type ? lesson_type.toUpperCase() : 'VIDEO',
      video_url: video_url ? video_url.trim() : '',
      thumbnail_url: thumbnail_url ? thumbnail_url.trim() : '',
      duration_minutes: duration_minutes !== undefined && duration_minutes !== null ? Number(duration_minutes) : 0,
      display_order: display_order !== undefined && display_order !== null ? Number(display_order) : 0,
      is_preview: Boolean(is_preview),
      status: status ? status.toUpperCase() : 'PUBLISHED'
    }
  };
}

function validateUpdateLesson(req) {
  const { id } = req.params;
  const { title, description, lesson_type, video_url, thumbnail_url, duration_minutes, display_order, is_preview, status } = req.body || {};

  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    return { isValid: false, error: 'Valid Lesson ID is required.' };
  }

  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
    return { isValid: false, error: 'Lesson title must be a non-empty string.' };
  }

  if (lesson_type !== undefined && !ALLOWED_LESSON_TYPES.includes(lesson_type.toUpperCase())) {
    return { isValid: false, error: `Invalid lesson_type. Allowed: ${ALLOWED_LESSON_TYPES.join(', ')}` };
  }

  if (duration_minutes !== undefined && duration_minutes !== null) {
    const dur = Number(duration_minutes);
    if (isNaN(dur) || dur < 0) {
      return { isValid: false, error: 'duration_minutes must be >= 0.' };
    }
  }

  if (display_order !== undefined && display_order !== null) {
    const order = Number(display_order);
    if (isNaN(order) || order < 0 || !Number.isInteger(order)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  if (status !== undefined && !ALLOWED_LESSON_STATUSES.includes(status.toUpperCase())) {
    return { isValid: false, error: 'Invalid lesson status.' };
  }

  const sanitizedData = {};
  if (title !== undefined) sanitizedData.title = title.trim();
  if (description !== undefined) sanitizedData.description = description.trim();
  if (lesson_type !== undefined) sanitizedData.lesson_type = lesson_type.toUpperCase();
  if (video_url !== undefined) sanitizedData.video_url = video_url.trim();
  if (thumbnail_url !== undefined) sanitizedData.thumbnail_url = thumbnail_url.trim();
  if (duration_minutes !== undefined) sanitizedData.duration_minutes = Number(duration_minutes);
  if (display_order !== undefined) sanitizedData.display_order = Number(display_order);
  if (is_preview !== undefined) sanitizedData.is_preview = Boolean(is_preview);
  if (status !== undefined) sanitizedData.status = status.toUpperCase();

  return { isValid: true, sanitizedData };
}

/**
 * Topic Validation
 */
function validateCreateTopic(req) {
  const { lessonId } = req.params;
  const { title, description, display_order } = req.body || {};

  if (!lessonId || typeof lessonId !== 'string' || lessonId.trim().length === 0) {
    return { isValid: false, error: 'Valid lessonId is required.' };
  }

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return { isValid: false, error: 'Topic title is required.' };
  }

  if (display_order !== undefined && display_order !== null) {
    const order = Number(display_order);
    if (isNaN(order) || order < 0 || !Number.isInteger(order)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  return {
    isValid: true,
    sanitizedData: {
      lesson_id: lessonId,
      title: title.trim(),
      description: description ? description.trim() : '',
      display_order: display_order !== undefined && display_order !== null ? Number(display_order) : 0
    }
  };
}

function validateUpdateTopic(req) {
  const { id } = req.params;
  const { title, description, display_order } = req.body || {};

  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    return { isValid: false, error: 'Valid Topic ID is required.' };
  }

  if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
    return { isValid: false, error: 'Topic title must be a non-empty string.' };
  }

  if (display_order !== undefined && display_order !== null) {
    const order = Number(display_order);
    if (isNaN(order) || order < 0 || !Number.isInteger(order)) {
      return { isValid: false, error: 'display_order must be a non-negative integer.' };
    }
  }

  const sanitizedData = {};
  if (title !== undefined) sanitizedData.title = title.trim();
  if (description !== undefined) sanitizedData.description = description.trim();
  if (display_order !== undefined) sanitizedData.display_order = Number(display_order);

  return { isValid: true, sanitizedData };
}

/**
 * Reorder payload validation
 */
function validateReorder(req) {
  const { id } = req.params;
  const { display_order } = req.body || {};

  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    return { isValid: false, error: 'Valid ID is required.' };
  }

  const order = Number(display_order);
  if (display_order === undefined || isNaN(order) || order < 0 || !Number.isInteger(order)) {
    return { isValid: false, error: 'display_order must be a non-negative integer.' };
  }

  return { isValid: true, sanitizedData: { display_order: order } };
}

module.exports = {
  validateCreateVersion,
  validateUpdateVersion,
  validateCreateModule,
  validateUpdateModule,
  validateCreateLesson,
  validateUpdateLesson,
  validateCreateTopic,
  validateUpdateTopic,
  validateReorder
};
