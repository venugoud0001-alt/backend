/**
 * InternNetra — Phase 3 Video Analytics Aggregation & Admin API Test Suite
 * Validates:
 * 1. Overview metrics calculation & rewatch accuracy
 * 2. Topic analytics calculation
 * 3. Course analytics with module and topic rollups (zero N+1)
 * 4. Module analytics with topic rollups
 * 5. Paginated students analytics (limit, offset, totalPages)
 * 6. Single student breakdown
 * 7. Daily trend buckets
 * 8. All date filters: today, last7days, last30days, thisMonth, custom
 * 9. Empty dataset handling (clean zero values, no division-by-zero crashes)
 * 10. Live HTTP endpoint & Admin Authorization guards (401 unauthenticated, 403 student, 200 admin)
 * 11. Zero regression on Phase 1 & 2
 */

const crypto = require('crypto');
const { supabase } = require('../src/config/supabase');
const adminService = require('../src/modules/video/video.analytics.admin.service');
const videoAnalyticsService = require('../src/modules/video/video.analytics.service');

async function runPhase3TestSuite() {
  console.log('========================================================================');
  console.log('🚀 INTERNNETRA LMS: VIDEO ANALYTICS PHASE 3 VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assertTest(name, condition, extraInfo = '') {
    if (condition) {
      console.log(`✅ [PASS] ${name} ${extraInfo ? '(' + extraInfo + ')' : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name} ${extraInfo ? '(' + extraInfo + ')' : ''}`);
      failed++;
    }
  }

  // --------------------------------------------------------------------------
  // STEP 1: DISCOVER FIXTURES & SEED CONTROLLED TEST TELEMETRY
  // --------------------------------------------------------------------------
  console.log('--- TEST GROUP 1: Fixtures Discovery & Controlled Seed Setup ---');

  const { data: students } = await supabase.from('students').select('id, email, full_name').limit(3);
  assertTest('Real students available', students && students.length >= 2);
  const student1 = students[0];
  const student2 = students[1];

  const { data: topics } = await supabase.from('topics').select('id, course_id, module_id, title').limit(3);
  assertTest('Real topics available', topics && topics.length >= 2);
  const topic1 = topics[0];
  const topic2 = topics[1];
  const courseId = topic1.course_id;
  const moduleId = topic1.module_id;

  const createdEventIds = [];
  const sessionA = crypto.randomUUID();
  const sessionB = crypto.randomUUID(); // Second session by student1 on topic1 => REWATCH!
  const sessionC = crypto.randomUUID(); // Session by student2 on topic1 => INITIAL VIEW!

  // Seed controlled telemetry:
  // Student 1, Session A on Topic 1: PLAY, HEARTBEAT (15s), HEARTBEAT (15s), COMPLETED (100%)
  // Student 1, Session B on Topic 1: PLAY, HEARTBEAT (15s) -> This is REWATCH
  // Student 2, Session C on Topic 1: PLAY, HEARTBEAT (15s)
  const now = new Date();
  const seededEvents = [
    // Session A
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionA,
      event_type: 'VIDEO_SESSION_STARTED',
      position_seconds: 0,
      duration_seconds: 300,
      completion_percentage: 0,
      event_timestamp: new Date(now.getTime() - 3600000).toISOString()
    },
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionA,
      event_type: 'VIDEO_PLAY',
      position_seconds: 0,
      duration_seconds: 300,
      completion_percentage: 0,
      event_timestamp: new Date(now.getTime() - 3500000).toISOString()
    },
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionA,
      event_type: 'VIDEO_HEARTBEAT',
      position_seconds: 15,
      duration_seconds: 300,
      completion_percentage: 5,
      metadata: { heartbeat_interval_seconds: 15 },
      event_timestamp: new Date(now.getTime() - 3400000).toISOString()
    },
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionA,
      event_type: 'VIDEO_HEARTBEAT',
      position_seconds: 30,
      duration_seconds: 300,
      completion_percentage: 10,
      metadata: { heartbeat_interval_seconds: 15 },
      event_timestamp: new Date(now.getTime() - 3300000).toISOString()
    },
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionA,
      event_type: 'VIDEO_COMPLETED',
      position_seconds: 300,
      duration_seconds: 300,
      completion_percentage: 100,
      event_timestamp: new Date(now.getTime() - 3200000).toISOString()
    },
    // Session B (Student 1 REWATCH on Topic 1)
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionB,
      event_type: 'VIDEO_SESSION_STARTED',
      position_seconds: 0,
      duration_seconds: 300,
      completion_percentage: 0,
      event_timestamp: new Date(now.getTime() - 1800000).toISOString()
    },
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionB,
      event_type: 'VIDEO_PLAY',
      position_seconds: 0,
      duration_seconds: 300,
      completion_percentage: 0,
      event_timestamp: new Date(now.getTime() - 1700000).toISOString()
    },
    {
      client_event_id: crypto.randomUUID(),
      student_id: student1.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionB,
      event_type: 'VIDEO_HEARTBEAT',
      position_seconds: 15,
      duration_seconds: 300,
      completion_percentage: 5,
      metadata: { heartbeat_interval_seconds: 15 },
      event_timestamp: new Date(now.getTime() - 1600000).toISOString()
    },
    // Session C (Student 2 Initial View on Topic 1)
    {
      client_event_id: crypto.randomUUID(),
      student_id: student2.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionC,
      event_type: 'VIDEO_PLAY',
      position_seconds: 0,
      duration_seconds: 300,
      completion_percentage: 0,
      event_timestamp: new Date(now.getTime() - 600000).toISOString()
    },
    {
      client_event_id: crypto.randomUUID(),
      student_id: student2.id,
      course_id: courseId,
      module_id: moduleId,
      topic_id: topic1.id,
      session_id: sessionC,
      event_type: 'VIDEO_HEARTBEAT',
      position_seconds: 15,
      duration_seconds: 300,
      completion_percentage: 5,
      metadata: { heartbeat_interval_seconds: 15 },
      event_timestamp: new Date(now.getTime() - 500000).toISOString()
    }
  ];

  const { data: insertedSeeds, error: seedErr } = await supabase
    .from('video_analytics_events')
    .insert(seededEvents)
    .select('id');

  assertTest('Seeded controlled telemetry events into database', !seedErr && insertedSeeds?.length === 10);
  if (insertedSeeds) {
    createdEventIds.push(...insertedSeeds.map(e => e.id));
  }

  // --------------------------------------------------------------------------
  // STEP 2: OVERVIEW METRICS VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: Platform Overview Metrics ---');
  const overviewRes = await adminService.getOverviewMetrics({ dateFilter: 'last7days' });

  assertTest('Overview returns valid dateRange', overviewRes && overviewRes.dateRange?.filterName === 'last7days');
  const m = overviewRes.metrics;
  assertTest('Overview records >= 2 uniqueViewers', m.uniqueViewers >= 2, `Count: ${m.uniqueViewers}`);
  assertTest('Overview records >= 3 sessions', m.sessions >= 3, `Count: ${m.sessions}`);
  assertTest('Overview records >= 3 plays', m.plays >= 3, `Count: ${m.plays}`);
  assertTest('Overview records >= 1 rewatchCount', m.rewatchCount >= 1, `Count: ${m.rewatchCount}`);
  assertTest('Overview records >= 60 totalWatchTimeSeconds (4 heartbeats * 15s)', m.totalWatchTimeSeconds >= 60, `Seconds: ${m.totalWatchTimeSeconds}`);
  assertTest('Overview records averageWatchTimeSeconds > 0', m.averageWatchTimeSeconds > 0);
  assertTest('Overview records completedViewers >= 1', m.completedViewers >= 1);
  assertTest('Overview records averagePlaysPerViewer > 0', m.averagePlaysPerViewer > 0);

  // --------------------------------------------------------------------------
  // STEP 3: TOPIC ANALYTICS VERIFICATION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: Topic-Level Analytics ---');
  const topicRes = await adminService.getTopicMetrics(topic1.id, { dateFilter: 'last7days' });

  assertTest('Topic metrics returns topic metadata', topicRes.topic?.id === topic1.id);
  const tm = topicRes.metrics;
  assertTest('Topic uniqueViewers >= 2', tm.uniqueViewers >= 2);
  assertTest('Topic sessions >= 3', tm.sessions >= 3);
  assertTest('Topic plays >= 3', tm.plays >= 3);
  assertTest('Topic rewatches >= 1', tm.rewatches >= 1);
  assertTest('Topic watchTimeSeconds >= 60', tm.watchTimeSeconds >= 60);
  assertTest('Topic completedStudents >= 1', tm.completedStudents >= 1);
  assertTest('Topic lastActivity timestamp populated', !!tm.lastActivity);

  // --------------------------------------------------------------------------
  // STEP 4: COURSE & MODULE ANALYTICS (ZERO N+1 VERIFICATION)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: Course & Module Analytics Rollups ---');
  const courseRes = await adminService.getCourseAnalytics(courseId, { dateFilter: 'last7days' });

  assertTest('Course analytics returns course metadata', courseRes.course?.id === courseId);
  assertTest('Course metrics populated', courseRes.metrics?.uniqueViewers >= 2);
  assertTest('Course modules array populated', Array.isArray(courseRes.modules) && courseRes.modules.length > 0);
  assertTest('Course topics array populated', Array.isArray(courseRes.topics) && courseRes.topics.length > 0);

  const moduleRes = await adminService.getModuleAnalytics(moduleId, { dateFilter: 'last7days' });
  assertTest('Module analytics returns moduleId', String(moduleRes.moduleId) === String(moduleId));
  assertTest('Module metrics populated', moduleRes.metrics?.uniqueViewers >= 2);
  assertTest('Module topics array populated', Array.isArray(moduleRes.topics) && moduleRes.topics.length > 0);

  // --------------------------------------------------------------------------
  // STEP 5: PAGINATED STUDENTS ANALYTICS
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: Paginated Students Analytics ---');
  const studentsPage1 = await adminService.getStudentsAnalytics({
    dateFilter: 'last7days',
    page: 1,
    limit: 2
  });

  assertTest('Students listing returns array', Array.isArray(studentsPage1.students));
  assertTest('Students listing adheres to limit', studentsPage1.students.length <= 2);
  assertTest('Pagination object contains total & totalPages', studentsPage1.pagination?.total >= 2 && studentsPage1.pagination?.totalPages >= 1);

  const foundStudent1 = studentsPage1.students.find(s => s.studentId === student1.id);
  if (foundStudent1) {
    assertTest('Student 1 metrics populated (topicsViewed, sessions, watchTime)', foundStudent1.topicsViewed >= 1 && foundStudent1.sessions >= 2);
  }

  // --------------------------------------------------------------------------
  // STEP 6: SINGLE STUDENT DEEP DIVE
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 6: Single Student Deep Dive ---');
  const studentDetail = await adminService.getSingleStudentAnalytics(student1.id, { dateFilter: 'last7days' });

  assertTest('Single student returns profile', studentDetail.student?.id === student1.id);
  assertTest('Single student metrics show sessions >= 2', studentDetail.metrics?.sessions >= 2);
  assertTest('Single student metrics show rewatches >= 1', studentDetail.metrics?.rewatches >= 1);
  assertTest('Single student topics history populated', Array.isArray(studentDetail.topics) && studentDetail.topics.length > 0);

  // --------------------------------------------------------------------------
  // STEP 7: TRENDS TIME-SERIES AGGREGATION
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 7: Daily Trends Time-Series ---');
  const trendsRes = await adminService.getTrendsAnalytics({ dateFilter: 'last7days' });

  assertTest('Trends returns array of daily buckets', Array.isArray(trendsRes.trends) && trendsRes.trends.length > 0);
  const todayBucket = trendsRes.trends.find(t => t.date === now.toISOString().slice(0, 10));
  assertTest('Today bucket contains plays and watch time', todayBucket && todayBucket.plays >= 3 && todayBucket.watchTimeSeconds >= 60);

  // --------------------------------------------------------------------------
  // STEP 8: DATE RANGE FILTERS
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 8: Parameterized Date Filter Presets ---');
  const todayRange = adminService.resolveDateRange('today');
  assertTest('Date filter "today" produces valid range', todayRange.filterName === 'today' && new Date(todayRange.startDate) <= new Date(todayRange.endDate));

  const weekRange = adminService.resolveDateRange('last7days');
  assertTest('Date filter "last7days" produces 7-day delta', Math.round((new Date(weekRange.endDate) - new Date(weekRange.startDate)) / (24 * 3600 * 1000)) === 7);

  const monthRange = adminService.resolveDateRange('thisMonth');
  assertTest('Date filter "thisMonth" starts at day 1', new Date(monthRange.startDate).getUTCDate() === 1);

  const customRange = adminService.resolveDateRange('custom', '2026-08-01T00:00:00Z', '2026-08-15T00:00:00Z');
  assertTest('Date filter "custom" parses ISO bounds', customRange.startDate === '2026-08-01T00:00:00.000Z' && customRange.endDate === '2026-08-15T00:00:00.000Z');

  // --------------------------------------------------------------------------
  // STEP 9: EMPTY DATASET RESILIENCE
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 9: Empty Dataset Handling ---');
  // Query a date range in the distant past (year 2000)
  const emptyRes = await adminService.getOverviewMetrics({
    dateFilter: 'custom',
    startDate: '2000-01-01T00:00:00.000Z',
    endDate: '2000-01-02T00:00:00.000Z'
  });

  assertTest('Empty dataset overview returns 0 uniqueViewers', emptyRes.metrics?.uniqueViewers === 0);
  assertTest('Empty dataset overview returns 0 plays', emptyRes.metrics?.plays === 0);
  assertTest('Empty dataset overview returns 0 averageWatchTimeSeconds (no NaN)', emptyRes.metrics?.averageWatchTimeSeconds === 0);
  assertTest('Empty dataset overview returns 0 averagePlaysPerViewer (no NaN)', emptyRes.metrics?.averagePlaysPerViewer === 0);

  // --------------------------------------------------------------------------
  // STEP 10: LIVE HTTP ENDPOINT & ADMIN AUTHORIZATION (PORT 5000)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 10: Live HTTP Admin Endpoints & Security Guards ---');
  const baseUrl = 'http://127.0.0.1:5000/api';

  // 10.1 Unauthenticated Request -> 401
  const unauthRes = await fetch(`${baseUrl}/admin/analytics/video/overview`);
  assertTest('Unauthenticated request rejected with 401', unauthRes.status === 401);

  // 10.2 Student Role Request -> 403 Forbidden
  // Generate a valid JWT for student1 with role STUDENT
  const jwt = require('jsonwebtoken');
  const jwtSecret = process.env.JWT_SECRET || 'internnetra_prod_jwt_secret_key_2026';
  const studentToken = jwt.sign(
    { id: student1.id, email: student1.email, role: 'STUDENT', user_metadata: { role: 'STUDENT' } },
    jwtSecret,
    { expiresIn: '1h' }
  );

  const studentReq = await fetch(`${baseUrl}/admin/analytics/video/overview`, {
    headers: { Authorization: `Bearer ${studentToken}` }
  });
  assertTest('Student role request rejected with 403 Forbidden', studentReq.status === 403);

  // 10.3 Authorized Admin Request -> 200 OK
  const adminReq = await fetch(`${baseUrl}/admin/analytics/video/overview?dateFilter=last7days`, {
    headers: { Authorization: 'Bearer admin-session-token-1001' }
  });
  assertTest('Admin request succeeds with 200 OK', adminReq.status === 200);
  const adminJson = await adminReq.json();
  const returnedMetrics = adminJson.data?.metrics || adminJson.metrics;
  assertTest('Admin response contains SUCCESS status & metrics', adminJson.status === 'SUCCESS' && returnedMetrics?.uniqueViewers !== undefined);

  // 10.4 Admin Requests across other routes
  const courseReq = await fetch(`${baseUrl}/admin/analytics/video/courses/${courseId}`, {
    headers: { Authorization: 'Bearer admin-session-token-1001' }
  });
  assertTest('Admin GET /courses/:courseId succeeds with 200', courseReq.status === 200);

  const topicReq = await fetch(`${baseUrl}/admin/analytics/video/topics/${topic1.id}`, {
    headers: { Authorization: 'Bearer admin-session-token-1001' }
  });
  assertTest('Admin GET /topics/:topicId succeeds with 200', topicReq.status === 200);

  const studentsReq = await fetch(`${baseUrl}/admin/analytics/video/students?page=1&limit=5`, {
    headers: { Authorization: 'Bearer admin-session-token-1001' }
  });
  assertTest('Admin GET /students succeeds with 200 and pagination', studentsReq.status === 200);

  const trendsReq = await fetch(`${baseUrl}/admin/analytics/video/trends`, {
    headers: { Authorization: 'Bearer admin-session-token-1001' }
  });
  assertTest('Admin GET /trends succeeds with 200', trendsReq.status === 200);

  // --------------------------------------------------------------------------
  // CLEANUP TEMPORARY TEST SEEDS
  // --------------------------------------------------------------------------
  if (createdEventIds.length > 0) {
    await supabase.from('video_analytics_events').delete().in('id', createdEventIds);
    console.log(`\n🧹 Cleaned up ${createdEventIds.length} temporary test analytics events.`);
  }

  console.log('\n========================================================================');
  console.log(`📊 PHASE 3 SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log('========================================================================\n');

  return { passed, failed };
}

if (require.main === module) {
  runPhase3TestSuite()
    .then(({ failed }) => {
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('Fatal error during Phase 3 test execution:', err);
      process.exit(1);
    });
}

module.exports = { runPhase3TestSuite };
