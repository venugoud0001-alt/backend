/**
 * Comprehensive RBAC & Security Hardening Test Suite
 * Validates Roles, Granular Permissions, Sub-Admin Delegation, Privilege Escalation Prevention, and Direct API Security.
 * Uses native Node.js http module (Zero extra dependencies).
 */

const rbacService = require('../src/modules/rbac/rbac.service');
const { ROLES, PERMISSIONS } = require('../src/modules/rbac/rbac.constants');
const app = require('../src/app');
const http = require('http');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/config/supabase');

async function runRbacTestSuite() {
  console.log('🛡️  Starting Comprehensive RBAC Verification Suite...\n');
  const results = [];

  function record(testNum, name, passed, details) {
    results.push({ testNum, name, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`[Test ${testNum < 10 ? '0' + testNum : testNum}] ${mark} - ${name}`);
    if (details) console.log(`   └─ ${details}`);
  }

  // Start test server on dynamic port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  function doRequest({ method = 'GET', path, token, body = null }) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      };

      const req = http.request(options, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = {};
          try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Generate verified test JWTs
  const superAdminToken = jwt.sign(
    { id: 'usr-super-admin', email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Sub-Admin with Course & Curriculum Permissions ONLY
  const courseAdminEmail = 'course.manager@internnetra.com';
  const courseAdminSubUser = await rbacService.createSubAdmin(
    { email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN },
    {
      name: 'Course Content Admin',
      email: courseAdminEmail,
      designation: 'Course Administrator',
      permissions: [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.COURSE_VIEW,
        PERMISSIONS.COURSE_CREATE,
        PERMISSIONS.COURSE_EDIT,
        PERMISSIONS.CURRICULUM_VIEW,
        PERMISSIONS.CURRICULUM_CREATE,
        PERMISSIONS.CURRICULUM_EDIT
        // NOTE: No course.archive, no payment.*, no student.*, no admin.*
      ]
    }
  );

  const courseAdminToken = jwt.sign(
    { id: courseAdminSubUser.id, email: courseAdminEmail, role: ROLES.ADMIN },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Sub-Admin without course.create
  const readOnlyAdminEmail = 'viewer.admin@internnetra.com';
  const readOnlySubUser = await rbacService.createSubAdmin(
    { email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN },
    {
      name: 'Read Only Auditor',
      email: readOnlyAdminEmail,
      designation: 'Auditor',
      permissions: [PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.COURSE_VIEW]
    }
  );

  const readOnlyAdminToken = jwt.sign(
    { id: readOnlySubUser.id, email: readOnlyAdminEmail, role: ROLES.ADMIN },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Standard Student User
  const studentToken = jwt.sign(
    { id: 'usr-student-456', email: 'student@example.com', role: ROLES.STUDENT },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // ----------------------------------------------------
  // Test 1: SUPER_ADMIN Full Permissions Resolution
  // ----------------------------------------------------
  try {
    const superRbac = await rbacService.getUserRoleAndPermissions({ email: 'admin@internnetra.com' });
    const hasAll = Object.values(PERMISSIONS).every(p => rbacService.hasPermission(superRbac, p));
    record(1, 'SUPER_ADMIN Full Platform Permissions', superRbac.role === ROLES.SUPER_ADMIN && hasAll, 'Super Admin possesses all catalog permissions implicitly.');
  } catch (e) {
    record(1, 'SUPER_ADMIN Full Platform Permissions', false, e.message);
  }

  // ----------------------------------------------------
  // Test 2: ADMIN with Course Permissions - Allowed Access
  // ----------------------------------------------------
  try {
    const courseRbac = await rbacService.getUserRoleAndPermissions({ email: courseAdminEmail });
    const canCreate = rbacService.hasPermission(courseRbac, PERMISSIONS.COURSE_CREATE);
    const canEdit = rbacService.hasPermission(courseRbac, PERMISSIONS.COURSE_EDIT);
    record(2, 'ADMIN with Course Permissions: Allowed Actions', canCreate && canEdit, 'Course Admin successfully authorized for course.create and course.edit.');
  } catch (e) {
    record(2, 'ADMIN with Course Permissions: Allowed Actions', false, e.message);
  }

  // ----------------------------------------------------
  // Test 3: ADMIN with Course Permissions - Blocked from Payments
  // ----------------------------------------------------
  try {
    const courseRbac = await rbacService.getUserRoleAndPermissions({ email: courseAdminEmail });
    const canViewPayments = rbacService.hasPermission(courseRbac, PERMISSIONS.PAYMENT_VIEW);
    record(3, 'ADMIN Blocked from Payments Module', canViewPayments === false, 'Course Admin has NO payment.view permission.');
  } catch (e) {
    record(3, 'ADMIN Blocked from Payments Module', false, e.message);
  }

  // ----------------------------------------------------
  // Test 4: ADMIN with Course Permissions - Direct API Rejection (GET /api/admin/payments)
  // ----------------------------------------------------
  try {
    const res = await doRequest({
      method: 'GET',
      path: '/api/admin/payments',
      token: courseAdminToken
    });
    record(4, 'Direct API: Course Admin Accessing /api/admin/payments', res.status === 403, `API returned HTTP ${res.status}: ${res.body.message || JSON.stringify(res.body)}`);
  } catch (e) {
    record(4, 'Direct API: Course Admin Accessing /api/admin/payments', false, e.message);
  }

  // ----------------------------------------------------
  // Test 5: ADMIN without course.create - Direct API Rejection (POST /api/courses)
  // ----------------------------------------------------
  try {
    const res = await doRequest({
      method: 'POST',
      path: '/api/courses',
      token: readOnlyAdminToken,
      body: { title: 'Unauthorized Course', departmentId: 'dept-1' }
    });
    record(5, 'Direct API: Admin Without course.create Blocked', res.status === 403, `API returned HTTP ${res.status}: ${res.body.message || JSON.stringify(res.body)}`);
  } catch (e) {
    record(5, 'Direct API: Admin Without course.create Blocked', false, e.message);
  }

  // ----------------------------------------------------
  // Test 6: ADMIN without course.archive - Direct API Rejection (DELETE /api/courses/:id)
  // ----------------------------------------------------
  try {
    const res = await doRequest({
      method: 'DELETE',
      path: '/api/courses/3168251d-74a3-4f49-a38c-3cf6ef6be5b4',
      token: courseAdminToken
    });
    record(6, 'Direct API: Admin Without course.archive Blocked from Deletion', res.status === 403, `API returned HTTP ${res.status}: ${res.body.message || JSON.stringify(res.body)}`);
  } catch (e) {
    record(6, 'Direct API: Admin Without course.archive Blocked from Deletion', false, e.message);
  }

  // ----------------------------------------------------
  // Test 7: STUDENT Role - Complete Rejection from Admin Endpoints
  // ----------------------------------------------------
  try {
    const resCourses = await doRequest({
      method: 'POST',
      path: '/api/courses',
      token: studentToken,
      body: { title: 'Student Attempt' }
    });

    const resPayments = await doRequest({
      method: 'GET',
      path: '/api/admin/payments',
      token: studentToken
    });

    const resSubUsers = await doRequest({
      method: 'GET',
      path: '/api/admin/sub-users',
      token: studentToken
    });

    const allRejected = resCourses.status === 403 && resPayments.status === 403 && resSubUsers.status === 403;
    record(7, 'STUDENT Role Blocked from All Administrative APIs', allRejected, 'Student received HTTP 403 Forbidden across all administrative route attempts.');
  } catch (e) {
    record(7, 'STUDENT Role Blocked from All Administrative APIs', false, e.message);
  }

  // ----------------------------------------------------
  // Test 8: Privilege Escalation - Sub-Admin Cannot Create Sub-Admins
  // ----------------------------------------------------
  try {
    const res = await doRequest({
      method: 'POST',
      path: '/api/admin/sub-users',
      token: courseAdminToken,
      body: {
        name: 'Hacked Sub-Admin',
        email: 'hacked@internnetra.com',
        permissions: [PERMISSIONS.PAYMENT_VIEW]
      }
    });
    record(8, 'Privilege Escalation: Sub-Admin Cannot Create Other Admins', res.status === 403, `API returned HTTP ${res.status}: ${res.body.message || JSON.stringify(res.body)}`);
  } catch (e) {
    record(8, 'Privilege Escalation: Sub-Admin Cannot Create Other Admins', false, e.message);
  }

  // ----------------------------------------------------
  // Test 9: Privilege Escalation - Sub-Admin Cannot Elevate Own Permissions
  // ----------------------------------------------------
  try {
    const res = await doRequest({
      method: 'PUT',
      path: `/api/admin/sub-users/${courseAdminSubUser.id}`,
      token: courseAdminToken,
      body: {
        permissions: Object.values(PERMISSIONS)
      }
    });
    record(9, 'Privilege Escalation: Sub-Admin Cannot Elevate Permissions', res.status === 403, `API returned HTTP ${res.status}: ${res.body.message || JSON.stringify(res.body)}`);
  } catch (e) {
    record(9, 'Privilege Escalation: Sub-Admin Cannot Elevate Permissions', false, e.message);
  }

  // ----------------------------------------------------
  // Test 10: Privilege Escalation - Cannot Create Second Super Admin
  // ----------------------------------------------------
  try {
    await rbacService.createSubAdmin(
      { email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN },
      {
        name: 'Duplicate Root',
        email: 'admin@internnetra.com', // Attempting to duplicate master email
        permissions: Object.values(PERMISSIONS)
      }
    );
    record(10, 'Privilege Escalation: Duplicate Super Admin Creation Blocked', false, 'Failed to reject duplicate Super Admin.');
  } catch (e) {
    record(10, 'Privilege Escalation: Duplicate Super Admin Creation Blocked', e.statusCode === 400 || e.statusCode === 403, e.message);
  }

  // ----------------------------------------------------
  // Test 11: Audit Logging Verification
  // ----------------------------------------------------
  try {
    const logs = await rbacService.getAuditLogs({ email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN });
    const hasAdminCreated = logs.some(l => l.action === 'admin.created');
    record(11, 'Audit Logging for Sensitive Administrative Operations', hasAdminCreated, `Audit trail active with ${logs.length} logged administrative events.`);
  } catch (e) {
    record(11, 'Audit Logging for Sensitive Administrative Operations', false, e.message);
  }

  // ----------------------------------------------------
  // Test 12: Account Deactivation Enforcement
  // ----------------------------------------------------
  try {
    // Deactivate readOnlySubUser
    await rbacService.deactivateSubAdmin({ email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN }, readOnlySubUser.id);
    const deactivatedRbac = await rbacService.getUserRoleAndPermissions({ email: readOnlyAdminEmail });
    const isBlocked = rbacService.hasPermission(deactivatedRbac, PERMISSIONS.DASHBOARD_VIEW) === false;

    // Test API rejection with deactivated token
    const res = await doRequest({
      method: 'GET',
      path: '/api/admin/permissions',
      token: readOnlyAdminToken
    });

    record(12, 'Administrative Account Deactivation Enforcement', isBlocked && res.status === 403, 'Disabled administrator immediately revoked from API access.');
  } catch (e) {
    record(12, 'Administrative Account Deactivation Enforcement', false, e.message);
  }

  server.close();

  console.log('\n📊 RBAC Verification Test Results:');
  const passedCount = results.filter(r => r.passed).length;
  console.log(`Passed: ${passedCount} / ${results.length} (100% Target)`);

  if (passedCount === results.length) {
    console.log('🌟 All 12 RBAC and security criteria verified successfully!');
  }
}

runRbacTestSuite().then(() => process.exit(0)).catch(err => {
  console.error('Fatal RBAC Test Failure:', err);
  process.exit(1);
});
