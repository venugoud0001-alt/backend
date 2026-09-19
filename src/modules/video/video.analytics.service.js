/**
 * InternNetra Video Analytics Service
 * Phase 2: High-throughput, resilient event ingestion and validation pipeline.
 * Adheres strictly to non-blocking analytics constraints and database safety.
 */

const { supabase } = require('../../config/supabase');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_EVENT_TYPES = new Set([
  'VIDEO_TOPIC_OPENED',
  'VIDEO_SESSION_STARTED',
  'VIDEO_PLAY',
  'VIDEO_PAUSE',
  'VIDEO_SEEK',
  'VIDEO_HEARTBEAT',
  'VIDEO_COMPLETED',
  'VIDEO_SESSION_ENDED',
  'VIDEO_TOPIC_SWITCHED'
]);

class VideoAnalyticsService {
  /**
   * Derives the authentic student UUID from authentication context.
   * Client-supplied student_id values are strictly disregarded.
   */
  async resolveAuthenticatedStudentId(user) {
    if (!user || (!user.id && !user.email)) {
      return null;
    }

    const userId = user.id ? String(user.id).trim() : null;
    const userEmail = user.email ? String(user.email).toLowerCase().trim() : null;

    // 1. If user.id is a UUID, check students table directly
    if (userId && UUID_REGEX.test(userId)) {
      const { data: studentById } = await supabase
        .from('students')
        .select('id')
        .eq('id', userId)
        .maybeSingle();

      if (studentById && studentById.id) {
        return studentById.id;
      }
    }

    // 2. Lookup student by verified email address
    if (userEmail) {
      const { data: studentByEmail } = await supabase
        .from('students')
        .select('id')
        .ilike('email', userEmail)
        .maybeSingle();

      if (studentByEmail && studentByEmail.id) {
        return studentByEmail.id;
      }
    }

    return null;
  }

  /**
   * Validates course, module, and topic relationships against the database.
   * Resolves canonical course UUID whether client passes UUID or human-readable slug.
   */
  async validateHierarchy(courseId, moduleId, topicId) {
    // 1. Resolve canonical course UUID (supports valid UUIDs, course slugs, or topic-derived UUID)
    let canonicalCourse = null;
    const cleanCourseId = courseId ? String(courseId).trim() : null;

    if (cleanCourseId && UUID_REGEX.test(cleanCourseId)) {
      const { data: courseById } = await supabase
        .from('courses')
        .select('id, slug, curriculum_modules')
        .eq('id', cleanCourseId)
        .maybeSingle();
      canonicalCourse = courseById;
    } else if (cleanCourseId) {
      // Lookup course by slug
      const { data: courseBySlug } = await supabase
        .from('courses')
        .select('id, slug, curriculum_modules')
        .eq('slug', cleanCourseId)
        .maybeSingle();
      canonicalCourse = courseBySlug;
    }

    // Fallback: If course was not resolved yet and topicId is provided, lookup course by topic
    let topicRecord = null;
    if (topicId && UUID_REGEX.test(topicId)) {
      const { data: topic } = await supabase
        .from('topics')
        .select('id, course_id, module_id, title')
        .eq('id', topicId)
        .maybeSingle();
      if (topic) {
        topicRecord = topic;
        if (!canonicalCourse && topic.course_id) {
          const { data: courseByTopic } = await supabase
            .from('courses')
            .select('id, slug, curriculum_modules')
            .eq('id', topic.course_id)
            .maybeSingle();
          canonicalCourse = courseByTopic;
        }
      }
    }

    if (!canonicalCourse || !canonicalCourse.id || !UUID_REGEX.test(canonicalCourse.id)) {
      throw { statusCode: 400, message: 'Invalid or missing courseId. Must be a valid UUID or existing course slug.' };
    }

    const canonicalCourseId = canonicalCourse.id;

    // 2. Validate module belongs to course (soft when topic resolves module)
    let cleanModuleId = moduleId !== undefined && moduleId !== null ? String(moduleId).trim() : '';

    // Prefer topic's module_id when client moduleId drifts from healed curriculum IDs
    if (topicRecord?.module_id) {
      cleanModuleId = String(topicRecord.module_id).trim();
    }

    if (!cleanModuleId) {
      throw { statusCode: 400, message: 'Invalid or missing moduleId.' };
    }

    let moduleBelongsToCourse = false;

    if (Array.isArray(canonicalCourse.curriculum_modules)) {
      moduleBelongsToCourse = canonicalCourse.curriculum_modules.some((m, idx) => {
        const idStr = String(m?.id !== undefined && m?.id !== null ? m.id : idx + 1);
        return idStr === cleanModuleId;
      });
    }

    // Fallback: check if topics exist in this course under this module
    if (!moduleBelongsToCourse) {
      const { data: topicInMod } = await supabase
        .from('topics')
        .select('id')
        .eq('course_id', canonicalCourseId)
        .eq('module_id', cleanModuleId)
        .limit(1)
        .maybeSingle();

      if (topicInMod) {
        moduleBelongsToCourse = true;
      }
    }

    // Last resort: topic already proven to belong to this course
    if (!moduleBelongsToCourse && topicRecord && String(topicRecord.course_id) === String(canonicalCourseId)) {
      moduleBelongsToCourse = true;
    }

    if (!moduleBelongsToCourse && moduleId !== undefined && moduleId !== null) {
      // Client may have sent UI lessonId; if a topic UUID is present we already
      // soft-resolved above. Without topic evidence, keep the hard fail.
      if (!topicRecord) {
        throw {
          statusCode: 400,
          message: `Module '${cleanModuleId}' does not belong to course '${canonicalCourse.slug || canonicalCourseId}'.`
        };
      }
    }

    // 3. Validate topic belongs to course (module mismatch is soft-corrected above)
    if (topicId) {
      const cleanTopicId = String(topicId).trim();
      if (!UUID_REGEX.test(cleanTopicId)) {
        // Synthetic curriculum topic ids are not persisted — drop topic scope, keep event
        return { course: canonicalCourse, canonicalCourseId, topic: null, canonicalModuleId: cleanModuleId };
      }

      if (!topicRecord) {
        const { data: topic, error: topicErr } = await supabase
          .from('topics')
          .select('id, course_id, module_id, title')
          .eq('id', cleanTopicId)
          .maybeSingle();

        if (topicErr || !topic) {
          // Non-blocking analytics: accept event without topic FK rather than 404 the heartbeat
          return { course: canonicalCourse, canonicalCourseId, topic: null, canonicalModuleId: cleanModuleId };
        }
        topicRecord = topic;
        if (topic.module_id) cleanModuleId = String(topic.module_id).trim();
      }

      if (topicRecord.course_id && String(topicRecord.course_id) !== String(canonicalCourseId)) {
        throw {
          statusCode: 400,
          message: `Topic '${cleanTopicId}' belongs to course '${topicRecord.course_id}', not '${canonicalCourseId}'.`
        };
      }
    }

    return { course: canonicalCourse, canonicalCourseId, topic: topicRecord, canonicalModuleId: cleanModuleId };
  }

