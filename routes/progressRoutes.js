const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateJWT, optionalAuthenticateJWT, requirePermission } = require('../middleware/auth');
const progressService = require('../src/modules/progress/progress.service');
const streakService = require('../src/modules/progress/streak.service');

// 1. Record Video Watch Progress (Phase 6: 90% completion rule, periodic / event-driven)
router.post('/video/progress', authenticateJWT, async (req, res, next) => {
  try {
    const result = await progressService.recordVideoProgress(req.user, req.body || {});
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 2. Get Video Progress & Course Completion Breakdown
router.get('/video/progress/:courseId', authenticateJWT, async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const result = await progressService.getCourseProgress(req.user, courseId);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 3. Submit Certificate Request (Enforces >= 90% and requires admin approval)
router.post('/certificate/request', authenticateJWT, async (req, res, next) => {
  try {
    const result = await progressService.requestCertificate(req.user, req.body || {});
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 4. Get Certificate Status for Course
router.get('/certificate/status/:courseId', authenticateJWT, async (req, res, next) => {
  try {
    const { courseId } = req.params;
    const result = await progressService.getCertificateStatus(req.user, { courseId });
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// 5. Admin: List Certificate Requests (Requires certificate.view)
router.get('/admin/certificates', authenticateJWT, requirePermission('certificate.view'), async (req, res, next) => {
  try {
    const { data: requests, error } = await supabase
      .from('certificate_requests')
      .select('*')
      .order('requested_at', { ascending: false });

    return res.status(200).json({
      status: 'SUCCESS',
      requests: requests || []
    });
  } catch (err) {
    next(err);
  }
});

// 6. Admin: Approve Certificate Request (Requires certificate.approve)
router.post('/admin/certificates/approve', authenticateJWT, requirePermission('certificate.approve'), async (req, res, next) => {
  try {
    const { certificateId } = req.body;
    if (!certificateId) {
      return res.status(400).json({ status: 'ERROR', message: 'certificateId is required.' });
    }

    await supabase
      .from('certificate_requests')
      .update({
        status: 'APPROVED',
        approved_at: new Date().toISOString(),
        approved_by: req.user?.email || 'admin'
      })
      .eq('certificate_id', certificateId);

    return res.status(200).json({
      status: 'SUCCESS',
      message: `Certificate ${certificateId} approved successfully.`
    });
  } catch (err) {
    next(err);
  }
});

// 7. Admin: Reject Certificate Request (Requires certificate.reject)
router.post('/admin/certificates/reject', authenticateJWT, requirePermission('certificate.reject'), async (req, res, next) => {
  try {
    const { certificateId, reason } = req.body;
    if (!certificateId) {
      return res.status(400).json({ status: 'ERROR', message: 'certificateId is required.' });
    }

    await supabase
      .from('certificate_requests')
      .update({
        status: 'REJECTED',
        rejection_reason: reason || 'Requirements not satisfied'
      })
      .eq('certificate_id', certificateId);

    return res.status(200).json({
      status: 'SUCCESS',
      message: `Certificate ${certificateId} rejected.`
    });
  } catch (err) {
    next(err);
  }
});

// ================= Progress Synchronization Endpoints =================
router.get('/progress/:enrollmentId', authenticateJWT, async (req, res, next) => {
  try {
    const { enrollmentId } = req.params;
    const userEmail = (req.user?.email || "").toLowerCase().trim();

    if (!userEmail) {
      return res.status(401).json({ status: 'ERROR', message: 'Authentication required.' });
    }

    const { data: student } = await supabase
      .from('students')
      .select('id, email')
      .ilike('email', userEmail)
      .maybeSingle();

    if (!student) {
      return res.status(200).json({ status: 'SUCCESS', enrollmentId, progress: [] });
    }

    const isEnrollmentUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enrollmentId);
    if (isEnrollmentUuid) {
      const { data: enr } = await supabase
        .from('enrollments')
        .select('id, student_id')
        .eq('id', enrollmentId)
        .maybeSingle();

      if (enr && enr.student_id && enr.student_id !== student.id && req.userRole !== 'ADMIN') {
        return res.status(403).json({ status: 'ERROR', message: 'Forbidden: Unauthorized access to enrollment progress.' });
      }
    }

    const { data: progressRecords } = await supabase
      .from('lesson_video_progress')
      .select('*')
      .eq('student_id', student.id);

    return res.status(200).json({
      status: 'SUCCESS',
      enrollmentId,
      studentId: student.id,
      progress: progressRecords || []
    });
  } catch (err) {
    next(err);
  }
});

router.put('/progress/:enrollmentId/:moduleId', authenticateJWT, async (req, res, next) => {
  try {
    const { enrollmentId, moduleId } = req.params;
    const { completed = true, progressPercent = 100, lastPositionSeconds = 0, totalDurationSeconds = 0 } = req.body || {};
    const userEmail = (req.user?.email || "").toLowerCase().trim();

    if (!userEmail) {
      return res.status(401).json({ status: 'ERROR', message: 'Authentication required.' });
    }

    const pct = Number(progressPercent);
    const pos = Number(lastPositionSeconds);

    const { data: student } = await supabase
      .from('students')
      .select('id, email')
      .ilike('email', userEmail)
      .maybeSingle();

    if (!student) {
      // Return 200 OK for admin / guest previewing
      return res.status(200).json({
        status: 'SUCCESS',
        progressRecord: {
          module_id: String(moduleId),
          completed: Boolean(completed),
          progress_percent: isNaN(pct) ? 100 : pct,
          last_position_seconds: isNaN(pos) ? 0 : pos
        }
      });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enrollmentId);
    let courseId = enrollmentId;
    let resolvedEnrollmentId = null;

    if (isUuid) {
      const { data: enr } = await supabase
        .from('enrollments')
        .select('id, course_id, student_id')
        .eq('id', enrollmentId)
        .maybeSingle();

      if (enr) {
        if (enr.student_id && enr.student_id !== student.id && req.userRole !== 'ADMIN') {
          return res.status(403).json({ status: 'ERROR', message: 'Forbidden: Cannot update progress for another student enrollment.' });
        }
        resolvedEnrollmentId = enr.id;
        courseId = enr.course_id;
      }
    }

    const upsertData = {
      student_id: student.id,
      enrollment_id: resolvedEnrollmentId,
      course_id: courseId,
      module_id: String(moduleId),
      lesson_id: String(moduleId),
      watched_position_seconds: isNaN(pos) ? 0 : Math.max(0, Math.floor(pos)),
      watched_duration_seconds: isNaN(pos) ? 0 : Math.max(0, Math.floor(pos)),
      total_duration_seconds: Number(totalDurationSeconds) || 0,
      completion_percent: isNaN(pct) ? 100 : Math.min(100, Math.max(0, Math.round(pct))),
      is_completed: Boolean(completed) || (pct >= 90),
      completed_at: (Boolean(completed) || pct >= 90) ? new Date().toISOString() : null,
      last_watched_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { data: record, error } = await supabase
      .from('lesson_video_progress')
      .upsert(upsertData, { onConflict: 'student_id,lesson_id' })
      .select()
      .maybeSingle();

    if (error) {
      console.warn('⚠️ [Video Progress DB Notice]:', error.message);
    }

    return res.status(200).json({
      status: 'SUCCESS',
      progressRecord: record || upsertData
    });
  } catch (err) {
    next(err);
  }
});

// ================= Dynamic Student Learning Streak Endpoints =================
router.get(['/student/learning-streak', '/progress/streak', '/video/learning-streak'], optionalAuthenticateJWT, async (req, res, next) => {
  try {
    const queryEmail = req.query?.email || req.headers['x-student-email'] || null;
    const tzOffset = req.query?.tz ? Number(req.query.tz) : 0;
    const result = await streakService.getStudentStreak(req.user, queryEmail, tzOffset);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post(['/student/learning-streak/heartbeat', '/progress/streak/heartbeat'], optionalAuthenticateJWT, async (req, res, next) => {
  try {
    const queryEmail = req.body?.email || req.query?.email || req.headers['x-student-email'] || null;
    const result = await streakService.recordHeartbeat(req.user, { ...(req.body || {}), email: queryEmail });
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
