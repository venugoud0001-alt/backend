const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const {
  supabase,
  CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET,
  CASHFREE_ENV,
  CASHFREE_WEBHOOK_URL
} = require('../config/supabase');
const { paymentLimiter } = require('../middleware/rateLimiter');
const { authenticateJWT, requireAdminRole, requirePermission } = require('../middleware/auth');
const couponService = require('../src/modules/coupons/coupon.service');
const pricingService = require('../src/modules/pricing/pricing.service');
const { calculateDiscountedPricing } = require('../src/utils/pricingEngine');
const { getStudentEnrollments } = require('../src/modules/enrollments/studentEnrollment.controller');
const { addCalendarMonths } = require('../src/utils/dateUtils');

// Authoritative Student Enrollments Endpoint
router.get(['/student/enrollments', '/enrollments/my-enrollments'], getStudentEnrollments);

// Cashfree HMAC Signature Verification Helper (Constant-Time Verification)
function verifyCashfreeWebhookSignature(req) {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const secret = CASHFREE_CLIENT_SECRET;

    if (!signature || !timestamp || !secret) {
      return false;
    }

    const rawPayload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const dataToSign = timestamp + rawPayload;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('base64');

    const sigBuffer = Buffer.from(String(signature));
    const expectedBuffer = Buffer.from(String(expectedSignature));

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch (err) {
    console.error("Signature Verification Exception:", err);
    return false;
  }
}

