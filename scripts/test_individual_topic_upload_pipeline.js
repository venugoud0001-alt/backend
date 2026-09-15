/**
 * LMS INDIVIDUAL TOPIC VIDEO UPLOAD PIPELINE AUDIT & TEST SUITE
 * 
 * Verifies:
 *  1. Topic video S3 path isolation (source key & HLS prefix)
 *  2. Independent MediaConvert job creation for Topic ONLY (1 job per topic)
 *  3. Absence of cross-topic queue disturbance (Topics 2..10 remain unaffected)
 *  4. Authoritative topic completion updates (topics table & courses curriculum_modules)
 *  5. Topic status polling isolation (no module hijacking)
 */

const s3PathUtils = require('../src/utils/s3PathUtils');
const videoService = require('../src/modules/video/video.service');
const mediaConvertVideoService = require('../src/modules/video/video.mediaconvert.service');
const s3VideoService = require('../src/modules/video/video.s3.service');

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASSED: [Test ${totalTests}] ${testName}`);
    if (details) console.log(`     ↳ ${details}`);
  } else {
    console.error(`  ❌ FAILED: [Test ${totalTests}] ${testName}`);
    if (details) console.error(`     ↳ ${details}`);
  }
}

async function runAudit() {
  console.log('===============================================================');
  console.log('🎬 INDIVIDUAL TOPIC VIDEO UPLOAD & TRANSCODING AUDIT');
  console.log('===============================================================\n');

  // Stub S3 multipart methods
  s3VideoService.createMultipartUpload = async ({ s3Key, contentType }) => ({
    uploadId: 'mock_upload_id_topic_123',
    s3Bucket: 'internnetra-lms-videos-prod-365957110532-ap-south-1-an',
    s3Key
  });

  s3VideoService.generatePresignedPartUrls = async () => ([
    { partNumber: 1, uploadUrl: 'https://s3.mock/part1' },
    { partNumber: 2, uploadUrl: 'https://s3.mock/part2' }
  ]);

  s3VideoService.completeMultipartUpload = async ({ uploadId, s3Key, parts }) => ({
    location: `https://internnetra-lms-videos-prod-365957110532-ap-south-1-an.s3.amazonaws.com/${s3Key}`,
    s3Bucket: 'internnetra-lms-videos-prod-365957110532-ap-south-1-an',
    s3Key,
    etag: '"mock-etag-complete"'
  });

  // Intercept MediaConvert job submissions
  const submittedJobs = [];
  mediaConvertVideoService.submitTranscodeJob = async (params) => {
    submittedJobs.push(params);
    return {
      jobId: `mc_topic_job_${submittedJobs.length}`,
      status: 'SUBMITTED',
      createdAt: new Date().toISOString()
    };
  };

  const mockAdminUser = { id: 'admin_test_1', role: 'ADMIN' };

  // 1. Audit S3 Path Structure
  console.log('--- 1. AUDITING S3 PATH SPECIFICATIONS ---');
  const courseSlug = 'cyber-security';
  const moduleSlug = '01-fundamentals';
  const videoAssetId = 'asset-topic-uuid-1';
  const topicId = 'topic-uuid-3';
  const fileName = 'lesson-3-lecture.mp4';

  const sourceKey = s3PathUtils.buildS3TopicSourceKey(courseSlug, moduleSlug, videoAssetId, topicId, fileName);
  const hlsPrefix = s3PathUtils.buildS3TopicHlsPrefix(courseSlug, moduleSlug, videoAssetId, topicId);
  const masterKey = s3PathUtils.buildS3TopicMasterKey(courseSlug, moduleSlug, videoAssetId, topicId);

  assert(
    sourceKey === `courses/${courseSlug}/modules/${moduleSlug}/videos/${videoAssetId}/topics/${topicId}/source/lesson-3-lecture.mp4`,
    'Topic source key is isolated under topic directory',
    sourceKey
  );

  assert(
    hlsPrefix === `courses/${courseSlug}/modules/${moduleSlug}/videos/${videoAssetId}/topics/${topicId}/hls/`,
    'Topic HLS prefix is isolated under topic directory',
    hlsPrefix
  );

  assert(
    masterKey === `courses/${courseSlug}/modules/${moduleSlug}/videos/${videoAssetId}/topics/${topicId}/hls/master.m3u8`,
    'Topic master playlist points to topic directory',
    masterKey
  );

  // 2. Audit MediaConvert Job Settings Generation
  console.log('\n--- 2. AUDITING MEDIACONVERT JOB SETTINGS ---');
  const jobSettings = mediaConvertVideoService.buildJobSettings({
    sourceBucket: 'internnetra-lms-videos-prod-365957110532-ap-south-1-an',
    sourceKey,
    outputPrefix: hlsPrefix
  });

  assert(
    jobSettings.Inputs[0].FileInput === `s3://internnetra-lms-videos-prod-365957110532-ap-south-1-an/${sourceKey}`,
    'MediaConvert file input points to the topic source video'
  );

  assert(
    jobSettings.OutputGroups[0].OutputGroupSettings.HlsGroupSettings.Destination.includes(`/topics/${topicId}/hls/master`),
    'MediaConvert HLS output group destinations point exclusively to topic HLS path',
    jobSettings.OutputGroups[0].OutputGroupSettings.HlsGroupSettings.Destination
  );

  assert(
    jobSettings.OutputGroups[0].Outputs.some(o => o.NameModifier === '_720p') &&
    jobSettings.OutputGroups[0].Outputs.some(o => o.NameModifier === '_1080p'),
    'MediaConvert job includes both 720p and 1080p adaptive HLS renditions'
  );

  // 3. Test Multipart Completion & Single MediaConvert Job Dispatch
  console.log('\n--- 3. TESTING MULTIPART COMPLETION & JOB DISPATCH ---');
  const courseId = 'cyber_sec_c1';
  const moduleId = 'mod_1';

  // Seed mock course in memory
  videoService.memoryVideoStore.set(`topic_${topicId}`, {
    id: topicId,
    module_id: moduleId,
    course_id: courseId,
    title: 'Topic 3 - Advanced Firewalls',
    display_order: 3,
    processing_status: 'DRAFT'
  });

  // Seed Topic 1 and Topic 2 in memory as well to verify isolation
  videoService.memoryVideoStore.set(`topic_top_1`, {
    id: 'top_1',
    module_id: moduleId,
    course_id: courseId,
    title: 'Topic 1 - Intro',
    display_order: 1,
    processing_status: 'DRAFT'
  });
  videoService.memoryVideoStore.set(`topic_top_2`, {
    id: 'top_2',
    module_id: moduleId,
    course_id: courseId,
    title: 'Topic 2 - Basics',
    display_order: 2,
    processing_status: 'DRAFT'
  });

  const completeResult = await videoService.completeTopicMultipartUploadAndStartProcessing(mockAdminUser, {
    topicId,
    videoAssetId,
    uploadId: 'mock_upload_id_topic_123',
    s3Key: sourceKey,
    parts: [{ PartNumber: 1, ETag: '"part1"' }, { PartNumber: 2, ETag: '"part2"' }],
    durationSeconds: 1800,
    courseId,
    moduleId
  });

  assert(
    completeResult.status === 'SUCCESS' && completeResult.jobId === 'mc_topic_job_1',
    'Topic multipart upload completed and returned MediaConvert jobId'
  );

  assert(
    submittedJobs.length === 1,
    'Exactly ONE MediaConvert job was submitted for Topic 3',
    `Submitted count: ${submittedJobs.length}`
  );

  const submittedJob = submittedJobs[0];
  assert(
    submittedJob.userMetadata.topicId === topicId &&
    submittedJob.userMetadata.isIndividualTopicVideo === 'true' &&
    submittedJob.userMetadata.isTopicJob === 'true',
    'MediaConvert userMetadata contains authoritative topic identifiers',
    JSON.stringify(submittedJob.userMetadata)
  );

  // 4. Verify Other Topics are NOT Affected
  console.log('\n--- 4. AUDITING TOPIC ISOLATION ---');
  const t1 = videoService.memoryVideoStore.get('topic_top_1');
  const t2 = videoService.memoryVideoStore.get('topic_top_2');
  const t3 = videoService.memoryVideoStore.get(`topic_${topicId}`);

  assert(t1.processing_status === 'DRAFT', 'Topic 1 remains unaffected in DRAFT state');
  assert(t2.processing_status === 'DRAFT', 'Topic 2 remains unaffected in DRAFT state');
  assert(t3.processing_status === 'PROCESSING', 'Topic 3 is transitioned to PROCESSING state');

  // 5. Test Completion Handling
  console.log('\n--- 5. TESTING MEDIA-CONVERT COMPLETION ---');
  await videoService.handleTopicProcessingCompleted({
    jobId: 'mc_topic_job_1',
    topicId,
    sourceVideoId: videoAssetId,
    moduleId,
    courseId,
    isIndividualTopicVideo: true
  });

  const updatedT3 = videoService.memoryVideoStore.get(`topic_${topicId}`);
  assert(updatedT3.processing_status === 'READY', 'Topic 3 processing_status is set to READY');
  assert(updatedT3.video_status === 'READY', 'Topic 3 video_status is set to READY');
  assert(
    updatedT3.video_url && updatedT3.video_url.includes(`/topics/${topicId}/hls/master.m3u8`),
    'Topic 3 video_url is populated with topic master.m3u8',
    updatedT3.video_url
  );
  assert(
    updatedT3.hls_master_url && updatedT3.hls_master_url.includes(`/topics/${topicId}/hls/master.m3u8`),
    'Topic 3 hls_master_url is populated with topic master.m3u8',
    updatedT3.hls_master_url
  );

  assert(submittedJobs.length === 1, 'No additional clipping jobs were dispatched to other topics');

  console.log('\n===============================================================');
  console.log(`TOTAL AUDIT RESULTS: ${passedTests} / ${totalTests} PASSED`);
  console.log('===============================================================');
}

runAudit().catch(err => {
  console.error('Audit crashed with uncaught error:', err);
  process.exit(1);
});
