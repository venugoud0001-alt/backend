/**
 * Automated Security Regression Test Suite for InternNetra LMS
 * Verifies that all vulnerabilities identified in the audit are securely patched.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Load environment to use real JWT secret for valid admin tests
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-local-suite';
const CASHFREE_SECRET = process.env.CASHFREE_CLIENT_SECRET || 'test_cf_secret';

console.log('================================================================');
console.log('INTERNNETRA NLS - AUTOMATED SECURITY REGRESSION TEST SUITE');
console.log('================================================================\n');

// 1. Helper for HTTP Requests
function sendRequest({ method, path, headers = {}, body = null }) {
  return new Promise((resolve) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: 'localhost',
      port: process.env.PORT || 5000,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json || data });
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 0, error: err.message });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// 2. Token Generators
function generateUnsignedToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function generateTamperedToken(payload) {
  // Sign with a wrong / fake key
  return jwt.sign(payload, 'wrong-attacker-secret-key', { expiresIn: '1h' });
}

function generateValidStudentToken() {
  return jwt.sign({ id: 'student-uuid-101', email: 'student@example.com', role: 'STUDENT' }, JWT_SECRET, { expiresIn: '1h' });
}

function generateValidAdminToken() {
  return jwt.sign({ id: 'admin-uuid-001', email: 'admin@internnetra.com', role: 'ADMIN' }, JWT_SECRET, { expiresIn: '1h' });
}

// 3. Test Cases Definition
const tests = [
  {
    name: '1. Forged Unsigned JWT (alg: none, role: ADMIN) must be rejected with 401',
    run: async () => {
      const token = generateUnsignedToken({ id: 'attacker', email: 'admin@internnetra.com', role: 'ADMIN' });
      const res = await sendRequest({
        method: 'GET',
        path: '/api/admin/diagnostics',
        headers: { Authorization: `Bearer ${token}` }
      });
      return { pass: res.statusCode === 401, details: `Got HTTP ${res.statusCode}` };
    }
  },
  {
    name: '2. Tampered JWT (Wrong signature, role: ADMIN) must be rejected with 401',
    run: async () => {
      const token = generateTamperedToken({ id: 'attacker', email: 'admin@internnetra.com', role: 'ADMIN' });
      const res = await sendRequest({
        method: 'GET',
        path: '/api/admin/diagnostics',
        headers: { Authorization: `Bearer ${token}` }
      });
      return { pass: res.statusCode === 401, details: `Got HTTP ${res.statusCode}` };
    }
  },
  {
    name: '3. Invalid JWT format string must be rejected with 401',
    run: async () => {
      const res = await sendRequest({
        method: 'GET',
        path: '/api/admin/diagnostics',
        headers: { Authorization: 'Bearer invalid-token-string' }
      });
      return { pass: res.statusCode === 401, details: `Got HTTP ${res.statusCode}` };
    }
  },
  {
    name: '4. Missing Authorization header on Protected Admin Endpoints must return 401',
    run: async () => {
      const paths = [
        { method: 'GET', path: '/api/admin/diagnostics' },
        { method: 'GET', path: '/api/admin/payments' },
        { method: 'POST', path: '/api/pricing/plans', body: { course_id: 'test' } },
        { method: 'POST', path: '/api/upload/image', body: { imageBase64: 'test' } }
      ];
      for (const p of paths) {
        const res = await sendRequest(p);
        if (res.statusCode !== 401) {
          return { pass: false, details: `${p.method} ${p.path} returned HTTP ${res.statusCode}, expected 401` };
        }
      }
      return { pass: true, details: 'All 4 admin endpoints rejected unauthenticated calls with 401' };
    }
  },
  {
    name: '5. Normal Student JWT accessing Protected Admin Endpoints must return 403 Forbidden',
    run: async () => {
      const studentToken = generateValidStudentToken();
      const paths = [
        { method: 'GET', path: '/api/admin/diagnostics' },
        { method: 'GET', path: '/api/admin/payments' }
      ];
      for (const p of paths) {
        const res = await sendRequest({
          ...p,
          headers: { Authorization: `Bearer ${studentToken}` }
        });
        if (res.statusCode !== 403) {
          return { pass: false, details: `${p.method} ${p.path} returned HTTP ${res.statusCode}, expected 403` };
        }
      }
      return { pass: true, details: 'Student token was correctly denied with 403 Forbidden' };
    }
  },
  {
    name: '6. Valid Admin Token accessing Admin Diagnostics succeeds (HTTP 200)',
    run: async () => {
      const adminToken = generateValidAdminToken();
      const res = await sendRequest({
        method: 'GET',
        path: '/api/admin/diagnostics',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      return {
        pass: res.statusCode === 200,
        details: `Got HTTP ${res.statusCode} with status: ${res.body?.status || 'OK'}`
      };
    }
  },
  {
    name: '7. Cashfree Webhook without x-webhook-signature must be rejected with 401',
    run: async () => {
      const res = await sendRequest({
        method: 'POST',
        path: '/api/webhooks/cashfree',
        body: {
          data: {
            order: { order_id: 'order_fake_123' },
            payment: { cf_payment_id: 'cf_fake_123' }
          }
        }
      });
      return { pass: res.statusCode === 401, details: `Got HTTP ${res.statusCode}` };
    }
  },
  {
    name: '8. Cashfree Webhook with invalid x-webhook-signature must be rejected with 401',
    run: async () => {
      const res = await sendRequest({
        method: 'POST',
        path: '/api/webhooks/cashfree',
        headers: {
          'x-webhook-signature': 'invalid_forged_hmac_signature',
          'x-webhook-timestamp': String(Date.now())
        },
        body: {
          data: {
            order: { order_id: 'order_fake_123' },
            payment: { cf_payment_id: 'cf_fake_123' }
          }
        }
      });
      return { pass: res.statusCode === 401, details: `Got HTTP ${res.statusCode}` };
    }
  },
  {
    name: '9. Cashfree Webhook with valid HMAC signature succeeds',
    run: async () => {
      const timestamp = String(Date.now());
      const bodyPayload = JSON.stringify({
        data: {
          order: { order_id: 'TEST_NON_EXISTENT_ORDER_999' },
          payment: { cf_payment_id: 'TEST_PMT_999' }
        }
      });
      const dataToSign = timestamp + bodyPayload;
      const validSig = crypto.createHmac('sha256', CASHFREE_SECRET).update(dataToSign).digest('base64');

      const res = await sendRequest({
        method: 'POST',
        path: '/api/webhooks/cashfree',
        headers: {
          'x-webhook-signature': validSig,
          'x-webhook-timestamp': timestamp,
          'Content-Type': 'application/json'
        },
        body: bodyPayload
      });

      // Status 200 expected (either ignored or processed, but NOT 401 unauthorized)
      const pass = res.statusCode === 200;
      return { pass, details: `Got HTTP ${res.statusCode} with status: ${res.body?.status || res.body?.message}` };
    }
  }
];

// 4. Test Runner
async function runSuite() {
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test.run();
      if (result.pass) {
        console.log(`✅ [PASS] ${test.name}`);
        if (result.details) console.log(`   └─ Details: ${result.details}`);
        passed++;
      } else {
        console.log(`❌ [FAIL] ${test.name}`);
        if (result.details) console.log(`   └─ Failure: ${result.details}`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ [ERROR] ${test.name}`);
      console.log(`   └─ Exception: ${err.message}`);
      failed++;
    }
    console.log('');
  }

  console.log('================================================================');
  console.log(`SECURITY SUITE SUMMARY: ${passed} Passed, ${failed} Failed out of ${tests.length} Tests.`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSuite();
