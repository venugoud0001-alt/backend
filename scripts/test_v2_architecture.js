/**
 * InternNetra LMS Architecture V2 Comprehensive Test Suite
 */

const http = require('http');

const BASE_URL = 'http://localhost:5000/api';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting LMS Architecture V2 Integration Test Suite...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  // 1. Health Check
  try {
    const health = await request('GET', '/health');
    assert(health.status === 200 && health.data.status === 'active', 'Health check endpoint /api/health');
  } catch (err) {
    assert(false, `Health check exception: ${err.message}`);
  }

  // 2. Department API - GET
  let depts = [];
  try {
    const res = await request('GET', '/departments');
    assert(res.status === 200, 'GET /api/departments returns 200');
    depts = res.data.departments || res.data.data?.departments || [];
    assert(Array.isArray(depts), 'Departments response contains array');
  } catch (err) {
    assert(false, `GET /api/departments failed: ${err.message}`);
  }

  // 3. Department API - GET by Slug
  if (depts.length > 0) {
    try {
      const slug = depts[0].slug;
      const res = await request('GET', `/departments/${slug}`);
      assert(res.status === 200, `GET /api/departments/${slug} returns 200`);
    } catch (err) {
      assert(false, `GET department by slug failed: ${err.message}`);
    }
  }

  // 4. Course API - GET
  let courses = [];
  try {
    const res = await request('GET', '/courses');
    assert(res.status === 200, 'GET /api/courses returns 200');
    courses = res.data.courses || res.data.data?.courses || [];
    assert(Array.isArray(courses), 'Courses response contains array');
  } catch (err) {
    assert(false, `GET /api/courses failed: ${err.message}`);
  }

  // 5. Course Curriculum API - GET
  if (courses.length > 0) {
    try {
      const slug = courses[0].slug;
      const res = await request('GET', `/courses/${slug}/curriculum`);
      assert(res.status === 200, `GET /api/courses/${slug}/curriculum returns 200`);
      const hasStructure = Boolean(res.data?.course || res.data?.curriculum || res.data?.modules || res.data?.data);
      assert(hasStructure, 'Curriculum response structured correctly');
      if (!hasStructure) {
        console.log('   Received curriculum response:', JSON.stringify(res.data, null, 2));
      }
    } catch (err) {
      assert(false, `GET curriculum failed: ${err.message}`);
    }
  }

  // 6. Pricing Calculation Service Test
  if (courses.length > 0) {
    try {
      const courseId = courses[0].id;
      const calcRes = await request('POST', '/pricing/calculate', { courseId, paymentMode: 'FULL' });
      assert(calcRes.status === 200 || calcRes.status === 404, 'Authoritative pricing calculation API responds properly');
    } catch (err) {
      assert(false, `Pricing calculation exception: ${err.message}`);
    }
  }

  // 7. Installment Phase Sum Validation Test (Invalid Sum Check)
  try {
    const invalidPlanRes = await request('POST', '/pricing/plans', {
      courseId: courses[0]?.id || '00000000-0000-0000-0000-000000000001',
      name: 'Invalid Installment Plan',
      paymentMode: 'INSTALLMENT',
      totalAmount: 15000,
      currency: 'INR',
      phases: [
        { phase_number: 1, name: 'Phase 1', amount: 5000 },
        { phase_number: 2, name: 'Phase 2', amount: 3000 } // Total 8000 != 15000
      ]
    });
    assert(invalidPlanRes.status === 422, 'Reject invalid installment sum (SUM 8000 != total 15000) with 422 Unprocessable Entity');
  } catch (err) {
    assert(false, `Invalid installment sum test failed: ${err.message}`);
  }

  // 8. Invalid ID / 404 Tests
  try {
    const notFoundRes = await request('GET', '/courses/non-existent-course-slug-123456');
    assert(notFoundRes.status === 404, 'GET invalid course slug returns 404 Not Found');
  } catch (err) {
    assert(false, `404 test failed: ${err.message}`);
  }

  console.log(`\n===========================================`);
  console.log(`🎉 TEST SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log(`===========================================\n`);
}

runTests();
