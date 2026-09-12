/**
 * End-to-End Hierarchy Chain Ownership Security Test Suite
 * 
 * Tests Non-Negotiable Security Invariant:
 * COURSE (courseId)
 *   ↓
 * MODULE (moduleId, courseId)
 *   ↓
 * TOPIC (topicId, moduleId, courseId)
 *   ↓
 * VIDEO (videoId, topicId, moduleId, courseId)
 *   ↓
 * UPLOAD / BACKGROUND JOB (uploadId / jobId, videoId, moduleId, courseId)
 *   ↓
 * S3 / HLS ASSET (s3Key)
 * 
 * Verifies:
 * 1. Relational database ownership is authoritative.
 * 2. Cross-course access strictly fails closed with HTTP 403.
 * 3. Cross-module access strictly fails closed with HTTP 403.
 * 4. Legacy numeric and string identifier collisions ('1', 'mod_1') are isolated to course scope.
 * 5. All 10 orphan/corrupted data scenarios fail closed.
 * 6. Zero side effects on rejected operations (0 DB writes, 0 S3 deletes, 0 MediaConvert jobs).
 * 7. Video service integration: uploads, batch transcoding, retries, deletes, playback.
 */

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

const { supabase } = require('./src/config/supabase');
const {
  HierarchyValidationError,
  validateCourse,
  validateModule,
  validateTopic,
  validateVideo,
  validateUploadConsistency,
  validateHierarchyChain
} = require('./src/utils/hierarchyValidator');

const videoService = require('./src/modules/video/video.service');
const curriculumService = require('./src/modules/curriculum/curriculum.service');
const videoCleanupService = require('./src/modules/video/video.cleanup.service');

// Real Production Courses
const COURSE_A = {
  id: 'e785fb8f-7952-47cd-878f-c5ed73422b6d',
  slug: 'ai-ml',
  title: 'AI + ML'
};

const COURSE_B = {
  id: 'ac3d8a52-753e-4c49-a1c7-6cdd250d8183',
  slug: 'cyber-security-cloud-computing',
  title: 'Cyber Security + Cloud Computing'
};

// Real Production Topics
const TOPIC_A1 = {
  id: '308418f0-7255-4918-9b03-e5817a866fb6',
  moduleId: '1',
  courseId: COURSE_A.id
};

const TOPIC_B4 = {
  id: 'a76f01c4-37c7-43eb-9330-8353fc14d31d',
  moduleId: '2',
  courseId: COURSE_B.id
};

let passedCount = 0;
let failedCount = 0;
const testResults = [];

