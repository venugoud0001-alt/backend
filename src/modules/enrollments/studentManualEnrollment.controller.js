/**
 * Authoritative Admin Manual Student Creation & Course Enrollment Controller
 * Enterprise Grade - One Source of Truth for Student, Enrollment & Payment Ledger
 */

const { supabase } = require('../../config/supabase');
const installmentService = require('../../services/installment.service');
const mailer = require('../../../services/mailer');
const notificationService = require('../../services/notifications/notification.service');
const couponService = require('../coupons/coupon.service');
const { addCalendarMonths } = require('../../utils/dateUtils');
const logger = console;

// In-flight concurrency locks to prevent double-submission during manual provisioning
const inFlightManualEnrollmentLocks = new Map();

/**
 * 1. Check Student Email Existence & Return Details (Live Validation)
 * GET /api/admin/students/check-email?email=...
 */
async function checkStudentEmail(req, res, next) {
  try {
    const rawEmail = req.query.email || req.body?.email;
    if (!rawEmail) {
      return res.status(400).json({ status: 'ERROR', message: 'Email query parameter is required.' });
    }

    const normalizedEmail = String(rawEmail).toLowerCase().trim();

    // Query students and profiles tables
    const { data: student, error: sErr } = await supabase
      .from('students')
      .select('id, email, full_name, phone, account_status, created_at')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, status, enrolled_course, created_at')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    const resolvedStudent = student || profile;

    if (!resolvedStudent) {
      return res.status(200).json({
        status: 'SUCCESS',
        exists: false,
        email: normalizedEmail
      });
    }

    // Fetch student's existing enrollments
    const studentId = student?.id || profile?.id;
    let existingEnrollments = [];

    if (studentId) {
      const { data: enrollments } = await supabase
        .from('enrollments')
        .select('id, course_id, course_name, payment_plan, payment_status, course_access_status, amount_paid, amount_pending, total_amount, created_at')
        .or(`student_id.eq.${studentId},student_id.eq.${profile?.id || studentId}`)
        .order('created_at', { ascending: false });

      existingEnrollments = enrollments || [];
    }

    return res.status(200).json({
      status: 'SUCCESS',
      exists: true,
      student: {
        id: resolvedStudent.id,
        name: resolvedStudent.full_name || resolvedStudent.name || 'Student',
        email: resolvedStudent.email,
        phone: resolvedStudent.phone || '',
        accountStatus: resolvedStudent.account_status || resolvedStudent.status || 'Active Online',
        enrollments: existingEnrollments
      }
    });
  } catch (err) {
    next(err);
  }
}

/**
 * 2. Search Existing Students
 * GET /api/admin/students/search?q=...
 */
async function searchExistingStudents(req, res, next) {
  try {
    const query = String(req.query.q || '').trim();
    if (!query || query.length < 2) {
      return res.status(200).json({ status: 'SUCCESS', data: [] });
    }

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, status, enrolled_course, created_at')
      .or(`full_name.ilike.%${query}%,email.ilike.%${query}%`)
      .limit(20);

    if (error) throw error;

    return res.status(200).json({
      status: 'SUCCESS',
      data: (profiles || []).map(p => ({
        id: p.id,
        name: p.full_name || p.email?.split('@')[0] || 'Student',
        email: p.email,
        phone: p.phone || '',
        status: p.status || 'Active Online',
        enrolledCourse: p.enrolled_course || ''
      }))
    });
  } catch (err) {
    next(err);
  }
}

/**
 * 3. Authoritative Manual Student Creation & Course Enrollment
 * POST /api/admin/students/manual-enrollment
 */
