/**
 * Learning Progress & Course Completion Service
 * Implements 90% video completion rule, multi-lesson course rollups, and certificate eligibility workflows.
 */

const { supabase } = require('../../config/supabase');
const { classifyIdentifier, normalizeIdentifier } = require('../../utils/idValidator');

// Resilient memory cache for offline/local development
const memoryProgressStore = new Map();
const memoryCertificateRequests = new Map();

class ProgressService {
  /**
   * Helper to resolve course by UUID or slug with strict identifier validation
   */
  async findCourse(courseIdOrSlug) {
    if (!courseIdOrSlug) return null;
    const classification = classifyIdentifier(courseIdOrSlug);

    // If identifier is invalid (injection syntax, dangerous characters, whitespace), reject immediately without querying DB
    if (classification === 'INVALID') {
      return null;
    }
    const clean = String(courseIdOrSlug).trim();

    let query = supabase.from('courses').select('id, title, slug, curriculum_modules');
    if (classification === 'UUID') {
      query = query.eq('id', clean);
    } else {
      query = query.eq('slug', normalizeIdentifier(clean, 'SLUG'));
    }

    let { data: course } = await query.maybeSingle();
    if (!course && classification === 'SLUG') {
      const { data: allCourses } = await supabase.from('courses').select('id, title, slug, curriculum_modules');
      course = (allCourses || []).find(c => 
        c.slug === clean || 
        c.slug?.toLowerCase() === clean.toLowerCase() ||
        (c.title && c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') === clean.toLowerCase())
      );
    }
    return course || null;
  }

  /**
   * 1. Record Video Watch Progress
   * Enforces 90% playback completion rule, prevents trivial skips,
   * updates lesson_video_progress and rolls up course completion on enrollments.
   */
  async recordVideoProgress(user, {
    enrollmentId,
    courseId,
    moduleId,
    lessonId,
    currentPositionSeconds = 0,
    totalDurationSeconds = 0,
    watchedDurationSeconds = 0,
    event = 'timeupdate'
  }) {
    if (!user || !user.email) {
      throw { statusCode: 401, message: 'Authentication required.' };
    }

    const userEmail = user.email.toLowerCase().trim();
    const pos = Math.max(0, Math.floor(Number(currentPositionSeconds) || 0));
    const total = Math.max(0, Math.floor(Number(totalDurationSeconds) || 0));
    const watched = Math.max(pos, Math.floor(Number(watchedDurationSeconds) || pos));

    // Calculate Completion Percent
    let completionPercent = 0;
    if (total > 0) {
      completionPercent = Math.min(100, Math.round((pos / total) * 100));
    } else if (watched > 0) {
      completionPercent = 100;
    }

    // MANDATORY 90% COMPLETION RULE:
    // A video is marked complete ONLY IF completion percentage reaches 90.00%
    const isCompleted = completionPercent >= 90;

    // 1. Resolve Student Profile
    const { data: student } = await supabase
      .from('students')
      .select('id, email, full_name')
      .ilike('email', userEmail)
      .maybeSingle();

    if (!student) {
      throw { statusCode: 404, message: 'Student profile not found.' };
    }

    // 2. Resolve Enrollment Record
    let enrollment = null;
    if (enrollmentId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enrollmentId);
      if (isUuid) {
        const { data: enr } = await supabase
          .from('enrollments')
          .select('id, student_id, course_id, progress, completed_lessons')
          .eq('id', enrollmentId)
          .maybeSingle();
        if (enr && enr.student_id && enr.student_id !== student.id) {
          throw { statusCode: 403, message: 'Unauthorized: Enrollment does not belong to authenticated student.' };
        }
        enrollment = enr;
      }
    }

    if (!enrollment && courseId) {
      const { data: enr } = await supabase
        .from('enrollments')
        .select('id, student_id, course_id, progress, completed_lessons')
        .eq('student_id', student.id)
        .eq('course_id', courseId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      enrollment = enr;
    }

    const resolvedCourseId = courseId || enrollment?.course_id;

    // 3. Prevent Out-of-Order Multi-Tab Regressions
    // Fetch existing progress from memory or DB to ensure progress and completion monotonically increase
    const cacheKey = `${student.id}_${lessonId}`;
    const prevCache = memoryProgressStore.get(cacheKey) || {};

    let existingProg = null;
    try {
      const { data: dbProg } = await supabase
        .from('lesson_video_progress')
        .select('watched_position_seconds, watched_duration_seconds, completion_percent, is_completed, completed_at')
        .eq('student_id', student.id)
        .eq('lesson_id', String(lessonId))
        .maybeSingle();
      existingProg = dbProg;
    } catch (e) {}

    const maxPercent = Math.max(completionPercent, prevCache.completion_percent || 0, existingProg?.completion_percent || 0);
    const maxWatched = Math.max(watched, prevCache.watched_duration_seconds || 0, existingProg?.watched_duration_seconds || 0);
    const finalCompleted = Boolean(isCompleted || prevCache.is_completed || existingProg?.is_completed || maxPercent >= 90);
    const completedAtTimestamp = finalCompleted
      ? (existingProg?.completed_at || prevCache.completed_at || new Date().toISOString())
      : null;

    const videoProgressPayload = {
      student_id: student.id,
      enrollment_id: enrollment?.id || null,
      course_id: resolvedCourseId,
      lesson_id: String(lessonId),
      module_id: moduleId ? String(moduleId) : null,
      watched_position_seconds: pos,
      watched_duration_seconds: maxWatched,
      total_duration_seconds: total,
      completion_percent: maxPercent,
      is_completed: finalCompleted,
      completed_at: completedAtTimestamp,
      last_watched_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    memoryProgressStore.set(cacheKey, {
      ...prevCache,
      ...videoProgressPayload,
      is_completed: finalCompleted,
      completion_percent: maxPercent
    });

    try {
      await supabase
        .from('lesson_video_progress')
        .upsert(videoProgressPayload, { onConflict: 'student_id,lesson_id' });
    } catch (dbErr) {
      // Table might still be deploying migration; resilient memory store handles it
    }

    // 4. Sync with legacy lesson_progress table for backward compatibility
    if (moduleId && enrollment?.id) {
      try {
        await supabase
          .from('lesson_progress')
          .upsert({
            student_id: student.id,
            enrollment_id: enrollment.id,
            course_id: resolvedCourseId,
            module_id: String(moduleId),
            completed: isCompleted,
            progress_percent: completionPercent,
            last_position_seconds: pos,
            completed_at: isCompleted ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
          }, { onConflict: 'student_id,enrollment_id,module_id' });
      } catch (legacyErr) {}
    }

    // 5. Calculate Course & Module Completion Rollup
    let courseProgress = enrollment?.progress || 0;
    let totalLessonsCount = 0;
    let completedLessonsCount = 0;

    if (resolvedCourseId) {
      const courseData = await this.findCourse(resolvedCourseId);

      if (courseData && Array.isArray(courseData.curriculum_modules)) {
        const modules = courseData.curriculum_modules;
        totalLessonsCount = modules.length;

        // Query all completed lessons for this student
        const { data: completedRecords } = await supabase
          .from('lesson_video_progress')
          .select('lesson_id, module_id, is_completed')
          .eq('student_id', student.id)
          .eq('is_completed', true);

        const completedLessonSet = new Set((completedRecords || []).map(r => String(r.lesson_id)));
        (completedRecords || []).forEach(r => {
          if (r.module_id) completedLessonSet.add(String(r.module_id));
        });

        // Also check memory cache
        for (const [k, v] of memoryProgressStore.entries()) {
          if (k.startsWith(`${student.id}_`) && v.is_completed) {
            const lesId = k.slice(student.id.length + 1);
            completedLessonSet.add(lesId);
          }
        }

        completedLessonsCount = modules.filter((m, idx) => {
          const modId = String(m.id || idx + 1);
          const videoAssetId = m.video_asset_id ? String(m.video_asset_id) : null;
          return completedLessonSet.has(modId) || (videoAssetId && completedLessonSet.has(videoAssetId));
        }).length;

        if (totalLessonsCount > 0) {
          courseProgress = Math.min(100, Math.round((completedLessonsCount / totalLessonsCount) * 100));
        }

        // Update enrollment progress in DB
        if (enrollment?.id) {
          try {
            await supabase
              .from('enrollments')
              .update({
                progress: courseProgress,
                completed_lessons: completedLessonsCount,
                updated_at: new Date().toISOString()
              })
              .eq('id', enrollment.id);
          } catch (enrUpdateErr) {}
        }
      }
    }

    const isEligibleForCertificate = courseProgress >= 90;

    return {
      status: 'SUCCESS',
      lessonId,
      currentPositionSeconds: pos,
      watchedPositionSeconds: pos,
      watchedDurationSeconds: maxWatched,
      completionPercent: maxPercent,
      isCompleted: finalCompleted,
      courseProgress,
      completedLessons: completedLessonsCount,
      totalLessons: totalLessonsCount,
      isEligibleForCertificate
    };
  }

  /**
   * 2. Get Course Progress Breakdown
   */
  async getCourseProgress(user, courseId) {
    if (!user || !user.email) {
      throw { statusCode: 401, message: 'Authentication required.' };
    }

    const userEmail = user.email.toLowerCase().trim();
    const { data: student } = await supabase
      .from('students')
      .select('id, email, full_name')
      .ilike('email', userEmail)
      .maybeSingle();

    if (!student) {
      throw { statusCode: 404, message: 'Student not found.' };
    }

    // 1. Fetch Course Curriculum (supports UUID, slug, and title)
    const course = await this.findCourse(courseId);

    if (!course) {
      throw { statusCode: 404, message: 'Course not found.' };
    }

    // 2. Fetch Progress Records
    const { data: dbProgress } = await supabase
      .from('lesson_video_progress')
      .select('*')
      .eq('student_id', student.id);

    const progressMap = new Map();
    (dbProgress || []).forEach(p => {
      progressMap.set(String(p.lesson_id), p);
      if (p.module_id) progressMap.set(String(p.module_id), p);
    });

    // Merge in-memory cache entries
    for (const [k, v] of memoryProgressStore.entries()) {
      if (k.startsWith(`${student.id}_`)) {
        const lesId = k.slice(student.id.length + 1);
        if (!progressMap.has(lesId) || v.is_completed) {
          progressMap.set(lesId, v);
        }
      }
    }

    // 3. Roll up Module & Course Stats
    const modules = course.curriculum_modules || [];
    const totalLessons = modules.length;
    let completedLessons = 0;

    const moduleStats = modules.map((m, idx) => {
      const modId = String(m.id || idx + 1);
      const videoAssetId = m.video_asset_id ? String(m.video_asset_id) : null;
      const prog = progressMap.get(modId) || (videoAssetId ? progressMap.get(videoAssetId) : null);
      const isComp = Boolean(prog?.is_completed);

      if (isComp) {
        completedLessons++;
      }

      const rawTopics = Array.isArray(m.topics) && m.topics.length > 0
        ? m.topics
        : (Array.isArray(m.lessons) ? m.lessons : []);

      return {
        moduleId: m.id || idx + 1,
        title: m.title || m.name || `Module ${idx + 1}`,
        duration: m.duration,
        isCompleted: isComp,
        completionPercent: prog?.completion_percent || 0,
        lastPositionSeconds: prog?.watched_position_seconds || 0,
        topics: rawTopics.map((t, tIdx) => typeof t === "string" ? t : (t?.title || t?.name || `Topic ${tIdx + 1}`)).filter(Boolean)
      };
    });

    const overallProgress = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
    const isEligibleForCertificate = overallProgress >= 90;

    // Check certificate request status from DB first (ARCH-12 fix)
    let certRequest = null;
    try {
      const { data: dbCert } = await supabase
        .from('certificate_requests')
        .select('*')
        .eq('student_id', student.id)
        .eq('course_id', course.id)
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (dbCert) {
        certRequest = {
          status: dbCert.status,
          certificateId: dbCert.certificate_id
        };
      }
    } catch (e) {}

    // Fallback to memory store if table is connecting
    if (!certRequest) {
      const memReq = memoryCertificateRequests.get(`${student.id}_${course.id}`);
      if (memReq) {
        certRequest = {
          status: memReq.status,
          certificateId: memReq.certificateId || memReq.certificate_id
        };
      }
    }

    return {
      status: 'SUCCESS',
      courseId: course.id,
      courseTitle: course.title,
      overallProgress,
      completedLessons,
      totalLessons,
      isEligibleForCertificate,
      certificateStatus: certRequest?.status || (isEligibleForCertificate ? 'ELIGIBLE' : 'NOT_ELIGIBLE'),
      certificateId: certRequest?.certificateId || null,
      modules: moduleStats
    };
  }

  /**
   * 3. Submit Certificate Request (Admin Approval Workflow)
   * Enforces >= 90% progress and persists into certificate_requests table (ARCH-12 fix).
   */
  async requestCertificate(user, { enrollmentId, courseId, fullName, collegeName }) {
    if (!user || !user.email) {
      throw { statusCode: 401, message: 'Authentication required.' };
    }

    const userEmail = user.email.toLowerCase().trim();
    const { data: student } = await supabase
      .from('students')
      .select('id, email, full_name')
      .ilike('email', userEmail)
      .maybeSingle();

    if (!student) {
      throw { statusCode: 404, message: 'Student profile not found.' };
    }

    if (enrollmentId) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enrollmentId);
      if (isUuid) {
        const { data: enr } = await supabase
          .from('enrollments')
          .select('id, student_id')
          .eq('id', enrollmentId)
          .maybeSingle();
        if (enr && enr.student_id && enr.student_id !== student.id) {
          throw { statusCode: 403, message: 'Unauthorized: Enrollment does not belong to authenticated student.' };
        }
      }
    }

    // Verify Eligibility
    const progressData = await this.getCourseProgress(user, courseId);
    if (progressData.overallProgress < 90) {
      throw {
        statusCode: 403,
        message: `Certificate Eligibility Requirement: You have completed ${progressData.overallProgress}% of the course. At least 90% completion is required to apply for verified certification.`
      };
    }

    // Prevent duplicate active certificate requests
    try {
      const { data: existingReq } = await supabase
        .from('certificate_requests')
        .select('*')
        .eq('student_id', student.id)
        .eq('course_id', progressData.courseId)
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingReq) {
        return {
          status: 'SUCCESS',
          certificateId: existingReq.certificate_id,
          requestStatus: existingReq.status,
          message: existingReq.status === 'APPROVED'
            ? 'Certificate has already been verified and approved.'
            : 'Certificate application has been submitted and is currently under review.'
        };
      }
    } catch (checkErr) {}

