const { authenticateJWT, optionalAuthenticateJWT } = require('../src/middleware/authenticate');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/config/supabase');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.json = function (data) {
    this.jsonData = data;
    return this;
  };
  return res;
}

async function runTests() {
  console.log('--- RUNNING CRIT-01 VERIFICATION SUITE ---');
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

  // 1. Reject 'admin-session-token-1001'
  {
    const req = {
      headers: { authorization: 'Bearer admin-session-token-1001' }
    };
    const res = mockRes();
    let nextCalled = false;
    await authenticateJWT(req, res, () => { nextCalled = true; });

    assert(!nextCalled && res.statusCode === 401, 'Hardcoded token admin-session-token-1001 must be rejected with 401');
    assert(res.jsonData && (res.jsonData.status === 'ERROR' || res.jsonData.success === false), 'Response indicates failure');
  }

  // 2. Reject 'mock-admin-token'
  {
    const req = {
      headers: { authorization: 'Bearer mock-admin-token' }
    };
    const res = mockRes();
    let nextCalled = false;
    await authenticateJWT(req, res, () => { nextCalled = true; });

    assert(!nextCalled && res.statusCode === 401, 'Hardcoded token mock-admin-token must be rejected with 401');
  }

  // 3. Reject tampered / forged token
  {
    const req = {
      headers: { authorization: 'Bearer forged.token.signature' }
    };
    const res = mockRes();
    let nextCalled = false;
    await authenticateJWT(req, res, () => { nextCalled = true; });

    assert(!nextCalled && res.statusCode === 401, 'Forged/tampered token must be rejected with 401');
  }

  // 4. Reject missing Authorization header
  {
    const req = { headers: {} };
    const res = mockRes();
    let nextCalled = false;
    await authenticateJWT(req, res, () => { nextCalled = true; });

    assert(!nextCalled && res.statusCode === 401, 'Missing Authorization header rejected with 401');
  }

  // 5. optionalAuthenticateJWT treats backdoor token as unauthenticated (GUEST)
  {
    const req = {
      headers: { authorization: 'Bearer admin-session-token-1001' }
    };
    const res = mockRes();
    let nextCalled = false;
    await optionalAuthenticateJWT(req, res, () => { nextCalled = true; });

    assert(nextCalled && req.userRole === 'GUEST' && req.user === null, 'optionalAuthenticateJWT treats backdoor token as GUEST');
  }

  // 6. Valid cryptographically signed JWT for admin@internnetra.com
  {
    const secret = JWT_SECRET || 'internnetra_super_secret_jwt_key_2025_prod_secure';
    const payload = {
      id: 'f934b486-4c9e-4beb-b4d1-164ade559374',
      email: 'admin@internnetra.com',
      role: 'SUPER_ADMIN'
    };
    const validToken = jwt.sign(payload, secret, { expiresIn: '1h' });

    const req = {
      headers: { authorization: `Bearer ${validToken}` }
    };
    const res = mockRes();
    let nextCalled = false;
    await authenticateJWT(req, res, () => { nextCalled = true; });

    assert(nextCalled, 'Cryptographically signed JWT passes authentication');
    assert(req.user && req.user.email === 'admin@internnetra.com', 'Req.user populated with authentic user details');
    assert(req.userRole === 'SUPER_ADMIN', `Authoritative role correctly resolved to SUPER_ADMIN (got ${req.userRole})`);
    assert(Array.isArray(req.user.permissions) && req.user.permissions.length > 0, 'Permissions dynamically assigned by RBAC service');
  }

  // 7. Valid cryptographically signed JWT for regular student
  {
    const secret = JWT_SECRET || 'internnetra_super_secret_jwt_key_2025_prod_secure';
    const payload = {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'student@example.com',
      role: 'STUDENT'
    };
    const validToken = jwt.sign(payload, secret, { expiresIn: '1h' });

    const req = {
      headers: { authorization: `Bearer ${validToken}` }
    };
    const res = mockRes();
    let nextCalled = false;
    await authenticateJWT(req, res, () => { nextCalled = true; });

    assert(nextCalled, 'Cryptographically signed Student JWT passes authentication');
    assert(req.userRole === 'STUDENT', `Student role correctly assigned (got ${req.userRole})`);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal error in tests:', err);
  process.exit(1);
});
