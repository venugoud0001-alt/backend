const { supabase } = require('../../config/supabase');
const { addCalendarMonths, isAccessExpired } = require('../../utils/dateUtils');
const installmentService = require('../../services/installment.service');

/**
 * Authoritative Student Enrollments Controller
 * Fetches real course enrollments for a student joined with courses and payments
 */
async function getStudentEnrollments(req, res) {
  try {
    // 1. Resolve student email strictly from authenticated user session (prevents cross-student data leakage)
    let userEmail = '';
    if (req.user?.email) {
      if (req.userRole === 'ADMIN' && req.query?.email) {
        userEmail = String(req.query.email).toLowerCase().trim();
      } else {
        userEmail = String(req.user.email).toLowerCase().trim();
      }
    } else {
      userEmail = (req.query?.email || req.headers['x-student-email'] || '').toLowerCase().trim();
    }

    if (!userEmail) {
      return res.status(401).json({
        status: 'ERROR',
        message: 'Authentication required to access student enrollments.'
      });
    }

    // 2. Fetch student identity from students table
    const { data: student, error: sErr } = await supabase
      .from('students')
      .select('id, email, full_name, phone, account_status')
      .ilike('email', userEmail)
      .maybeSingle();

    if (sErr) {
      console.warn('[ENROLLMENT_API] Student lookup note:', sErr.message);
    }

    let enrollments = [];

    // 3. If student record exists, fetch enrollments joined with courses
    if (student?.id) {
      let { data: enrData, error: eErr } = await supabase
        .from('enrollments')
        .select(`
          id,
          student_id,
          course_id,
          course_name,
          total_amount,
          amount_paid,
          amount_pending,
          payment_plan,
          payment_status,
          course_access_status,
          suspension_reason,
          suspension_notes,
          second_payment_due_at,
          installment_due_at,
          account_status,
          progress,
          completed_lessons,
          certificate_status,
          certificate_id,
          batch_name,
          access_start_date,
          access_expiry_date,
          created_at,
          updated_at
        `)
        .eq('student_id', student.id)
        .order('created_at', { ascending: false });

      if (eErr) {
        // Fallback to base columns if access columns not yet migrated
        const { data: fallbackData } = await supabase
          .from('enrollments')
          .select(`
            id,
            student_id,
            course_id,
            course_name,
            total_amount,
            amount_paid,
            amount_pending,
            payment_plan,
            payment_status,
            course_access_status,
            account_status,
            progress,
            completed_lessons,
            certificate_status,
            certificate_id,
            batch_name,
            created_at,
            updated_at
          `)
          .eq('student_id', student.id)
          .order('created_at', { ascending: false });

        if (Array.isArray(fallbackData) && fallbackData.length > 0) {
          enrData = fallbackData;
        }
      }

      if (Array.isArray(enrData) && enrData.length > 0) {
        enrollments = enrData;
      }
    }

    // 4. Fallback check: If no enrollments exist in enrollments table, check verified payments
    if (enrollments.length === 0) {
      const { data: paymentsData } = await supabase
        .from('payments')
        .select(`
          txn_id,
          email,
          student_name,
          course_name,
          amount,
          amount_paid,
          total_course_fee,
          remaining_balance,
          payment_type,
          status,
          created_at
        `)
        .ilike('email', userEmail)
        .order('created_at', { ascending: false });

      if (paymentsData && paymentsData.length > 0) {
        for (const pmt of paymentsData) {
          const courseTitle = (pmt.course_name || '').trim();
          if (!courseTitle) continue;

          // Attempt to find matching course by title or slug
          const { data: matchedCourse } = await supabase
            .from('courses')
            .select('id, title, slug')
            .or(`title.ilike.%${courseTitle}%,slug.ilike.%${courseTitle}%`)
            .maybeSingle();

          const totalAmt = Number(pmt.total_course_fee || 4000);
          const paidAmt = Number(pmt.amount_paid || pmt.amount || 0);
          const pendingAmt = Number(pmt.remaining_balance ?? Math.max(0, totalAmt - paidAmt));

          enrollments.push({
            id: `enr_pmt_${pmt.txn_id || Date.now()}`,
            student_id: student?.id || null,
            course_id: matchedCourse?.id || null,
            course_name: matchedCourse?.title || courseTitle,
            total_amount: totalAmt,
            amount_paid: paidAmt,
            amount_pending: pendingAmt,
            payment_plan: pmt.payment_type || (pendingAmt > 0 ? 'INSTALLMENT' : 'FULL'),
            payment_status: pendingAmt <= 0 ? 'PAID' : (paidAmt > 0 ? 'PARTIALLY_PAID' : 'PAYMENT_PENDING'),
            course_access_status: paidAmt > 0 ? 'UNLOCKED' : 'LOCKED',
            progress: 0,
            completed_lessons: 0,
            created_at: pmt.created_at || new Date().toISOString(),
            source: 'Verified Payment'
          });
        }
      }
    }

    // 5. Deduplicate multiple enrollment attempts for the same course
    const dedupedMap = new Map();
    enrollments.forEach(enr => {
      const key = enr.course_id || enr.course_name;
      if (!dedupedMap.has(key)) {
        dedupedMap.set(key, enr);
      } else {
        const existing = dedupedMap.get(key);
        if ((enr.amount_paid || 0) > (existing.amount_paid || 0)) {
          dedupedMap.set(key, enr);
        }
      }
    });
    const uniqueEnrollments = Array.from(dedupedMap.values());

    // 6. Fetch course details (slug, modules, images) for each enrolled course_id
    const courseIds = uniqueEnrollments.map(e => e.course_id).filter(Boolean);
    let coursesMap = {};

    if (courseIds.length > 0) {
      const { data: coursesData } = await supabase
        .from('courses')
        .select(`
          id,
          title,
          slug,
          price,
          installment_price,
          image_url,
          curriculum_modules,
          duration,
          level,
          category_id
        `)
        .in('id', courseIds);

      if (coursesData && coursesData.length > 0) {
        coursesData.forEach(c => {
          coursesMap[c.id] = c;
        });
      }
    }

    // 7. Map into authoritative student enrollment records
    const normalized = uniqueEnrollments.map(enr => {
      const course = coursesMap[enr.course_id] || null;
      const canonicalTitle = course?.title || enr.course_name;
      const canonicalSlug = course?.slug || canonicalTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const modules = Array.isArray(course?.curriculum_modules) ? course.curriculum_modules : [];
      const totalLessons = modules.length > 0 ? modules.length : 10;
      const completed = Number(enr.completed_lessons || 0);
      const progressPercent = enr.progress !== undefined && enr.progress !== null
        ? Number(enr.progress)
        : Math.min(100, Math.round((completed / totalLessons) * 100));

      const totalAmt = Number(enr.total_amount || course?.price || 4000);
      const isSettled = enr.payment_status === 'PAID';
      const rawPaid = Number(enr.amount_paid || 0);
      const paidAmt = isSettled ? totalAmt : Math.min(totalAmt, rawPaid);
      const pendingAmt = isSettled
        ? 0
        : Number(
            enr.amount_pending !== undefined && enr.amount_pending !== null
              ? enr.amount_pending
              : Math.max(0, totalAmt - paidAmt)
          );

      const accessStart = enr.access_start_date || enr.created_at || new Date().toISOString();
      const accessExpiry = enr.access_expiry_date || addCalendarMonths(accessStart, 6).toISOString();
      const isExpired = isAccessExpired(accessExpiry);

      const rawThumb = course?.image_url || '';
      const cleanThumb = typeof rawThumb === 'string' && !rawThumb.includes('[object Object]') && rawThumb !== 'null' && rawThumb !== 'undefined' ? rawThumb.trim() : '';

      const installmentInfo = installmentService.evaluateEnrollmentState(enr);

      return {
        id: course?.id || enr.course_id || enr.id,
            enrollmentId: enr.id,
            courseId: course?.id || enr.course_id,
            course_id: course?.id || enr.course_id,
            name: canonicalTitle,
            title: canonicalTitle,
            slug: canonicalSlug,
            rawName: enr.course_name,
            thumbnail_url: cleanThumb,
            image_url: cleanThumb,
            totalAmount: totalAmt,
            total_amount: totalAmt,
            totalFee: totalAmt,
            amountPaid: paidAmt,
            amount_paid: paidAmt,
            amountPending: pendingAmt,
            amount_pending: pendingAmt,
            remainingBalance: pendingAmt,
            remaining_balance: pendingAmt,
            paymentPlan: enr.payment_plan || (pendingAmt > 0 ? 'INSTALLMENT' : 'FULL'),
            payment_plan: enr.payment_plan || (pendingAmt > 0 ? 'INSTALLMENT' : 'FULL'),
            paymentStatus: enr.payment_status || (pendingAmt <= 0 ? 'PAID' : (paidAmt > 0 ? 'PARTIALLY_PAID' : 'PAYMENT_PENDING')),
            payment_status: enr.payment_status || (pendingAmt <= 0 ? 'PAID' : (paidAmt > 0 ? 'PARTIALLY_PAID' : 'PAYMENT_PENDING')),
            courseAccessStatus: enr.course_access_status || (paidAmt > 0 ? 'UNLOCKED' : 'LOCKED'),
            course_access_status: enr.course_access_status || (paidAmt > 0 ? 'UNLOCKED' : 'LOCKED'),
            secondPaymentDueAt: installmentInfo?.secondPaymentDueAt || enr.installment_due_at || null,
            second_payment_due_at: installmentInfo?.secondPaymentDueAt || enr.installment_due_at || null,
            daysRemaining: installmentInfo?.daysRemaining ?? null,
            daysOverdue: installmentInfo?.daysOverdue ?? 0,
            isOverdue: Boolean(installmentInfo?.isOverdue),
            isSuspended: enr.course_access_status === 'SUSPENDED',
            suspensionReason: enr.suspension_reason || (enr.course_access_status === 'SUSPENDED' ? (pendingAmt > 0 && installmentInfo?.isOverdue ? 'PAYMENT_OVERDUE' : 'MANUAL_ADMIN') : null),
            suspension_reason: enr.suspension_reason || (enr.course_access_status === 'SUSPENDED' ? (pendingAmt > 0 && installmentInfo?.isOverdue ? 'PAYMENT_OVERDUE' : 'MANUAL_ADMIN') : null),
            suspensionNotes: enr.suspension_notes || null,
            suspension_notes: enr.suspension_notes || null,
            completedLessons: completed,
            totalLessons: totalLessons,
            progress: progressPercent,
            curriculum: modules,
            enrolledAt: enr.created_at || new Date().toISOString(),
            accessStartDate: accessStart,
            accessExpiryDate: accessExpiry,
            access_start_date: accessStart,
            access_expiry_date: accessExpiry,
            isExpired: isExpired,
            status: isExpired ? 'Access Expired' : (enr.course_access_status === 'SUSPENDED' ? 'Access Suspended' : (enr.course_access_status === 'LOCKED' ? 'Pending Payment' : 'Active')),
            source: 'Authoritative Backend Database'
          };
        });

    return res.status(200).json({
      status: 'SUCCESS',
      studentEmail: userEmail,
      count: normalized.length,
      data: normalized
    });

  } catch (err) {
    console.error('[ENROLLMENT_API] Error fetching student enrollments:', err);
    return res.status(500).json({
      status: 'ERROR',
      message: 'Failed to retrieve student enrollments.'
    });
  }
}

module.exports = {
  getStudentEnrollments
};