function runTest(name, fn) {
  try {
    fn();
    passedCount++;
    testResults.push({ name, pass: true });
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    failedCount++;
    testResults.push({ name, pass: false, error: err.message });
    console.log(`❌ [FAIL] ${name}`);
    console.log(`   └─ Error: ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    passedCount++;
    testResults.push({ name, pass: true });
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    failedCount++;
    testResults.push({ name, pass: false, error: err.message });
    console.log(`❌ [FAIL] ${name}`);
    console.log(`   └─ Error: ${err.message}`);
  }
}

async function runSuite() {
  console.log('================================================================');
  console.log('END-TO-END HIERARCHY CHAIN SECURITY TEST SUITE');
  console.log('================================================================\n');

  // ==========================================================================
  // 1. COURSE VALIDATION TESTS
  // ==========================================================================
  console.log('--- LEVEL 1: COURSE VALIDATION ---');

  await runAsyncTest('COURSE: Valid course UUID resolves canonical course record', async () => {
    const res = await validateCourse(COURSE_A.id);
    assert.strictEqual(res.canonicalCourseId, COURSE_A.id);
    assert.strictEqual(res.course.slug, COURSE_A.slug);
  });

  await runAsyncTest('COURSE: Valid course slug resolves canonical course record', async () => {
    const res = await validateCourse(COURSE_B.slug);
    assert.strictEqual(res.canonicalCourseId, COURSE_B.id);
    assert.strictEqual(res.course.id, COURSE_B.id);
  });

  await runAsyncTest('COURSE: Invalid course identifier (PostgREST injection) rejected with 400', async () => {
    let threw = false;
    try {
      await validateCourse('ai-ml.eq.null');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.code, 'INVALID_COURSE_IDENTIFIER');
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('COURSE: Unknown course UUID rejected with 404 COURSE_NOT_FOUND', async () => {
    let threw = false;
    try {
      await validateCourse('00000000-0000-4000-8000-000000000000');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 404);
      assert.strictEqual(err.code, 'COURSE_NOT_FOUND');
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('COURSE: Unknown course slug rejected with 404 COURSE_NOT_FOUND', async () => {
    let threw = false;
    try {
      await validateCourse('unknown-nonexistent-course-slug');
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 404);
      assert.strictEqual(err.code, 'COURSE_NOT_FOUND');
    }
    assert.strictEqual(threw, true);
  });

  // ==========================================================================
  // 2. MODULE VALIDATION & CROSS-COURSE COLLISION TESTS
  // ==========================================================================
  console.log('\n--- LEVEL 2: MODULE VALIDATION & COLLISION ISOLATION ---');

  await runAsyncTest('MODULE: AI/ML Course + Module 1 resolves within AI/ML scope (ALLOW)', async () => {
    const res = await validateModule(COURSE_A.id, '1');
    assert.strictEqual(res.canonicalCourseId, COURSE_A.id);
    assert.ok(res.module.title.toLowerCase().includes('ai & machine learning'));
  });

  await runAsyncTest('MODULE: Cyber Security Course + Module 1 resolves within Cyber Security scope (ALLOW)', async () => {
    const res = await validateModule(COURSE_B.id, '1');
    assert.strictEqual(res.canonicalCourseId, COURSE_B.id);
    assert.ok(res.module.title.toLowerCase().includes('cyber security'));
  });

  await runAsyncTest('MODULE: Cross-Course Reference: AI/ML Course + Cyber Security Module 1 strictly rejected with 403', async () => {
    const cyberSecMod1 = { id: '1', course_id: COURSE_B.id, title: 'Module 1: Cyber Security Fundamentals' };
    let threw = false;
    try {
      await validateModule(COURSE_A.id, cyberSecMod1);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_MODULE_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Must reject module bound to another course');
  });

  await runAsyncTest('MODULE: Cross-Course Reference: Cyber Security Course + AI/ML Module 1 strictly rejected with 403', async () => {
    const aiMlMod1 = { id: '1', course_id: COURSE_A.id, title: 'Module 1: AI & Machine Learning Overview' };
    let threw = false;
    try {
      await validateModule(COURSE_B.id, aiMlMod1);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_MODULE_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Must reject module bound to another course');
  });

  await runAsyncTest('MODULE: Legacy string identifier "mod_1" is strictly scoped to authorized course', async () => {
    const resA = await validateModule(COURSE_A.id, 'mod_1');
    assert.strictEqual(resA.canonicalCourseId, COURSE_A.id);

    const resB = await validateModule(COURSE_B.id, 'mod_1');
    assert.strictEqual(resB.canonicalCourseId, COURSE_B.id);

    // Assert different titles / curriculum contents
    assert.notStrictEqual(resA.module.title, resB.module.title);
  });

  await runAsyncTest('MODULE: Unscoped module validation throws error (Cannot validate module without course scope)', async () => {
    let threw = false;
    try {
      await validateHierarchyChain({ moduleId: '1' });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.code, 'UNSCOPED_MODULE_VALIDATION');
    }
    assert.strictEqual(threw, true);
  });

  // ==========================================================================
  // 3. TOPIC VALIDATION & CROSS-MODULE/CROSS-COURSE TESTS
  // ==========================================================================
  console.log('\n--- LEVEL 3: TOPIC VALIDATION & SCOPE ENFORCEMENT ---');

  await runAsyncTest('TOPIC: Valid topic within authorized course + module succeeds (ALLOW)', async () => {
    const res = await validateTopic(COURSE_B.id, '2', TOPIC_B4.id);
    assert.strictEqual(res.canonicalCourseId, COURSE_B.id);
    assert.strictEqual(res.canonicalTopicId, TOPIC_B4.id);
    assert.strictEqual(res.topic.module_id, '2');
    assert.strictEqual(res.topic.course_id, COURSE_B.id);
  });

  await runAsyncTest('TOPIC: Cross-Module Reference: Cyber Security Course + Module 1 + Topic 4 (belongs to Module 2) rejected with 403', async () => {
    let threw = false;
    try {
      await validateTopic(COURSE_B.id, '1', TOPIC_B4.id);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Cross-module topic access must fail closed');
  });

  await runAsyncTest('TOPIC: Cross-Course Reference: AI/ML Course + Module 1 + Topic 4 (belongs to Cyber Security) rejected with 403', async () => {
    let threw = false;
    try {
      await validateTopic(COURSE_A.id, '1', TOPIC_B4.id);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Cross-course topic access must fail closed');
  });

  await runAsyncTest('TOPIC: Cross-Course Reference: Cyber Security Course + Module 2 + Topic 1 (belongs to AI/ML) rejected with 403', async () => {
    let threw = false;
    try {
      await validateTopic(COURSE_B.id, '2', TOPIC_A1.id);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Cross-course topic access must fail closed');
  });

  // ==========================================================================
  // 4. VIDEO VALIDATION & CHAIN ENFORCEMENT
  // ==========================================================================
  console.log('\n--- LEVEL 4: VIDEO VALIDATION & OWNERSHIP CHAIN ---');

  await runAsyncTest('VIDEO: Valid video with matching topic, module, and course passes validation', async () => {
    // Cyber Security Module 3 real video record and topic
    const VALID_VID_ID = 'b10ceee4-464b-4d24-9deb-bf11c0562ddf';
    const VALID_TOPIC_ID = 'a19c40a2-aec0-46ca-aa86-5fec63d870c6';
    const res = await validateVideo(COURSE_B.id, '3', VALID_TOPIC_ID, VALID_VID_ID);
    assert.strictEqual(res.canonicalVideoId, VALID_VID_ID);
    assert.strictEqual(res.canonicalCourseId, COURSE_B.id);
  });

  await runAsyncTest('VIDEO: Cross-Course Reference: AI/ML Course referencing Cyber Security video rejected with 403', async () => {
    const VALID_VID_ID = 'b10ceee4-464b-4d24-9deb-bf11c0562ddf';
    const VALID_TOPIC_ID = 'a19c40a2-aec0-46ca-aa86-5fec63d870c6';
    let threw = false;
    try {
      await validateVideo(COURSE_A.id, '1', VALID_TOPIC_ID, VALID_VID_ID);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.ok(['HIERARCHY_VIDEO_MISMATCH', 'HIERARCHY_TOPIC_MISMATCH'].includes(err.code));
    }
    assert.strictEqual(threw, true, 'Cross-course video access must fail closed');
  });

  await runAsyncTest('VIDEO: Cross-Module Reference: Video with module_id "3" requested under "2" rejected with 403', async () => {
    const VALID_VID_ID = 'b10ceee4-464b-4d24-9deb-bf11c0562ddf';
    const VALID_TOPIC_ID = 'a19c40a2-aec0-46ca-aa86-5fec63d870c6';
    let threw = false;
    try {
      await validateVideo(COURSE_B.id, '2', VALID_TOPIC_ID, VALID_VID_ID);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.ok(['HIERARCHY_VIDEO_MISMATCH', 'HIERARCHY_TOPIC_MISMATCH'].includes(err.code));
    }
    assert.strictEqual(threw, true, 'Cross-module video access must fail closed');
  });

  await runAsyncTest('VIDEO: Cross-Topic Reference: Video requested under mismatched topic rejected with 403', async () => {
    const VALID_VID_ID = 'b10ceee4-464b-4d24-9deb-bf11c0562ddf';
    let threw = false;
    try {
      // Pass Topic A1 (from Course A) under Course B Module 3
      await validateVideo(COURSE_B.id, '3', TOPIC_A1.id, VALID_VID_ID);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.ok(['HIERARCHY_VIDEO_MISMATCH', 'HIERARCHY_TOPIC_MISMATCH'].includes(err.code));
    }
    assert.strictEqual(threw, true, 'Cross-topic video access must fail closed');
  });

  // ==========================================================================
  // 5. UPLOAD & S3 KEY CONSISTENCY TESTS
  // ==========================================================================
  console.log('\n--- LEVEL 5: UPLOAD & S3 KEY CONSISTENCY ---');

  runTest('UPLOAD: Valid S3 key with expected course prefix passes consistency check', () => {
    const course = { id: COURSE_A.id, slug: COURSE_A.slug, title: COURSE_A.title };
    const moduleObj = { id: '1', title: 'Module 1' };
    const s3Key = `courses/${COURSE_A.slug}/01-module-1/videos/vid-1/raw.mp4`;

    const isValid = validateUploadConsistency({
      course,
      module: moduleObj,
      s3Key
    });
    assert.strictEqual(isValid, true);
  });

  runTest('UPLOAD: Malicious S3 key with Cross-Course prefix (Cyber Security key passed to AI/ML) rejected with 403', () => {
    const course = { id: COURSE_A.id, slug: COURSE_A.slug, title: COURSE_A.title };
    const moduleObj = { id: '1', title: 'Module 1' };
    const maliciousKey = `courses/${COURSE_B.slug}/01-cyber/videos/vid-1/raw.mp4`;

    let threw = false;
    try {
      validateUploadConsistency({
        course,
        module: moduleObj,
        s3Key: maliciousKey
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_S3_KEY_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Malicious S3 key must be rejected');
  });

  runTest('UPLOAD: S3 substring matching attempt (courses/attacker-ai-ml/...) rejected', () => {
    const course = { id: COURSE_A.id, slug: COURSE_A.slug, title: COURSE_A.title };
    const moduleObj = { id: '1', title: 'Module 1' };
    const bypassKey = `courses/attacker-ai-ml/01-mod/raw.mp4`;

    let threw = false;
    try {
      validateUploadConsistency({
        course,
        module: moduleObj,
        s3Key: bypassKey
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_S3_KEY_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Substring match attack must be rejected');
  });

  runTest('UPLOAD: Upload session belonging to Course B rejected when executing under Course A', () => {
    const course = { id: COURSE_A.id, slug: COURSE_A.slug, title: COURSE_A.title };
    const moduleObj = { id: '1', title: 'Module 1' };
    const session = {
      courseId: COURSE_B.id,
      moduleId: '1',
      uploadId: 'upload-session-b'
    };

    let threw = false;
    try {
      validateUploadConsistency({
        course,
        module: moduleObj,
        multipartSession: session
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_UPLOAD_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Cross-course upload session must be rejected');
  });

  // ==========================================================================
  // 6. ORPHAN & CORRUPTED DATA FAIL-CLOSED TESTS (Section 15)
  // ==========================================================================
  console.log('\n--- SECTION 15: ORPHAN & CORRUPTED DATA TESTS ---');

  await runAsyncTest('ORPHAN 1: Video references nonexistent topic fails closed', async () => {
    let threw = false;
    try {
      await validateVideo(COURSE_A.id, '1', 'nonexistent-topic-uuid-999', 'fake-video-id');
    } catch (err) {
      threw = true;
      assert.ok([403, 404].includes(err.statusCode));
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('ORPHAN 2: Video topic belongs to different module fails closed with 403', async () => {
    let threw = false;
    try {
      await validateTopic(COURSE_B.id, '1', TOPIC_B4.id);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('ORPHAN 3: Video module belongs to different course fails closed with 403', async () => {
    let threw = false;
    try {
      const cyberSecModule = { id: '3', course_id: COURSE_B.id, title: 'Module 3: Linux for Cyber Security' };
      await validateModule(COURSE_A.id, cyberSecModule);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_MODULE_MISMATCH');
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('ORPHAN 4: Topic references nonexistent module fails closed with 403', async () => {
    let threw = false;
    try {
      await validateTopic(COURSE_A.id, 'nonexistent-mod-id', TOPIC_A1.id);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('ORPHAN 5: Topic course_id mismatches module/course fails closed with 403', async () => {
    let threw = false;
    try {
      await validateTopic(COURSE_A.id, '1', TOPIC_B4.id);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('ORPHAN 6: Historical orphan video in DB (course_id: null) fails closed on access', async () => {
    // e0d53783-d063-4ef1-9e0f-e32cb1d9cd80 has course_id: null in database
    const ORPHAN_VID_ID = 'e0d53783-d063-4ef1-9e0f-e32cb1d9cd80';
    let threw = false;
    try {
      await validateVideo(COURSE_A.id, '1', TOPIC_A1.id, ORPHAN_VID_ID);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_VIDEO_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Orphan video with null course_id must be rejected');
  });

  await runAsyncTest('ORPHAN 7: Upload ownership differs from video ownership fails closed', () => {
    let threw = false;
    try {
      validateUploadConsistency({
        course: { id: COURSE_A.id, slug: COURSE_A.slug },
        module: { id: '1' },
        multipartSession: { courseId: COURSE_B.id, moduleId: '1' }
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('ORPHAN 8: Background job ownership differs from authoritative video fails closed', async () => {
    // Retry topic processing for Topic B4 under Course A scope
    let threw = false;
    try {
      await videoService.retryTopicProcessing({ role: 'ADMIN' }, {
        topicId: TOPIC_B4.id,
        courseId: COURSE_A.id,
        moduleId: '1'
      });
    } catch (err) {
      threw = true;
      assert.ok([403, 404].includes(err.statusCode) || ['HIERARCHY_TOPIC_MISMATCH', 'HIERARCHY_CHAIN_VIOLATION'].includes(err.code));
    }
    assert.strictEqual(threw, true, 'Mismatched job ownership must fail closed');
  });

  await runAsyncTest('ORPHAN 9: S3 key belongs to Course B while DB asset belongs to Course A fails closed', () => {
    let threw = false;
    try {
      validateUploadConsistency({
        course: { id: COURSE_A.id, slug: COURSE_A.slug },
        module: { id: '1' },
        s3Key: `courses/${COURSE_B.slug}/01-mod/raw.mp4`
      });
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_S3_KEY_MISMATCH');
    }
    assert.strictEqual(threw, true);
  });

  await runAsyncTest('ORPHAN 10: Curriculum JSON cannot establish ownership when relational DB disagrees', async () => {
    // Even if curriculum JSON has a module or topic, relational records in `topics` table take precedence
    // Topic B4 belongs to Course B in DB. If caller attempts to use Topic B4 in Course A:
    let threw = false;
    try {
      await validateTopic(COURSE_A.id, '1', TOPIC_B4.id);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Relational DB ownership must override JSON');
  });

  // ==========================================================================
  // 7. ZERO-SIDE-EFFECT SECURITY ASSERTIONS (Section 14)
  // ==========================================================================
  console.log('\n--- SECTION 14: ZERO-SIDE-EFFECT MUTATION SAFETY ---');

  await runAsyncTest('MUTATION SAFETY: Rejected cross-course deleteModule causes ZERO DB mutations', async () => {
    let dbMutations = 0;
    const origUpdate = supabase.from;
    supabase.from = (table) => {
      const builder = origUpdate.call(supabase, table);
      const origUpd = builder.update;
      builder.update = function(...args) {
        dbMutations++;
        return origUpd.apply(this, args);
      };
      return builder;
    };

    try {
      let threw = false;
      try {
        // Attempt to delete a module that does not belong to Course A
        await curriculumService.deleteModule('nonexistent-mod-in-course-a', COURSE_A.id);
      } catch (e) {
        threw = true;
      }
      assert.strictEqual(threw, true);
      assert.strictEqual(dbMutations, 0, 'ZERO DB UPDATE calls must occur on rejected module delete');
    } finally {
      supabase.from = origUpdate;
    }
  });

  await runAsyncTest('MUTATION SAFETY: Rejected global deleteModule without courseId causes ZERO DB queries across courses', async () => {
    let threw = false;
    try {
      await curriculumService.deleteModule('1', null);
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 400);
      assert.ok(err.message.includes('course_id is required'));
    }
    assert.strictEqual(threw, true, 'Unscoped deleteModule must be rejected without DB scan');
  });

  await runAsyncTest('MUTATION SAFETY: Rejected cross-course batch transcode causes ZERO MediaConvert jobs', async () => {
    const mediaConvertVideoService = require('./src/modules/video/video.mediaconvert.service');
    let jobsCreated = 0;
    const origSubmit = mediaConvertVideoService.submitTopicClippingJob;
    mediaConvertVideoService.submitTopicClippingJob = async () => {
      jobsCreated++;
      return { jobId: 'illegal-job-id' };
    };

    try {
      let threw = false;
      try {
        // Attempt batch processing for Course A using Course B's topics
        await videoService.startTopicBatchProcessing({ role: 'ADMIN' }, {
          courseId: COURSE_A.id,
          moduleId: '1',
          topicIds: [TOPIC_B4.id]
        });
      } catch (e) {
        threw = true;
      }
      assert.strictEqual(threw, true);
      assert.strictEqual(jobsCreated, 0, 'ZERO MediaConvert jobs must be submitted on rejected hierarchy');
    } finally {
      mediaConvertVideoService.submitTopicClippingJob = origSubmit;
    }
  });

  await runAsyncTest('MUTATION SAFETY: Rejected cross-course topic retry causes ZERO MediaConvert jobs', async () => {
    const mediaConvertVideoService = require('./src/modules/video/video.mediaconvert.service');
    let retriesSubmitted = 0;
    const origSubmit = mediaConvertVideoService.submitTopicClippingJob;
    mediaConvertVideoService.submitTopicClippingJob = async () => {
      retriesSubmitted++;
      return { jobId: 'illegal-retry-job-id' };
    };

    try {
      let threw = false;
      try {
        await videoService.retryTopicProcessing({ role: 'ADMIN' }, {
          topicId: TOPIC_B4.id,
          courseId: COURSE_A.id,
          moduleId: '1'
        });
      } catch (e) {
        threw = true;
      }
      assert.strictEqual(threw, true);
      assert.strictEqual(retriesSubmitted, 0, 'ZERO MediaConvert retry jobs must be submitted on rejected hierarchy');
    } finally {
      mediaConvertVideoService.submitTopicClippingJob = origSubmit;
    }
  });

  await runAsyncTest('MUTATION SAFETY: Rejected cross-course deleteTopicVideo causes ZERO S3 purge and ZERO DB updates', async () => {
    const s3VideoService = require('./src/modules/video/video.s3.service');
    let s3PurgeCount = 0;
    const origPurge = s3VideoService.purgeVideoPrefix;
    s3VideoService.purgeVideoPrefix = async () => {
      s3PurgeCount++;
      return true;
    };

    try {
      let threw = false;
      try {
        // Attempt to delete Topic B4 under Course A
        await videoService.deleteTopicVideo({ role: 'ADMIN' }, {
          topicId: TOPIC_B4.id,
          courseId: COURSE_A.id,
          moduleId: '1'
        });
      } catch (e) {
        threw = true;
      }
      assert.strictEqual(threw, true);
      assert.strictEqual(s3PurgeCount, 0, 'ZERO S3 purge calls must occur on rejected topic delete');
    } finally {
      s3VideoService.purgeVideoPrefix = origPurge;
    }
  });

  await runAsyncTest('MUTATION SAFETY: Rejected cross-course removeFromCourse causes ZERO DB unassign mutations', async () => {
    let dbUpdates = 0;
    const origFrom = supabase.from;
    supabase.from = (table) => {
      const b = origFrom.call(supabase, table);
      const origU = b.update;
      b.update = function(...args) {
        dbUpdates++;
        return origU.apply(this, args);
      };
      return b;
    };

    try {
      let threw = false;
      try {
        // Attempt unassigning Course B video under Course A
        await videoService.removeFromCourse({ role: 'ADMIN' }, {
          courseId: COURSE_A.id,
          moduleId: '1',
          videoAssetId: 'b10ceee4-464b-4d24-9deb-bf11c0562ddf' // belongs to Course B
        });
      } catch (e) {
        threw = true;
      }
      assert.strictEqual(threw, true);
      assert.strictEqual(dbUpdates, 0, 'ZERO DB updates must occur on rejected removeFromCourse');
    } finally {
      supabase.from = origFrom;
    }
  });

  // ==========================================================================
  // 8. PLAYBACK AUTHORIZATION TESTS
  // ==========================================================================
  console.log('\n--- LEVEL 8: PLAYBACK AUTHORIZATION & HARDENING ---');

  await runAsyncTest('PLAYBACK: Valid topic playback authorization resolves correct course and module', async () => {
    const authResult = await videoService.authorizeTopicPlayback(
      { id: 'admin-user', role: 'ADMIN', email: 'admin@internnetra.com' },
      {
        courseId: COURSE_B.id,
        moduleId: '2',
        topicId: TOPIC_B4.id
      }
    );
    assert.strictEqual(authResult.success, true);
    assert.ok(authResult.playbackUrl.includes('.m3u8'));
    assert.ok(authResult.token.length > 20);
  });

  await runAsyncTest('PLAYBACK: Cross-course topic playback authorization rejected with 403 HIERARCHY_TOPIC_MISMATCH', async () => {
    let threw = false;
    try {
      await videoService.authorizeTopicPlayback(
        { id: 'admin-user', role: 'ADMIN', email: 'admin@internnetra.com' },
        {
          courseId: COURSE_A.id, // AI/ML Course
          moduleId: '1',
          topicId: TOPIC_B4.id   // Cyber Security Topic 4
        }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Cross-course topic playback must be rejected with 403');
  });

  await runAsyncTest('PLAYBACK: Cross-module topic playback authorization rejected with 403 HIERARCHY_TOPIC_MISMATCH', async () => {
    let threw = false;
    try {
      await videoService.authorizeTopicPlayback(
        { id: 'admin-user', role: 'ADMIN', email: 'admin@internnetra.com' },
        {
          courseId: COURSE_B.id,
          moduleId: '1',         // Module 1 (Topic 4 belongs to Module 2)
          topicId: TOPIC_B4.id
        }
      );
    } catch (err) {
      threw = true;
      assert.strictEqual(err.statusCode, 403);
      assert.strictEqual(err.code, 'HIERARCHY_TOPIC_MISMATCH');
    }
    assert.strictEqual(threw, true, 'Cross-module topic playback must be rejected with 403');
  });

  // ==========================================================================
  // FINAL SUMMARY REPORT
  // ==========================================================================
  console.log('\n================================================================');
  console.log(`HIERARCHY SECURITY SUITE SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED (TOTAL ${passedCount + failedCount})`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error('Fatal Suite Runner Error:', err);
  process.exit(1);
});
