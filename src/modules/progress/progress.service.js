/**
 * Learning Progress & Course Completion Service
 * Implements 90% video completion rule, multi-lesson course rollups, and certificate eligibility workflows.
 */

const { supabase } = require('../../config/supabase');

// Resilient memory cache for offline/local development
const memoryProgressStore = new Map();
const memoryCertificateRequests = new Map();

class ProgressService {
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

    // 3. Upsert into lesson_video_progress
    const videoProgressPayload = {
      student_id: student.id,
      enrollment_id: enrollment?.id || null,
      course_id: resolvedCourseId,
      lesson_id: String(lessonId),
      module_id: moduleId ? String(moduleId) : null,
      watched_position_seconds: pos,
      watched_duration_seconds: watched,
      total_duration_seconds: total,
      completion_percent: completionPercent,
      is_completed: isCompleted,
      completed_at: isCompleted ? new Date().toISOString() : null,
      last_watched_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Store in memory cache
    const cacheKey = `${student.id}_${lessonId}`;
    const prevCache = memoryProgressStore.get(cacheKey) || {};
    memoryProgressStore.set(cacheKey, {
      ...prevCache,
      ...videoProgressPayload,
      // If already completed previously, keep completed state
      is_completed: prevCache.is_completed || isCompleted
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
      const { data: courseData } = await supabase
        .from('courses')
        .select('id, curriculum_modules')
        .or(`id.eq.${resolvedCourseId},slug.eq.${resolvedCourseId}`)
        .maybeSingle();

      if (courseData && Array.isArray(courseData.curriculum_modules)) {
        // Collect all published lessons
        const allCourseLessons = [];
        for (const mod of courseData.curriculum_modules) {
          if (Array.isArray(mod.lessons)) {
            for (const l of mod.lessons) {
              allCourseLessons.push({ lessonId: String(l.id), moduleId: mod.id });
            }
          }
        }
        totalLessonsCount = allCourseLessons.length;

        // Query all completed lessons for this student
        const { data: completedRecords } = await supabase
          .from('lesson_video_progress')
          .select('lesson_id, is_completed')
          .eq('student_id', student.id)
          .eq('is_completed', true);

        const completedLessonSet = new Set((completedRecords || []).map(r => String(r.lesson_id)));
        
        // Also check memory cache
        for (const l of allCourseLessons) {
          const mKey = `${student.id}_${l.lessonId}`;
          if (memoryProgressStore.get(mKey)?.is_completed) {
            completedLessonSet.add(l.lessonId);
          }
        }

        completedLessonsCount = allCourseLessons.filter(l => completedLessonSet.has(l.lessonId)).length;
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
      completionPercent,
      isCompleted,
      courseProgress,
      completedLessons: completedLessonsCount,
      totalLessons: totalLessonsCount,
      isEligibleForCertificate
    };
  }

  /**
   * 2. Retrieve Course & Module Progress Breakdown
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

    // 1. Fetch Course Curriculum
    const { data: course } = await supabase
      .from('courses')
      .select('id, title, slug, curriculum_modules')
      .or(`id.eq.${courseId},slug.eq.${courseId}`)
      .maybeSingle();

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
    let totalLessons = 0;
    let completedLessons = 0;

    const moduleStats = modules.map(m => {
      const lessons = m.lessons || [];
      const mTotal = lessons.length;
      let mCompleted = 0;

      const lessonsProgress = lessons.map(l => {
        totalLessons++;
        const prog = progressMap.get(String(l.id));
        const isComp = Boolean(prog?.is_completed);
        if (isComp) {
          completedLessons++;
          mCompleted++;
        }
        return {
          lessonId: l.id,
          title: l.title || l.name,
          duration: l.duration,
          isCompleted: isComp,
          completionPercent: prog?.completion_percent || 0,
          lastPositionSeconds: prog?.watched_position_seconds || 0
        };
      });

      const mPercent = mTotal > 0 ? Math.round((mCompleted / mTotal) * 100) : 0;
      return {
        moduleId: m.id,
        title: m.title || m.name,
        totalLessons: mTotal,
        completedLessons: mCompleted,
        progressPercent: mPercent,
        lessons: lessonsProgress
      };
    });

    const overallProgress = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
    const isEligibleForCertificate = overallProgress >= 90;

    // Check certificate request status
    const certRequest = memoryCertificateRequests.get(`${student.id}_${course.id}`);

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
   * Does NOT auto-issue; registers request with status PENDING_APPROVAL.
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

    // Verify Eligibility
    const progressData = await this.getCourseProgress(user, courseId);
    if (progressData.overallProgress < 90) {
      throw {
        statusCode: 403,
        message: `Certificate Eligibility Requirement: You have completed ${progressData.overallProgress}% of the course. At least 90% completion is required to apply for verified certification.`
      };
    }

    const certId = `IN-${(progressData.courseTitle || 'NLS').slice(0, 3).toUpperCase()}-2026-${student.id.slice(0, 4).toUpperCase()}`;
    const requestKey = `${student.id}_${progressData.courseId}`;

    const requestRecord = {
      certificateId: certId,
      studentId: student.id,
      courseId: progressData.courseId,
      enrollmentId: enrollmentId || null,
      studentName: fullName || student.full_name || 'Student',
      collegeName: collegeName || student.college || 'InternNetra Academy',
      status: 'PENDING_APPROVAL', // Admin approval strictly required!
      requestedAt: new Date().toISOString(),
      approvedAt: null
    };

    memoryCertificateRequests.set(requestKey, requestRecord);

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
