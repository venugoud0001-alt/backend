const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticateJWT, requirePermission } = require('../middleware/auth');
const progressService = require('../src/modules/progress/progress.service');

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

// ================= Legacy Progress Synchronization Endpoints =================
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
      return res.status(404).json({ status: 'ERROR', message: 'Student profile not found.' });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enrollmentId);
    let enrollment = null;
    if (isUuid) {
      const { data: enr } = await supabase
        .from('enrollments')
        .select('id, student_id, course_id, payment_status')
        .eq('id', enrollmentId)
        .maybeSingle();
      enrollment = enr;
    }

    if (!enrollment) {
      const { data: latestEnr } = await supabase
        .from('enrollments')
        .select('id, student_id, course_id, payment_status')
        .eq('student_id', student.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      enrollment = latestEnr;
    }

    if (!enrollment) {
      return res.status(404).json({ status: 'ERROR', message: 'Enrollment record not found.' });
    }

    if (String(enrollment.student_id) !== String(student.id)) {
      return res.status(403).json({ status: 'ERROR', message: 'Access denied: You do not own this enrollment.' });
    }

    const { data: progressRecords, error } = await supabase
      .from('lesson_progress')
      .select('*')
      .eq('student_id', student.id)
      .eq('enrollment_id', enrollment.id);

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ status: 'ERROR', message: error.message });
    }

    res.status(200).json({
      status: 'SUCCESS',
      enrollmentId: enrollment.id,
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
    const { completed = true, progressPercent = 100, lastPositionSeconds = 0 } = req.body || {};
    const userEmail = (req.user?.email || "").toLowerCase().trim();

    if (!userEmail) {
      return res.status(401).json({ status: 'ERROR', message: 'Authentication required.' });
    }

    const pct = Number(progressPercent);
    const pos = Number(lastPositionSeconds);

    if (isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ status: 'ERROR', message: 'Progress percentage must be between 0 and 100.' });
    }

    if (isNaN(pos) || pos < 0) {
      return res.status(400).json({ status: 'ERROR', message: 'Video position must be non-negative.' });
    }

    const { data: student } = await supabase
      .from('students')
      .select('id, email')
      .ilike('email', userEmail)
      .maybeSingle();

    if (!student) {
      return res.status(404).json({ status: 'ERROR', message: 'Student profile not found.' });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(enrollmentId);
    let enrollment = null;
    if (isUuid) {
      const { data: enr } = await supabase
        .from('enrollments')
        .select('id, student_id, course_id')
        .eq('id', enrollmentId)
        .maybeSingle();
      enrollment = enr;
    }

    if (!enrollment) {
      const { data: latestEnr } = await supabase
        .from('enrollments')
        .select('id, student_id, course_id')
        .eq('student_id', student.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      enrollment = latestEnr;
    }

    if (!enrollment) {
      return res.status(404).json({ status: 'ERROR', message: 'Enrollment record not found.' });
    }

    if (String(enrollment.student_id) !== String(student.id)) {
      return res.status(403).json({ status: 'ERROR', message: 'Access denied: You do not own this enrollment.' });
    }

    const upsertData = {
      student_id: student.id,
      enrollment_id: enrollment.id,
      course_id: enrollment.course_id,
      module_id: String(moduleId),
      completed: Boolean(completed),
      progress_percent: pct,
      last_position_seconds: pos,
      completed_at: completed ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    };

    const { data: record, error } = await supabase
      .from('lesson_progress')
      .upsert(upsertData, { onConflict: 'student_id,enrollment_id,module_id' })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ status: 'ERROR', message: error.message });
    }

    res.status(200).json({
      status: 'SUCCESS',
      progressRecord: record
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