// Authoritative Payment Order Creation
router.post(['/payments/create-enrollment-order', '/payments/create-order'], paymentLimiter, async (req, res, next) => {
  try {
    const { courseId, batchId, paymentPlan = "FULL", couponCode = "", name, email, phone, returnUrl } = req.body;
    const studentName = name || req.body.studentName || "Student";
    const studentEmail = email || req.body.email;

    if (!studentEmail) {
      return res.status(400).json({ status: 'ERROR', message: 'Student email is required for payment checkout.' });
    }

    const normalizedEmail = studentEmail.toLowerCase().trim();
    const cleanPhone = String(phone || '9876543210').replace(/[^0-9]/g, "").slice(-10);

    // Course Lookup with Resilient Catalog Synchronization
    let course = null;
    const requestedCourseName = (req.body.courseName || req.body.course_name || req.body.programTitle || "").trim();
    const isUuid = courseId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(courseId);

    if (isUuid) {
      const { data } = await supabase.from('courses').select('id, title, price, installment_price, status').eq('id', courseId).maybeSingle();
      course = data;
    }

    if (!course && courseId) {
      const { data } = await supabase.from('courses').select('id, title, price, installment_price, status').or(`slug.eq.${courseId},id.eq.${courseId}`).maybeSingle();
      course = data;
    }

    if (!course && requestedCourseName) {
      const { data: allCourses } = await supabase.from('courses').select('id, title, price, installment_price, status');
      if (allCourses && allCourses.length > 0) {
        const reqLower = requestedCourseName.toLowerCase();
        course = allCourses.find(c => {
          const titleLower = (c.title || "").toLowerCase();
          const slugLower = (c.slug || "").toLowerCase();
          return titleLower === reqLower || titleLower.includes(reqLower) || reqLower.includes(titleLower) || slugLower === reqLower;
        });
      }
    }

    if (!course) {
      return res.status(404).json({ status: 'ERROR', message: `Course not found for identifier '${courseId || requestedCourseName}'.` });
    }

    // Authoritative Server-Side Coupon Validation & Pricing Calculation
    let validatedCoupon = null;
    if (couponCode && String(couponCode).trim().length > 0) {
      try {
        const valResult = await couponService.validateCouponForCourse({
          code: couponCode,
          courseId: course.id,
          paymentMode: paymentPlan
        });
        validatedCoupon = valResult.coupon;
      } catch (couponErr) {
        console.warn(`[CHECKOUT] Coupon validation note for '${couponCode}':`, couponErr.message || couponErr);
      }
    }

    // Fetch authoritative pricing plans from pricingService
    const pricingData = await pricingService.getPricingForCourse(course.id).catch((err) => {
      console.warn(`[CHECKOUT] Note fetching pricing for '${course.id}':`, err.message);
      return null;
    });

    const plans = pricingData?.pricingPlans || [];
    const fullPlan = plans.find(p => p.paymentMode === "FULL");
    const installmentPlan = plans.find(p => p.paymentMode === "INSTALLMENT");
    const activePlan = paymentPlan === "INSTALLMENT" ? installmentPlan : fullPlan;
    const activePhases = installmentPlan?.phases || [];

    const pricing = calculateDiscountedPricing({
      course,
      pricingPlan: activePlan ? { total_amount: activePlan.totalAmount } : null,
      installments: activePhases.map(p => ({ amount: p.amount, phase_number: p.phaseNumber })),
      coupon: validatedCoupon,
      paymentMode: paymentPlan
    });

    const totalCoursePrice = pricing.discountedTotal;

    let orderAmount = paymentPlan === "INSTALLMENT"
      ? (pricing.discountedInstallments?.[0]?.amount || pricing.discountedTotal)
      : pricing.discountedTotal;

    orderAmount = Math.round(Number(orderAmount));
    if (isNaN(orderAmount) || orderAmount <= 0) {
      orderAmount = paymentPlan === "INSTALLMENT" ? 1500 : 4000;
    }

    // Batch & Capacity Validation
    let batch = null;
    if (batchId) {
      const { data: batchData } = await supabase.from('batches').select('id, capacity, enrolled_count, status').eq('id', batchId).maybeSingle();
      if (batchData) {
        if (batchData.status === 'CLOSED' || batchData.status === 'FULL' || batchData.enrolled_count >= batchData.capacity) {
          return res.status(400).json({ status: 'ERROR', message: 'Selected batch is full. Please select another batch.' });
        }
        batch = batchData;
      }
    }

    // Student Record
    let { data: student } = await supabase.from('students').select('id, email, full_name, phone, account_status').ilike('email', normalizedEmail).maybeSingle();
    if (!student) {
      const { data: newStudent } = await supabase.from('students').insert([{
        email: normalizedEmail,
        full_name: studentName,
        phone: cleanPhone,
        account_status: "NOT_ACTIVATED",
        email_verified: false
      }]).select().single();
      student = newStudent;
    }

    // Pending Enrollment
    const { data: enrollment, error: enrErr } = await supabase.from('enrollments').insert([{
      student_id: student?.id,
      course_id: course.id,
      course_name: course.title,
      total_amount: totalCoursePrice,
      amount_paid: 0,
      amount_pending: totalCoursePrice,
      payment_plan: paymentPlan,
      payment_status: "PAYMENT_PENDING",
      course_access_status: "LOCKED",
      account_status: "NOT_ACTIVATED"
    }]).select().single();

    if (enrErr) throw enrErr;

    // Internal Order Row
    const orderId = `ENR_${enrollment.id.slice(0, 8)}_${Date.now().toString().slice(-6)}`;
    await supabase.from('orders').insert([{
      order_id: orderId,
      cashfree_order_id: orderId,
      student_id: student?.id,
      course_id: course.id,
      enrollment_id: enrollment.id,
      amount: orderAmount,
      installment_number: 1,
      status: "CREATED"
    }]);

    try {
      await supabase.from('payments').upsert([{
        txn_id: orderId,
        student_name: studentName,
        email: normalizedEmail,
        mobile: cleanPhone,
        course_name: course.title,
        payment_type: paymentPlan,
        amount_paid: orderAmount,
        total_course_fee: totalCoursePrice,
        remaining_balance: Math.max(0, totalCoursePrice - orderAmount),
        batch_start_date: req.body.batchStartDate || "October 1, 2026",
        payment_method: "Cashfree Production Gateway",
        status: paymentPlan === "INSTALLMENT" ? "1st Installment Initiated" : "Full Payment Initiated",
        created_at: new Date().toISOString()
      }], { onConflict: "txn_id" });
    } catch (pmtErr) {
      console.warn("Pre-payment server insert note:", pmtErr.message);
    }

    // Cashfree PG Order API Call
    const isSandbox = CASHFREE_ENV === "SANDBOX";
    const cashfreeEndpoint = isSandbox ? "https://sandbox.cashfree.com/pg/orders" : "https://api.cashfree.com/pg/orders";
    let finalReturnUrl = (returnUrl || `https://internnetra.com/payment-success?order_id={order_id}`).replace(/^http:\/\//i, "https://");

    const payload = {
      order_id: orderId,
      order_amount: orderAmount,
      order_currency: "INR",
      customer_details: {
        customer_id: `cust_${student?.id || Date.now()}`,
        customer_name: studentName,
        customer_email: normalizedEmail,
        customer_phone: cleanPhone,
      },
      order_meta: {
        return_url: finalReturnUrl,
        notify_url: CASHFREE_WEBHOOK_URL,
        total_fee: String(totalCoursePrice),
      },
      order_note: `Enrollment - ${course.title.slice(0, 30)}`,
    };

    const response = await fetch(cashfreeEndpoint, {
      method: "POST",
      headers: {
        "x-api-version": "2023-08-01",
        "x-client-id": CASHFREE_CLIENT_ID,
        "x-client-secret": CASHFREE_CLIENT_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok || !data.payment_session_id) {
      return res.status(400).json({ status: 'ERROR', message: data.message || 'Failed to create Cashfree order.' });
    }

    res.status(200).json({
      status: 'SUCCESS',
      orderId: data.order_id || orderId,
      paymentSessionId: data.payment_session_id,
      amount: orderAmount,
      mode: isSandbox ? "sandbox" : "production",
    });
  } catch (err) {
    next(err);
  }
});

// Create Installment Payment Order (Pay Remaining Balance via Cashfree)
router.post('/payments/create-installment-order', paymentLimiter, async (req, res, next) => {
  try {
    const { email, enrollmentId, courseName, returnUrl } = req.body;
    if (!email) {
      return res.status(400).json({ status: 'ERROR', message: 'Student email is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Locate student record
    let { data: student } = await supabase
      .from('students')
      .select('id, email, full_name, phone')
      .ilike('email', normalizedEmail)
      .maybeSingle();

    // 2. Locate enrollment record
    let enrollment = null;
    if (enrollmentId) {
      const { data, error } = await supabase
        .from('enrollments')
        .select('*')
        .eq('id', enrollmentId)
        .maybeSingle();
      if (!error) enrollment = data;
    }

    if (!enrollment && student) {
      let query = supabase
        .from('enrollments')
        .select('*')
        .eq('student_id', student.id)
        .order('created_at', { ascending: false });

      if (courseName) {
        query = query.ilike('course_name', `%${courseName.trim()}%`);
      }
      const { data } = await query.limit(1).maybeSingle();
      enrollment = data;
    }

    if (!enrollment) {
      return res.status(404).json({
        status: 'ERROR',
        message: 'No enrollment record found for this course and email.',
      });
    }

    // 3. Verify pending balance
    const totalFee = Number(enrollment.total_amount || 0);
    const amountPaid = Number(enrollment.amount_paid || 0);
    const pendingAmount = Number(enrollment.amount_pending ?? (totalFee - amountPaid));

    if (pendingAmount <= 0 || enrollment.payment_status === 'PAID') {
      return res.status(400).json({
        status: 'ERROR',
        message: 'This course enrollment is already fully paid. No pending balance.',
      });
    }

    // 4. Generate unique Cashfree order ID
    const orderId = `INST_${enrollment.id.slice(0, 8)}_${Date.now().toString().slice(-6)}`;

    // 5. Insert order record
    await supabase.from('orders').insert([{
      order_id: orderId,
      cashfree_order_id: orderId,
      student_id: student?.id || enrollment.student_id,
      course_id: enrollment.course_id,
      enrollment_id: enrollment.id,
      amount: pendingAmount,
      installment_number: 2,
      status: 'CREATED',
    }]);

    // 6. Pre-record in payments table
    try {
      await supabase.from('payments').upsert([{
        txn_id: orderId,
        student_name: student?.full_name || 'Student',
        email: normalizedEmail,
        mobile: student?.phone || '9999999999',
        course_name: enrollment.course_name,
        payment_type: 'INSTALLMENT',
        amount_paid: pendingAmount,
        total_course_fee: totalFee,
        remaining_balance: 0,
        payment_method: 'Cashfree Production Gateway',
        status: 'Final Installment Initiated',
        created_at: new Date().toISOString(),
      }], { onConflict: 'txn_id' });
    } catch (pmtErr) {
      console.warn('Pre-payment installment insert note:', pmtErr.message);
    }

    // 7. Create Cashfree Order
    const isSandbox = CASHFREE_ENV === 'SANDBOX';
    const cashfreeEndpoint = isSandbox
      ? 'https://sandbox.cashfree.com/pg/orders'
      : 'https://api.cashfree.com/pg/orders';

    const cleanPhone = (student?.phone || '9999999999').replace(/[^0-9]/g, '').slice(-10);
    let finalReturnUrl = (returnUrl || `https://internnetra.com/payment-success?order_id={order_id}`).replace(/^http:\/\//i, 'https://');

    const payload = {
      order_id: orderId,
      order_amount: pendingAmount,
      order_currency: 'INR',
      customer_details: {
        customer_id: `cust_${student?.id || enrollment.student_id || Date.now()}`,
        customer_name: student?.full_name || 'Student',
        customer_email: normalizedEmail,
        customer_phone: cleanPhone || '9999999999',
      },
      order_meta: {
        return_url: finalReturnUrl,
        notify_url: CASHFREE_WEBHOOK_URL,
        total_fee: String(totalFee),
      },
      order_note: `Final Installment - ${(enrollment.course_name || 'Program').slice(0, 30)}`,
    };

    const response = await fetch(cashfreeEndpoint, {
      method: 'POST',
      headers: {
        'x-api-version': '2023-08-01',
        'x-client-id': CASHFREE_CLIENT_ID,
        'x-client-secret': CASHFREE_CLIENT_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok || !data.payment_session_id) {
      return res.status(400).json({
        status: 'ERROR',
        message: data.message || 'Failed to create Cashfree installment order.',
      });
    }

    res.status(200).json({
      status: 'SUCCESS',
      orderId: data.order_id || orderId,
      paymentSessionId: data.payment_session_id,
      amount: pendingAmount,
      courseName: enrollment.course_name,
      mode: isSandbox ? 'sandbox' : 'production',
    });
  } catch (err) {
    next(err);
  }
});

// Order Status Verification Endpoint
router.post(['/payments/verify-order', '/payments/verify'], async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ status: 'ERROR', message: 'orderId is required.' });
    }

    const isSandbox = CASHFREE_ENV === "SANDBOX";
    const verifyApiUrl = isSandbox
      ? `https://sandbox.cashfree.com/pg/orders/${orderId}`
      : `https://api.cashfree.com/pg/orders/${orderId}`;

    const cfVerifyRes = await fetch(verifyApiUrl, {
      method: "GET",
      headers: {
        "x-api-version": "2023-08-01",
        "x-client-id": CASHFREE_CLIENT_ID,
        "x-client-secret": CASHFREE_CLIENT_SECRET,
      },
    });

    const cfOrderData = await cfVerifyRes.json();
    if (!cfVerifyRes.ok) {
      return res.status(200).json({
        status: 'SUCCESS',
        isPaid: false,
        orderStatus: 'UNPAID',
        data: null
      });
    }

    const isPaid = cfOrderData.order_status === "PAID";

    let matchedOrder = null;
    let matchedEnrollment = null;
    let amountPaid = Number(cfOrderData.order_amount) || 0;
    let totalFee = 0;
    let remainingBal = 0;
    let isFullPaid = false;

    try {
      const { data: ord } = await supabase
        .from("orders")
        .select("enrollment_id, installment_number, amount")
        .or(`cashfree_order_id.eq.${orderId},order_id.eq.${orderId}`)
        .maybeSingle();

      matchedOrder = ord;
      if (matchedOrder?.enrollment_id) {
        const { data: enr } = await supabase.from("enrollments").select("*").eq("id", matchedOrder.enrollment_id).maybeSingle();
        matchedEnrollment = enr;
      }
    } catch (lookupErr) {
      console.warn("Order lookup note:", lookupErr.message);
    }

    if (matchedEnrollment) {
      totalFee = Number(matchedEnrollment.total_amount) || totalFee;
      remainingBal = matchedEnrollment.amount_pending !== undefined ? Number(matchedEnrollment.amount_pending) : Math.max(0, totalFee - amountPaid);
      isFullPaid = matchedEnrollment.payment_status === "PAID" || (remainingBal <= 0 && matchedEnrollment.payment_plan !== "INSTALLMENT");
    } else {
      totalFee = Number(cfOrderData.order_meta?.total_fee) || (amountPaid > 1500 ? amountPaid : 4000);
      remainingBal = Math.max(0, totalFee - amountPaid);
      isFullPaid = remainingBal <= 0;
    }

    if (isPaid) {
      try {
        const customer = cfOrderData.customer_details || {};
        const studentEmail = (customer.customer_email || "").toLowerCase().trim();
        const studentName = customer.customer_name || "Enrolled Student";
        const studentPhone = customer.customer_phone || "";
        const courseName = (cfOrderData.order_note || "").replace("Enrollment - ", "").replace("Registration Token - ", "") || matchedEnrollment?.course_name || "Live Program";
        const txnId = cfOrderData.cf_order_id ? String(cfOrderData.cf_order_id) : `CF_${orderId}`;

        // Ensure order is recorded as PAID first
        await supabase.from("orders").update({
          status: "PAID",
          amount: amountPaid
        }).eq("cashfree_order_id", orderId);

        if (matchedEnrollment) {
          // Authoritatively compute cumulative paid amount from all PAID orders for this enrollment
          const { data: allPaidOrders } = await supabase
            .from("orders")
            .select("amount")
            .eq("enrollment_id", matchedEnrollment.id)
            .eq("status", "PAID");

          let actualSumPaid = 0;
          if (Array.isArray(allPaidOrders) && allPaidOrders.length > 0) {
            actualSumPaid = allPaidOrders.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
          } else {
            actualSumPaid = amountPaid;
          }

          // Accounting Invariant: amount_paid can never exceed totalFee
          const cumPaid = Math.min(totalFee, actualSumPaid);
          remainingBal = Math.max(0, totalFee - cumPaid);
          isFullPaid = remainingBal <= 0;

          matchedEnrollment.amount_paid = cumPaid;
          matchedEnrollment.amount_pending = remainingBal;
          matchedEnrollment.payment_status = isFullPaid ? "PAID" : "PARTIALLY_PAID";
        }

        await supabase.from("payments").upsert([{
          txn_id: txnId,
          student_name: studentName,
          email: studentEmail,
          mobile: studentPhone,
          course_name: courseName,
          payment_type: isFullPaid ? "FULL" : "INSTALLMENT",
          amount_paid: amountPaid,
          total_course_fee: totalFee,
          remaining_balance: remainingBal,
          payment_method: "Cashfree PG",
          status: isFullPaid ? "Full Payment Settled" : `1st Installment Settled (Balance ₹${remainingBal.toLocaleString()} Due)`,
          created_at: new Date().toISOString()
        }], { onConflict: "txn_id" });

        if (matchedOrder?.enrollment_id) {
          const nowIso = new Date().toISOString();
          const expiryIso = addCalendarMonths(nowIso, 6).toISOString();

          await supabase.from("enrollments").update({
            payment_status: isFullPaid ? "PAID" : "PARTIALLY_PAID",
            amount_paid: matchedEnrollment.amount_paid,
            amount_pending: remainingBal,
            course_access_status: "UNLOCKED",
            account_status: "ACTIVE",
            access_start_date: nowIso,
            access_expiry_date: expiryIso,
            updated_at: nowIso
          }).eq("id", matchedOrder.enrollment_id);
        }
      } catch (syncErr) {
        console.warn("Auto-sync Cashfree payment note:", syncErr.message);
      }
    }

    res.status(200).json({
      status: 'SUCCESS',
      isPaid,
      orderStatus: cfOrderData.order_status,
      data: {
        ...cfOrderData,
        order_meta: {
          ...(cfOrderData.order_meta || {}),
          total_fee: totalFee,
          remaining_balance: remainingBal,
          payment_plan: matchedEnrollment?.payment_plan || (isFullPaid ? "FULL" : "INSTALLMENT"),
        },
      },
      enrollment: matchedEnrollment ? {
        id: matchedEnrollment.id,
        course_name: matchedEnrollment.course_name,
        total_amount: totalFee,
        amount_paid: matchedEnrollment.amount_paid || amountPaid,
        amount_pending: remainingBal,
        payment_plan: matchedEnrollment.payment_plan || (isFullPaid ? "FULL" : "INSTALLMENT"),
        payment_status: matchedEnrollment.payment_status || (isFullPaid ? "PAID" : "PARTIALLY_PAID"),
      } : null,
    });
  } catch (err) {
    next(err);
  }
});

// Admin Sync Specific Order
router.post(['/payments/sync-order', '/admin/sync-order'], authenticateJWT, requireAdminRole, async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ status: 'ERROR', message: 'orderId is required.' });
    }

    const isSandbox = CASHFREE_ENV === "SANDBOX";
    const verifyApiUrl = isSandbox
      ? `https://sandbox.cashfree.com/pg/orders/${orderId}`
      : `https://api.cashfree.com/pg/orders/${orderId}`;

    const cfVerifyRes = await fetch(verifyApiUrl, {
      method: "GET",
      headers: {
        "x-api-version": "2023-08-01",
        "x-client-id": CASHFREE_CLIENT_ID,
        "x-client-secret": CASHFREE_CLIENT_SECRET,
      },
    });

    const cfOrderData = await cfVerifyRes.json();
    if (!cfVerifyRes.ok) {
      return res.status(400).json({ status: 'ERROR', message: cfOrderData.message || 'Order not found in Cashfree.' });
    }

    const customer = cfOrderData.customer_details || {};
    let studentEmail = (customer.customer_email || "").toLowerCase().trim();
    let studentName = customer.customer_name || "";
    let studentPhone = customer.customer_phone || "";
    let courseName = (cfOrderData.order_note || "").replace("Enrollment - ", "").replace("Registration Token - ", "").trim();

    try {
      const { data: existingPreOrder } = await supabase
        .from("payments")
        .select("student_name, email, mobile, course_name")
        .eq("txn_id", String(orderId))
        .maybeSingle();

      if (existingPreOrder) {
        if (!studentName && existingPreOrder.student_name) studentName = existingPreOrder.student_name;
        if (!studentEmail && existingPreOrder.email) studentEmail = existingPreOrder.email;
        if (!studentPhone && existingPreOrder.mobile) studentPhone = existingPreOrder.mobile;
        if (!courseName && existingPreOrder.course_name) courseName = existingPreOrder.course_name;
      }
    } catch (dbLookupErr) {
      console.warn("Sync order db lookup note:", dbLookupErr.message);
    }

    const amountPaid = Number(cfOrderData.order_amount) || 0;
    const totalFee = Number(cfOrderData.order_meta?.total_fee || amountPaid) || amountPaid;
    const remainingBal = Math.max(0, totalFee - amountPaid);
    const isPaid = cfOrderData.order_status === "PAID";

    const { data: pmtData, error: pmtErr } = await supabase.from("payments").upsert([{
      txn_id: orderId,
      student_name: studentName || "Student",
      email: studentEmail || "",
      mobile: studentPhone || "",
      course_name: courseName || "Enrolled Program",
      payment_type: remainingBal <= 0 ? "FULL" : "INSTALLMENT",
      amount_paid: isPaid ? amountPaid : 0,
      total_course_fee: totalFee,
      remaining_balance: remainingBal,
      payment_method: "Cashfree PG",
      status: isPaid ? (remainingBal <= 0 ? "Full Payment Settled" : "1st Installment Settled") : "Payment Initiated",
      created_at: new Date().toISOString()
    }], { onConflict: "txn_id" }).select().single();

    if (pmtErr) throw pmtErr;

    res.status(200).json({
      status: 'SUCCESS',
      message: `Order ${orderId} synced to database successfully!`,
      data: pmtData
    });
  } catch (err) {
    next(err);
  }
});

