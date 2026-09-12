const rateLimit = require('express-rate-limit');

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

const heavyVideoOpsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // max 30 operations per 15 min per user/IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => req.user?.id || req.user?.email || req.ip,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Video upload and transcoding rate limit exceeded. Please wait a few minutes before starting new jobs.'
  }
});

module.exports = {
  authRateLimiter,
  otpSendLimiter,
  paymentLimiter,
  heavyVideoOpsLimiter
};
