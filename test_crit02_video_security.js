/**
 * Automated Video Playback Security Test Suite (CRIT-02 Remediation)
 * Verifies that all video authorization flaws and bypasses are completely closed.
 */
const http = require('http');
const jwt = require('jsonwebtoken');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 5000;

console.log('================================================================');
console.log('CRIT-02 VIDEO AUTHORIZATION SECURITY TEST SUITE');
console.log('================================================================\n');

function sendRequest({ method = 'GET', path, headers = {} }) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json || data });
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 0, error: err.message });
    });
    req.end();
  });
}

// Token Helpers
function createValidPlaybackToken(overrides = {}) {
  return jwt.sign({
    sub: 'student-uuid-101',
    email: 'student@example.com',
    courseId: 'ai-ml-course-uuid',
    courseSlug: 'ai-ml',
    moduleId: 'mod-1',
    topicId: 'topic-1',
    role: 'STUDENT',
    type: 'VIDEO_PLAYBACK',
    ...overrides
  }, JWT_SECRET, { expiresIn: '15m' });
}

function createExpiredPlaybackToken() {
  return jwt.sign({
    sub: 'student-uuid-101',
    courseId: 'ai-ml-course-uuid',
    courseSlug: 'ai-ml',
    role: 'STUDENT',
    type: 'VIDEO_PLAYBACK'
  }, JWT_SECRET, { expiresIn: -60 }); // expired 60 seconds ago
}

function createStandardLoginToken(role = 'STUDENT') {
  return jwt.sign({
    id: 'user-uuid-101',
    email: 'user@example.com',
    role: role
  }, JWT_SECRET, { expiresIn: '1h' });
}

function createTamperedToken() {
  return jwt.sign({
    sub: 'attacker',
    courseId: 'ai-ml',
    role: 'STUDENT',
    type: 'VIDEO_PLAYBACK'
  }, 'wrong-attacker-secret', { expiresIn: '15m' });
}

const tests = [
  {
    name: '1. Missing token on master manifest request (.m3u8) MUST be rejected with HTTP 401',
    run: async () => {
      const res = await sendRequest({
        path: '/api/video/hls-stream/courses/ai-ml/master.m3u8'
      });
      const pass = res.statusCode === 401 && res.body?.code === 'PLAYBACK_TOKEN_REQUIRED';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '2. Missing token on video chunk request (.ts) MUST be rejected with HTTP 401',
    run: async () => {
      const res = await sendRequest({
        path: '/api/video/hls-stream/courses/ai-ml/segment_001.ts'
      });
      const pass = res.statusCode === 401 && res.body?.code === 'PLAYBACK_TOKEN_REQUIRED';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '3. Tampered / invalid signature token MUST be rejected with HTTP 403',
    run: async () => {
      const token = createTamperedToken();
      const res = await sendRequest({
        path: `/api/video/hls-stream/courses/ai-ml/master.m3u8?token=${token}`
      });
      const pass = res.statusCode === 403 && res.body?.code === 'VIDEO_ACCESS_EXPIRED';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '4. Expired playback token MUST be rejected with HTTP 403',
    run: async () => {
      const token = createExpiredPlaybackToken();
      const res = await sendRequest({
        path: `/api/video/hls-stream/courses/ai-ml/master.m3u8?token=${token}`
      });
      const pass = res.statusCode === 403 && res.body?.code === 'VIDEO_ACCESS_EXPIRED';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '5. Standard Student Login JWT (without VIDEO_PLAYBACK type) MUST be rejected with HTTP 403',
    run: async () => {
      const token = createStandardLoginToken('STUDENT');
      const res = await sendRequest({
        path: `/api/video/hls-stream/courses/ai-ml/master.m3u8?token=${token}`
      });
      const pass = res.statusCode === 403 && res.body?.code === 'INVALID_TOKEN_TYPE';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '6. Standard Admin Login JWT (without VIDEO_PLAYBACK type) MUST be rejected with HTTP 403',
    run: async () => {
      const token = createStandardLoginToken('ADMIN');
      const res = await sendRequest({
        path: `/api/video/hls-stream/courses/ai-ml/master.m3u8?token=${token}`
      });
      const pass = res.statusCode === 403 && res.body?.code === 'INVALID_TOKEN_TYPE';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '7. Course Isolation: AI/ML playback token requesting Cyber Security course MUST be rejected with HTTP 403',
    run: async () => {
      const token = createValidPlaybackToken({
        courseSlug: 'ai-ml',
        courseId: '11111111-1111-1111-1111-111111111111'
      });
      const res = await sendRequest({
        path: `/api/video/hls-stream/courses/cyber-security/master.m3u8?token=${token}`
      });
      const pass = res.statusCode === 403 && res.body?.code === 'FORBIDDEN_COURSE_MISMATCH';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '8. Admin Playback Token with Course A scope CANNOT access Course B video (HTTP 403)',
    run: async () => {
      const token = createValidPlaybackToken({
        role: 'ADMIN',
        courseSlug: 'ai-ml',
        courseId: '11111111-1111-1111-1111-111111111111'
      });
      const res = await sendRequest({
        path: `/api/video/hls-stream/courses/full-stack/master.m3u8?token=${token}`
      });
      const pass = res.statusCode === 403 && res.body?.code === 'FORBIDDEN_COURSE_MISMATCH';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '9. Bearer header authorization support works with same security enforcement',
    run: async () => {
      const token = createValidPlaybackToken({
        courseSlug: 'ai-ml',
        courseId: '11111111-1111-1111-1111-111111111111'
      });
      // Try accessing mismatched course via Authorization header
      const res = await sendRequest({
        path: '/api/video/hls-stream/courses/cyber-security/master.m3u8',
        headers: { Authorization: `Bearer ${token}` }
      });
      const pass = res.statusCode === 403 && res.body?.code === 'FORBIDDEN_COURSE_MISMATCH';
      return {
        pass,
        details: `HTTP ${res.statusCode}, Code: ${res.body?.code || 'N/A'}`
      };
    }
  },
  {
    name: '10. Valid token matching course passes security gateway and reaches storage resolution',
    run: async () => {
      const token = createValidPlaybackToken({
        courseSlug: 'ai-ml',
        courseId: '11111111-1111-1111-1111-111111111111'
      });
      const res = await sendRequest({
        path: `/api/video/hls-stream/courses/ai-ml/test-video.m3u8?token=${token}`
      });
      // Because 'test-video.m3u8' is a test key, S3 will respond 404 NoSuchKey (or 200 if real).
      // What proves security authorization PASS is that it was NOT 401 or 403!
      const pass = res.statusCode === 404 || res.statusCode === 200;
      return {
        pass,
        details: `HTTP ${res.statusCode} (Successfully passed authentication and course boundary checks)`
      };
    }
  }
];

async function runSuite() {
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test.run();
      if (result.pass) {
        console.log(`✅ [PASS] ${test.name}`);
        if (result.details) console.log(`   └─ Details: ${result.details}`);
        passed++;
      } else {
        console.log(`❌ [FAIL] ${test.name}`);
        if (result.details) console.log(`   └─ Details: ${result.details}`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ [ERROR] ${test.name}`);
      console.log(`   └─ Exception: ${err.message}`);
      failed++;
    }
  }

  console.log('\n================================================================');
  console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED (TOTAL ${tests.length})`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSuite();
