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

module.exports = {
  authRateLimiter,
  otpSendLimiter,
  paymentLimiter
};
