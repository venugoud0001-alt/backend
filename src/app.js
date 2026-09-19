/**
 * InternNetra NLS Modular Express Application
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const env = require('./config/env');
const { errorHandler } = require('./middleware/errorHandler');

// Domain Routers
const departmentRoutes = require('./modules/departments/department.routes');
const courseRoutes = require('./modules/courses/course.routes');
const curriculumRoutes = require('./modules/curriculum/curriculum.routes');
const pricingRoutes = require('./modules/pricing/pricing.routes');
const authRoutes = require('./modules/auth/auth.routes');
const paymentRoutes = require('./modules/payment/payment.routes');
const progressRoutes = require('./modules/progress/progress.routes');
const uploadRoutes = require('./routes/uploadRoutes');
const couponRoutes = require('./modules/coupons/couponRoutes');
const diagnosticsRouter = require('./modules/admin/diagnostics.controller');
const videoRoutes = require('./modules/video/video.routes');
const rbacRoutes = require('./modules/rbac/rbac.routes');

const rateLimit = require('express-rate-limit');

const app = express();

// Security Header Guard & Embedding Protection (Clickjacking & XSS mitigation)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: { action: 'sameorigin' },
  hidePoweredBy: true,
  xssFilter: true
}));

// CORS Configuration (Must be registered before rate limiters and routes)
const defaultProductionOrigins = [
  'https://internnetra.com',
  'https://www.internnetra.com',
  'https://api.internnetra.com'
];

const envOrigins = env.CORS_ALLOWED_ORIGINS
  ? env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean)
  : [];

const frontendOrigin = String(env.FRONTEND_URL || process.env.FRONTEND_URL || '')
  .trim()
  .replace(/\/+$/, '');

const productionAllowlist = new Set([
  ...defaultProductionOrigins,
  ...envOrigins,
  ...(frontendOrigin ? [frontendOrigin] : [])
]);

const normalizeOrigin = (origin) => String(origin || '').trim().replace(/\/+$/, '');

const isAllowedOrigin = (origin) => {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (productionAllowlist.has(normalized)) return true;
  // Case-insensitive host match for allowlisted production domains
  try {
    const { protocol, host } = new URL(normalized);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    const candidate = `${protocol}//${host.toLowerCase()}`;
    return productionAllowlist.has(candidate);
  } catch {
    return false;
  }
};

const corsAllowedHeaders = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'Accept',
  'Range',
  'Origin',
  'Cache-Control',
  'Pragma',
  'Expires',
  'x-webhook-secret'
];

const corsOptions = {
  origin: (origin, callback) => {
    const isProduction = process.env.NODE_ENV === 'production';

    // Same-origin / server-to-server tools often omit Origin
    if (!origin) {
      return callback(null, !isProduction);
    }

    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    if (!isProduction) {
      if (
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.startsWith('http://[::1]:') ||
        origin === 'http://localhost' ||
        origin === 'http://127.0.0.1'
      ) {
        return callback(null, true);
      }
    }

    // Reject without throwing — throwing can omit ACAO and confuse browsers
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: corsAllowedHeaders,
  exposedHeaders: ['ETag', 'Content-Range', 'Accept-Ranges'],
  optionsSuccessStatus: 204,
  maxAge: 86400
};

// Attach ACAO early so rate-limit / error responses still pass browser CORS checks
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(origin));
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Methods', corsOptions.methods.join(','));
      res.setHeader('Access-Control-Allow-Headers', corsAllowedHeaders.join(','));
      res.setHeader('Access-Control-Max-Age', String(corsOptions.maxAge));
      return res.sendStatus(204);
    }
    // Unknown origin preflight — end without ACAO (browser will block)
    return res.sendStatus(204);
  }
  return next();
});

app.use(cors(corsOptions));

// Rate Limiting Guards (skip OPTIONS — already answered above)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: { success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many authentication attempts. Please try again later.' }
});

const streamAuthLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 stream auth requests per min
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  message: { success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many stream requests. Please slow down.' }
});

const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5000 : 20000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  handler: (req, res, _next, options) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(origin));
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.status(options.statusCode).json(options.message);
  },
  message: { success: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many API requests. Please try again in a moment.' }
});

app.use('/api/', generalApiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/send-otp', authLimiter);
app.use('/api/auth/verify-otp', authLimiter);
app.use('/api/video/stream', streamAuthLimiter);

// Body Parsing Middleware (Preserve rawBody for Webhook Signature Verification)
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Serve Uploaded Static Files Locally
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'active',
    service: 'InternNetra Security-Hardened NLS Backend API',
    port: env.PORT,
    environment: env.CASHFREE_ENV,
    timestamp: new Date().toISOString()
  });
});

// Deep Database Readiness Probe Endpoint
app.get(['/api/health/ready', '/api/health/readiness'], async (req, res) => {
  try {
    const { supabase } = require('./config/supabase');
    const startTime = Date.now();
    const { error } = await supabase.from('courses').select('id').limit(1).maybeSingle();
    const latencyMs = Date.now() - startTime;
    if (error) {
      return res.status(503).json({
        status: 'degraded',
        database: 'disconnected',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
    return res.status(200).json({
      status: 'ready',
      database: 'connected',
      dbLatencyMs: latencyMs,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(503).json({
      status: 'unhealthy',
      database: 'error',
      timestamp: new Date().toISOString()
    });
  }
});

// Mount Modular API Routers under /api
app.use('/api', departmentRoutes);
app.use('/api', courseRoutes);
app.use('/api', curriculumRoutes);
app.use('/api', pricingRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api', authRoutes);
app.use('/api', paymentRoutes);
app.use('/api', progressRoutes);
app.use('/api', uploadRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api', couponRoutes);
app.use('/api', diagnosticsRouter);
app.use('/api', videoRoutes);
app.use('/api', rbacRoutes);

// Global Centralized Error Handling Middleware
app.use(errorHandler);

module.exports = app;