// Admin Payment Ledger
router.get(['/admin/payments', '/payments/admin-ledger'], authenticateJWT, requirePermission('payment.view'), async (req, res, next) => {
  try {
    const { data: paymentsData } = await supabase.from('payments').select('*').order('created_at', { ascending: false });
    const { data: ordersData } = await supabase.from('orders').select('*').order('created_at', { ascending: false });
    const { data: enrollmentsData } = await supabase.from('enrollments').select('*, students(full_name, email, phone)').order('updated_at', { ascending: false });

    res.status(200).json({
      status: 'SUCCESS',
      payments: paymentsData || [],
      orders: ordersData || [],
      enrollments: enrollmentsData || []
    });
  } catch (err) {
    next(err);
  }
});

// Admin Payment Ledger Export
router.get('/admin/payments/export', authenticateJWT, requirePermission('payment.export'), async (req, res, next) => {
  try {
    const { data: paymentsData } = await supabase.from('payments').select('*').order('created_at', { ascending: false });
    res.status(200).json({
      status: 'SUCCESS',
      message: 'Export generated.',
      count: (paymentsData || []).length,
      data: paymentsData || []
    });
  } catch (err) {
    next(err);
  }
});

// Backend Payment Reconciliation Endpoint
router.post('/payments/reconcile-order', authenticateJWT, paymentLimiter, async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ status: 'ERROR', message: 'orderId is required for reconciliation.' });
    }

    const { data: internalOrder } = await supabase
      .from('orders')
      .select('order_id, cashfree_order_id, student_id, course_id, enrollment_id, amount, status')
      .eq('cashfree_order_id', orderId)
      .maybeSingle();

    if (!internalOrder) {
      return res.status(404).json({ status: 'ERROR', message: 'Order not found in database.' });
    }

    const isSandbox = CASHFREE_ENV === "SANDBOX";
    const verifyApiUrl = isSandbox
      ? `https://sandbox.cashfree.com/pg/orders/${orderId}`
      : `https://api.cashfree.com/pg/orders/${orderId}`;

    const cfVerifyRes = await fetch(verifyApiUrl, {
      method: "GET",
      headers: {
        "x-api-version": "2023-08-01",
        "x-client-id": CASHFREE_CLIENT_ID,
        "x-client-secret": CASHFREE_CLIENT_SECRET,
      },
    });

    const cfOrderData = await cfVerifyRes.json();
    if (!cfVerifyRes.ok) {
      return res.status(400).json({ status: 'ERROR', message: cfOrderData.message || 'Failed to verify Cashfree order.' });
    }

    if (cfOrderData.order_status !== "PAID") {
      return res.status(200).json({ status: 'UNPAID', message: `Cashfree order status is ${cfOrderData.order_status}`, cfStatus: cfOrderData.order_status });
    }

    const customerObj = cfOrderData.customer_details || {};
    let email = (customerObj.customer_email || req.user?.email || '').toLowerCase().trim();
    let studentName = customerObj.customer_name || '';

    try {
      const { data: existingPreOrder } = await supabase
        .from("payments")
        .select("student_name, email")
        .eq("txn_id", String(orderId))
        .maybeSingle();

      if (existingPreOrder) {
        if (!studentName && existingPreOrder.student_name) studentName = existingPreOrder.student_name;
        if (!email && existingPreOrder.email) email = existingPreOrder.email;
      }
    } catch (lookupErr) {
      console.warn("Reconcile lookup note:", lookupErr.message);
    }

    if (!studentName) studentName = "Student";
    if (!email) email = "";

    const amountPaid = Number(cfOrderData.order_amount) || Number(internalOrder.amount);
    const cashfreePaymentId = cfOrderData.cf_order_id ? String(cfOrderData.cf_order_id) : `CF_RECON_${orderId}`;

    const { data: rpcResult, error: rpcError } = await supabase.rpc('process_payment_webhook', {
      p_cashfree_order_id: String(orderId),
      p_cashfree_payment_id: String(cashfreePaymentId),
      p_student_name: String(studentName),
      p_email: String(email),
      p_amount_paid: Number(amountPaid)
    });

    if (rpcError) {
      return res.status(500).json({ status: 'ERROR', message: rpcError.message });
    }

    res.status(200).json({
      status: 'SUCCESS',
      reconciled: true,
      orderStatus: 'PAID',
      result: rpcResult
    });
  } catch (err) {
    next(err);
  }
});

