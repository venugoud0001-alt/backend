const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from backend/.env or root .env
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CASHFREE_CLIENT_ID',
  'CASHFREE_CLIENT_SECRET',
  'JWT_SECRET'
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`❌ Configuration Error: Required environment variable is missing: ${key}`);
      process.exit(1);
    } else {
      console.warn(`⚠️ Warning: Required environment variable missing: ${key}`);
    }
  }
}

module.exports = {
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  CASHFREE_CLIENT_ID: process.env.CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET: process.env.CASHFREE_CLIENT_SECRET,
  CASHFREE_ENV: process.env.CASHFREE_ENV || 'PRODUCTION',
  CASHFREE_WEBHOOK_URL: process.env.CASHFREE_WEBHOOK_URL || 'https://api.internnetra.com/api/webhooks/cashfree',
  JWT_SECRET: process.env.JWT_SECRET,
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: Number(process.env.SMTP_PORT || 465),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS ? process.env.SMTP_PASS.replace(/\s+/g, '') : '',
  SMTP_FROM: process.env.SMTP_FROM || `"InternNetra Team" <${process.env.SMTP_USER || 'info@internnetra.com'}>`,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  FRONTEND_URL: process.env.FRONTEND_URL || 'https://internnetra.com',
  BACKEND_URL: process.env.BACKEND_URL || 'https://api.internnetra.com',
  
  // AWS Video Infrastructure Configuration (Phase 2 & 3)
  AWS_REGION: process.env.AWS_REGION || 'ap-south-1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  AWS_S3_BUCKET_SOURCE: process.env.AWS_S3_RAW_BUCKET || process.env.AWS_S3_BUCKET_SOURCE || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an',
  AWS_S3_BUCKET_OUTPUT: process.env.AWS_S3_HLS_BUCKET || process.env.AWS_S3_BUCKET_OUTPUT || 'internnetra-lms-videos-prod-365957110532-ap-south-1-an',
  AWS_MEDIACONVERT_ENDPOINT: process.env.AWS_MEDIACONVERT_ENDPOINT || '',
  AWS_MEDIACONVERT_ROLE_ARN: process.env.AWS_MEDIACONVERT_ROLE_ARN || '',
  AWS_WEBHOOK_SECRET: process.env.AWS_WEBHOOK_SECRET || '',
  CLOUDFRONT_DOMAIN: (process.env.CLOUDFRONT_DISTRIBUTION_DOMAIN && !process.env.CLOUDFRONT_DISTRIBUTION_DOMAIN.includes('NOT_CREATED')) 
    ? process.env.CLOUDFRONT_DISTRIBUTION_DOMAIN 
    : (process.env.CLOUDFRONT_DOMAIN && !process.env.CLOUDFRONT_DOMAIN.includes('NOT_CREATED')) 
      ? process.env.CLOUDFRONT_DOMAIN 
      : '',
  CLOUDFRONT_KEY_PAIR_ID: (process.env.CLOUDFRONT_KEY_PAIR_ID && !process.env.CLOUDFRONT_KEY_PAIR_ID.includes('NOT_CREATED')) ? process.env.CLOUDFRONT_KEY_PAIR_ID : '',
  CLOUDFRONT_PRIVATE_KEY: (process.env.CLOUDFRONT_PRIVATE_KEY && !process.env.CLOUDFRONT_PRIVATE_KEY.includes('NOT_CREATED')) ? process.env.CLOUDFRONT_PRIVATE_KEY : '',

  // S3 Multipart Upload Tuning
  VIDEO_UPLOAD_PART_SIZE_MB: Number(process.env.VIDEO_UPLOAD_PART_SIZE_MB || 32),
  VIDEO_UPLOAD_CONCURRENCY: Number(process.env.VIDEO_UPLOAD_CONCURRENCY || 6),
  VIDEO_MULTIPART_THRESHOLD_MB: Number(process.env.VIDEO_MULTIPART_THRESHOLD_MB || 100),

  // Video Security & Session Control (Levels 1-3)
  VIDEO_ACCESS_TTL_SECONDS: Number(process.env.VIDEO_ACCESS_TTL_SECONDS || 900), // Default: 15 minutes
  MAX_CONCURRENT_VIDEO_SESSIONS: Number(process.env.MAX_CONCURRENT_VIDEO_SESSIONS || 2),
  ALLOWED_STREAMING_ORIGINS: (process.env.ALLOWED_STREAMING_ORIGINS || 'https://internnetra.com,https://www.internnetra.com,http://localhost:3000,http://localhost:5173')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
};
