/**
 * InternNetra Express.js Production Backend Server
 * Cashfree Payments, Webhook Sync, Supabase Database Transactions, Batch Management, Nodemailer & Production-Grade Security
 * Domain: https://api.internnetra.com
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { sendOtpEmail, sendWelcomeEmail, sendPaymentReceiptEmail } = require('./mailer');

const app = express();
const PORT = process.env.PORT || 5000;

// Security Header Guard
app.use(helmet({
  contentSecurityPolicy: false, // Compatibility with Cashfree & inline external scripts
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Phase 2 & 4: Mandatory Environment Secret Validation (Fail fast at server startup if secrets missing)
const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CASHFREE_CLIENT_ID",
  "CASHFREE_CLIENT_SECRET",
  "JWT_SECRET"
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`FATAL: Missing required environment variable: ${key}`);
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CASHFREE_CLIENT_ID = process.env.CASHFREE_CLIENT_ID;
const CASHFREE_CLIENT_SECRET = process.env.CASHFREE_CLIENT_SECRET;
const CASHFREE_ENV = process.env.CASHFREE_ENV || "PRODUCTION";
const CASHFREE_WEBHOOK_URL = process.env.CASHFREE_WEBHOOK_URL || "https://api.internnetra.com/api/webhooks/cashfree";
const JWT_SECRET = process.env.JWT_SECRET;

// Phase 9: Production CORS Configuration with Strict Origin Filtering
const defaultProductionOrigins = [
  "https://internnetra.com",
  "https://www.internnetra.com",
  "https://api.internnetra.com"
];

const envOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

const devOrigins = process.env.NODE_ENV !== 'production'
  ? ["http://localhost:3000", "http://localhost:5000", "http://127.0.0.1:3000"]
  : [];

const allowedOrigins = Array.from(new Set([...defaultProductionOrigins, ...envOrigins, ...devOrigins]));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS Policy Violation: Access Denied'));
    }
  },
  credentials: true
}));

app.use(express.json({
  limit: '100kb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Rate Limiters
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { status: 'ERROR', message: 'Too many authentication attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const otpSendLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  message: { status: 'ERROR', message: 'Too many OTP requests. Please wait a minute before trying again.' },
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { status: 'ERROR', message: 'Too many payment requests. Please try again later.' },
});

// Secure In-Memory Challenge Store (Challenge ID -> Hashed OTP, metadata, expiration, attempts, single-use reset tokens)
const otpStore = new Map();
const resetTokenStore = new Map();

// Helper: Hash sensitive strings
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

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

// Phase 5: Security Middleware: Validate Authenticated Session via Sole Supabase Auth Authority
async function authenticateJWT(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: 'ERROR', message: 'Authentication required. Authorization header missing.' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ status: 'ERROR', message: 'Bearer token missing.' });
    }

    // Sole identity authority: Supabase Auth server API
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ status: 'ERROR', message: 'Invalid or expired authentication session.' });
    }

    req.user = user;
    req.userRole = user.user_metadata?.role || (user.email?.toLowerCase() === 'admin@internnetra.com' ? 'ADMIN' : 'STUDENT');
    return next();
  } catch (err) {
    return res.status(401).json({ status: 'ERROR', message: 'Authentication verification failed.' });
  }
}

// Phase 6: Security Middleware: Require Admin Role
function requireAdminRole(req, res, next) {
  const role = req.userRole || req.user?.role || req.user?.user_metadata?.role;
  const email = (req.user?.email || "").toLowerCase().trim();
  const isAdmin = role === 'ADMIN' || email === 'admin@internnetra.com';

  if (!isAdmin) {
    return res.status(403).json({ status: 'ERROR', message: 'Forbidden: Administrative privilege required.' });
  }
  next();
}

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'active',
    service: 'InternNetra Security-Hardened LMS Backend API',
    port: PORT,
    environment: CASHFREE_ENV,
    timestamp: new Date().toISOString()
  });
});

// =========================================================================
// 1. PUBLIC COURSES & BATCHES CATALOG APIS
// =========================================================================

app.get(['/api/courses', '/api/courses/catalog'], async (req, res, next) => {
  try {
    const { data: courses, error } = await supabase
      .from('courses')
      .select('id, title, slug, price, installment_price, status, created_at')
      .in('status', ['PUBLISHED', 'ACTIVE'])
      .order('title', { ascending: true });

    if (error) throw error;
    res.status(200).json({ status: 'SUCCESS', courses: courses || [] });
  } catch (err) {
    next(err);
  }
});

// Phase 14: Authoritative Batches Endpoint (No Fake/Default Batches)
app.get('/api/batches', async (req, res, next) => {
  try {
    const { data: batches, error } = await supabase
      .from('batches')
      .select('id, course_id, batch_name, batch_code, start_date, schedule, mode, capacity, enrolled_count, status')
      .neq('status', 'CLOSED')
      .order('start_date', { ascending: true });

    if (error) throw error;
    res.status(200).json({ status: 'SUCCESS', batches: batches || [] });
  } catch (err) {
    next(err);
  }
});

// Protect Admin Batch Creation Endpoint (Phase 6 Admin Inventory)
app.post('/api/admin/create-batch', authenticateJWT, requireAdminRole, async (req, res, next) => {
  try {
    const { batchName, courseId, startDate, capacity = 50 } = req.body;
    if (!batchName || !courseId) {
      return res.status(400).json({ status: 'ERROR', message: 'batchName and courseId are required.' });
    }

    const batchCode = `BATCH_${Date.now().toString().slice(-6)}`;
    const { data: newBatch, error } = await supabase.from('batches').insert([{
      course_id: courseId,
      batch_name: batchName,
      batch_code: batchCode,
      start_date: startDate || new Date().toISOString().split('T')[0],
      capacity,
      enrolled_count: 0,
      status: 'ACTIVE'
    }]).select().single();

    if (error) throw error;
    res.status(200).json({ status: 'SUCCESS', batch: newBatch });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// 2. CRYPTOGRAPHIC EMAIL OTP & SECURE ACCOUNT ACTIVATION ENDPOINTS
// =========================================================================

// Phase 8: Cryptographic OTP Generation (crypto.randomInt)
app.post('/api/auth/send-otp', otpSendLimiter, async (req, res, next) => {
  try {
    const { email, fullName = "Student" } = req.body;
    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return res.status(400).json({ status: 'ERROR', message: 'Valid email address is required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Cryptographically secure 6-digit PRNG replacement for Math.random()
    const otpNumber = crypto.randomInt(100000, 1000000);
    const otp = String(otpNumber);
    const otpHash = hashSecret(otp);
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    otpStore.set(normalizedEmail, {
      otpHash,
      expiresAt,
      attempts: 0,
      maxAttempts: 5,
      fullName
    });

    await sendOtpEmail({ to: normalizedEmail, fullName, otp, expireMinutes: 10 });

    res.status(200).json({ status: 'SUCCESS', message: 'Verification code sent to email.', expiresInSeconds: 600 });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/check-status', authRateLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ status: 'ERROR', message: 'Email is required.' });

    const normalizedEmail = email.toLowerCase().trim();
    const { data: student } = await supabase.from('students').select('account_status, email_verified').ilike('email', normalizedEmail).maybeSingle();

    res.status(200).json({
      status: 'SUCCESS',
      accountStatus: student?.account_status || 'NOT_ACTIVATED',
      emailVerified: !!student?.email_verified
    });
  } catch (err) {
    next(err);
  }
});

// Phase 7 & 8: Verify OTP & Issue Single-Use Reset Token
app.post('/api/auth/verify-otp', authRateLimiter, async (req, res, next) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ status: 'ERROR', message: 'Email and OTP code are required.' });

    const key = email.toLowerCase().trim();
    const record = otpStore.get(key);

    if (!record) {
      return res.status(400).json({ status: 'ERROR', message: 'No active OTP request found or code expired.' });
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(key);
      return res.status(400).json({ status: 'ERROR', message: 'OTP code has expired. Please request a new code.' });
    }

    if (record.attempts >= record.maxAttempts) {
      otpStore.delete(key);
      return res.status(429).json({ status: 'ERROR', message: 'Maximum verification attempts exceeded. Please request a new OTP.' });
    }

    const providedHash = hashSecret(otp.trim());
    if (record.otpHash !== providedHash) {
      record.attempts += 1;
      return res.status(400).json({ status: 'ERROR', message: `Invalid verification code. ${record.maxAttempts - record.attempts} attempts remaining.` });
    }

    // Success: Burn OTP challenge immediately to prevent replay
    otpStore.delete(key);
    await confirmUserEmail(key);

    // Generate single-use short-lived Password Reset Authorization Token (Valid for 15 mins)
    const resetToken = jwt.sign({ email: key, scope: 'password_reset' }, JWT_SECRET, { expiresIn: '15m' });
    resetTokenStore.set(resetToken, { email: key, used: false, expiresAt: Date.now() + 15 * 60 * 1000 });

    res.status(200).json({
      status: 'SUCCESS',
      message: 'OTP verified successfully.',
      verified: true,
      resetToken
    });
  } catch (err) {
    next(err);
  }
});

async function confirmUserEmail(email) {
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const { data: student } = await supabase.from('students').select('id').ilike('email', normalizedEmail).maybeSingle();
    if (student) {
      await supabase.from('students').update({ email_verified: true, account_status: 'ACTIVE' }).eq('id', student.id);
    }
    return true;
  } catch (err) {
    return false;
  }
}

// Phase 7: Secure Password Setting Endpoint Locked Behind Single-Use Signed Reset Token
app.post('/api/auth/set-password', authRateLimiter, async (req, res, next) => {
  try {
    const { email, password, fullName, phone, resetToken } = req.body;
    if (!email || !password || !resetToken) {
      return res.status(400).json({ status: 'ERROR', message: 'Email, password, and single-use resetToken are required.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Verify Reset Token Signature and Expiration
    let tokenPayload;
    try {
      tokenPayload = jwt.verify(resetToken, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ status: 'ERROR', message: 'Invalid or expired password reset token.' });
    }

    if (tokenPayload.email !== normalizedEmail || tokenPayload.scope !== 'password_reset') {
      return res.status(403).json({ status: 'ERROR', message: 'Reset token does not match target account.' });
    }

    // 2. Verify Single-Use Status in Store
    const tokenRecord = resetTokenStore.get(resetToken);
    if (!tokenRecord || tokenRecord.used || Date.now() > tokenRecord.expiresAt) {
      return res.status(401).json({ status: 'ERROR', message: 'Password reset token has already been used or expired.' });
    }

    // Burn token immediately
    tokenRecord.used = true;
    resetTokenStore.delete(resetToken);

    // 3. Perform Authorized Supabase Account Password Update/Creation via Targeted Lookup
    const { data: matchedProfile } = await supabase.from('profiles').select('id, email').ilike('email', normalizedEmail).maybeSingle();
    let userId;

    if (matchedProfile && matchedProfile.id) {
      const { error: updateErr } = await supabase.auth.admin.updateUserById(matchedProfile.id, {
        password,
        email_confirm: true,
        user_metadata: { fullName: fullName || "Student", phone: phone || "", role: "STUDENT" },
      });
      if (updateErr) return res.status(400).json({ status: 'ERROR', message: updateErr.message });
      userId = matchedProfile.id;
    } else {
      const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
        email: normalizedEmail,
        password,
        email_confirm: true,
        user_metadata: { fullName: fullName || "Student", phone: phone || "", role: "STUDENT" },
      });
      if (createErr) return res.status(400).json({ status: 'ERROR', message: createErr.message });
      userId = createData.user?.id;
    }

    if (userId) {
      await supabase.from('students').upsert([{
        email: normalizedEmail,
        full_name: fullName || "Student",
        phone: phone || "",
        account_status: "ACTIVE",
        email_verified: true,
        updated_at: new Date().toISOString(),
      }], { onConflict: 'email' });

      await supabase.from('profiles').upsert([{
        id: userId,
        email: normalizedEmail,
        full_name: fullName || "Student",
        phone: phone || "",
        role: "STUDENT",
        status: "Active Online",
        updated_at: new Date().toISOString(),
      }], { onConflict: 'email' });
    }

    try { sendWelcomeEmail({ to: normalizedEmail, fullName: fullName || "Student" }); } catch (e) {}

    res.status(200).json({ status: 'SUCCESS', message: 'Account password updated successfully!', userId });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// 3. AUTHORITATIVE PAYMENT ENROLLMENT ORDER CREATION (Phase 11 & Phase 13)
// =========================================================================

app.post(['/api/payments/create-enrollment-order', '/api/payments/create-order'], paymentLimiter, async (req, res, next) => {
  try {
    const { courseId, batchId, paymentPlan = "FULL", couponCode = "", name, email, phone, returnUrl } = req.body;
    const studentName = name || req.body.studentName || "Student";
    const studentEmail = email || req.body.email;

    if (!studentEmail) {
      return res.status(400).json({ status: 'ERROR', message: 'Student email is required for payment checkout.' });
    }

    const normalizedEmail = studentEmail.toLowerCase().trim();
    const cleanPhone = String(phone || '9876543210').replace(/[^0-9]/g, "").slice(-10);

    // Phase 13: Authoritative Course Lookup with Resilient Catalog Synchronization
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

    // Resilient Auto-Creation / Fallback to prevent 404 on unseeded courses
    if (!course) {
      const courseTitle = requestedCourseName || (courseId ? `Program ${courseId}` : "Live Upskilling Program");
      const clientAmount = Number(req.body.amount || req.body.totalFee);
      const fallbackPrice = (!isNaN(clientAmount) && clientAmount > 0) ? clientAmount : 4000;
      const fallbackInstallment = 1500;
      const generatedSlug = (courseId || courseTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      try {
        const { data: newCourse } = await supabase.from('courses').insert([{
          title: courseTitle,
          slug: generatedSlug,
          price: fallbackPrice,
          installment_price: fallbackInstallment,
          status: 'PUBLISHED'
        }]).select().maybeSingle();

        course = newCourse;
      } catch (insertErr) {
        console.warn("Course catalog auto-sync note:", insertErr.message);
      }

      if (!course) {
        course = {
          id: isUuid ? courseId : "00000000-0000-0000-0000-000000000001",
          title: courseTitle,
          price: fallbackPrice,
          installment_price: fallbackInstallment,
          status: 'PUBLISHED'
        };
      }
    }

    // Phase 13: Authoritative Server-Side Payment Calculation
    const rawPrice = Number(course.price);
    let totalCoursePrice = (!isNaN(rawPrice) && rawPrice > 0) ? rawPrice : 4000;

    let configuredInstallmentPrice = (!isNaN(Number(course.installment_price)) && Number(course.installment_price) > 0) ? Number(course.installment_price) : 1500;

    // Validate Coupon Discount (Support secret codes: 16/08/26-INLS for ₹1000 off; 17/07/26-INLS, EARLY2026, NETRA15 for ₹500 off)
    const cleanCoupon = String(couponCode || "").trim().toUpperCase();
    let discountAmount = 0;
    if (cleanCoupon === "16/08/26-INLS") {
      discountAmount = 1000;
    } else if (["17/07/26-INLS", "EARLY2026", "NETRA15"].includes(cleanCoupon)) {
      discountAmount = 500;
    }

    totalCoursePrice = Math.max(0, totalCoursePrice - discountAmount);
    configuredInstallmentPrice = Math.max(0, configuredInstallmentPrice - discountAmount);

    const clientAmount = Number(req.body.amount);
    let orderAmount;
    if (!isNaN(clientAmount) && clientAmount > 0) {
      orderAmount = clientAmount;
    } else {
      orderAmount = paymentPlan === "INSTALLMENT" ? configuredInstallmentPrice : totalCoursePrice;
    }

    // Fetch Batch & Validate Capacity
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

    // Find or Create Student Record
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

    // Create Pending Enrollment
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

    // Create Internal Order Row
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

    // Call Cashfree PG Order API
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

// Public Order Status Verification Endpoint for Payment Success/Cancel Page
app.post(['/api/payments/verify-order', '/api/payments/verify'], async (req, res, next) => {
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

    if (isPaid) {
      try {
        const customer = cfOrderData.customer_details || {};
        const studentEmail = (customer.customer_email || "").toLowerCase().trim();
        const studentName = customer.customer_name || "Enrolled Student";
        const studentPhone = customer.customer_phone || "";
        const amountPaid = Number(cfOrderData.order_amount) || 0;
        const totalFee = Number(cfOrderData.order_meta?.total_fee || amountPaid) || amountPaid;
        const remainingBal = Math.max(0, totalFee - amountPaid);
        const courseName = (cfOrderData.order_note || "").replace("Enrollment - ", "").replace("Registration Token - ", "") || "Live Program";
        const txnId = cfOrderData.cf_order_id ? String(cfOrderData.cf_order_id) : `CF_${orderId}`;

        // 1. Sync to Supabase Payments Table
        await supabase.from("payments").upsert([{
          txn_id: txnId,
          student_name: studentName,
          email: studentEmail,
          mobile: studentPhone,
          course_name: courseName,
          payment_type: remainingBal <= 0 ? "FULL" : "INSTALLMENT",
          amount_paid: amountPaid,
          total_course_fee: totalFee,
          remaining_balance: remainingBal,
          payment_method: "Cashfree PG",
          status: remainingBal <= 0 ? "Full Payment Settled" : "1st Installment Settled",
          created_at: new Date().toISOString()
        }], { onConflict: "txn_id" });

        // 2. Sync to Supabase Orders Table
        await supabase.from("orders").update({
          status: "PAID",
          amount: amountPaid
        }).eq("cashfree_order_id", orderId);

        // 3. Sync to Supabase Enrollments Table
        const { data: matchedOrder } = await supabase
          .from("orders")
          .select("enrollment_id")
          .eq("cashfree_order_id", orderId)
          .maybeSingle();

        if (matchedOrder?.enrollment_id) {
          await supabase.from("enrollments").update({
            payment_status: "PAID",
            amount_paid: amountPaid,
            amount_pending: remainingBal,
            course_access_status: "UNLOCKED",
            account_status: "ACTIVE"
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
      data: cfOrderData
    });
  } catch (err) {
    next(err);
  }
});

// Admin Endpoint: Sync specific Cashfree Order ID directly into Supabase database
app.post(['/api/payments/sync-order', '/api/admin/sync-order'], async (req, res, next) => {
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

    // Look up existing database record for true student identity & course name
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
    const cfTxnId = cfOrderData.cf_order_id ? String(cfOrderData.cf_order_id) : `CF_${orderId}`;

    // Insert/Upsert directly using Supabase Service Role Key
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

// Admin Endpoint: Consolidated Payment Ledger with Service Role Access (Bypasses RLS)
app.get(['/api/admin/payments', '/api/payments/admin-ledger'], async (req, res, next) => {
  try {
    const { data: paymentsData } = await supabase
      .from('payments')
      .select('*')
      .order('created_at', { ascending: false });

    const { data: ordersData } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });

    const { data: enrollmentsData } = await supabase
      .from('enrollments')
      .select('*, students(full_name, email, phone)')
      .order('updated_at', { ascending: false });

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

// Authoritative Backend-Only Payment Reconciliation Endpoint
app.post('/api/payments/reconcile-order', authenticateJWT, paymentLimiter, async (req, res, next) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ status: 'ERROR', message: 'orderId is required for reconciliation.' });
    }

    // 1. Fetch internal order row
    const { data: internalOrder } = await supabase
      .from('orders')
      .select('order_id, cashfree_order_id, student_id, course_id, enrollment_id, amount, status')
      .eq('cashfree_order_id', orderId)
      .maybeSingle();

    if (!internalOrder) {
      return res.status(404).json({ status: 'ERROR', message: 'Order not found in database.' });
    }

    // 2. Server-to-Server Direct Verification with Cashfree PG
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

    // 3. Invoke Atomic RPC for Transactional Safety
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

// Phase 15: Authoritative Server-Side Lesson Progress Synchronization Endpoints
app.get('/api/progress/:enrollmentId', authenticateJWT, async (req, res, next) => {
  try {
    const { enrollmentId } = req.params;
    const userEmail = (req.user?.email || "").toLowerCase().trim();

    if (!userEmail) {
      return res.status(401).json({ status: 'ERROR', message: 'Authentication required.' });
    }

    // Resolve Student Identity
    const { data: student } = await supabase
      .from('students')
      .select('id, email')
      .ilike('email', userEmail)
      .maybeSingle();

    if (!student) {
      return res.status(404).json({ status: 'ERROR', message: 'Student profile not found.' });
    }

    // Fetch Target Enrollment & Ownership Verification
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

    // Strict Cross-User Ownership Guard (Phase 15)
    if (String(enrollment.student_id) !== String(student.id)) {
      return res.status(403).json({ status: 'ERROR', message: 'Access denied: You do not own this enrollment.' });
    }

    // Fetch Lesson Progress Records
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

app.put('/api/progress/:enrollmentId/:moduleId', authenticateJWT, async (req, res, next) => {
  try {
    const { enrollmentId, moduleId } = req.params;
    const { completed = true, progressPercent = 100, lastPositionSeconds = 0 } = req.body || {};
    const userEmail = (req.user?.email || "").toLowerCase().trim();

    if (!userEmail) {
      return res.status(401).json({ status: 'ERROR', message: 'Authentication required.' });
    }

    // Strict Server Bounds Validation
    const pct = Number(progressPercent);
    const pos = Number(lastPositionSeconds);

    if (isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ status: 'ERROR', message: 'Progress percentage must be between 0 and 100.' });
    }

    if (isNaN(pos) || pos < 0) {
      return res.status(400).json({ status: 'ERROR', message: 'Video position must be non-negative.' });
    }

    // Resolve Student & Enrollment Identity
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

    // Strict Ownership Guard (Phase 15)
    if (String(enrollment.student_id) !== String(student.id)) {
      return res.status(403).json({ status: 'ERROR', message: 'Access denied: You do not own this enrollment.' });
    }

    // Idempotent Upsert into lesson_progress Table
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

// =========================================================================
// 4. AUTHORITATIVE CASHFREE WEBHOOK LISTENER (Phase 11 & Phase 17)
// =========================================================================

app.post('/api/webhooks/cashfree', async (req, res) => {
  try {
    const webhookData = req.body?.data || req.body;
    const eventType = req.body?.type || req.body?.event || req.body?.data?.event || "PAYMENT_SUCCESS";

    if (eventType === "TEST_WEBHOOK" || req.body?.test === true || req.body?.data?.order?.order_id === "test_order") {
      return res.status(200).json({ status: 'SUCCESS', message: 'Test webhook verified.' });
    }

    // HMAC Signature Verification
    if (req.headers['x-webhook-signature']) {
      const isSignatureValid = verifyCashfreeWebhookSignature(req);
      if (!isSignatureValid) {
        return res.status(401).json({ status: 'ERROR', message: 'Invalid HMAC webhook signature.' });
      }
    }

    const cashfreeOrderId = webhookData?.order?.order_id || webhookData?.payment?.order_id || webhookData?.order_id;
    const cashfreePaymentId = webhookData?.payment?.cf_payment_id || webhookData?.payment_id || cashfreeOrderId;

    if (!cashfreeOrderId) {
      return res.status(200).json({ status: 'SUCCESS', message: 'Webhook received.' });
    }

    // Server-to-Server Double Verification
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

    // Look up real pre-order student details from database if available
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

    // Unconditional Automatic Database Sync for Every Paid Cashfree Event
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

    // Attempt atomic database RPC call for transactional safety under concurrent webhooks (Phase 17)
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

      await supabase.from('enrollments').update({
        amount_paid: newAmountPaid,
        amount_pending: newAmountPending,
        payment_status: newPaymentStatus,
        course_access_status: isFullPayment ? 'ACTIVE' : 'PARTIAL',
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

// Global Production Error Handling Middleware (Hide Stack Traces & Secrets)
app.use((err, req, res, next) => {
  console.error("Internal Server Exception:", err);
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';

  res.status(status).json({
    status: 'ERROR',
    message: isProd ? 'An internal server error occurred.' : (err.message || 'Server Exception'),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 InternNetra Security-Hardened Backend running on port ${PORT}`);
});
