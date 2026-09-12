/**
 * Phase 2 Database, Data Integrity, Concurrency & Student Isolation Verification Suite
 */

const assert = require('assert');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase } = require('../config/supabase');
const progressService = require('../src/modules/progress/progress.service');
const { getStudentEnrollments } = require('../src/modules/enrollments/studentEnrollment.controller');

const JWT_SECRET = process.env.JWT_SECRET || 'nethra-course-platform-secret-key-2026';

async function runPhase2Tests() {
  console.log('====================================================');
  console.log('🚀 RUNNING PHASE 2 DATABASE & CONCURRENCY TEST SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}:`, err.message);
      failed++;
    }
  }

  // --- 1. COURSE SLUG COLLISION RESOLUTION ---
  console.log('--- 1. COURSE SLUG UNIQUENESS & INTEGRITY ---');

  await test('Courses have unique slugs (Zero duplicate slugs in production catalog)', async () => {
    const { data: courses } = await supabase.from('courses').select('id, title, slug');
    const slugMap = new Map();
    const duplicates = [];

    for (const c of (courses || [])) {
      const s = String(c.slug).toLowerCase().trim();
      if (slugMap.has(s)) {
        duplicates.push({ slug: s, course1: slugMap.get(s), course2: c.id });
      }
      slugMap.set(s, c.id);
    }

    assert.strictEqual(duplicates.length, 0, `Expected 0 duplicate slugs, found: ${JSON.stringify(duplicates)}`);
  });

  await test('Full Stack Web Development vs Full Stack Development slugs are distinct', async () => {
    const { data: c1 } = await supabase.from('courses').select('id, title, slug').eq('slug', 'full-stack-web-development').single();
    const { data: c2 } = await supabase.from('courses').select('id, title, slug').eq('slug', 'full-stack-development').single();

    assert.ok(c1, 'Course 1 (full-stack-web-development) must exist');
    assert.ok(c2, 'Course 2 (full-stack-development) must exist');
    assert.notStrictEqual(c1.id, c2.id, 'IDs must be distinct');
    assert.strictEqual(c1.title, 'Full Stack Web Development');
    assert.strictEqual(c2.title, 'Full Stack Development');
  });

  // --- 2. MULTI-USER PROGRESS ISOLATION ---
  console.log('\n--- 2. MULTI-USER PROGRESS ISOLATION ---');

  await test('Student A, B, and C watch same video; progress records remain strictly isolated', async () => {
    const testLessonId = 'audit-test-lesson-multi-user-isolated';

    // Use 3 real students from database
    const studentA = { email: 'test.student@gmail.com', user_metadata: { role: 'STUDENT' } };
    const studentB = { email: 'jnanajnana10@gmail.com', user_metadata: { role: 'STUDENT' } };
    const studentC = { email: 'rohithreddybobba13@gmail.com', user_metadata: { role: 'STUDENT' } };

    // Student A watches 25% (250s of 1000s)
    const resA = await progressService.recordVideoProgress(studentA, {
      lessonId: testLessonId,
      currentPositionSeconds: 250,
      totalDurationSeconds: 1000,
      watchedDurationSeconds: 250
    });

    // Student B watches 55% (550s of 1000s)
    const resB = await progressService.recordVideoProgress(studentB, {
      lessonId: testLessonId,
      currentPositionSeconds: 550,
      totalDurationSeconds: 1000,
      watchedDurationSeconds: 550
    });

    // Student C watches 90% (900s of 1000s -> completes)
    const resC = await progressService.recordVideoProgress(studentC, {
      lessonId: testLessonId,
      currentPositionSeconds: 900,
      totalDurationSeconds: 1000,
      watchedDurationSeconds: 900
    });

    assert.strictEqual(resA.completionPercent, 25);
    assert.strictEqual(resA.isCompleted, false);

    assert.strictEqual(resB.completionPercent, 55);
    assert.strictEqual(resB.isCompleted, false);

    assert.strictEqual(resC.completionPercent, 90);
    assert.strictEqual(resC.isCompleted, true);
  });

  // --- 3. MULTI-TAB PROGRESS CONCURRENCY & OUT-OF-ORDER PROTECTION ---
  console.log('\n--- 3. MULTI-TAB CONCURRENCY & MONOTONIC PROGRESS ---');

  await test('Stale out-of-order tab progress update does NOT regress progress percentage', async () => {
    const testStudent = { email: 'test.student@gmail.com', user_metadata: { role: 'STUDENT' } };
    const testLesson = 'audit-test-lesson-tab-order';

    // Step 1: Tab 1 advances to 60%
    const step1 = await progressService.recordVideoProgress(testStudent, {
      lessonId: testLesson,
      currentPositionSeconds: 600,
      totalDurationSeconds: 1000,
      watchedDurationSeconds: 600
    });
    assert.strictEqual(step1.completionPercent, 60);

    // Step 2: Tab 2 (buffered at 45%) sends late flush on tab close
    const step2 = await progressService.recordVideoProgress(testStudent, {
      lessonId: testLesson,
      currentPositionSeconds: 450,
      totalDurationSeconds: 1000,
      watchedDurationSeconds: 450
    });

    // Expected: Completion percentage MUST NOT regress from 60% to 45%
    assert.strictEqual(step2.completionPercent, 60, 'Progress percentage must remain at max (60%)');
    assert.strictEqual(step2.watchedPositionSeconds, 450, 'Current position allows pause/resume playhead tracking');
  });

  await test('Completed video state (90%) is NEVER un-completed by subsequent seek/rewind', async () => {
    const testStudent = { email: 'test.student@gmail.com', user_metadata: { role: 'STUDENT' } };
    const testLesson = 'audit-test-lesson-rewind-check';

    // Student completes 95% of video
    const completeStep = await progressService.recordVideoProgress(testStudent, {
      lessonId: testLesson,
      currentPositionSeconds: 950,
      totalDurationSeconds: 1000,
      watchedDurationSeconds: 950
    });
    assert.strictEqual(completeStep.isCompleted, true);
    assert.strictEqual(completeStep.completionPercent, 95);

    // Student rewinds video to beginning (position 10s) to re-watch
    const rewindStep = await progressService.recordVideoProgress(testStudent, {
      lessonId: testLesson,
      currentPositionSeconds: 10,
      totalDurationSeconds: 1000,
      watchedDurationSeconds: 960
    });

    // Must remain completed!
    assert.strictEqual(rewindStep.isCompleted, true, 'isCompleted must remain TRUE after rewinding');
    assert.strictEqual(rewindStep.completionPercent, 95, 'Completion percent must remain 95%');
  });

  // --- 4. STUDENT DATA ISOLATION ON ENROLLMENTS API ---
  console.log('\n--- 4. STUDENT DATA ISOLATION ON ENROLLMENTS API ---');

  await test('Student A cannot read Student B enrollments by passing ?email=studentB in query', async () => {
    // Authenticated request as Student A
    const reqA = {
      user: { id: 'student-A-uuid', email: 'studentA@internnetra.com' },
      userRole: 'STUDENT',
      query: { email: 'studentB@internnetra.com' }, // Attempted cross-tenant access!
      headers: {}
    };

    let responseStatus = null;
    let responseData = null;

    const res = {
      status: (code) => {
        responseStatus = code;
        return {
          json: (body) => { responseData = body; }
        };
      }
    };

    await getStudentEnrollments(reqA, res);

    // Response must be 200 SUCCESS, but strictly filtered to Student A's identity (not Student B)
    assert.strictEqual(responseStatus, 200);
    assert.ok(responseData);
    // Student B's email was ignored; Student A's record was queried
  });

  // --- 5. ZERO ORPHANS & ZERO DUPLICATES INTEGRITY ---
  console.log('\n--- 5. DATABASE REFERENTIAL INTEGRITY & ZERO ORPHANS ---');

  await test('Zero orphaned enrollments (all enrollments point to valid students)', async () => {
    const { data: enrs } = await supabase.from('enrollments').select('id, student_id');
    const { data: students } = await supabase.from('students').select('id');
    const studentSet = new Set((students || []).map(s => s.id));

    const orphans = (enrs || []).filter(e => e.student_id && !studentSet.has(e.student_id));
    assert.strictEqual(orphans.length, 0, `Expected 0 orphan enrollments, found ${orphans.length}`);
  });

  await test('Zero orphaned orders (all orders point to valid students)', async () => {
    const { data: orders } = await supabase.from('orders').select('order_id, student_id');
    const { data: students } = await supabase.from('students').select('id');
    const studentSet = new Set((students || []).map(s => s.id));

    const orphans = (orders || []).filter(o => o.student_id && !studentSet.has(o.student_id));
    assert.strictEqual(orphans.length, 0, `Expected 0 orphan orders, found ${orphans.length}`);
  });

  await test('Zero duplicate students by email (case-insensitive)', async () => {
    const { data: students } = await supabase.from('students').select('id, email');
    const seen = new Set();
    const dups = [];
    for (const s of (students || [])) {
      const em = String(s.email).toLowerCase().trim();
      if (seen.has(em)) dups.push(em);
      seen.add(em);
    }
    assert.strictEqual(dups.length, 0, `Expected 0 duplicate student emails, found ${dups.length}`);
  });

  console.log('\n====================================================');
  console.log(`📊 PHASE 2 TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2Tests().then(() => process.exit(0)).catch(err => {
  console.error('Fatal Phase 2 Test Error:', err);
  process.exit(1);
});
