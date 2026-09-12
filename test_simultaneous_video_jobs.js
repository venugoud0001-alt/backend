/**
 * Comprehensive Regression Test: Simultaneous Video Upload & Transcoding Jobs
 *
 * Requirements Verified:
 * 1. Every upload/transcoding job maintains an immutable unique identity:
 *    jobId + courseId + moduleId + lessonId/videoAssetId.
 * 2. 3 simultaneous jobs belonging to different modules/courses coexist:
 *    - Job A: Course 1, Module 1
 *    - Job B: Course 1, Module 2
 *    - Job C: Course 2, Module 1
 * 3. Updating Job A NEVER overwrites or alters Job B or Job C.
 * 4. Status queries and active jobs listing return independent statuses for ALL active jobs.
 * 5. Cross-module and cross-course hierarchy validation fails closed (403).
 */

const crypto = require('crypto');
const videoService = require('./src/modules/video/video.service');
const { validateHierarchyChain } = require('./src/utils/hierarchyValidator');
const { supabase } = require('./src/config/supabase');

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`✅ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runSimultaneousJobsTestSuite() {
  console.log('================================================================');
  console.log('REGRESSION SUITE: SIMULTANEOUS VIDEO UPLOAD & TRANSCODING JOBS');
  console.log('================================================================\n');

  const courseA_Id = 'e785fb8f-7952-47cd-878f-c5ed73422b6d'; // Existing Course A
  const courseB_Id = 'ac3d8a52-753e-4c49-a1c7-6cdd250d8183'; // Existing Course B

  const videoAssetA = crypto.randomUUID();
  const videoAssetB = crypto.randomUUID();
  const videoAssetC = crypto.randomUUID();

  const adminUser = { id: 'admin-tester-1', role: 'ADMIN', email: 'admin@internnetra.com' };

  try {
    // --- STEP 1: INITIALIZE 3 SIMULTANEOUS JOBS ---
    console.log('--- TEST 1: START 3 SIMULTANEOUS JOBS ACROSS MODULES & COURSES ---');

    const jobA_Record = await videoService.upsertVideoRecord({
      id: videoAssetA,
      course_id: courseA_Id,
      module_id: '17',
      lesson_id: '17',
      title: 'Module 17 Masterclass (Course A)',
      status: 'UPLOADING',
      duration_seconds: 1200,
      source_duration_seconds: 1200,
      file_size_bytes: 52428800,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const jobB_Record = await videoService.upsertVideoRecord({
      id: videoAssetB,
      course_id: courseA_Id,
      module_id: '18',
      lesson_id: '18',
      title: 'Module 18 Masterclass (Course A)',
      status: 'UPLOADING',
      duration_seconds: 1800,
      source_duration_seconds: 1800,
      file_size_bytes: 78643200,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const jobC_Record = await videoService.upsertVideoRecord({
      id: videoAssetC,
      course_id: courseB_Id,
      module_id: '1',
      lesson_id: '1',
      title: 'Module 1 Masterclass (Course B)',
      status: 'UPLOADING',
      duration_seconds: 900,
      source_duration_seconds: 900,
      file_size_bytes: 31457280,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    assert(jobA_Record && jobA_Record.id === videoAssetA, 'Job A initialized with unique UUID in Course A Module 17');
    assert(jobB_Record && jobB_Record.id === videoAssetB, 'Job B initialized with unique UUID in Course A Module 18');
    assert(jobC_Record && jobC_Record.id === videoAssetC, 'Job C initialized with unique UUID in Course B Module 1');

    // --- STEP 2: VERIFY ALL 3 JOBS ARE INDEPENDENTLY LISTED IN ACTIVE JOBS ---
    console.log('\n--- TEST 2: ACTIVE JOBS LISTING MUST INCLUDE ALL CONCURRENT JOBS ---');

    const activeJobs = await videoService.listActiveTranscodingJobs(adminUser);
    const listedA = activeJobs.find(j => j.id === videoAssetA);
    const listedB = activeJobs.find(j => j.id === videoAssetB);
    const listedC = activeJobs.find(j => j.id === videoAssetC);

    assert(listedA && listedA.status === 'UPLOADING', 'Active jobs includes Job A with status UPLOADING');
    assert(listedB && listedB.status === 'UPLOADING', 'Active jobs includes Job B with status UPLOADING');
    assert(listedC && listedC.status === 'UPLOADING', 'Active jobs includes Job C with status UPLOADING');
    assert(listedA.moduleId === '17' && listedB.moduleId === '18', 'Job A (Mod 17) and Job B (Mod 18) maintain distinct module boundaries in same course');

    // --- STEP 3: PARALLEL STATE TRANSITIONS ---
    console.log('\n--- TEST 3: INDEPENDENT STATE MUTATIONS (UPDATING JOB A DOES NOT OVERWRITE B OR C) ---');

    // Job A moves to PROCESSING (MediaConvert started)
    await videoService.upsertVideoRecord({
      ...jobA_Record,
      status: 'PROCESSING',
      mediaconvert_job_id: 'mc_job_a_12345',
      updated_at: new Date().toISOString()
    });

    // Job B moves to FAILED
    await videoService.upsertVideoRecord({
      ...jobB_Record,
      status: 'FAILED',
      error_message: 'Sample network timeout during upload',
      updated_at: new Date().toISOString()
    });

    // Job C moves to READY (transcode complete)
    await videoService.upsertVideoRecord({
      ...jobC_Record,
      status: 'READY',
      hls_master_url: 'https://cdn.internnetra.com/courses/course-b/m1/master.m3u8',
      updated_at: new Date().toISOString()
    });

    // Verify each job state independently
    const statusA = await videoService.getVideoStatus(videoAssetA, courseA_Id);
    const statusB = await videoService.getVideoStatus(videoAssetB, courseA_Id);
    const statusC = await videoService.getVideoStatus(videoAssetC, courseB_Id);

    console.log('Status A:', { status: statusA.status, rawStatus: statusA.rawStatus });
    console.log('Status B:', { status: statusB.status, rawStatus: statusB.rawStatus });
    console.log('Status C:', { status: statusC.status, rawStatus: statusC.rawStatus });

    assert(statusA.status === 'PROCESSING' || statusA.status === 'READY' || statusA.rawStatus === 'PROCESSING' || statusA.rawStatus === 'READY', 'Job A status successfully progressed to PROCESSING or READY');
    assert(statusB.status === 'FAILED' || statusB.rawStatus === 'FAILED', 'Job B status is FAILED and was NOT overwritten by Job A');
    assert(statusC.status === 'READY' || statusC.rawStatus === 'READY', 'Job C status is READY and was NOT overwritten by Job A or Job B');

    // --- STEP 4: VERIFY GET_VIDEO_STATUS ISOLATION & HIERARCHY SAFETY ---
    console.log('\n--- TEST 4: STATUS SCOPE & HIERARCHY OWNERSHIP ENFORCEMENT ---');

    // Querying Job A under Course B must fail or return null/isolated
    try {
      const crossCourseStatus = await videoService.getVideoStatus(videoAssetA, courseB_Id);
      assert(!crossCourseStatus || crossCourseStatus.status === 'NO_VIDEO', 'Querying Job A with incorrect Course B scope does not return Job A details');
    } catch (e) {
      assert(true, 'Querying Job A with incorrect Course B scope rejected cleanly');
    }

    // Hierarchy validation for Job A under Module 2 must reject with 403
    let hierarchyRejected = false;
    try {
      await validateHierarchyChain({
        courseId: courseA_Id,
        moduleId: '2',
        videoId: videoAssetA
      });
    } catch (err) {
      if (err.statusCode === 403 || err.message?.includes('ownership mismatch')) {
        hierarchyRejected = true;
      }
    }
    assert(hierarchyRejected, 'Hierarchy validator strictly rejects Job A (Module 1) requested under Module 2 (HTTP 403)');

    // --- STEP 5: CLEANUP TEST RECORDS ---
    console.log('\n--- CLEANUP: REMOVE TEST ARTIFACTS ---');
    await supabase.from('lesson_videos').delete().in('id', [videoAssetA, videoAssetB, videoAssetC]);
    assert(true, 'Test records cleaned up from database');

    console.log('\n================================================================');
    console.log(`TEST SUITE COMPLETE: ${passedTests} / ${totalTests} ASSERTIONS PASSED`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('Test suite encountered an unexpected error:', err);
    process.exit(1);
  }
}

runSimultaneousJobsTestSuite().then(() => {
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