async function createStudentAndEnroll(req, res, next) {
  const adminEmail = req.user?.email || 'admin@internnetra.com';
  const adminId = req.user?.id || null;

  const {
    studentType = 'NEW', // 'NEW' | 'EXISTING'
    fullName,
    email,
    phone = '',
    studentId: providedStudentId,
    courseId,
    courseIds,
    paymentPlan = 'FULL', // 'FULL' | 'INSTALLMENT'
    paymentStatus = 'PAID', // 'PAID' | 'PENDING'
    installment1Amount,
    installment2Amount,
    installment1Status = 'PAID', // 'PAID' | 'PENDING'
    paymentMethod = 'Cash', // 'Cash' | 'UPI' | 'Bank Transfer' | 'Cashfree PG' | 'Other'
    couponCode = ''
  } = req.body;

  // 1. Basic Field Validations
  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ status: 'ERROR', message: 'A valid email address is required.' });
  }

  if (studentType === 'NEW' && (!fullName || !fullName.trim())) {
    return res.status(400).json({ status: 'ERROR', message: 'Full name is required for new student creation.' });
  }

  const rawCourseIds = Array.isArray(courseIds) && courseIds.length > 0
    ? courseIds.filter(Boolean)
    : (courseId ? [courseId] : []);

  if (rawCourseIds.length === 0) {
    return res.status(400).json({ status: 'ERROR', message: 'Please select at least one course for enrollment.' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '').slice(-10);
  const lockKey = `${normalizedEmail}_${rawCourseIds.slice().sort().join('_')}`;

  // 2. Concurrency / Double-Click Guard
  if (inFlightManualEnrollmentLocks.has(lockKey)) {
    return res.status(409).json({
      status: 'ERROR',
      code: 'REQUEST_IN_FLIGHT',
      message: 'An enrollment operation for this student and course(s) is currently in progress. Please wait a moment.'
    });
  }
  inFlightManualEnrollmentLocks.set(lockKey, Date.now());

  try {
    // 3. Authoritative Course Lookup (Multi-Course Support)
    const uuidList = rawCourseIds.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    const slugList = rawCourseIds.filter(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));

    let courses = [];
    if (uuidList.length > 0) {
      const { data: uData } = await supabase
        .from('courses')
        .select('id, title, price, installment_price, status, category_id, duration')
        .in('id', uuidList);
      if (uData) courses = courses.concat(uData);
    }
    if (slugList.length > 0) {
      const { data: sData } = await supabase
        .from('courses')
        .select('id, title, price, installment_price, status, category_id, duration')
        .in('slug', slugList);
      if (sData) courses = courses.concat(sData);
    }

    if (courses.length === 0) {
      inFlightManualEnrollmentLocks.delete(lockKey);
      return res.status(404).json({ status: 'ERROR', message: 'No matching courses found for provided identifier(s).' });
    }

    // Deduplicate courses by id
    const uniqueCourseMap = new Map();
    courses.forEach(c => uniqueCourseMap.set(c.id, c));
    const coursesFound = Array.from(uniqueCourseMap.values());
    const combinedCourseNames = coursesFound.map(c => c.title).join(', ');

    // 4. Authoritative Pricing & Coupon Validation (Combined for all selected courses)
    const baseCoursePrice = coursesFound.reduce((acc, c) => acc + Math.max(0, Math.round(Number(c.price || 4000))), 0);
    let discount = 0;
    let validatedCoupon = null;

    if (couponCode && String(couponCode).trim().length > 0) {
      try {
        const valResult = await couponService.validateCouponForCourse({
          code: String(couponCode).trim().toUpperCase(),
          courseId: coursesFound[0].id,
          paymentMode: paymentPlan
        });
        const isOk = valResult?.valid || valResult?.isValid;
        const couponObj = valResult?.coupon || valResult;
        if (isOk && couponObj) {
          validatedCoupon = couponObj;
          const discType = (validatedCoupon.discount_type || validatedCoupon.discountType || 'PERCENTAGE').toUpperCase();
          const discVal = Number(
            validatedCoupon.discount_value !== undefined
              ? validatedCoupon.discount_value
              : (validatedCoupon.discountValue !== undefined ? validatedCoupon.discountValue : (validatedCoupon.discount_amount || 0))
          );
          if (discType === 'PERCENTAGE') {
            discount = Math.round((baseCoursePrice * discVal) / 100);
          } else {
            discount = Math.round(discVal);
          }
          discount = Math.min(baseCoursePrice, Math.max(0, discount));

          // Increment coupon usage count
          try {
            await couponService.incrementUsage(validatedCoupon.id || validatedCoupon.code);
          } catch (incErr) {
            logger.warn('[Manual Enrollment] Failed to increment coupon usage:', incErr.message);
          }
        }
      } catch (cErr) {
        logger.warn('[Manual Enrollment] Coupon check note:', cErr.message);
      }
    }

    const finalAmount = Math.max(0, baseCoursePrice - discount);

    // 5. Authoritative Financial & Installment Mathematics
    let amountPaid = 0;
    let remainingBalance = 0;
    let finalPaymentStatus = 'PAID';
    let finalAccessStatus = 'ACTIVE';
    let firstInstallmentAmount = null;
    let secondInstallmentAmount = null;
    let firstPaidAt = null;
    let secondPaidAt = null;
    let secondDueAt = null;

    const now = new Date();
    const nowIso = now.toISOString();

    if (paymentPlan === 'INSTALLMENT') {
      const inst1 = Math.round(Number(installment1Amount));
      const inst2 = Math.round(Number(installment2Amount));

      if (isNaN(inst1) || inst1 <= 0 || isNaN(inst2) || inst2 <= 0) {
        inFlightManualEnrollmentLocks.delete(lockKey);
        return res.status(400).json({
          status: 'ERROR',
          message: 'Both Installment 1 and Installment 2 amounts must be greater than zero.'
        });
      }

      if (inst1 + inst2 !== finalAmount) {
        inFlightManualEnrollmentLocks.delete(lockKey);
        return res.status(400).json({
          status: 'ERROR',
          message: `Installment amounts must equal final enrollment amount. (Installment 1: ₹${inst1} + Installment 2: ₹${inst2} = ₹${inst1 + inst2}, expected ₹${finalAmount}).`
        });
      }

      firstInstallmentAmount = inst1;
      secondInstallmentAmount = inst2;

      // Authoritative 5-day due date calculated server-side: first payment date + 5 calendar days
      secondDueAt = installmentService.calculateSecondPaymentDueDate(now).toISOString();

      if (installment1Status === 'PAID') {
        amountPaid = inst1;
        remainingBalance = inst2;
        finalPaymentStatus = 'PARTIALLY_PAID';
        finalAccessStatus = 'ACTIVE';
        firstPaidAt = nowIso;
      } else {
        amountPaid = 0;
        remainingBalance = finalAmount;
        finalPaymentStatus = 'PAYMENT_PENDING';
        finalAccessStatus = 'LOCKED';
        firstPaidAt = null;
      }
    } else {
      // FULL PAYMENT
      if (paymentStatus === 'PAID') {
        amountPaid = finalAmount;
        remainingBalance = 0;
        finalPaymentStatus = 'PAID';
        finalAccessStatus = 'ACTIVE';
        firstPaidAt = nowIso;
        secondPaidAt = nowIso;
        secondDueAt = null;
      } else {
        amountPaid = 0;
        remainingBalance = finalAmount;
        finalPaymentStatus = 'PAYMENT_PENDING';
        finalAccessStatus = 'LOCKED';
        firstPaidAt = null;
        secondDueAt = null;
      }
    }

    // 6. Student Account Handling (New vs Existing)
    let studentRecord = null;

    // Check if account already exists
    const { data: existingStudent } = await supabase
      .from('students')
      .select('id, email, full_name, phone, account_status')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, status, enrolled_course')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    if (studentType === 'NEW') {
      if (existingStudent || existingProfile) {
        inFlightManualEnrollmentLocks.delete(lockKey);
        return res.status(400).json({
          status: 'ERROR',
          code: 'ACCOUNT_ALREADY_EXISTS',
          message: `An account already exists with email '${normalizedEmail}'. Please select 'Existing Student' to enroll them.`,
          existingStudent: {
            id: existingStudent?.id || existingProfile?.id,
            name: existingStudent?.full_name || existingProfile?.full_name,
            email: normalizedEmail,
            accountStatus: existingStudent?.account_status || existingProfile?.status
          }
        });
      }

      // Create new student in students table
      const studentDisplayName = (fullName || 'Student').trim();
      const { data: newStudent, error: sCreateErr } = await supabase
        .from('students')
        .insert([{
          email: normalizedEmail,
          full_name: studentDisplayName,
          phone: cleanPhone,
          account_status: 'ACTIVE',
          email_verified: true,
          created_at: nowIso,
          updated_at: nowIso
        }])
        .select()
        .single();

      if (sCreateErr) throw sCreateErr;
      studentRecord = newStudent;

      // Also create matching profile in profiles table
      try {
        await supabase.from('profiles').upsert([{
          id: studentRecord.id,
          email: normalizedEmail,
          full_name: studentDisplayName,
          phone: cleanPhone,
          role: 'STUDENT',
          status: 'Active Online',
          enrolled_course: combinedCourseNames,
          created_at: nowIso,
          updated_at: nowIso
        }], { onConflict: 'email' });
      } catch (pErr) {
        logger.warn('[Manual Enrollment] Profile sync note:', pErr.message);
      }

      // Provision account in Supabase auth.users so student can set password and login seamlessly
      try {
        await supabase.auth.admin.createUser({
          id: studentRecord.id,
          email: normalizedEmail,
          email_confirm: true,
          user_metadata: {
            fullName: studentDisplayName,
            phone: cleanPhone,
            role: 'STUDENT'
          }
        });
      } catch (authCreateErr) {
        // Non-blocking: if user already exists in auth.users
      }
    } else {
      // EXISTING STUDENT
      if (!existingStudent && !existingProfile) {
        inFlightManualEnrollmentLocks.delete(lockKey);
        return res.status(404).json({
          status: 'ERROR',
          code: 'STUDENT_NOT_FOUND',
          message: `No existing student found with email '${normalizedEmail}'.`
        });
      }

      studentRecord = existingStudent || {
        id: existingProfile.id,
        email: existingProfile.email,
        full_name: existingProfile.full_name,
        phone: existingProfile.phone
      };

      // Ensure student is present in students table
      if (!existingStudent) {
        try {
          const { data: sBackfill } = await supabase.from('students').upsert([{
            id: studentRecord.id,
            email: normalizedEmail,
            full_name: studentRecord.full_name || 'Student',
            phone: cleanPhone || studentRecord.phone,
            account_status: 'ACTIVE',
            email_verified: true,
            updated_at: nowIso
          }], { onConflict: 'email' }).select().single();
          if (sBackfill) studentRecord = sBackfill;
        } catch (sErr) {
          // ignore
        }
      }

      // Update enrolled course in profiles if empty
      try {
        await supabase.from('profiles').update({
          enrolled_course: combinedCourseNames,
          status: 'Active Online',
          updated_at: nowIso
        }).eq('id', studentRecord.id);
      } catch (pUpErr) {
        // ignore
      }
    }

    // 7. Duplicate Enrollment Check (Across all selected courses)
    const { data: existingActiveEnrollments } = await supabase
      .from('enrollments')
      .select('id, course_id, course_name, payment_plan, payment_status, course_access_status, amount_paid, amount_pending, total_amount')
      .eq('student_id', studentRecord.id)
      .in('course_id', coursesFound.map(c => c.id));

    if (existingActiveEnrollments && existingActiveEnrollments.length > 0) {
      const dupNames = existingActiveEnrollments.map(e => e.course_name).join(', ');
      inFlightManualEnrollmentLocks.delete(lockKey);
      return res.status(400).json({
        status: 'ERROR',
        code: 'DUPLICATE_ENROLLMENT',
        message: `Student '${studentRecord.full_name || studentRecord.email}' is already enrolled in: ${dupNames}.`,
        enrollment: existingActiveEnrollments[0],
        enrollments: existingActiveEnrollments
      });
    }

    // 8. Create Authoritative Enrollment Records (One per selected course)
    const accessStartTime = nowIso;
    const accessExpiryTime = addCalendarMonths(accessStartTime, 6).toISOString();
    const createdEnrollments = [];

    for (let i = 0; i < coursesFound.length; i++) {
      const c = coursesFound[i];
      const cPrice = Math.max(0, Math.round(Number(c.price || 4000)));
      const propRatio = baseCoursePrice > 0 ? (cPrice / baseCoursePrice) : (1 / coursesFound.length);
      const cTotal = Math.round(finalAmount * propRatio);
      const cPaid = Math.round(amountPaid * propRatio);
      const cPending = Math.max(0, cTotal - cPaid);

      const enrollmentPayload = {
        student_id: studentRecord.id,
        course_id: c.id,
        course_name: c.title,
        total_amount: cTotal,
        amount_paid: cPaid,
        amount_pending: cPending,
        payment_plan: paymentPlan,
        payment_status: finalPaymentStatus,
        course_access_status: finalAccessStatus,
        account_status: 'ACTIVE',
        first_installment_amount: paymentPlan === 'INSTALLMENT' ? Math.round((firstInstallmentAmount || 0) * propRatio) : null,
        second_installment_amount: paymentPlan === 'INSTALLMENT' ? Math.round((secondInstallmentAmount || 0) * propRatio) : null,
        first_installment_paid_at: firstPaidAt,
        second_installment_paid_at: secondPaidAt,
        second_payment_due_at: secondDueAt,
        installment_due_at: secondDueAt,
        access_start_date: accessStartTime,
        access_expiry_date: accessExpiryTime,
        created_at: nowIso,
        updated_at: nowIso
      };

      const { data: newEnrollment, error: enrErr } = await supabase
        .from('enrollments')
        .insert([enrollmentPayload])
        .select()
        .single();

      if (enrErr) {
        inFlightManualEnrollmentLocks.delete(lockKey);
        throw enrErr;
      }
      createdEnrollments.push(newEnrollment);
    }

    // 9. Payment Ledger Entry Creation (Authoritative payments table)
    let paymentRecord = null;
    let txnId = `TXN-MAN-${Date.now().toString().slice(-8)}`;

    if (amountPaid > 0) {
      const couponTag = (validatedCoupon && discount > 0)
        ? ` [Coupon: ${validatedCoupon.code.toUpperCase()} -₹${discount.toLocaleString('en-IN')}]`
        : '';
      const methodWithCoupon = `${paymentMethod || 'Cash'}${couponTag}`;

      const paymentPayload = {
        txn_id: txnId,
        student_name: studentRecord.full_name || fullName || 'Student',
        email: normalizedEmail,
        course_name: combinedCourseNames,
        amount: amountPaid,
        amount_paid: amountPaid,
        total_course_fee: finalAmount,
        remaining_balance: remainingBalance,
        payment_type: paymentPlan,
        method: methodWithCoupon,
        payment_method: methodWithCoupon,
        status: remainingBalance <= 0 ? 'Full Payment Settled' : '1st Installment Settled',
        created_at: nowIso
      };

      const { data: pData, error: pErr } = await supabase
        .from('payments')
        .insert([paymentPayload])
        .select()
        .single();

      if (!pErr && pData) {
        paymentRecord = pData;
      } else if (pErr) {
        logger.warn('[Manual Enrollment] Payment write error:', pErr.message);
      }

      // Also create an order record for complete audit trail
      try {
        for (const enr of createdEnrollments) {
          await supabase.from('orders').insert([{
            order_id: txnId,
            cashfree_order_id: txnId,
            student_id: studentRecord.id,
            course_id: enr.course_id,
            enrollment_id: enr.id,
            amount: enr.amount_paid,
            status: 'PAID',
            installment_number: paymentPlan === 'INSTALLMENT' ? 1 : null
          }]);
        }
      } catch (oErr) {
        logger.warn('[Manual Enrollment] Order record note:', oErr.message);
      }
    }

    // 10. Audit Logging
    try {
      await installmentService.logAuditEvent({
        actorEmail: adminEmail,
        actorRole: 'ADMIN',
        action: 'MANUAL_STUDENT_ENROLLED',
        targetId: createdEnrollments[0]?.id,
        details: {
          admin_id: adminId,
          student_id: studentRecord.id,
          student_email: normalizedEmail,
          course_count: createdEnrollments.length,
          course_names: combinedCourseNames,
          payment_plan: paymentPlan,
          amount_paid: amountPaid,
          remaining_balance: remainingBalance,
          access_status: finalAccessStatus,
          payment_method: paymentMethod,
          coupon_code: validatedCoupon ? validatedCoupon.code.toUpperCase() : null,
          discount_amount: discount,
          txn_id: txnId,
          second_payment_due_at: secondDueAt
        }
      });
    } catch (auditErr) {
      logger.warn('[Manual Enrollment] Audit write note:', auditErr.message);
    }

    // 11. Dispatch In-App Notification
    try {
      await notificationService.sendNotification({
        userId: studentRecord.id,
        title: 'Course Enrollment Confirmed',
        message: `You have been officially enrolled in ${combinedCourseNames} by the academic administration.`,
        channel: 'IN_APP'
      });
    } catch (notifErr) {
      // non-blocking
    }

    // 12. Dispatch Email (Payment Receipt & Portal Access Link)
    let emailSent = false;
    let emailError = null;

    try {
      const formattedDueDate = secondDueAt
        ? new Date(secondDueAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : '5 Days';

      await mailer.sendPaymentReceiptEmail({
        to: normalizedEmail,
        paymentDetails: {
          studentName: studentRecord.full_name || fullName || 'Student',
          email: normalizedEmail,
          mobile: cleanPhone || studentRecord.phone || '',
          courseName: combinedCourseNames,
          amountPaid: amountPaid,
          totalFee: finalAmount,
          remainingBalance: remainingBalance,
          dueDate: formattedDueDate,
          batchStartDate: 'October 1, 2026',
          txnId: txnId
        }
      });
      emailSent = true;
    } catch (mailErr) {
      logger.warn('[Manual Enrollment] Email delivery note:', mailErr.message);
      emailSent = false;
      emailError = mailErr.message || 'SMTP delivery failed';
    }

    // Release in-flight lock
    inFlightManualEnrollmentLocks.delete(lockKey);

    // 13. Return Comprehensive Success Response
    return res.status(201).json({
      status: 'SUCCESS',
      message: `${createdEnrollments.length} course enrollment(s) created successfully!`,
      student: {
        id: studentRecord.id,
        name: studentRecord.full_name || fullName,
        email: normalizedEmail,
        phone: cleanPhone || studentRecord.phone,
        type: studentType
      },
      enrollment: createdEnrollments[0],
      enrollments: createdEnrollments,
      payment: paymentRecord,
      financials: {
        basePrice: baseCoursePrice,
        discount,
        couponCode: validatedCoupon ? validatedCoupon.code.toUpperCase() : null,
        finalAmount,
        amountPaid,
        remainingBalance,
        paymentPlan,
        paymentStatus: finalPaymentStatus,
        accessStatus: finalAccessStatus,
        secondPaymentDueAt: secondDueAt
      },
      emailSent,
      emailError
    });
  } catch (err) {
    inFlightManualEnrollmentLocks.delete(lockKey);
    next(err);
  }
}

