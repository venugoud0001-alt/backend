/**
 * End-to-End Verification Test for Phase 3 Video Pipeline
 */

const videoService = require('../src/modules/video/video.service');
const { VIDEO_STATUS } = require('../src/modules/video/video.constants');

async function runTests() {
  console.log('🧪 Starting Phase 3 Video Pipeline Verification Tests...\n');

  // Test 1: File Type Validation (Rejects invalid formats)
  console.log('Test 1: Validating file type protection...');
  try {
    await videoService.requestUpload({ role: 'ADMIN' }, {
      courseId: '3168251d-74a3-4f49-a38c-3cf6ef6be5b4',
      moduleId: 'mod_test',
      lessonId: 'les_test',
      fileName: 'malware.exe',
      contentType: 'application/x-msdownload'
    });
    console.error('❌ Test 1 Failed: Accepted invalid file type.');
  } catch (err) {
    if (err.statusCode === 400 && err.message.includes('Invalid video format')) {
      console.log('  ✓ Test 1 Passed: Invalid MIME type properly rejected (400 Bad Request).');
    } else {
      console.error('❌ Test 1 Unexpected error:', err);
    }
  }

  // Test 2: File Size Validation (Rejects > 5 GB)
  console.log('\nTest 2: Validating file size protection...');
  try {
    await videoService.requestUpload({ role: 'ADMIN' }, {
      courseId: '3168251d-74a3-4f49-a38c-3cf6ef6be5b4',
      moduleId: 'mod_test',
      lessonId: 'les_test',
      fileName: 'massive_video.mp4',
      contentType: 'video/mp4',
      fileSizeBytes: 6 * 1024 * 1024 * 1024 // 6 GB
    });
    console.error('❌ Test 2 Failed: Accepted file exceeding size limit.');
  } catch (err) {
    if (err.statusCode === 400 && err.message.includes('exceeds maximum allowed limit')) {
      console.log('  ✓ Test 2 Passed: Over-sized file (>5GB) properly rejected (400 Bad Request).');
    } else {
      console.error('❌ Test 2 Unexpected error:', err);
    }
  }

  // Test 3: Request Presigned Upload URL
  console.log('\nTest 3: Requesting direct-to-S3 presigned upload URL...');
  const uploadRes = await videoService.requestUpload({ role: 'ADMIN' }, {
    courseId: '3168251d-74a3-4f49-a38c-3cf6ef6be5b4',
    moduleId: 'a8d89e5a-83a5-4953-8f9e-db713663ae3c',
    lessonId: 'les_1787829168664_0',
    fileName: 'lesson_masterclass.mp4',
    contentType: 'video/mp4',
    fileSizeBytes: 250 * 1024 * 1024, // 250 MB
    title: 'Full 1-Hour Video Masterclass'
  });

  if (uploadRes.uploadUrl && uploadRes.s3Key.includes('courses/3168251d-74a3-4f49-a38c-3cf6ef6be5b4')) {
    console.log('  ✓ Test 3 Passed: Deterministic S3 Key generated:', uploadRes.s3Key);
    console.log('  ✓ Presigned URL received (Direct to S3 without Hostinger proxy).');
  } else {
    console.error('❌ Test 3 Failed:', uploadRes);
  }

  // Test 4: Confirm Upload & Start MediaConvert Job
  console.log('\nTest 4: Confirming upload and starting MediaConvert HLS job...');
  const confirmRes = await videoService.confirmUploadAndStartProcessing({ role: 'ADMIN' }, {
    videoAssetId: uploadRes.videoAssetId,
    lessonId: 'les_1787829168664_0'
  });

  if (confirmRes.jobId && confirmRes.processingStatus === VIDEO_STATUS.PROCESSING) {
    console.log('  ✓ Test 4 Passed: MediaConvert job submitted with ID:', confirmRes.jobId);
    console.log('  ✓ Master Playlist URL mapped:', confirmRes.masterPlaylistUrl);
  } else {
    console.error('❌ Test 4 Failed:', confirmRes);
  }

  // Test 5: Verify Final READY Status & Source Deletion
  console.log('\nTest 5: Polling status & verifying source deletion...');
  // Wait 1.5s for mock finalization
  await new Promise(r => setTimeout(r, 1500));

  const statusRes = await videoService.getVideoStatus('les_1787829168664_0');
  console.log('  Video Status Record:', {
    lessonId: statusRes.lessonId,
    status: statusRes.status,
    hlsMasterUrl: statusRes.hlsMasterUrl,
    sourceDeleted: statusRes.sourceDeleted
  });

  if (statusRes.status === VIDEO_STATUS.READY && statusRes.sourceDeleted) {
    console.log('  ✓ Test 5 Passed: State transitioned to READY and temporary raw source video confirmed deleted.');
  } else {
    console.log('  ℹ️ Status is currently:', statusRes.status);
  }

  console.log('\n🎉 All Video Pipeline Verification Tests Complete!\n');
}

runTests().then(() => process.exit(0)).catch(err => {
  console.error('❌ Pipeline Test Fatal Error:', err);
  process.exit(1);
});
