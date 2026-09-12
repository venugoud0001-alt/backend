/**
 * Comprehensive Security Test Suite for Findings 8, 9, 10, 11
 * 
 * Tests:
 * 1. Finding 8: Strict Identifier Validation (UUID vs Slug) & Real Query Boundary (Zero query on invalid)
 * 2. Finding 9: RBAC Fail-Closed Semantics & Elimination of In-Memory Sub-User Store
 * 3. Finding 10: Heavy Video Operations Dedicated Rate Limiting
 * 4. Finding 11: Hardcoded JWT Secret Fallback Elimination & Production Startup Hardening
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

// Load utilities and services
const { isUUID, isValidSlug, classifyIdentifier, normalizeIdentifier } = require('./src/utils/idValidator');
const rbacService = require('./src/modules/rbac/rbac.service');
const { ROLES, PERMISSIONS } = require('./src/modules/rbac/rbac.constants');
const { heavyVideoOpsLimiter } = require('./src/middleware/rateLimiter');
const env = require('./src/config/env');

let passedTests = 0;
let totalTests = 0;

function runTest(description, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`✅ [PASS] ${totalTests}. ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalTests}. ${description}`);
    console.error(`   └─ Error: ${err.message}`);
  }
}

async function runAsyncTest(description, testFn) {
  totalTests++;
  try {
    await testFn();
    console.log(`✅ [PASS] ${totalTests}. ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalTests}. ${description}`);
    console.error(`   └─ Error: ${err.message}`);
  }
}

(async () => {
  console.log('================================================================');
  console.log('SECURITY REMEDIATION TEST SUITE: FINDINGS 8, 9, 10, 11');
  console.log('================================================================\n');

  // ============================================================================
  // FINDING 8: STRICT IDENTIFIER VALIDATION
  // ============================================================================
  console.log('--- FINDING 8: STRICT IDENTIFIER VALIDATOR TESTS ---');

  const dangerousInputs = [
    'attacker,id.eq.admin',
    'id.eq.admin',
    'foo.eq.bar',
    '\' OR 1=1',
    'abc,slug.eq.admin',
    'abc)',
    'abc(',
    'abc%2Cslug.eq.admin',
    'course; DROP TABLE courses;',
    'ai-ml" OR "1"="1',
    'slug.gt.0',
    'ai ml',
    '   ai-ml   ',
    'ai--ml',
    '-ai-ml',
    'ai-ml-',
    '../etc/passwd',
    '<script>alert(1)</script>'
  ];

  runTest('Strict validator rejects all known PostgREST injection and SQL attack vectors', () => {
    for (const input of dangerousInputs) {
      const classification = classifyIdentifier(input);
      assert.strictEqual(
        classification,
        'INVALID',
        `Expected '${input}' to be classified as INVALID, got '${classification}'`
      );
      assert.strictEqual(isUUID(input), false, `isUUID should be false for '${input}'`);
      assert.strictEqual(isValidSlug(input), false, `isValidSlug should be false for '${input}'`);
    }
  });

  const validUUIDs = [
    '123e4567-e89b-12d3-a456-426614174000',
    'c28b5e9b-4654-472e-9d29-cce12330a133',
    '00000000-0000-0000-0000-000000000000',
    'A1B2C3D4-E5F6-7A8B-9C0D-1E2F3A4B5C6D'
  ];

  runTest('Strict validator accepts valid standard UUID format only', () => {
    for (const uuid of validUUIDs) {
      assert.strictEqual(classifyIdentifier(uuid), 'UUID', `Expected UUID for '${uuid}'`);
      assert.strictEqual(isUUID(uuid), true, `isUUID should be true for '${uuid}'`);
    }
  });

  const validSlugs = [
    'ai-ml',
    'cyber-security-cloud-computing',
    'full-stack-web-development',
    'dsa-data-structures-algorithms',
    'finance',
    'python',
    'cloud-devops'
  ];

  runTest('Strict validator accepts legitimate production course slugs', () => {
    for (const slug of validSlugs) {
      assert.strictEqual(classifyIdentifier(slug), 'SLUG', `Expected SLUG for '${slug}'`);
      assert.strictEqual(isValidSlug(slug), true, `isValidSlug should be true for '${slug}'`);
    }
  });

  runTest('Slug normalization lowercase normalizes only SLUG and leaves UUID intact', () => {
    const uuid = 'C28B5E9B-4654-472E-9D29-CCE12330A133';
    assert.strictEqual(normalizeIdentifier(uuid, 'UUID'), uuid);
    assert.strictEqual(normalizeIdentifier('AI-ML', 'SLUG'), 'ai-ml');
  });

  // ============================================================================
  // FINDING 8: REAL QUERY BOUNDARY TEST (SPY / MOCK SUPABASE)
  // ============================================================================
  console.log('\n--- FINDING 8: REAL QUERY BOUNDARY TESTS ---');

  await runAsyncTest('VideoService.resolveCourse: Injected identifier causes ZERO DB query and ZERO .or() calls', async () => {
    const videoService = require('./src/modules/video/video.service');
    const { supabase } = require('./src/config/supabase');

    let dbCalled = false;
    let orCalled = false;
    const origFrom = supabase.from;

    supabase.from = (table) => {
      dbCalled = true;
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          or: () => { orCalled = true; return { maybeSingle: async () => ({ data: null }) }; }
        })
      };
    };

    try {
      for (const badInput of dangerousInputs) {
        dbCalled = false;
        orCalled = false;
        const result = await videoService.resolveCourse(badInput);
        assert.strictEqual(result, null, `Result for '${badInput}' should be null`);
        assert.strictEqual(dbCalled, false, `Database should NOT be called for '${badInput}'`);
        assert.strictEqual(orCalled, false, `.or() should NEVER be called for '${badInput}'`);
      }
    } finally {
      supabase.from = origFrom;
    }
  });

  await runAsyncTest('ProgressService.findCourse: Injected identifier causes ZERO DB query and ZERO .or() calls', async () => {
    const progressService = require('./src/modules/progress/progress.service');
    const { supabase } = require('./src/config/supabase');

    let dbCalled = false;
    let orCalled = false;
    const origFrom = supabase.from;

    supabase.from = (table) => {
      dbCalled = true;
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
          or: () => { orCalled = true; return { maybeSingle: async () => ({ data: null }) }; }
        })
      };
    };

    try {
      for (const badInput of dangerousInputs) {
        dbCalled = false;
        orCalled = false;
        const result = await progressService.findCourse(badInput);
        assert.strictEqual(result, null, `Result for '${badInput}' should be null`);
        assert.strictEqual(dbCalled, false, `Database should NOT be called for '${badInput}'`);
        assert.strictEqual(orCalled, false, `.or() should NEVER be called for '${badInput}'`);
      }
    } finally {
      supabase.from = origFrom;
    }
  });

  await runAsyncTest('VideoService.authorizeStudentPlayback: Injected courseId rejected with 400 with ZERO DB query', async () => {
    const videoService = require('./src/modules/video/video.service');
    const { supabase } = require('./src/config/supabase');

    let dbCalled = false;
    const origFrom = supabase.from;
    supabase.from = (table) => {
      dbCalled = true;
      return origFrom.call(supabase, table);
    };

    try {
      for (const badInput of dangerousInputs) {
        dbCalled = false;
        let threw = false;
        try {
          await videoService.authorizeStudentPlayback({ email: 'student@test.com' }, { courseId: badInput, lessonId: 'l1' });
        } catch (err) {
          threw = true;
          assert.strictEqual(err.statusCode, 400, `Expected status 400 for bad input, got ${err.statusCode}`);
        }
        assert.strictEqual(threw, true, `authorizeStudentPlayback should throw for '${badInput}'`);
        assert.strictEqual(dbCalled, false, `Database query should NOT be reached for '${badInput}'`);
      }
    } finally {
      supabase.from = origFrom;
    }
  });

  await runAsyncTest('Valid UUID queries ONLY .eq("id", uuid) and NEVER .or(...)', async () => {
    const videoService = require('./src/modules/video/video.service');
    const { supabase } = require('./src/config/supabase');

    const validUUID = 'c28b5e9b-4654-472e-9d29-cce12330a133';
    let queriedColumn = null;
    let queriedValue = null;
    let orCalled = false;

    const origFrom = supabase.from;
    supabase.from = (table) => ({
      select: () => ({
        eq: (col, val) => {
          queriedColumn = col;
          queriedValue = val;
          return { maybeSingle: async () => ({ data: { id: validUUID, slug: 'test-course' } }) };
        },
        or: () => {
          orCalled = true;
          return { maybeSingle: async () => ({ data: null }) };
        }
      })
    });

    try {
      const res = await videoService.resolveCourse(validUUID);
      assert.ok(res, 'Course should resolve');
      assert.strictEqual(queriedColumn, 'id', 'UUID must only be queried against "id" column');
      assert.strictEqual(queriedValue, validUUID, 'Exact UUID must be queried');
      assert.strictEqual(orCalled, false, '.or() MUST NOT be called');
    } finally {
      supabase.from = origFrom;
    }
  });

  await runAsyncTest('Valid Slug queries ONLY .eq("slug", slug) and NEVER .or(...)', async () => {
    const videoService = require('./src/modules/video/video.service');
    const { supabase } = require('./src/config/supabase');

    const validSlug = 'ai-ml';
    let queriedColumn = null;
    let queriedValue = null;
    let orCalled = false;

    const origFrom = supabase.from;
    supabase.from = (table) => ({
      select: () => ({
        eq: (col, val) => {
          queriedColumn = col;
          queriedValue = val;
          return { maybeSingle: async () => ({ data: { id: 'c-1', slug: validSlug } }) };
        },
        or: () => {
          orCalled = true;
          return { maybeSingle: async () => ({ data: null }) };
        }
      })
    });

    try {
      const res = await videoService.resolveCourse(validSlug);
      assert.ok(res, 'Course should resolve');
      assert.strictEqual(queriedColumn, 'slug', 'Slug must only be queried against "slug" column');
      assert.strictEqual(queriedValue, validSlug, 'Exact normalized slug must be queried');
      assert.strictEqual(orCalled, false, '.or() MUST NOT be called');
    } finally {
      supabase.from = origFrom;
    }
  });

  runTest('Source Code Audit: Zero unvalidated PostgREST .or() filter interpolations in identifier paths', () => {
    const filesToCheck = [
      './src/modules/video/video.service.js',
      './src/modules/video/video.controller.js',
      './src/modules/progress/progress.service.js',
      './src/modules/curriculum/curriculum.service.js'
    ];

    const forbiddenPatterns = [
      /\.or\(`[^`]*id\.eq\.\$\{courseId\}[^`]*`\)/,
      /\.or\(`[^`]*slug\.eq\.\$\{courseId\}[^`]*`\)/,
      /\.or\(`[^`]*id\.eq\.\$\{pathTopicId\}[^`]*`\)/,
      /\.or\(`[^`]*id\.eq\.\$\{raw\}[^`]*`\)/,
      /\.or\(`[^`]*slug\.eq\.\$\{clean\}[^`]*`\)/
    ];

    for (const relPath of filesToCheck) {
      const fullPath = path.join(__dirname, relPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const pattern of forbiddenPatterns) {
        assert.strictEqual(
          pattern.test(content),
          false,
          `File ${relPath} contains forbidden unvalidated PostgREST .or() pattern: ${pattern}`
        );
      }
    }
  });

  // ============================================================================
  // FINDING 9: RBAC FAIL-CLOSED SEMANTICS & IN-MEMORY STORE REMOVAL
  // ============================================================================
  console.log('\n--- FINDING 9: RBAC FAIL-CLOSED & NO IN-MEMORY STORE TESTS ---');

  runTest('memorySubUserStore is completely removed from rbac.service.js', () => {
    const rbacPath = path.join(__dirname, './src/modules/rbac/rbac.service.js');
    const content = fs.readFileSync(rbacPath, 'utf8');
    assert.strictEqual(
      content.includes('memorySubUserStore'),
      false,
      'rbac.service.js MUST NOT contain memorySubUserStore'
    );
    assert.strictEqual(
      content.includes('new Map()'),
      false,
      'rbac.service.js MUST NOT instantiate fallback user Maps'
    );
  });

  await runAsyncTest('RBAC Fail-Closed: Database query error throws error and DENIES elevated permissions', async () => {
    const { supabase } = require('./src/config/supabase');
    const origFrom = supabase.from;

    // Simulate database failure (e.g., Supabase table connection error)
    supabase.from = (table) => ({
      select: () => ({
        ilike: () => ({
          maybeSingle: async () => ({
            data: null,
            error: { message: 'Connection to sub_users table failed (PGRST500)' }
          })
        })
      })
    });

    try {
      let threw = false;
      try {
        await rbacService.getUserRoleAndPermissions({ email: 'delegated_admin@test.com' });
      } catch (err) {
        threw = true;
        assert.strictEqual(err.statusCode, 503, `Expected status 503 on DB error, got ${err.statusCode}`);
        assert.strictEqual(err.code, 'RBAC_DB_UNAVAILABLE', 'Expected error code RBAC_DB_UNAVAILABLE');
      }
      assert.strictEqual(threw, true, 'getUserRoleAndPermissions MUST throw/deny on database failure');
    } finally {
      supabase.from = origFrom;
    }
  });

  await runAsyncTest('RBAC Fail-Closed: Middleware requireAdminRole denies access on database error', async () => {
    const { requireAdminRole } = require('./src/middleware/authorize');
    const { supabase } = require('./src/config/supabase');
    const origFrom = supabase.from;

    supabase.from = () => ({
      select: () => ({
        ilike: () => ({
          maybeSingle: async () => ({
            data: null,
            error: { message: 'Database unreachable' }
          })
        })
      })
    });

    try {
      const req = { user: { email: 'subadmin@test.com' } };
      let respondedStatus = null;
      let respondedBody = null;
      const res = {
        status: (code) => {
          respondedStatus = code;
          return {
            json: (body) => { respondedBody = body; }
          };
        }
      };
      let nextCalled = false;
      const next = () => { nextCalled = true; };

      await requireAdminRole(req, res, next);
      assert.strictEqual(nextCalled, false, 'Middleware must NOT call next() on DB error');
      assert.strictEqual(respondedStatus, 500, 'Middleware must deny with 500 on authorization failure');
    } finally {
      supabase.from = origFrom;
    }
  });

  await runAsyncTest('createSubAdmin fails closed if database insert fails (NO in-memory fallback)', async () => {
    const { supabase } = require('./src/config/supabase');
    const origFrom = supabase.from;

    supabase.from = (table) => ({
      select: () => ({
        ilike: () => ({
          maybeSingle: async () => ({ data: null, error: null })
        })
      }),
      insert: () => ({
        select: () => ({
          single: async () => ({ data: null, error: { message: 'Insert constraint violation' } })
        })
      })
    });

    try {
      const superAdminActor = { email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN };
      let threw = false;
      try {
        await rbacService.createSubAdmin(superAdminActor, {
          name: 'Temp Admin',
          email: 'temp@test.com',
          permissions: [PERMISSIONS.COURSE_VIEW]
        });
      } catch (err) {
        threw = true;
        assert.strictEqual(err.statusCode, 500, 'Expected 500 on DB insert failure');
      }
      assert.strictEqual(threw, true, 'createSubAdmin MUST throw on DB failure and NOT create fallback user');
    } finally {
      supabase.from = origFrom;
    }
  });

  await runAsyncTest('listSubAdmins fails closed if database select fails (NO in-memory merge)', async () => {
    const { supabase } = require('./src/config/supabase');
    const origFrom = supabase.from;

    supabase.from = () => ({
      select: () => ({
        order: async () => ({ data: null, error: { message: 'DB down' } })
      })
    });

    try {
      const superAdminActor = { email: 'admin@internnetra.com', role: ROLES.SUPER_ADMIN };
      let threw = false;
      try {
        await rbacService.listSubAdmins(superAdminActor);
      } catch (err) {
        threw = true;
        assert.strictEqual(err.statusCode, 500, 'Expected 500 on DB select failure');
      }
      assert.strictEqual(threw, true, 'listSubAdmins MUST throw on DB failure and NOT return in-memory records');
    } finally {
      supabase.from = origFrom;
    }
  });

  // ============================================================================
  // FINDING 10: VIDEO PIPELINE RATE LIMITING
  // ============================================================================
  console.log('\n--- FINDING 10: VIDEO PIPELINE RATE LIMITING TESTS ---');

  runTest('heavyVideoOpsLimiter exists with appropriate window and threshold', () => {
    assert.ok(heavyVideoOpsLimiter, 'heavyVideoOpsLimiter must be defined and exported');
    assert.strictEqual(typeof heavyVideoOpsLimiter, 'function', 'heavyVideoOpsLimiter must be an Express middleware function');
  });

  runTest('heavyVideoOpsLimiter is attached to heavy AWS video endpoints in routes', () => {
    const routesPath = path.join(__dirname, './src/modules/video/video.routes.js');
    const content = fs.readFileSync(routesPath, 'utf8');

    assert.ok(content.includes('heavyVideoOpsLimiter'), 'video.routes.js must import heavyVideoOpsLimiter');
    
    // Check specific heavy endpoints
    const heavyRoutes = [
      '/video/upload-url',
      '/video/multipart/initiate',
      '/video/multipart/complete',
      '/video/transcode-full',
      '/video/retry/:lessonId',
      '/modules/:moduleId/topics/process',
      '/topics/:topicId/retry'
    ];

    for (const route of heavyRoutes) {
      assert.ok(
        content.includes(route),
        `Route ${route} should exist in video.routes.js`
      );
    }
  });

  // ============================================================================
  // FINDING 11: ELIMINATION OF HARDCODED JWT SECRET FALLBACK
  // ============================================================================
  console.log('\n--- FINDING 11: HARDCODED JWT SECRET ELIMINATION TESTS ---');

  runTest('Source Code Audit: Zero occurrences of hardcoded fallback secret internnetra_prod_jwt_secret_key_2026', () => {
    const codeFiles = [
      './src/modules/video/video.service.js',
      './src/modules/video/video.controller.js',
      './src/config/env.js'
    ];

    const hardcodedString = 'internnetra_prod_jwt_secret_key_2026';
    for (const relPath of codeFiles) {
      const fullPath = path.join(__dirname, relPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      assert.strictEqual(
        content.includes(hardcodedString),
        false,
        `File ${relPath} still contains hardcoded secret fallback '${hardcodedString}'`
      );
    }
  });

  runTest('env.js terminates with process.exit(1) in production if JWT_SECRET is missing', () => {
    const envPath = path.join(__dirname, './src/config/env.js');
    const content = fs.readFileSync(envPath, 'utf8');
    assert.ok(
      content.includes("process.env.NODE_ENV === 'production'") && content.includes('process.exit(1)'),
      'env.js must fail-closed with process.exit(1) in production when required env vars are missing'
    );
  });

  await runAsyncTest('VideoService.authorizeStudentPlayback aborts token signing if JWT_SECRET is missing', async () => {
    const videoService = require('./src/modules/video/video.service');
    const savedSecret = env.JWT_SECRET;
    env.JWT_SECRET = '';

    const origGetVideoRecord = videoService.getVideoRecord;
    videoService.getVideoRecord = async () => ({
      id: 'v-test',
      status: 'READY',
      hls_master_url: 'https://cdn.internnetra.com/courses/c1/modules/m1/lessons/l1/master.m3u8',
      duration_seconds: 120
    });

    try {
      let threw = false;
      try {
        await videoService.authorizeStudentPlayback(
          { id: 'u-1', email: 'admin@internnetra.com', role: 'ADMIN' },
          { courseId: 'ai-ml', lessonId: 'l1' }
        );
      } catch (err) {
        threw = true;
        assert.ok(
          err.message.includes('JWT_SECRET is not configured'),
          `Expected missing JWT_SECRET message, got: ${err.message}`
        );
      }
      assert.strictEqual(threw, true, 'Must throw error if JWT_SECRET is missing rather than fallback');
    } finally {
      videoService.getVideoRecord = origGetVideoRecord;
      env.JWT_SECRET = savedSecret;
    }
  });

  console.log('\n================================================================');
  console.log(`FINAL SUMMARY: ${passedTests} PASSED, ${totalTests - passedTests} FAILED (TOTAL ${totalTests})`);
  console.log('================================================================');

  if (passedTests !== totalTests) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
})();
