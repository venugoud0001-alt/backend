const http = require('http');
const app = require('../src/app');

// Start test server on random port
const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api`;
  console.log(`\n🧪 LMS Hierarchy Test Suite Running on Port ${port}...\n`);

  let testsPassed = 0;
  let testsFailed = 0;

  function logTest(name, success, detail = '') {
    if (success) {
      testsPassed++;
      console.log(`✅ [PASS] ${name} ${detail}`);
    } else {
      testsFailed++;
      console.error(`❌ [FAIL] ${name} ${detail}`);
    }
  }

  async function makeRequest(method, path, body = null, headers = {}) {
    return new Promise((resolve) => {
      const url = new URL(baseUrl + path);
      const reqHeaders = { 'Content-Type': 'application/json', ...headers };
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders
      };

      const req = http.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => responseBody += chunk);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(responseBody); } catch(e) { json = responseBody; }
          resolve({ status: res.statusCode, body: json });
        });
      });

      req.on('error', (err) => {
        resolve({ status: 500, body: { status: 'ERROR', message: err.message } });
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  try {
    // 1. GET /api/departments
    const r1 = await makeRequest('GET', '/departments');
    logTest('1. GET /api/departments', r1.status === 200 && r1.body.status === 'SUCCESS', `Status: ${r1.status}`);

    // 2. GET /api/departments/:slug (Non-existent slug)
    const r2 = await makeRequest('GET', '/departments/non-existent-dept-slug-12345');
    logTest('2. GET /api/departments/:slug (404 check)', r2.status === 404 && r2.body.status === 'ERROR', `Message: ${r2.body.message}`);

    // 3. POST /api/departments (Without Auth -> 401)
    const r3 = await makeRequest('POST', '/departments', { name: 'Engineering' });
    logTest('3. POST /api/departments without auth (401 check)', r3.status === 401 && r3.body.status === 'ERROR', `Message: ${r3.body.message}`);

    // 4. Validation: Invalid Department Status rejection
    const { validateCreateDepartment } = require('../src/modules/departments/department.validator');
    const valDeptStatus = validateCreateDepartment({ body: { name: 'Design', status: 'INVALID_STATUS' } });
    logTest('4. Invalid Department Status rejection', !valDeptStatus.isValid && valDeptStatus.error.includes('Invalid status'), `Error: ${valDeptStatus.error}`);

    // 5. Validation: Negative display_order rejection
    const valDisplayOrder = validateCreateDepartment({ body: { name: 'Design', display_order: -5 } });
    logTest('5. Invalid display_order rejection', !valDisplayOrder.isValid, `Error: ${valDisplayOrder.error}`);

    // 6. GET /api/courses
    const r6 = await makeRequest('GET', '/courses');
    logTest('6. GET /api/courses', r6.status === 200 && r6.body.status === 'SUCCESS', `Found ${r6.body.courses?.length || 0} public courses`);

    // 7. Course Validation: Missing department_id or invalid UUID
    const { validateCreateCourse } = require('../src/modules/courses/course.validator');
    const valCourseNoDept = validateCreateCourse({ body: { title: 'Fullstack Web Dev', department_id: 'invalid-uuid' } });
    logTest('7. Course invalid department_id UUID check', !valCourseNoDept.isValid, `Error: ${valCourseNoDept.error}`);

    // 8. Course Validation: Valid creation payload structure
    const dummyDeptUuid = '11111111-2222-3333-4444-555555555555';
    const valCourseValid = validateCreateCourse({ body: { title: 'Fullstack Web Dev', department_id: dummyDeptUuid, status: 'PUBLISHED' } });
    logTest('8. Course valid payload structure check', valCourseValid.isValid && valCourseValid.sanitizedData.slug === 'fullstack-web-dev', `Slug: ${valCourseValid.sanitizedData.slug}`);

    // 9. Version Validation: version_number <= 0 rejection
    const { validateCreateVersion } = require('../src/modules/curriculum/curriculum.validator');
    const valVerZero = validateCreateVersion({ params: { courseId: dummyDeptUuid }, body: { version_number: 0 } });
    logTest('9. Version number <= 0 rejection', !valVerZero.isValid, `Error: ${valVerZero.error}`);

    // 10. Lesson Validation: duration_minutes < 0 rejection
    const { validateCreateLesson } = require('../src/modules/curriculum/curriculum.validator');
    const valLessonNegDur = validateCreateLesson({ params: { moduleId: dummyDeptUuid }, body: { title: 'Intro Video', duration_minutes: -10 } });
    logTest('10. Invalid lesson duration < 0 rejection', !valLessonNegDur.isValid, `Error: ${valLessonNegDur.error}`);

    // 11. Slug utility tests
    const { generateSlug, isValidSlug } = require('../src/utils/slug');
    const testSlug = generateSlug(' Full Stack   Web Development 101!!! ');
    logTest('11. Slug generation utility', testSlug === 'full-stack-web-development-101' && isValidSlug(testSlug), `Generated: ${testSlug}`);

    // 12. Curriculum service test structure & fallback for public curriculum endpoint
    const curriculumService = require('../src/modules/curriculum/curriculum.service');
    let currRes = null;
    try {
      currRes = await curriculumService.getPublicCourseCurriculum('non-existent-course-slug-abcxyz');
    } catch(e) {
      currRes = e;
    }
    logTest('12. GET /api/courses/:slug/curriculum 404 for non-existent course', currRes.statusCode === 404 || currRes.status === 404, `StatusCode: ${currRes.statusCode || currRes.status}`);

    // 13. Health Check /api/health
    const r13 = await makeRequest('GET', '/health');
    logTest('13. GET /api/health', r13.status === 200 && r13.body.status === 'active', `Service: ${r13.body.service}`);

  } catch (err) {
    console.error('Fatal test runner error:', err);
  } finally {
    server.close(() => {
      console.log(`\n📊 TEST RESULTS SUMMARY:`);
      console.log(`Passed: ${testsPassed}`);
      console.log(`Failed: ${testsFailed}`);
      console.log(`Total: ${testsPassed + testsFailed}\n`);
      process.exit(testsFailed > 0 ? 1 : 0);
    });
  }
});
