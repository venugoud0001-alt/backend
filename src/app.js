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

const app = express();

// Security Header Guard
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS Configuration
const defaultProductionOrigins = [
  'https://internnetra.com',
  'https://www.internnetra.com',
  'https://api.internnetra.com'
];

const envOrigins = env.CORS_ALLOWED_ORIGINS
  ? env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : [];

const localOrigins = [
  'http://localhost:3000',
  'http://localhost:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000'
];

const allowedOrigins = Array.from(new Set([
  ...defaultProductionOrigins,
  ...localOrigins,
  ...envOrigins
]));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      callback(null, true);
    } else {
      callback(new Error('CORS Policy Violation: Access Denied'));
    }
  },
  credentials: true
}));

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
