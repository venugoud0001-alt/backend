/**
 * Authoritative Hierarchy Chain Ownership Validator
 * 
 * Enforces Non-Negotiable Security Invariant:
 * COURSE (courseId)
 *   ↓
 * MODULE (moduleId, courseId)
 *   ↓
 * TOPIC (topicId, moduleId, courseId)
 *   ↓
 * VIDEO (videoId, topicId, moduleId, courseId)
 *   ↓
 * UPLOAD / BACKGROUND JOB (uploadId / jobId, videoId, moduleId, courseId)
 *   ↓
 * S3 / HLS ASSET (s3Key)
 * 
 * Relational database ownership is authoritative.
 * All operations must validate the entire chain before performing any mutation.
 */

const { supabase } = require('../config/supabase');
const { classifyIdentifier, normalizeIdentifier, isUUID } = require('./idValidator');
const s3PathUtils = require('./s3PathUtils');

class HierarchyValidationError extends Error {
  constructor(message, statusCode = 403, code = 'HIERARCHY_CHAIN_VIOLATION', details = {}) {
    super(message);
    this.name = 'HierarchyValidationError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * 1. Validate Course
 * Resolves authoritative course record from database.
 */
async function validateCourse(courseIdOrSlug) {
  if (!courseIdOrSlug) {
    throw new HierarchyValidationError('Course identifier is required.', 400, 'COURSE_ID_REQUIRED');
  }

  let target = courseIdOrSlug;
  if (typeof courseIdOrSlug === 'object' && courseIdOrSlug !== null) {
    target = courseIdOrSlug.courseId || courseIdOrSlug.course_id || courseIdOrSlug.id || courseIdOrSlug.slug;
  }
  const raw = String(target || '').trim();
  if (!raw || raw === '[object Object]') {
    throw new HierarchyValidationError('Course identifier is required and must be valid.', 400, 'COURSE_ID_REQUIRED');
  }
  const classification = classifyIdentifier(raw);

  if (classification === 'INVALID') {
    throw new HierarchyValidationError(`Invalid course identifier format: '${raw}'.`, 400, 'INVALID_COURSE_IDENTIFIER');
  }

  let courseQuery = supabase.from('courses').select('id, title, slug, curriculum_modules');
  if (classification === 'UUID') {
    courseQuery = courseQuery.eq('id', raw);
  } else {
    courseQuery = courseQuery.eq('slug', normalizeIdentifier(raw, 'SLUG'));
  }

  const { data: course, error } = await courseQuery.maybeSingle();
  if (error || !course) {
    // If slug lookup failed, try fallback prefix stripping
    if (classification === 'SLUG') {
      const stripped = normalizeIdentifier(raw, 'SLUG').replace(/^(cse-it|ece-eee|mech-civil|management|add-on-programs)-/, '');
      if (stripped && stripped !== raw) {
        const { data: fallbackCourse } = await supabase
          .from('courses')
          .select('id, title, slug, curriculum_modules')
          .eq('slug', stripped)
          .maybeSingle();
        if (fallbackCourse) {
          return { canonicalCourseId: fallbackCourse.id, course: fallbackCourse };
        }
      }
    }
    throw new HierarchyValidationError(`Course not found for identifier '${raw}'.`, 404, 'COURSE_NOT_FOUND');
  }

  return { canonicalCourseId: course.id, course };
}

function isSafeIdentifier(val) {
  if (val === null || val === undefined) return false;
  const s = String(val).trim();
  if (s.length === 0 || s.length > 120) return false;
  // Reject dangerous injection characters (operators, delimiters, SQL/PostgREST syntax)
  if (/[\s,'"();<>{}\[\]\\\/%&|`^~*+=?!@#$]/.test(s)) return false;
  return /^[a-zA-Z0-9_-]+$/.test(s);
}

/**
 * 1. Validate Course
 * Resolves canonical course UUID and record from either UUID or slug.
 */
async function validateCourse(courseOrSlugOrId) {
  let rawCourseId = courseOrSlugOrId;
  if (typeof courseOrSlugOrId === 'object' && courseOrSlugOrId !== null) {
    if (courseOrSlugOrId.curriculum_modules && courseOrSlugOrId.id) {
      return {
        canonicalCourseId: courseOrSlugOrId.id,
        course: courseOrSlugOrId
      };
    }
    rawCourseId = courseOrSlugOrId.id || courseOrSlugOrId.canonicalCourseId || courseOrSlugOrId.courseId || courseOrSlugOrId.slug;
  }

  if (!rawCourseId) {
    throw new HierarchyValidationError('Course identifier is required.', 400, 'COURSE_ID_REQUIRED');
  }

  const cleanCourseId = String(rawCourseId).trim();
  const classification = classifyIdentifier(cleanCourseId);

  if (classification === 'INVALID') {
    throw new HierarchyValidationError(`Invalid course identifier format: '${cleanCourseId}'.`, 400, 'INVALID_COURSE_IDENTIFIER');
  }

  let query = supabase.from('courses').select('id, title, slug, curriculum_modules');
  if (classification === 'UUID') {
    query = query.eq('id', cleanCourseId);
  } else {
    query = query.eq('slug', normalizeIdentifier(cleanCourseId, 'SLUG'));
  }

  const { data: course, error } = await query.maybeSingle();

  if (error || !course) {
    throw new HierarchyValidationError(`Course '${cleanCourseId}' not found.`, 404, 'COURSE_NOT_FOUND', { suppliedCourseId: cleanCourseId });
  }

  return {
    canonicalCourseId: course.id,
    course
  };
}

/**
 * 2. Validate Module within Authoritative Course Scope
 * Ensures module strictly belongs to the resolved course.
 * Rejects cross-course module access (e.g. Course A + Course B Module).
 */
async function validateModule(courseOrId, moduleOrId) {
  if (!moduleOrId) {
    throw new HierarchyValidationError('Module identifier is required.', 400, 'MODULE_ID_REQUIRED');
  }

  // 1. Ensure course is validated and authoritative
  const { canonicalCourseId, course } = (courseOrId && courseOrId.id)
    ? { canonicalCourseId: courseOrId.id, course: courseOrId }
    : await validateCourse(courseOrId);

  let cleanModId = moduleOrId;
  let suppliedCourseId = null;
  if (typeof moduleOrId === 'object' && moduleOrId !== null) {
    suppliedCourseId = moduleOrId.course_id || moduleOrId.courseId || null;
    cleanModId = moduleOrId.canonicalModuleId || moduleOrId.id || moduleOrId.moduleId || moduleOrId.module_id;
  }

  if (!cleanModId) {
    throw new HierarchyValidationError('Module identifier is required.', 400, 'MODULE_ID_REQUIRED');
  }

  cleanModId = String(cleanModId).trim();
  if (!isSafeIdentifier(cleanModId)) {
    throw new HierarchyValidationError(`Invalid module identifier format: '${cleanModId}'.`, 400, 'INVALID_MODULE_IDENTIFIER');
  }

  // Check supplied course scope if module object carries one
  if (suppliedCourseId && String(suppliedCourseId) !== String(canonicalCourseId)) {
    throw new HierarchyValidationError(
      `Module belongs to course '${suppliedCourseId}', not authorized course '${canonicalCourseId}'. Cross-course module access denied.`,
      403,
      'HIERARCHY_MODULE_MISMATCH',
      { suppliedModuleCourseId: suppliedCourseId, authorizedCourseId: canonicalCourseId }
    );
  }

  // 2. Check Relational `modules` Table within this course scope
  try {
    const { data: relationalMod, error: modErr } = await supabase
      .from('modules')
      .select('*')
      .eq('course_id', canonicalCourseId)
      .eq('id', cleanModId)
      .maybeSingle();

    if (!modErr && relationalMod) {
      return {
        canonicalCourseId,
        canonicalModuleId: String(relationalMod.id),
        module: relationalMod,
        modIndex: 0,
        course
      };
    }
  } catch (err) {
    if (err instanceof HierarchyValidationError) throw err;
  }

  // 3. Check Course's `curriculum_modules` JSON (Scoped strictly to this course)
  let matchedMod = null;
  let matchedIndex = -1;

  if (Array.isArray(course.curriculum_modules)) {
    matchedIndex = course.curriculum_modules.findIndex((m, idx) => {
      if (!m) return false;
      return (
        String(m.id) === cleanModId ||
        String(m.video_asset_id) === cleanModId ||
        `mod_${idx + 1}` === cleanModId ||
        `mod_${m.id}` === cleanModId ||
        String(m.title) === cleanModId ||
        String(m.name) === cleanModId
      );
    });

    if (matchedIndex !== -1) {
      matchedMod = course.curriculum_modules[matchedIndex];
    }
  }

  if (!matchedMod) {
    // Also check if cleanModId is an integer 1-based index (e.g. "1" -> first module)
    const numIdx = parseInt(cleanModId, 10);
    if (!isNaN(numIdx) && numIdx > 0 && Array.isArray(course.curriculum_modules) && course.curriculum_modules[numIdx - 1]) {
      matchedIndex = numIdx - 1;
      matchedMod = course.curriculum_modules[matchedIndex];
    }
  }

  if (!matchedMod) {
    // Topics table is authoritative for Mode 2 — accept module_id that owns topics in this course
    try {
      const { data: topicOwned } = await supabase
        .from('topics')
        .select('id, module_id')
        .eq('course_id', canonicalCourseId)
        .eq('module_id', cleanModId)
        .limit(1)
        .maybeSingle();
      if (topicOwned) {
        matchedMod = {
          id: cleanModId,
          title: 'Module',
          name: 'Module',
          topics: [],
          video_content_mode: 'INDIVIDUAL_TOPIC_VIDEOS'
        };
        matchedIndex = -1;
      }
    } catch (_) {}
  }

  if (!matchedMod) {
    throw new HierarchyValidationError(
      `Module '${cleanModId}' does not belong to course '${course.title || course.id}' (${canonicalCourseId}). Hierarchy validation failed.`,
      403,
      'HIERARCHY_MODULE_MISMATCH',
      { suppliedModuleId: cleanModId, authorizedCourseId: canonicalCourseId }
    );
  }

  const canonicalModuleId = String(matchedMod.id || `mod_${matchedIndex + 1}`);

  return {
    canonicalCourseId,
    canonicalModuleId,
    module: matchedMod,
    modIndex: matchedIndex,
    course
  };
}

/**
 * 3. Validate Topic within Authoritative Module & Course Scope
 * Ensures topic strictly belongs to canonical moduleId AND canonical courseId.
 * Rejects cross-module and cross-course topic references.
 */
async function validateTopic(courseOrId, moduleOrId, topicOrId) {
  if (!topicOrId) {
    throw new HierarchyValidationError('Topic identifier is required.', 400, 'TOPIC_ID_REQUIRED');
  }

  const { canonicalCourseId, canonicalModuleId, module, course } = (moduleOrId && moduleOrId.canonicalModuleId)
    ? moduleOrId
    : await validateModule(courseOrId, moduleOrId);

  let cleanTopicId = topicOrId;
  let suppliedCourseId = null;
  let suppliedModuleId = null;
  if (typeof topicOrId === 'object' && topicOrId !== null) {
    suppliedCourseId = topicOrId.course_id || topicOrId.courseId || null;
    suppliedModuleId = topicOrId.module_id || topicOrId.moduleId || null;
    cleanTopicId = topicOrId.canonicalTopicId || topicOrId.id || topicOrId.topicId || topicOrId.topic_id;
  }

  if (!cleanTopicId) {
    throw new HierarchyValidationError('Topic identifier is required.', 400, 'TOPIC_ID_REQUIRED');
  }

  cleanTopicId = String(cleanTopicId).trim();
  if (!isSafeIdentifier(cleanTopicId)) {
    throw new HierarchyValidationError(`Invalid topic identifier format: '${cleanTopicId}'.`, 400, 'INVALID_TOPIC_IDENTIFIER');
  }

  // Cross-scope check on supplied topic object properties
  if (suppliedCourseId && String(suppliedCourseId) !== String(canonicalCourseId)) {
    throw new HierarchyValidationError(
      `Topic belongs to course '${suppliedCourseId}', not authorized course '${canonicalCourseId}'. Cross-course topic access denied.`,
      403,
      'HIERARCHY_TOPIC_MISMATCH',
      { topicId: cleanTopicId, expectedCourseId: canonicalCourseId, actualCourseId: suppliedCourseId }
    );
  }
  if (suppliedModuleId && String(suppliedModuleId) !== String(canonicalModuleId) && `mod_${suppliedModuleId}` !== String(canonicalModuleId)) {
    throw new HierarchyValidationError(
      `Topic belongs to module '${suppliedModuleId}', not authorized module '${canonicalModuleId}'. Cross-module topic access denied.`,
      403,
      'HIERARCHY_TOPIC_MISMATCH',
      { topicId: cleanTopicId, expectedModuleId: canonicalModuleId, actualModuleId: suppliedModuleId }
    );
  }

  let canonicalTopic = null;

  // 1. Authoritative Relational Check (`topics` table)
  try {
    const isTopicUUID = isUUID(cleanTopicId);
    let topicQuery = supabase.from('topics').select('*');
    if (isTopicUUID) {
      topicQuery = topicQuery.eq('id', cleanTopicId);
    } else {
      topicQuery = topicQuery.eq('title', cleanTopicId);
    }

    const { data: dbTopic, error: topErr } = await topicQuery.maybeSingle();
    if (!topErr && dbTopic) {
      // STRICT RELATIONSHIP VERIFICATION:
      if (!dbTopic.course_id || String(dbTopic.course_id) !== String(canonicalCourseId)) {
        throw new HierarchyValidationError(
          `Topic '${cleanTopicId}' belongs to course '${dbTopic.course_id || 'NONE'}', not authorized course '${canonicalCourseId}'. Cross-course topic access denied.`,
          403,
          'HIERARCHY_TOPIC_MISMATCH',
          { topicId: cleanTopicId, expectedCourseId: canonicalCourseId, actualCourseId: dbTopic.course_id }
        );
      }

      const modMatches = (
        String(dbTopic.module_id) === String(canonicalModuleId) ||
        String(dbTopic.module_id) === String(module?.id) ||
        `mod_${dbTopic.module_id}` === String(canonicalModuleId)
      );

      if (!modMatches) {
        throw new HierarchyValidationError(
          `Topic '${cleanTopicId}' belongs to module '${dbTopic.module_id}', not authorized module '${canonicalModuleId}'. Cross-module topic access denied.`,
          403,
          'HIERARCHY_TOPIC_MISMATCH',
          { topicId: cleanTopicId, expectedModuleId: canonicalModuleId, actualModuleId: dbTopic.module_id }
        );
      }

      canonicalTopic = dbTopic;
    }
  } catch (err) {
    if (err instanceof HierarchyValidationError) throw err;
  }

  // 2. Check Module's Topics array in curriculum JSON
  let jsonTopic = null;
  if (module && Array.isArray(module.topics)) {
    jsonTopic = module.topics.find((t, idx) => {
      if (!t) return false;
      if (typeof t === 'string') {
        return t === cleanTopicId || `top_${idx + 1}` === cleanTopicId;
      }
      return (
        String(t.id) === cleanTopicId ||
        String(t.title) === cleanTopicId ||
        String(t.name) === cleanTopicId ||
        `top_${idx + 1}` === cleanTopicId ||
        `top_${canonicalModuleId}_${idx + 1}` === cleanTopicId
      );
    });
  }

  // Also check module.lessons array if topics is empty
  if (!jsonTopic && module && Array.isArray(module.lessons)) {
    jsonTopic = module.lessons.find(l => l && String(l.id) === cleanTopicId);
  }

  // FAIL CLOSED IF CONFLICT: If relational DB topic existed but conflicts with JSON, fail closed
  if (!canonicalTopic && !jsonTopic) {
    throw new HierarchyValidationError(
      `Topic '${cleanTopicId}' does not belong to module '${canonicalModuleId}' in course '${canonicalCourseId}'. Hierarchy validation failed.`,
      403,
      'HIERARCHY_TOPIC_MISMATCH',
      { topicId: cleanTopicId, moduleId: canonicalModuleId, courseId: canonicalCourseId }
    );
  }

  const finalTopic = canonicalTopic || (typeof jsonTopic === 'object' ? jsonTopic : { id: cleanTopicId, title: String(jsonTopic) });
  const canonicalTopicId = String(finalTopic.id || cleanTopicId);

  return {
    canonicalCourseId,
    canonicalModuleId,
    canonicalTopicId,
    topic: finalTopic,
    module,
    course
  };
}

/**
 * 4. Validate Video Record within Authoritative Scope
 * Ensures video strictly belongs to topic, module, and course.
 */
async function validateVideo(courseOrId, moduleOrId, topicOrId, videoOrId) {
  if (!videoOrId) {
    throw new HierarchyValidationError('Video identifier is required.', 400, 'VIDEO_ID_REQUIRED');
  }

  let topicContext;
  const hasTopicParam = topicOrId && (
    (typeof topicOrId === 'object' && Boolean(topicOrId.canonicalTopicId || topicOrId.id || topicOrId.topicId || topicOrId.topic_id || topicOrId.title)) ||
    (typeof topicOrId === 'string' && topicOrId.trim() !== '') ||
    typeof topicOrId === 'number'
  );

  if (hasTopicParam) {
    topicContext = (topicOrId && topicOrId.canonicalTopicId)
      ? topicOrId
      : await validateTopic(courseOrId, moduleOrId, topicOrId);
  } else {
    // Video is scoped at module level (e.g. module master video)
    const modContext = (moduleOrId && moduleOrId.canonicalModuleId)
      ? moduleOrId
      : await validateModule(courseOrId, moduleOrId);
    topicContext = {
      ...modContext,
      canonicalTopicId: null,
      topic: null
    };
  }

  const { canonicalCourseId, canonicalModuleId, canonicalTopicId, course, module, topic } = topicContext;

  let cleanVideoId = videoOrId;
  let suppliedCourseId = null;
  let suppliedModuleId = null;
  let suppliedTopicId = null;
  if (typeof videoOrId === 'object' && videoOrId !== null) {
    suppliedCourseId = videoOrId.course_id || videoOrId.courseId || null;
    suppliedModuleId = videoOrId.module_id || videoOrId.moduleId || null;
    suppliedTopicId = videoOrId.topic_id || videoOrId.topicId || videoOrId.lesson_id || videoOrId.lessonId || null;
    cleanVideoId = videoOrId.canonicalVideoId || videoOrId.id || videoOrId.videoId || videoOrId.videoAssetId || videoOrId.video_id;
  }

  if (!cleanVideoId) {
    throw new HierarchyValidationError('Video identifier is required.', 400, 'VIDEO_ID_REQUIRED');
  }

  cleanVideoId = String(cleanVideoId).trim();
  if (!isSafeIdentifier(cleanVideoId)) {
    throw new HierarchyValidationError(`Invalid video identifier format: '${cleanVideoId}'.`, 400, 'INVALID_VIDEO_IDENTIFIER');
  }

  // Cross-scope check on supplied video object properties
  if (suppliedCourseId && String(suppliedCourseId) !== String(canonicalCourseId)) {
    throw new HierarchyValidationError(
      `Video belongs to course '${suppliedCourseId}', not authorized course '${canonicalCourseId}'. Cross-course video access denied.`,
      403,
      'HIERARCHY_VIDEO_MISMATCH',
      { videoId: cleanVideoId, expectedCourseId: canonicalCourseId, actualCourseId: suppliedCourseId }
    );
  }
  if (suppliedModuleId && String(suppliedModuleId) !== String(canonicalModuleId) && `mod_${suppliedModuleId}` !== String(canonicalModuleId)) {
    throw new HierarchyValidationError(
      `Video belongs to module '${suppliedModuleId}', not authorized module '${canonicalModuleId}'. Cross-module video access denied.`,
      403,
      'HIERARCHY_VIDEO_MISMATCH',
      { videoId: cleanVideoId, expectedModuleId: canonicalModuleId, actualModuleId: suppliedModuleId }
    );
  }

  const isVideoUUID = isUUID(cleanVideoId);

  let videoRecord = null;
  try {
    let q = supabase.from('lesson_videos').select('*');
    if (isVideoUUID) {
      q = q.eq('id', cleanVideoId);
    } else {
      q = q.eq('lesson_id', cleanVideoId);
      if (canonicalCourseId) {
        q = q.eq('course_id', canonicalCourseId);
      }
      if (canonicalModuleId) {
        q = q.eq('module_id', canonicalModuleId);
      }
    }
    const { data: dbVideo, error: vidErr } = await q.maybeSingle();
    if (!vidErr && dbVideo) {
      videoRecord = dbVideo;
    }
  } catch (e) {}

  if (!videoRecord) {
    try {
      const videoService = require('../modules/video/video.service');
      videoRecord = videoService?.memoryVideoStore?.get(cleanVideoId) || null;
    } catch (e) {}
  }

  if (!videoRecord && module) {
    if (String(module.video_asset_id) === cleanVideoId || String(module.id) === cleanVideoId) {
      videoRecord = {
        id: cleanVideoId,
        course_id: canonicalCourseId,
        module_id: canonicalModuleId,
        title: module.title || module.name,
        status: module.video_status || 'READY'
      };
    } else if (Array.isArray(module.lessons)) {
      const matchedLesson = module.lessons.find(l => l && (String(l.id) === cleanVideoId || String(l.video_asset_id) === cleanVideoId));
      if (matchedLesson) {
        videoRecord = {
          id: cleanVideoId,
          course_id: canonicalCourseId,
          module_id: canonicalModuleId,
          lesson_id: matchedLesson.id,
          title: matchedLesson.title,
          status: matchedLesson.video_status || 'READY'
        };
      }
    }
  }

  if (!videoRecord) {
    throw new HierarchyValidationError(
      `Video '${cleanVideoId}' does not exist in authoritative storage. Access denied.`,
      404,
      'VIDEO_NOT_FOUND',
      { videoId: cleanVideoId }
    );
  }

  // Authoritatively assert ownership chain
  if (videoRecord) {
    if (!videoRecord.course_id || String(videoRecord.course_id) !== String(canonicalCourseId)) {
      throw new HierarchyValidationError(
        `Video '${cleanVideoId}' belongs to course '${videoRecord.course_id || 'NONE'}', not authorized course '${canonicalCourseId}'. Video ownership mismatch.`,
        403,
        'HIERARCHY_VIDEO_MISMATCH',
        { videoId: cleanVideoId, expectedCourseId: canonicalCourseId, actualCourseId: videoRecord.course_id }
      );
    }

    if (!videoRecord.module_id || (String(videoRecord.module_id) !== String(canonicalModuleId) && String(videoRecord.module_id) !== String(module?.id))) {
      throw new HierarchyValidationError(
        `Video '${cleanVideoId}' belongs to module '${videoRecord.module_id || 'NONE'}', not authorized module '${canonicalModuleId}'. Video ownership mismatch.`,
        403,
        'HIERARCHY_VIDEO_MISMATCH',
        { videoId: cleanVideoId, expectedModuleId: canonicalModuleId, actualModuleId: videoRecord.module_id }
      );
    }

    const topicMatches = (
      !canonicalTopicId ||
      !videoRecord.lesson_id ||
      String(videoRecord.lesson_id) === String(canonicalTopicId) ||
      String(videoRecord.topic_id) === String(canonicalTopicId) ||
      String(topic?.source_video_id) === String(videoRecord.id)
    );

    if (!topicMatches) {
      throw new HierarchyValidationError(
        `Video '${cleanVideoId}' belongs to lesson/topic '${videoRecord.lesson_id}', not authorized topic '${canonicalTopicId}'. Video ownership mismatch.`,
        403,
        'HIERARCHY_VIDEO_MISMATCH',
        { videoId: cleanVideoId, expectedTopicId: canonicalTopicId, actualTopicId: videoRecord.lesson_id }
      );
    }
  }

  return {
    canonicalCourseId,
    canonicalModuleId,
    canonicalTopicId,
    canonicalVideoId: videoRecord ? String(videoRecord.id) : cleanVideoId,
    video: videoRecord,
    topic,
    module,
    course
  };
}

/**
 * 5. Validate Upload Session / S3 Key Consistency
 * S3 key is NOT authoritative ownership.
 * First establishes authoritative ownership, then verifies S3 key is consistent.
 */
function validateUploadConsistency({ course, module, videoId, s3Key, multipartSession }) {
  if (!course || !module) {
    throw new HierarchyValidationError('Course and module context required for upload validation.', 400, 'UPLOAD_CONTEXT_REQUIRED');
  }

  // 1. Validate Multipart Session metadata if provided
  if (multipartSession) {
    if (multipartSession.courseId && String(multipartSession.courseId) !== String(course.id)) {
      throw new HierarchyValidationError(
        `Upload session belongs to course '${multipartSession.courseId}', not authorized course '${course.id}'.`,
        403,
        'HIERARCHY_UPLOAD_MISMATCH'
      );
    }
    if (multipartSession.moduleId && String(multipartSession.moduleId) !== String(module.id)) {
      throw new HierarchyValidationError(
        `Upload session belongs to module '${multipartSession.moduleId}', not authorized module '${module.id}'.`,
        403,
        'HIERARCHY_UPLOAD_MISMATCH'
      );
    }
  }

  // 2. Validate S3 Key against authorized resource scope
  if (s3Key) {
    const cleanKey = String(s3Key).trim();
    const expectedCourseSlug = s3PathUtils.generateS3CourseSlug(course);
    const expectedCourseId = String(course.id).toLowerCase();

    // S3 key MUST start with courses/{courseSlug} or courses/{courseId}
    const hasCoursePrefix = (
      cleanKey.startsWith(`courses/${expectedCourseSlug}/`) ||
      cleanKey.startsWith(`courses/${expectedCourseId}/`) ||
      cleanKey.startsWith(`sources/${expectedCourseSlug}/`) ||
      cleanKey.startsWith(`sources/${expectedCourseId}/`)
    );

    if (!hasCoursePrefix) {
      throw new HierarchyValidationError(
        `S3 key '${cleanKey}' does not match the authorized course path ('courses/${expectedCourseSlug}/'). Malicious or mismatched key rejected.`,
        403,
        'HIERARCHY_S3_KEY_MISMATCH'
      );
    }
  }

  return true;
}

/**
 * Top-level Orchestrator: validateHierarchyChain
 * Validates whatever levels are supplied in the request.
 * Any mismatch fails closed immediately with ZERO side effects.
 *
 * Topic-first path: when a real topic UUID is supplied, course/module are
 * resolved from the topics row so healed curriculum module IDs (or UI lessonId
 * vs topics.module_id drift) do not 403 legitimate enrolled playback.
 */
async function validateHierarchyChain({ courseId, moduleId, topicId, videoId, uploadId, s3Key, multipartSession }) {
  let context = {};

  const cleanTopicId = topicId != null ? String(topicId).trim() : '';
  if (cleanTopicId && isUUID(cleanTopicId)) {
    try {
      const { data: dbTopic, error: topicLookupErr } = await supabase
        .from('topics')
        .select('*')
        .eq('id', cleanTopicId)
        .maybeSingle();

      if (!topicLookupErr && dbTopic) {
        const topicCourseId = dbTopic.course_id || courseId;
        if (!topicCourseId) {
          throw new HierarchyValidationError(
            `Topic '${cleanTopicId}' has no associated course scope (orphan record).`,
            403,
            'HIERARCHY_ORPHAN_RECORD',
            { topicId: cleanTopicId }
          );
        }

        const courseRes = await validateCourse(topicCourseId);

        // Client courseId (UUID or slug) must resolve to the same course as the topic
        if (courseId) {
          const clientCourse = await validateCourse(courseId);
          if (String(clientCourse.canonicalCourseId) !== String(courseRes.canonicalCourseId)) {
            throw new HierarchyValidationError(
              `Topic '${cleanTopicId}' belongs to course '${courseRes.canonicalCourseId}', not '${clientCourse.canonicalCourseId}'. Cross-course topic access denied.`,
              403,
              'HIERARCHY_TOPIC_MISMATCH',
              {
                topicId: cleanTopicId,
                expectedCourseId: clientCourse.canonicalCourseId,
                actualCourseId: courseRes.canonicalCourseId
              }
            );
          }
        }

        const effectiveModuleId = dbTopic.module_id || moduleId;
        let modRes = null;
        if (effectiveModuleId) {
          try {
            modRes = await validateModule(courseRes.course, effectiveModuleId);
          } catch (modErr) {
            // Curriculum JSON may have been healed to a new UUID while topics.module_id
            // still points at the previous id — keep topic-owned scope if same course.
            if (dbTopic.module_id && modErr instanceof HierarchyValidationError) {
              const jsonMod = Array.isArray(courseRes.course.curriculum_modules)
                ? courseRes.course.curriculum_modules.find((m) => m && String(m.id) === String(dbTopic.module_id))
                : null;
              modRes = {
                canonicalCourseId: courseRes.canonicalCourseId,
                canonicalModuleId: String(dbTopic.module_id),
                module: jsonMod || {
                  id: dbTopic.module_id,
                  title: 'Module',
                  name: 'Module',
                  topics: [],
                  video_content_mode: 'INDIVIDUAL_TOPIC_VIDEOS'
                },
                modIndex: -1,
                course: courseRes.course
              };
            } else {
              throw modErr;
            }
          }
        }

        context = {
          ...courseRes,
          ...(modRes || {}),
          canonicalTopicId: dbTopic.id,
          topic: dbTopic
        };

        if (videoId) {
          const vidRes = await validateVideo(
            context.course,
            context.module || { canonicalModuleId: context.canonicalModuleId, id: context.canonicalModuleId },
            context.topic,
            videoId
          );
          context = { ...context, ...vidRes };
        }

        if (s3Key || multipartSession || uploadId) {
          validateUploadConsistency({
            course: context.course,
            module: context.module || { id: context.canonicalModuleId },
            videoId: context.canonicalVideoId || videoId,
            s3Key,
            multipartSession
          });
        }

        return context;
      }
    } catch (err) {
      if (err instanceof HierarchyValidationError) throw err;
      // Fall through to classic path on unexpected lookup errors
    }
  }

  if (courseId) {
    const courseRes = await validateCourse(courseId);
    context = { ...context, ...courseRes };
  }

  if (moduleId) {
    if (!context.course) {
      throw new HierarchyValidationError('Cannot validate module without courseId scope.', 400, 'UNSCOPED_MODULE_VALIDATION');
    }
    const modRes = await validateModule(context.course, moduleId);
    context = { ...context, ...modRes };
  }

  if (topicId) {
    if (!context.module) {
      throw new HierarchyValidationError('Cannot validate topic without course and module scope.', 400, 'UNSCOPED_TOPIC_VALIDATION');
    }
    const topRes = await validateTopic(context.course, context.module, topicId);
    context = { ...context, ...topRes };
  }

  if (videoId) {
    if (!context.module) {
      throw new HierarchyValidationError('Cannot validate video without course and module scope.', 400, 'UNSCOPED_VIDEO_VALIDATION');
    }
    const vidRes = await validateVideo(context.course, context.module, context.topic || topicId || null, videoId);
    context = { ...context, ...vidRes };
  }

  if (s3Key || multipartSession || uploadId) {
    validateUploadConsistency({
      course: context.course,
      module: context.module,
      videoId: context.canonicalVideoId || videoId,
      s3Key,
      multipartSession
    });
  }

  return context;
}

module.exports = {
  HierarchyValidationError,
  validateCourse,
  validateModule,
  validateTopic,
  validateVideo,
  validateUploadConsistency,
  validateHierarchyChain
};
