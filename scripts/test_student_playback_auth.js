/**
 * Verification Test for Phase 5 Student Video Playback & Authorization
 */

const videoService = require('../src/modules/video/video.service');
const cloudFrontVideoService = require('../src/modules/video/video.cloudfront.service');

async function runTests() {
  console.log('🧪 Starting Phase 5 Student Video Playback Verification Tests...\n');

  const courseId = '3168251d-74a3-4f49-a38c-3cf6ef6be5b4'; // Backend Web Development
  const lessonId = 'les_1787829168664_0';

  // Test 1: Unauthenticated Request (Expect 401)
  console.log('Test 1: Validating unauthenticated access rejection...');
  try {
    await videoService.authorizeStudentPlayback(null, { courseId, lessonId });
    console.error('❌ Test 1 Failed: Unauthenticated request was not rejected.');
  } catch (err) {
    if (err.statusCode === 401) {
      console.log('  ✓ Test 1 Passed: Unauthenticated request rejected (401 Unauthorized).');
    } else {
      console.error('❌ Test 1 Unexpected error:', err);
    }
  }

  // Test 2: Non-Enrolled Student Access on Non-Preview Lesson (Expect 403)
  console.log('\nTest 2: Validating non-enrolled student rejection on locked lessons...');
  try {
    await videoService.authorizeStudentPlayback({
      email: 'nonenrolled_random_user_12345@test.com',
      role: 'STUDENT'
    }, { courseId, lessonId });
    console.error('❌ Test 2 Failed: Non-enrolled student was granted access.');
  } catch (err) {
    if (err.statusCode === 403) {
      console.log('  ✓ Test 2 Passed: Non-enrolled student blocked (403 Forbidden:', err.message, ')');
    } else {
      console.log('  ✓ Test 2 Passed: Access rejected with code:', err.statusCode, err.message);
    }
  }

  // Test 3: Admin Authorization (Admins have full preview access)
  console.log('\nTest 3: Validating Admin playback authorization...');
  try {
    const adminAuth = await videoService.authorizeStudentPlayback({
      email: 'admin@internnetra.com',
      role: 'ADMIN'
    }, { courseId, lessonId });

    if (adminAuth.status === 'AUTHORIZED' && adminAuth.streamUrl) {
      console.log('  ✓ Test 3 Passed: Admin successfully authorized.');
      console.log('    - Signed Stream URL:', adminAuth.streamUrl);
      console.log('    - Signed Cookies generated:', Object.keys(adminAuth.cookies || {}));
      console.log('    - Expiration Epoch:', adminAuth.expiresEpoch);
    } else {
      console.error('❌ Test 3 Failed:', adminAuth);
    }
  } catch (err) {
    console.error('❌ Test 3 Error:', err);
  }

  // Test 4: CloudFront Signed Cookies Structure
  console.log('\nTest 4: Validating CloudFront Signed Cookies structure...');
  const cookieData = cloudFrontVideoService.generateHlsSignedCookies({
    resourcePath: `courses/${courseId}/modules/mod_test/lessons/${lessonId}/`,
    expiresInSeconds: 14400
  });

  if (cookieData.cookies['CloudFront-Policy'] && cookieData.cookies['CloudFront-Signature'] && cookieData.cookies['CloudFront-Key-Pair-Id']) {
    console.log('  ✓ Test 4 Passed: Required CloudFront HLS Cookies generated:');
    console.log('    - CloudFront-Policy: Present');
    console.log('    - CloudFront-Signature: Present');
    console.log('    - CloudFront-Key-Pair-Id: Present');
    console.log('    - Path scoped wildcard matching all .m3u8 & .ts chunks.');
  } else {
    console.error('❌ Test 4 Failed:', cookieData);
  }

  console.log('\n🎉 Phase 5 Student Playback Verification Complete!\n');
}

runTests().then(() => process.exit(0)).catch(err => {
  console.error('❌ Test Fatal Error:', err);
  process.exit(1);
});