  /**
   * Evaluates whether a session represents a rewatch session for this student and topic.
   * Documented rule:
   * First qualifying session for a topic = Initial View.
   * Additional sessions for the same topic = Rewatch.
   */
  async evaluateRewatch(studentId, topicId, currentSessionId) {
    if (!studentId || !topicId) return false;

    try {
      let query = supabase
        .from('video_analytics_events')
        .select('id')
        .eq('student_id', studentId)
        .eq('topic_id', topicId)
        .in('event_type', ['VIDEO_SESSION_STARTED', 'VIDEO_PLAY'])
        .limit(1);

      if (currentSessionId && UUID_REGEX.test(currentSessionId)) {
        query = query.neq('session_id', currentSessionId);
      }

      const { data: priorEvents } = await query;
      return Boolean(priorEvents && priorEvents.length > 0);
    } catch (e) {
      return false;
    }
  }

  /**
   * Ingests and persists an analytics event safely.
   */
  async ingestEvent(user, payload = {}) {
    // 1. Authenticated User Check
    if (!user || (!user.id && !user.email)) {
      throw { statusCode: 401, message: 'Authentication required for video analytics.' };
    }

    // 2. Validate Event Type
    const { eventType } = payload;
    if (!eventType || typeof eventType !== 'string' || !VALID_EVENT_TYPES.has(eventType.trim())) {
      throw {
        statusCode: 400,
        message: `Invalid eventType '${eventType}'. Allowed types: ${Array.from(VALID_EVENT_TYPES).join(', ')}`
      };
    }
    const cleanEventType = eventType.trim();

    // 3. Extract and Validate Numerical Bounds
    let positionSeconds = payload.positionSeconds !== undefined && payload.positionSeconds !== null
      ? Number(payload.positionSeconds)
      : null;
    let durationSeconds = payload.durationSeconds !== undefined && payload.durationSeconds !== null
      ? Number(payload.durationSeconds)
      : null;
    let completionPercentage = payload.completionPercentage !== undefined && payload.completionPercentage !== null
      ? Number(payload.completionPercentage)
      : null;

    if (positionSeconds !== null) {
      if (isNaN(positionSeconds) || positionSeconds < 0) {
        throw { statusCode: 400, message: 'positionSeconds must be a non-negative number.' };
      }
      positionSeconds = Math.round(positionSeconds * 1000) / 1000;
    }

    if (durationSeconds !== null) {
      if (isNaN(durationSeconds) || durationSeconds < 0) {
        throw { statusCode: 400, message: 'durationSeconds must be a non-negative number.' };
      }
      durationSeconds = Math.round(durationSeconds * 1000) / 1000;
    }

    if (completionPercentage !== null) {
      if (isNaN(completionPercentage) || completionPercentage < 0 || completionPercentage > 100) {
        throw { statusCode: 400, message: 'completionPercentage must be between 0.00 and 100.00.' };
      }
      completionPercentage = Math.round(completionPercentage * 100) / 100;
    }

    // 4. Validate Course, Module, Topic Relationship
    const { courseId, moduleId, topicId } = payload;
    const { canonicalCourseId, topic, canonicalModuleId } = await this.validateHierarchy(courseId, moduleId, topicId);
    const resolvedModuleId = canonicalModuleId || String(moduleId || '').trim();

    // 5. Derive Authenticated Student ID (Client student_id strictly ignored)
    const studentId = await this.resolveAuthenticatedStudentId(user);

    // 6. Sanitize UUID Fields
    const clientEventId = payload.clientEventId && UUID_REGEX.test(payload.clientEventId)
      ? payload.clientEventId
      : null;

    const sessionId = payload.sessionId && UUID_REGEX.test(payload.sessionId)
      ? payload.sessionId
      : null;

    const videoId = payload.videoId && UUID_REGEX.test(payload.videoId)
      ? payload.videoId
      : null;

    // 7. Metadata enrichment (heartbeat interval, rewatch flag, playback info)
    const metadata = typeof payload.metadata === 'object' && payload.metadata !== null
      ? { ...payload.metadata }
      : {};

    if (cleanEventType === 'VIDEO_HEARTBEAT') {
      metadata.heartbeat_interval_seconds = metadata.heartbeat_interval_seconds || 15;
    }

    const effectiveTopicId = topic ? topic.id : (topicId && UUID_REGEX.test(topicId) ? topicId : null);

    if (cleanEventType === 'VIDEO_SESSION_STARTED' && effectiveTopicId && studentId) {
      const isRewatch = await this.evaluateRewatch(studentId, effectiveTopicId, sessionId);
      metadata.is_rewatch = isRewatch;
      metadata.session_classification = isRewatch ? 'REWATCH' : 'INITIAL_VIEW';
    }

    const eventTimestamp = payload.eventTimestamp && !isNaN(Date.parse(payload.eventTimestamp))
      ? new Date(payload.eventTimestamp).toISOString()
      : new Date().toISOString();

    const eventRecord = {
      client_event_id: clientEventId,
      student_id: studentId,
      course_id: canonicalCourseId,
      module_id: resolvedModuleId,
      lesson_id: payload.lessonId ? String(payload.lessonId).trim() : resolvedModuleId,
      topic_id: effectiveTopicId,
      video_id: videoId,
      session_id: sessionId,
      event_type: cleanEventType,
      position_seconds: positionSeconds,
      duration_seconds: durationSeconds,
      completion_percentage: completionPercentage,
      event_timestamp: eventTimestamp,
      metadata
    };

    // 8. Insert Event into Database with Deduplication Handling
    try {
      const { data, error } = await supabase
        .from('video_analytics_events')
        .insert([eventRecord])
        .select('id, client_event_id, event_type, created_at')
        .maybeSingle();

      if (error) {
        // Safe handling of duplicate client event submissions (PostgreSQL 23505)
        if (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('uq_video_analytics_client_event_id')) {
          return {
            status: 'DUPLICATE',
            ignored: true,
            message: 'Duplicate event received and safely acknowledged without error.',
            clientEventId
          };
        }
        console.error('⚠️ [Video Analytics DB Error]:', error.message);
        throw { statusCode: 500, message: 'Failed to record analytics event.' };
      }

      return {
        status: 'SUCCESS',
        event: data || { clientEventId, eventType: cleanEventType }
      };
    } catch (insertErr) {
      if (insertErr.statusCode) throw insertErr;
      if (insertErr.code === '23505' || insertErr.message?.includes('duplicate key')) {
        return {
          status: 'DUPLICATE',
          ignored: true,
          message: 'Duplicate event received and safely acknowledged without error.',
          clientEventId
        };
      }
      console.error('⚠️ [Video Analytics Ingestion Notice]:', insertErr.message);
      throw { statusCode: 500, message: 'Failed to record analytics event.' };
    }
  }
}

module.exports = new VideoAnalyticsService();
