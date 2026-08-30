const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase, JWT_SECRET } = require('../config/supabase');
const { authRateLimiter, otpSendLimiter } = require('../middleware/rateLimiter');
const { sendOtpEmail, sendWelcomeEmail } = require('../services/mailer');

// Secure In-Memory Challenge Store (Challenge ID -> Hashed OTP, metadata, expiration, attempts, single-use reset tokens)
const otpStore = new Map();
const resetTokenStore = new Map();

// Helper: Hash sensitive strings
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

// Cryptographic OTP Generation
router.post('/auth/send-otp', otpSendLimiter, async (req, res, next) => {
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

// Check Account Status
router.post('/auth/check-status', authRateLimiter, async (req, res, next) => {
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

// Verify OTP & Issue Single-Use Reset Token
router.post('/auth/verify-otp', authRateLimiter, async (req, res, next) => {
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

    // Success: Burn OTP challenge immediately
    otpStore.delete(key);
    await confirmUserEmail(key);

    // Single-use short-lived Password Reset Authorization Token (Valid for 15 mins)
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

// Secure Password Setting Endpoint Locked Behind Single-Use Signed Reset Token
router.post('/auth/set-password', authRateLimiter, async (req, res, next) => {
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

    // 3. Perform Authorized Supabase Account Password Update/Creation
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

module.exports = router;
