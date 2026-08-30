const axios = require('axios');
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');

const BASE_URL = 'http://localhost:5000/api';
const adminToken = jwt.sign({ id: 'admin-test-id', role: 'admin' }, env.JWT_SECRET, { expiresIn: '1h' });

const authAxios = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${adminToken}`
  }
});

async function runTests() {
  console.log('=== STARTING THUMBNAIL END-TO-END VERIFICATION ===\n');
  console.log('✓ Admin JWT generated.');

  // 1. Fetch departments to get a valid department_id
  const deptsRes = await axios.get(`${BASE_URL}/departments`);
  const depts = deptsRes.data?.data?.departments || deptsRes.data?.departments || [];
  if (!depts.length) {
    throw new Error('No departments found in database to link course.');
  }
  const testDeptId = depts[0].id;
  console.log(`✓ Department ID for course test: ${testDeptId}`);

  // 2. CREATE COURSE WITH THUMBNAIL
  const courseSlug = `test-thumb-course-${Date.now()}`;
  const coursePayload = {
    department_id: testDeptId,
    title: `Test Course Thumbnail ${Date.now()}`,
    slug: courseSlug,
    short_description: 'Testing course thumbnail persistence',
    thumbnail_url: 'https://example.com/storage/courses/test_thumb.webp',
    duration: '6 Weeks',
    level: 'Beginner',
    instructor_name: 'Test Instructor',
    status: 'PUBLISHED'
  };

  console.log('\n--- 1. Testing Course CREATE with thumbnail_url ---');
  const createCourseRes = await authAxios.post('/courses', coursePayload);
  const createdCourse = createCourseRes.data?.data?.course || createCourseRes.data?.course;
  console.log('CREATE Response thumbnail_url:', createdCourse.thumbnail_url);

  if (createdCourse.thumbnail_url !== 'https://example.com/storage/courses/test_thumb.webp') {
    throw new Error(`FAIL: CREATE course thumbnail_url expected "https://example.com/storage/courses/test_thumb.webp" but got "${createdCourse.thumbnail_url}"`);
  }
  console.log('✓ Course CREATE returned correct thumbnail_url.');

  const courseId = createdCourse.id;

  // 3. GET COURSE BY ID & BY SLUG
  console.log('\n--- 2. Testing Course GET API ---');
  const getByIdRes = await axios.get(`${BASE_URL}/courses/id/${courseId}?includeAll=true`);
  const fetchedById = getByIdRes.data?.data?.course || getByIdRes.data?.course;
  console.log('GET /courses/id/:id thumbnail_url:', fetchedById.thumbnail_url);

  if (fetchedById.thumbnail_url !== 'https://example.com/storage/courses/test_thumb.webp') {
    throw new Error(`FAIL: GET course by ID expected "https://example.com/storage/courses/test_thumb.webp" but got "${fetchedById.thumbnail_url}"`);
  }
  console.log('✓ GET /courses/id/:id returned correct thumbnail_url.');

  // 4. UPDATE COURSE (REPLACE THUMBNAIL)
  console.log('\n--- 3. Testing Course UPDATE (Replace Thumbnail) ---');
  const updatePayload = {
    title: fetchedById.title,
    thumbnail_url: 'https://example.com/storage/courses/updated_thumb.webp'
  };
  const updateRes = await authAxios.put(`/courses/${courseId}`, updatePayload);
  const updatedCourse = updateRes.data?.data?.course || updateRes.data?.course;
  console.log('UPDATE Response thumbnail_url:', updatedCourse.thumbnail_url);

  if (updatedCourse.thumbnail_url !== 'https://example.com/storage/courses/updated_thumb.webp') {
    throw new Error(`FAIL: UPDATE course thumbnail_url expected "https://example.com/storage/courses/updated_thumb.webp" but got "${updatedCourse.thumbnail_url}"`);
  }
  console.log('✓ Course UPDATE replaced thumbnail_url successfully.');

  // 5. UPDATE COURSE BASIC DETAILS WITHOUT THUMBNAIL PAYLOAD (MUST PRESERVE THUMBNAIL)
  console.log('\n--- 4. Testing Course UPDATE without thumbnail_url (Preservation check) ---');
  const partialUpdateRes = await authAxios.put(`/courses/${courseId}`, { title: `${fetchedById.title} Updated` });
  const partialUpdatedCourse = partialUpdateRes.data?.data?.course || partialUpdateRes.data?.course;
  console.log('Partial UPDATE thumbnail_url:', partialUpdatedCourse.thumbnail_url);

  if (partialUpdatedCourse.thumbnail_url !== 'https://example.com/storage/courses/updated_thumb.webp') {
    throw new Error(`FAIL: Partial UPDATE broke existing thumbnail_url! Got "${partialUpdatedCourse.thumbnail_url}"`);
  }
  console.log('✓ Partial UPDATE preserved existing thumbnail_url.');

  // 6. REMOVE COURSE THUMBNAIL
  console.log('\n--- 5. Testing Course REMOVE Thumbnail ---');
  const removeRes = await authAxios.put(`/courses/${courseId}`, { thumbnail_url: '' });
  const removedCourse = removeRes.data?.data?.course || removeRes.data?.course;
  console.log('REMOVE Response thumbnail_url:', removedCourse.thumbnail_url);

  if (removedCourse.thumbnail_url !== '') {
    throw new Error(`FAIL: REMOVE course thumbnail_url expected empty string but got "${removedCourse.thumbnail_url}"`);
  }
  console.log('✓ Course thumbnail removed successfully.');

  // Clean up test course
  await authAxios.delete(`/courses/${courseId}`);
  console.log('✓ Test course cleaned up.');

  // 7. DEPARTMENT THUMBNAIL E2E TEST
  console.log('\n--- 6. Testing Department CREATE with thumbnail_url ---');
  const deptSlug = `test-thumb-dept-${Date.now()}`;
  const deptPayload = {
    name: `Test Dept Thumbnail ${Date.now()}`,
    slug: deptSlug,
    description: 'Department thumbnail test',
    thumbnail_url: 'https://example.com/storage/departments/dept_thumb.webp',
    status: 'ACTIVE'
  };

  const createDeptRes = await authAxios.post('/departments', deptPayload);
  console.log('FULL CREATE DEPT RESPONSE DATA:', JSON.stringify(createDeptRes.data, null, 2));
  const createdDept = createDeptRes.data?.data?.department || createDeptRes.data?.department || createDeptRes.data;
  console.log('CREATE Department thumbnail_url:', createdDept.thumbnail_url);

  if (createdDept.thumbnail_url !== 'https://example.com/storage/departments/dept_thumb.webp') {
    throw new Error(`FAIL: CREATE department thumbnail_url expected "https://example.com/storage/departments/dept_thumb.webp" but got "${createdDept.thumbnail_url}"`);
  }
  console.log('✓ Department CREATE returned correct thumbnail_url.');

  const deptId = createdDept.id;

  // 8. GET DEPARTMENT BY SLUG
  console.log('\n--- 7. Testing Department GET API ---');
  const getDeptRes = await axios.get(`${BASE_URL}/departments/${deptSlug}`);
  const fetchedDept = getDeptRes.data?.data?.department || getDeptRes.data?.department;
  console.log('GET /departments/:slug thumbnail_url:', fetchedDept.thumbnail_url);

  if (fetchedDept.thumbnail_url !== 'https://example.com/storage/departments/dept_thumb.webp') {
    throw new Error(`FAIL: GET department expected "https://example.com/storage/departments/dept_thumb.webp" but got "${fetchedDept.thumbnail_url}"`);
  }
  console.log('✓ GET /departments/:slug returned correct thumbnail_url.');

  // 9. UPDATE DEPARTMENT THUMBNAIL
  console.log('\n--- 8. Testing Department UPDATE (Replace Thumbnail) ---');
  const updateDeptRes = await authAxios.put(`/departments/${deptId}`, {
    name: fetchedDept.name,
    thumbnail_url: 'https://example.com/storage/departments/new_dept_thumb.webp'
  });
  const updatedDept = updateDeptRes.data?.data?.department || updateDeptRes.data?.department;
  console.log('UPDATE Department thumbnail_url:', updatedDept.thumbnail_url);

  if (updatedDept.thumbnail_url !== 'https://example.com/storage/departments/new_dept_thumb.webp') {
    throw new Error(`FAIL: UPDATE department thumbnail_url expected "https://example.com/storage/departments/new_dept_thumb.webp" but got "${updatedDept.thumbnail_url}"`);
  }
  console.log('✓ Department UPDATE replaced thumbnail_url successfully.');

  // Clean up test department
  await authAxios.delete(`/departments/${deptId}`);
  console.log('✓ Test department cleaned up.');

  console.log('\n=== ALL THUMBNAIL E2E TESTS PASSED SUCCESSFULLY! ===');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message);
  if (err.response?.data) {
    console.error('API Error Response:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
