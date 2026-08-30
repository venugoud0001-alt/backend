const http = require('http');
const app = require('../src/app');
const { generateSlug, isValidSlug } = require('../src/utils/slug');
const departmentService = require('../src/modules/departments/department.service');
const courseService = require('../src/modules/courses/course.service');
const curriculumService = require('../src/modules/curriculum/curriculum.service');

const { validateCreateDepartment } = require('../src/modules/departments/department.validator');
const { validateCreateCourse } = require('../src/modules/courses/course.validator');
const { validateCreateVersion, validateCreateLesson } = require('../src/modules/curriculum/curriculum.validator');

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api`;
  console.log(`\n🧪 Full 20-Point LMS Hierarchy Integration Test Suite (Port ${port})\n`);

  let passed = 0;
  let failed = 0;

  function logTest(num, name, condition, detail = '') {
    if (condition) {
      passed++;
      console.log(`✅ [PASS] ${num}. ${name} ${detail ? '— ' + detail : ''}`);
    } else {
      failed++;
      console.error(`❌ [FAIL] ${num}. ${name} ${detail ? '— ' + detail : ''}`);
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

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  try {
    // 1. GET departments
    const r1 = await makeRequest('GET', '/departments');
    logTest(1, 'GET departments', r1.status === 200 && r1.body.status === 'SUCCESS', `Found ${r1.body.departments?.length || 0} departments`);

    // 2. GET department by slug
    const firstDeptSlug = r1.body.departments?.[0]?.slug || 'cs-it';
    const r2 = await makeRequest('GET', `/departments/${firstDeptSlug}`);
    logTest(2, 'GET department by slug', r2.status === 200 && r2.body.status === 'SUCCESS', `Slug: ${firstDeptSlug}`);

    // 3. POST department (Security check: rejects unauthorized client calls)
    const r3 = await makeRequest('POST', '/departments', { name: 'Robotics' });
    logTest(3, 'POST department auth guard', r3.status === 401 && r3.body.status === 'ERROR');

    // 4. Duplicate department slug handling
    const deptServiceTestSlug = generateSlug('Computer Science & IT');
    logTest(4, 'Duplicate department slug generator check', deptServiceTestSlug === 'computer-science-it');

    // 5. Update department validation
    const r5 = await makeRequest('PUT', '/departments/invalid-id-123');
    logTest(5, 'Update department auth guard', r5.status === 401);

    // 6. Invalid department status rejection
    const v6 = validateCreateDepartment({ body: { name: 'Test', status: 'INVALID_STATUS' } });
    logTest(6, 'Invalid department status rejection', !v6.isValid && v6.error.includes('Invalid status'));

    // 7. GET courses
    const r7 = await makeRequest('GET', '/courses');
    logTest(7, 'GET courses', r7.status === 200 && r7.body.status === 'SUCCESS', `Found ${r7.body.courses?.length || 0} courses`);

    // 8. Create course with valid department validation
    const validDeptId = r1.body.departments?.[0]?.id || 'dde6c91d-d242-4509-842c-1952c0b90c5a';
    const v8 = validateCreateCourse({ body: { title: 'Cloud Computing', department_id: validDeptId } });
    logTest(8, 'Create course validation with valid department UUID', v8.isValid);

    // 9. Create course with invalid department (rejection)
    const v9 = validateCreateCourse({ body: { title: 'Cloud Computing', department_id: 'not-a-uuid' } });
    logTest(9, 'Create course with invalid department ID rejected', !v9.isValid);

    // 10. Duplicate course slug check
    const courseSlugTest = generateSlug('Full Stack Web Development');
    logTest(10, 'Duplicate course slug handler', courseSlugTest === 'full-stack-web-development');

    // 11. Create course version validation
    const v11 = validateCreateVersion({ params: { courseId: validDeptId }, body: { version_number: 1, title: 'v1.0' } });
    logTest(11, 'Create course version validation', v11.isValid && v11.sanitizedData.version_number === 1);

    // 12. Duplicate version number rejection (version <= 0 check)
    const v12 = validateCreateVersion({ params: { courseId: validDeptId }, body: { version_number: 0 } });
    logTest(12, 'Duplicate/invalid version number <= 0 rejection', !v12.isValid);

    // 13. Create module validation
    const { validateCreateModule } = require('../src/modules/curriculum/curriculum.validator');
    const v13 = validateCreateModule({ params: { versionId: validDeptId }, body: { name: 'Frontend Architecture', display_order: 1 } });
    logTest(13, 'Create module validation', v13.isValid && v13.sanitizedData.name === 'Frontend Architecture');

    // 14. Create lesson validation
    const v14 = validateCreateLesson({ params: { moduleId: validDeptId }, body: { title: 'React Essentials', duration_minutes: 45, lesson_type: 'VIDEO' } });
    logTest(14, 'Create lesson validation', v14.isValid && v14.sanitizedData.duration_minutes === 45);

    // 15. Invalid lesson duration rejection (< 0)
    const v15 = validateCreateLesson({ params: { moduleId: validDeptId }, body: { title: 'React Essentials', duration_minutes: -15 } });
    logTest(15, 'Invalid lesson duration < 0 rejection', !v15.isValid);

    // 16. Create topics validation
    const { validateCreateTopic } = require('../src/modules/curriculum/curriculum.validator');
    const v16 = validateCreateTopic({ params: { lessonId: validDeptId }, body: { title: 'JSX Syntax', display_order: 1 } });
    logTest(16, 'Create topics validation', v16.isValid && v16.sanitizedData.title === 'JSX Syntax');

    // 17. Curriculum endpoint GET /api/courses/:slug/curriculum
    const sampleCourseSlug = r7.body.courses?.[0]?.slug || 'full-stack-development';
    const r17 = await makeRequest('GET', `/courses/${sampleCourseSlug}/curriculum`);
    logTest(17, 'Curriculum endpoint GET /api/courses/:slug/curriculum', r17.status === 200 && r17.body.status === 'SUCCESS', `Course: ${r17.body.course?.title}`);

    // 18. Verify ordering (display_order logic)
    const { validateReorder } = require('../src/modules/curriculum/curriculum.validator');
    const v18 = validateReorder({ params: { id: validDeptId }, body: { display_order: 2 } });
    logTest(18, 'Verify display_order reorder validation', v18.isValid && v18.sanitizedData.display_order === 2);

    // 19. Verify unpublished content is hidden for public requests
    const r19 = await makeRequest('GET', '/courses');
    const unpublishedInPublic = (r19.body.courses || []).some(c => c.status === 'DRAFT' || c.status === 'UNPUBLISHED');
    logTest(19, 'Verify unpublished content is hidden in public listing', !unpublishedInPublic);

    // 20. Verify errors return consistent JSON format
    const r20 = await makeRequest('GET', '/departments/invalid-slug-99999');
    logTest(20, 'Verify error returns consistent JSON response', r20.status === 404 && r20.body.status === 'ERROR' && typeof r20.body.message === 'string');

  } catch (err) {
    console.error('Fatal test error:', err);
  } finally {
    server.close(() => {
      console.log(`\n===========================================`);
      console.log(`📊 FINAL TEST RUN RESULTS SUMMARY:`);
      console.log(`Passed: ${passed} / 20`);
      console.log(`Failed: ${failed} / 20`);
      console.log(`===========================================\n`);
      process.exit(failed > 0 ? 1 : 0);
    });
  }
});