// Cashfree Webhook Handler
router.post('/webhooks/cashfree', async (req, res) => {
  try {
    const webhookData = req.body?.data || req.body;
    const eventType = req.body?.type || req.body?.event || req.body?.data?.event || "PAYMENT_SUCCESS";

    // Allow explicit sandbox test webhook simulation only when in non-production mode
    if ((eventType === "TEST_WEBHOOK" || req.body?.test === true || req.body?.data?.order?.order_id === "test_order") && (CASHFREE_ENV === "SANDBOX" || process.env.NODE_ENV !== 'production')) {
      return res.status(200).json({ status: 'SUCCESS', message: 'Test webhook verified.' });
    }

    // Enforce mandatory HMAC signature verification
    const isSignatureValid = verifyCashfreeWebhookSignature(req);
    if (!isSignatureValid) {
      return res.status(401).json({ status: 'ERROR', message: 'Missing or invalid HMAC webhook signature.' });
    }

    const cashfreeOrderId = webhookData?.order?.order_id || webhookData?.payment?.order_id || webhookData?.order_id;
    const cashfreePaymentId = webhookData?.payment?.cf_payment_id || webhookData?.payment_id || cashfreeOrderId;

    if (!cashfreeOrderId) {
      return res.status(200).json({ status: 'SUCCESS', message: 'Webhook received.' });
    }

    const isSandbox = CASHFREE_ENV === "SANDBOX";
    const verifyApiUrl = isSandbox
      ? `https://sandbox.cashfree.com/pg/orders/${cashfreeOrderId}`
      : `https://api.cashfree.com/pg/orders/${cashfreeOrderId}`;

    const cfVerifyRes = await fetch(verifyApiUrl, {
      method: "GET",
      headers: {
        "x-api-version": "2023-08-01",
        "x-client-id": CASHFREE_CLIENT_ID,
        "x-client-secret": CASHFREE_CLIENT_SECRET,
      },
    });

    const cfOrderData = await cfVerifyRes.json();
    if (!cfVerifyRes.ok || cfOrderData.order_status !== "PAID") {
      return res.status(200).json({ status: 'IGNORED', message: `Order status is ${cfOrderData?.order_status}` });
    }

    const customerObj = cfOrderData.customer_details || {};
    let email = (customerObj.customer_email || '').toLowerCase().trim();
    let studentName = customerObj.customer_name || '';
    let mobile = customerObj.customer_phone || '';
    let courseTitle = (cfOrderData.order_note || "").replace("Enrollment - ", "").replace("Registration Token - ", "").trim();
    const amountPaid = Number(cfOrderData.order_amount) || 0;

    try {
      const { data: existingPreOrder } = await supabase
        .from("payments")
        .select("student_name, email, mobile, course_name")
        .eq("txn_id", String(cashfreeOrderId))
        .maybeSingle();

      if (existingPreOrder) {
        if (!studentName && existingPreOrder.student_name) studentName = existingPreOrder.student_name;
        if (!email && existingPreOrder.email) email = existingPreOrder.email;
        if (!mobile && existingPreOrder.mobile) mobile = existingPreOrder.mobile;
        if (!courseTitle && existingPreOrder.course_name) courseTitle = existingPreOrder.course_name;
      }
    } catch (lookupErr) {
      console.warn("Pre-order lookup note:", lookupErr.message);
    }

    if (!studentName) studentName = "Enrolled Student";
    if (!email) email = "student@internnetra.com";
    if (!courseTitle) courseTitle = "Live Program";

    try {
      const totalFee = Number(cfOrderData.order_meta?.total_fee || amountPaid) || amountPaid;
      const remainingBal = Math.max(0, totalFee - amountPaid);

      await supabase.from("payments").upsert([{
        txn_id: String(cashfreeOrderId),
        cashfree_payment_id: String(cashfreePaymentId),
        student_name: studentName,
        email: email,
        mobile: mobile,
        course_name: courseTitle,
        amount_paid: amountPaid,
        total_course_fee: totalFee,
        remaining_balance: remainingBal,
        payment_type: remainingBal <= 0 ? "FULL" : "INSTALLMENT",
        payment_method: "Cashfree PG",
        status: remainingBal <= 0 ? "Full Payment Settled" : "1st Installment Settled",
        created_at: new Date().toISOString()
      }], { onConflict: "txn_id" });

      await supabase.from("orders").update({ status: "PAID", amount: amountPaid }).eq("cashfree_order_id", cashfreeOrderId);
    } catch (syncErr) {
      console.warn("Unconditional webhook sync note:", syncErr.message);
    }

    const { data: rpcResult, error: rpcError } = await supabase.rpc('process_payment_webhook', {
      p_cashfree_order_id: String(cashfreeOrderId),
      p_cashfree_payment_id: String(cashfreePaymentId),
      p_student_name: String(studentName),
      p_email: String(email),
      p_amount_paid: Number(amountPaid)
    });

    if (rpcError) {
      console.warn("RPC Payment Webhook Exception, falling back to query handler:", rpcError.message);
      const { data: existingPayment } = await supabase
        .from('payments')
        .select('id')
        .eq('cashfree_payment_id', String(cashfreePaymentId))
        .maybeSingle();

      if (existingPayment) {
        return res.status(200).json({ status: 'SUCCESS', message: 'Idempotent request.' });
      }

      const { data: internalOrder } = await supabase
        .from('orders')
        .select('order_id, cashfree_order_id, student_id, course_id, enrollment_id, amount, status')
        .eq('cashfree_order_id', cashfreeOrderId)
        .maybeSingle();

      let enrollment = null;
      if (internalOrder?.enrollment_id) {
        const { data } = await supabase.from('enrollments').select('id, student_id, course_id, course_name, total_amount, amount_paid, amount_pending, payment_plan, payment_status, course_access_status, batch_id').eq('id', internalOrder.enrollment_id).maybeSingle();
        enrollment = data;
      } else {
        const { data } = await supabase.from('enrollments').select('id, student_id, course_id, course_name, total_amount, amount_paid, amount_pending, payment_plan, payment_status, course_access_status, batch_id').ilike('email', email).maybeSingle();
        enrollment = data;
      }

      if (!enrollment) {
        return res.status(400).json({ status: 'ERROR', message: 'Enrollment record not found.' });
      }

      const totalFee = Number(enrollment.total_amount);
      const currentPaid = Number(enrollment.amount_paid || 0);
      const newAmountPaid = currentPaid + amountPaid;
      const newAmountPending = Math.max(0, totalFee - newAmountPaid);
      const isFullPayment = newAmountPending <= 0;
      const newPaymentStatus = isFullPayment ? 'PAID' : 'PARTIALLY_PAID';

      await supabase.from('payments').insert([{
        cashfree_order_id: cashfreeOrderId,
        cashfree_payment_id: String(cashfreePaymentId),
        txn_id: String(cashfreePaymentId),
        student_name: studentName,
        email: email,
        course_name: enrollment.course_name,
        amount: amountPaid,
        amount_paid: amountPaid,
        total_course_fee: totalFee,
        remaining_balance: newAmountPending,
        payment_type: isFullPayment ? 'FULL' : 'INSTALLMENT',
        payment_method: 'Cashfree PG',
        status: 'SUCCESS'
      }]);

      const accessStartTime = new Date().toISOString();
      const accessExpiryTime = addCalendarMonths(accessStartTime, 6).toISOString();

      await supabase.from('enrollments').update({
        amount_paid: newAmountPaid,
        amount_pending: newAmountPending,
        payment_status: newPaymentStatus,
        course_access_status: isFullPayment ? 'ACTIVE' : 'PARTIAL',
        access_start_date: accessStartTime,
        access_expiry_date: accessExpiryTime,
        updated_at: new Date().toISOString()
      }).eq('id', enrollment.id).neq('payment_status', 'PAID');

      if (enrollment.batch_id) {
        await supabase.rpc('increment_batch_enrolled_count', { p_batch_id: enrollment.batch_id });
      }

      return res.status(200).json({ status: 'SUCCESS', orderId: cashfreeOrderId, paymentId: cashfreePaymentId });
    }

    if (rpcResult?.status === 'IDEMPOTENT') {
      return res.status(200).json({ status: 'SUCCESS', message: 'Idempotent request.', result: rpcResult });
    }

    res.status(200).json({ status: 'SUCCESS', orderId: cashfreeOrderId, paymentId: cashfreePaymentId, result: rpcResult });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', message: 'Webhook processing exception.' });
  }
});

module.exports = router;