/**
 * 4. Retry Enrollment Email Delivery
 * POST /api/admin/students/retry-enrollment-email
 */
async function retryEnrollmentEmail(req, res, next) {
  try {
    const { enrollmentId } = req.body;
    if (!enrollmentId) {
      return res.status(400).json({ status: 'ERROR', message: 'enrollmentId is required.' });
    }

    const { data: enrollment, error } = await supabase
      .from('enrollments')
      .select('*, students(id, full_name, email, phone)')
      .eq('id', enrollmentId)
      .maybeSingle();

    if (error || !enrollment) {
      return res.status(404).json({ status: 'ERROR', message: 'Enrollment record not found.' });
    }

    const student = enrollment.students || {};
    const email = student.email || enrollment.student_email;
    if (!email) {
      return res.status(400).json({ status: 'ERROR', message: 'Student email not associated with enrollment.' });
    }

    const dueDate = enrollment.second_payment_due_at
      ? new Date(enrollment.second_payment_due_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      : '5 Days';

    await mailer.sendPaymentReceiptEmail({
      to: email,
      paymentDetails: {
        studentName: student.full_name || 'Student',
        email,
        mobile: student.phone || '',
        courseName: enrollment.course_name,
        amountPaid: Number(enrollment.amount_paid || 0),
        totalFee: Number(enrollment.total_amount || 0),
        remainingBalance: Number(enrollment.amount_pending || 0),
        dueDate,
        batchStartDate: 'October 1, 2026',
        txnId: `ENR-${enrollment.id.slice(0, 8)}`
      }
    });

    return res.status(200).json({
      status: 'SUCCESS',
      message: `Enrollment confirmation email successfully resent to ${email}.`
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  checkStudentEmail,
  searchExistingStudents,
  createStudentAndEnroll,
  retryEnrollmentEmail
};