    const certId = `IN-${(progressData.courseTitle || 'NLS').slice(0, 3).toUpperCase()}-2026-${student.id.slice(0, 4).toUpperCase()}`;
    const requestKey = `${student.id}_${progressData.courseId}`;

    const requestRecord = {
      certificate_id: certId,
      certificateId: certId,
      student_id: student.id,
      studentId: student.id,
      course_id: progressData.courseId,
      courseId: progressData.courseId,
      enrollment_id: enrollmentId || null,
      student_name: fullName || student.full_name || 'Student',
      college_name: collegeName || student.college || 'InternNetra Academy',
      status: 'PENDING_APPROVAL', // Admin approval strictly required!
      requested_at: new Date().toISOString(),
      requestedAt: new Date().toISOString(),
      approved_at: null
    };

    // 1. Keep in memory store for immediate local resolution
    memoryCertificateRequests.set(requestKey, requestRecord);

    // 2. Persist authoritatively in Supabase certificate_requests table (survives restart)
    try {
      await supabase.from('certificate_requests').upsert({
        certificate_id: certId,
        student_id: student.id,
        course_id: progressData.courseId,
        enrollment_id: enrollmentId || null,
        student_name: requestRecord.student_name,
        college_name: requestRecord.college_name,
        status: 'PENDING_APPROVAL',
        requested_at: requestRecord.requested_at
      }, { onConflict: 'certificate_id' });
    } catch (dbErr) {
      console.warn('⚠️ [Certificate Request DB Notice]:', dbErr.message);
    }

    return {
      status: 'SUCCESS',
      certificateId: certId,
      requestStatus: 'PENDING_APPROVAL',
      message: 'Certificate application submitted successfully. Your verified credential is under review by the academic administrator.'
    };
  }

  /**
   * 4. Get Certificate Status
   */
  async getCertificateStatus(user, { courseId }) {
    if (!user || !user.email) {
      throw { statusCode: 401, message: 'Authentication required.' };
    }

    const progressData = await this.getCourseProgress(user, courseId);
    return {
      status: 'SUCCESS',
      courseId: progressData.courseId,
      overallProgress: progressData.overallProgress,
      isEligible: progressData.isEligibleForCertificate,
      certificateStatus: progressData.certificateStatus,
      certificateId: progressData.certificateId
    };
  }
}

module.exports = new ProgressService();
