/**
 * Automated Verification Test Script for LMS Module 2 Security Remediation
 */
const http = require('http');

// Start backend server in test mode or run inline assertions
console.log("================== [LMS MODULE 2 SECURITY RE-AUDIT & VERIFICATION TEST] ==================");

const testCases = [
  {
    name: "1. Unauthenticated request to POST /api/admin/create-batch must be rejected with 401",
    path: "/api/admin/create-batch",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchName: "Test Batch", courseId: "2a541ca1-0400-4867-a5fe-87d591fd347c" }),
    expectedStatus: 401
  },
  {
    name: "2. Password reset POST /api/auth/set-password without valid single-use resetToken must fail with 400/401",
    path: "/api/auth/set-password",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "victim@example.com", password: "AttackerNewPassword123!" }),
    expectedStatus: 400
  },
  {
    name: "3. Account check POST /api/auth/check-status must return sanitized status without leaking fullName PII",
    path: "/api/auth/check-status",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test@example.com" }),
    expectedStatus: 200,
    checkBody: (data) => !data.fullName && data.status === "SUCCESS"
  }
];

// Helper to make HTTP request to running backend
function runRequest(test) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 5000,
      path: test.path,
      method: test.method,
      headers: test.headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: json });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', (err) => resolve({ error: err }));
    if (test.body) req.write(test.body);
    req.end();
  });
}

async function runAllTests() {
  console.log("Starting server verification...");
  let passed = 0;
  for (const test of testCases) {
    const res = await runRequest(test);
    if (res.error) {
      console.log(`❌ [FAIL] ${test.name} -> Error connecting: ${res.error.message}`);
    } else if (res.statusCode === test.expectedStatus && (!test.checkBody || test.checkBody(res.body))) {
      console.log(`✅ [PASS] ${test.name} (HTTP ${res.statusCode})`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${test.name} -> Expected HTTP ${test.expectedStatus}, got HTTP ${res.statusCode}. Body:`, res.body);
    }
  }

  console.log(`\n==================================================`);
  console.log(`TEST SUMMARY: ${passed}/${testCases.length} Security Tests Passed.`);
  console.log(`==================================================\n`);
  process.exit(passed === testCases.length ? 0 : 1);
}

runAllTests();
