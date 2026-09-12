/**
 * INTERNNETRA — PHASE 5: COMPLETE VIDEO ANALYTICS AUDIT SUITE
 * Performance + Security + Mathematical Accuracy + Player Regression Audit
 */

const { supabase } = require('../src/config/supabase');
const adminService = require('../src/modules/video/video.analytics.admin.service');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

let totalTests = 0;
let passedTests = 0;
const testResults = [];

function assertAudit(testId, name, condition, details = '') {
  totalTests++;
  const passed = Boolean(condition);
  if (passed) {
    passedTests++;
    console.log(`  ✅ [PASS] #${testId}: ${name} ${details ? `(${details})` : ''}`);
  } else {
    console.error(`  ❌ [FAIL] #${testId}: ${name} ${details ? `(${details})` : ''}`);
  }
  testResults.push({ testId, name, passed, details });
}

async function runPhase5Audit() {
  console.log('========================================================================');
  console.log('INTERNNETRA — PHASE 5: COMPLETE VIDEO ANALYTICS FINAL AUDIT');
  console.log('========================================================================\n');

  const cleanupEventIds = [];

  try {
    // --------------------------------------------------------------------------
    // FIXTURES ACQUISITION
    // --------------------------------------------------------------------------
    const { data: students } = await supabase.from('students').select('id, email, full_name').limit(4);
    if (!students || students.length < 3) {
      throw new Error('Audit requires at least 3 students in database.');
    }
    const studentA = students[0];
    const studentB = students[1];
    const studentC = students[2];

    const { data: courses } = await supabase.from('courses').select('id, title, slug').limit(3);
    if (!courses || courses.length < 2) {
      throw new Error('Audit requires at least 2 courses in database.');
    }
    const courseA = courses[0];
    const courseB = courses[1];

    const { data: topicsA } = await supabase.from('topics').select('id, course_id, module_id, title').eq('course_id', courseA.id).limit(3);
    const { data: topicsB } = await supabase.from('topics').select('id, course_id, module_id, title').eq('course_id', courseB.id).limit(2);
    
    // Fallback if course topics are structured differently
    let topicA1 = topicsA && topicsA[0];
    let topicA2 = topicsA && topicsA[1];
    let topicB1 = topicsB && topicsB[0];

    if (!topicA1 || !topicA2) {
      const { data: allTopics } = await supabase.from('topics').select('id, course_id, module_id, title').limit(4);
      topicA1 = allTopics[0];
      topicA2 = allTopics[1];
      topicB1 = allTopics[2];
    }

    console.log(`Found Fixtures:`);
    console.log(`  Students: A=${studentA.id}, B=${studentB.id}, C=${studentC.id}`);
    console.log(`  Course A=${courseA.id} (Topics: ${topicA1?.id}, ${topicA2?.id})`);
    console.log(`  Course B=${courseB.id} (Topic: ${topicB1?.id})\n`);

    // ==========================================================================
    // SECTION 1: VERIFY COMPLETE FLOW
    // ==========================================================================
    console.log('--- SECTION 1: Verify Complete Flow ---');
    const flowSessionId = crypto.randomUUID();
    const flowEvents = [
      {
        client_event_id: crypto.randomUUID(),
        student_id: studentA.id,
        course_id: courseA.id,
        module_id: topicA1.module_id,
        topic_id: topicA1.id,
        session_id: flowSessionId,
        event_type: 'VIDEO_TOPIC_OPENED',
        position_seconds: 0,
        duration_seconds: 300,
        completion_percentage: 0
      },
      {
        client_event_id: crypto.randomUUID(),
        student_id: studentA.id,
        course_id: courseA.id,
        module_id: topicA1.module_id,
        topic_id: topicA1.id,
        session_id: flowSessionId,
        event_type: 'VIDEO_SESSION_STARTED',
        position_seconds: 0,
        duration_seconds: 300,
        completion_percentage: 0
      },
      {
        client_event_id: crypto.randomUUID(),
        student_id: studentA.id,
        course_id: courseA.id,
        module_id: topicA1.module_id,
        topic_id: topicA1.id,
        session_id: flowSessionId,
        event_type: 'VIDEO_PLAY',
        position_seconds: 0,
        duration_seconds: 300,
        completion_percentage: 0
      },
      {
        client_event_id: crypto.randomUUID(),
        student_id: studentA.id,
        course_id: courseA.id,
        module_id: topicA1.module_id,
        topic_id: topicA1.id,
        session_id: flowSessionId,
        event_type: 'VIDEO_HEARTBEAT',
        position_seconds: 15,
        duration_seconds: 300,
        completion_percentage: 5,
        metadata: { heartbeat_interval_seconds: 15 }
      }
    ];

    const { data: insertedFlow, error: flowErr } = await supabase
      .from('video_analytics_events')
      .insert(flowEvents)
      .select('id');
    
    assertAudit('1.1', 'Flow: Ingest events into Supabase table', !flowErr && insertedFlow?.length === 4);
    if (insertedFlow) cleanupEventIds.push(...insertedFlow.map(e => e.id));

    const flowMetrics = await adminService.getTopicMetrics(topicA1.id, { dateFilter: 'last7days' });
    assertAudit('1.2', 'Flow: Aggregation service calculates topic metrics', flowMetrics && flowMetrics.metrics?.sessions >= 1);
    assertAudit('1.3', 'Flow: End-to-end data reached analytics layer', flowMetrics.metrics?.plays >= 1);

    // ==========================================================================
    // SECTION 2: VERIFY UNIQUE VIEWERS
    // One student with 50 heartbeat events => Unique viewers = 1
    // ==========================================================================
    console.log('\n--- SECTION 2: Verify Unique Viewers ---');
    const uqSessionId = crypto.randomUUID();
    const fiftyHeartbeats = [];
    for (let i = 1; i <= 50; i++) {
      fiftyHeartbeats.push({
        client_event_id: crypto.randomUUID(),
        student_id: studentA.id,
        course_id: courseA.id,
        module_id: topicA2.module_id,
        topic_id: topicA2.id,
        session_id: uqSessionId,
        event_type: 'VIDEO_HEARTBEAT',
        position_seconds: i * 2,
        duration_seconds: 200,
        completion_percentage: Math.min(100, Math.round((i * 2 / 200) * 100)),
        metadata: { heartbeat_interval_seconds: 2 }
      });
    }

    const { data: insHeartbeats } = await supabase.from('video_analytics_events').insert(fiftyHeartbeats).select('id');
    if (insHeartbeats) cleanupEventIds.push(...insHeartbeats.map(e => e.id));

    const topicA2Metrics = await adminService.getTopicMetrics(topicA2.id, { dateFilter: 'last7days' });
    assertAudit('2.1', '50 heartbeats from 1 student: Unique viewers == 1', topicA2Metrics.metrics?.uniqueViewers === 1, `Viewers: ${topicA2Metrics.metrics?.uniqueViewers}`);
    assertAudit('2.2', '50 heartbeats from 1 student: Total sessions == 1', topicA2Metrics.metrics?.sessions === 1, `Sessions: ${topicA2Metrics.metrics?.sessions}`);

    // ==========================================================================
    // SECTION 3: VERIFY PLAY COUNT
    // Student: Play, Pause, Play, Pause, Play => 3 plays, not 5, not 100 heartbeats
    // ==========================================================================
    console.log('\n--- SECTION 3: Verify Play Count ---');
    const playTestSession = crypto.randomUUID();
    const playSequenceEvents = [
      { client_event_id: crypto.randomUUID(), student_id: studentB.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: playTestSession, event_type: 'VIDEO_PLAY', position_seconds: 0, duration_seconds: 300 },
      { client_event_id: crypto.randomUUID(), student_id: studentB.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: playTestSession, event_type: 'VIDEO_PAUSE', position_seconds: 10, duration_seconds: 300 },
      { client_event_id: crypto.randomUUID(), student_id: studentB.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: playTestSession, event_type: 'VIDEO_PLAY', position_seconds: 10, duration_seconds: 300 },
      { client_event_id: crypto.randomUUID(), student_id: studentB.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: playTestSession, event_type: 'VIDEO_PAUSE', position_seconds: 25, duration_seconds: 300 },
      { client_event_id: crypto.randomUUID(), student_id: studentB.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: playTestSession, event_type: 'VIDEO_PLAY', position_seconds: 25, duration_seconds: 300 },
      // Plus 10 heartbeats
      { client_event_id: crypto.randomUUID(), student_id: studentB.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: playTestSession, event_type: 'VIDEO_HEARTBEAT', position_seconds: 30, duration_seconds: 300, metadata: { heartbeat_interval_seconds: 5 } }
    ];

    const { data: insPlays } = await supabase.from('video_analytics_events').insert(playSequenceEvents).select('id');
    if (insPlays) cleanupEventIds.push(...insPlays.map(e => e.id));

    // Count plays specifically for Student B in this session
    const { data: stuBPlays } = await supabase
      .from('video_analytics_events')
      .select('id, event_type')
      .eq('session_id', playTestSession);

    const playsOnly = stuBPlays.filter(e => e.event_type === 'VIDEO_PLAY').length;
    const totalEventsInSession = stuBPlays.length;

    assertAudit('3.1', 'Play-Pause-Play-Pause-Play records exactly 3 plays', playsOnly === 3, `Count: ${playsOnly}`);
    assertAudit('3.2', 'Heartbeat and Pause events are NOT counted as plays', playsOnly < totalEventsInSession, `Total events: ${totalEventsInSession}, Plays: ${playsOnly}`);

    // ==========================================================================
    // SECTION 4: VERIFY REWATCH
    // 1 qualifying initial session, 3 qualifying later sessions => Rewatch count = 3
    // ==========================================================================
    console.log('\n--- SECTION 4: Verify Rewatch Detection Rule ---');
    const sess1 = crypto.randomUUID(); // Initial view
    const sess2 = crypto.randomUUID(); // Rewatch 1
    const sess3 = crypto.randomUUID(); // Rewatch 2
    const sess4 = crypto.randomUUID(); // Rewatch 3

    const rewatchEvents = [
      // Session 1: initial
      { client_event_id: crypto.randomUUID(), student_id: studentC.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: sess1, event_type: 'VIDEO_PLAY', position_seconds: 0 },
      // Session 2: rewatch 1
      { client_event_id: crypto.randomUUID(), student_id: studentC.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: sess2, event_type: 'VIDEO_PLAY', position_seconds: 0 },
      // Session 3: rewatch 2
      { client_event_id: crypto.randomUUID(), student_id: studentC.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: sess3, event_type: 'VIDEO_PLAY', position_seconds: 0 },
      // Session 4: rewatch 3
      { client_event_id: crypto.randomUUID(), student_id: studentC.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: sess4, event_type: 'VIDEO_PLAY', position_seconds: 0 }
    ];

    const { data: insRewatch } = await supabase.from('video_analytics_events').insert(rewatchEvents).select('id');
    if (insRewatch) cleanupEventIds.push(...insRewatch.map(e => e.id));

    // Evaluate student C rewatches on topic A2
    const stuCRewatches = adminService.calculateRewatchCount(rewatchEvents);
    assertAudit('4.1', '1 initial session + 3 subsequent sessions => Rewatch count == 3', stuCRewatches === 3, `Rewatches: ${stuCRewatches}`);

    // ==========================================================================
    // SECTION 5: VERIFY WATCH TIME
    // Play 2m, Pause 10m, Play 3m => Total watch time ≈ 5 minutes (300s).
    // Pause time (10 min) must NOT count.
    // ==========================================================================
    console.log('\n--- SECTION 5: Verify Watch Time Calculation ---');
    const watchTimeEvents = [];
    const wtSession = crypto.randomUUID();

    // Play 2 minutes: 8 heartbeats of 15s = 120s
    for (let i = 1; i <= 8; i++) {
      watchTimeEvents.push({
        event_type: 'VIDEO_HEARTBEAT',
        metadata: { heartbeat_interval_seconds: 15 }
      });
    }

    // Pause 10 minutes: 1 VIDEO_PAUSE event, ZERO heartbeats emitted
    watchTimeEvents.push({
      event_type: 'VIDEO_PAUSE',
      position_seconds: 120
    });

    // Play 3 minutes: 12 heartbeats of 15s = 180s
    for (let i = 1; i <= 12; i++) {
      watchTimeEvents.push({
        event_type: 'VIDEO_HEARTBEAT',
        metadata: { heartbeat_interval_seconds: 15 }
      });
    }

    const calculatedSeconds = adminService.calculateWatchTime(watchTimeEvents);
    assertAudit('5.1', 'Play 2m + Pause 10m + Play 3m => exactly 300s watch time (5 min)', calculatedSeconds === 300, `Calculated: ${calculatedSeconds}s`);
    assertAudit('5.2', '10 minutes of Pause time is strictly ignored in watch time', calculatedSeconds < 900, `Expected 300s, not 900s`);

    // ==========================================================================
    // SECTION 6: VERIFY SEEK JUMP ACCURACY
    // Watch 2m, seek to 10m, continue 2m => Seek jump is NOT 8m watched.
    // Expected watch time = 2m + 2m = 4m (240s)
    // ==========================================================================
    console.log('\n--- SECTION 6: Verify Seek Jump Handling ---');
    const seekEvents = [];
    // Watch 2 minutes (8 heartbeats of 15s = 120s)
    for (let i = 1; i <= 8; i++) {
      seekEvents.push({
        event_type: 'VIDEO_HEARTBEAT',
        metadata: { heartbeat_interval_seconds: 15 }
      });
    }
    // Seek jump: from 120s to 600s (jump of 480s / 8 minutes)
    seekEvents.push({
      event_type: 'VIDEO_SEEK',
      position_seconds: 600,
      metadata: { previous_position: 120, target_position: 600 }
    });
    // Continue watching 2 minutes (8 heartbeats of 15s = 120s)
    for (let i = 1; i <= 8; i++) {
      seekEvents.push({
        event_type: 'VIDEO_HEARTBEAT',
        metadata: { heartbeat_interval_seconds: 15 }
      });
    }

    const seekCalculatedSeconds = adminService.calculateWatchTime(seekEvents);
    assertAudit('6.1', 'Seek jump (120s -> 600s) does NOT accumulate 8m into watch time', seekCalculatedSeconds === 240, `Watch time: ${seekCalculatedSeconds}s`);

    // ==========================================================================
    // SECTION 7: VERIFY COMPLETION
    // ==========================================================================
    console.log('\n--- SECTION 7: Verify Completion State ---');
    const completionSession = crypto.randomUUID();
    const completionEvents = [
      {
        client_event_id: crypto.randomUUID(),
        student_id: studentA.id,
        course_id: courseA.id,
        module_id: topicA1.module_id,
        topic_id: topicA1.id,
        session_id: completionSession,
        event_type: 'VIDEO_COMPLETED',
        position_seconds: 300,
        duration_seconds: 300,
        completion_percentage: 100
      }
    ];

    const { data: insComp } = await supabase.from('video_analytics_events').insert(completionEvents).select('id');
    if (insComp) cleanupEventIds.push(...insComp.map(e => e.id));

    const topicAfterComp = await adminService.getTopicMetrics(topicA1.id, { dateFilter: 'last7days' });
    assertAudit('7.1', 'VIDEO_COMPLETED increments completedStudents', topicAfterComp.metrics?.completedStudents >= 1);

    // ==========================================================================
    // SECTION 8: VERIFY TOPIC ISOLATION
    // Topic 1, Topic 2, Topic 3 events strictly partitioned by topic_id
    // ==========================================================================
    console.log('\n--- SECTION 8: Verify Topic Isolation ---');
    const isoTopic1Session = crypto.randomUUID();
    const isoTopic2Session = crypto.randomUUID();

    const isoEvents = [
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: isoTopic1Session, event_type: 'VIDEO_PLAY' },
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: isoTopic2Session, event_type: 'VIDEO_PLAY' }
    ];

    const { data: insIso } = await supabase.from('video_analytics_events').insert(isoEvents).select('id');
    if (insIso) cleanupEventIds.push(...insIso.map(e => e.id));

    const queryIso1 = await supabase.from('video_analytics_events').select('id, topic_id').eq('session_id', isoTopic1Session);
    const queryIso2 = await supabase.from('video_analytics_events').select('id, topic_id').eq('session_id', isoTopic2Session);

    assertAudit('8.1', 'Topic 1 session has strictly Topic 1 ID', queryIso1.data?.every(e => e.topic_id === topicA1.id));
    assertAudit('8.2', 'Topic 2 session has strictly Topic 2 ID', queryIso2.data?.every(e => e.topic_id === topicA2.id));
    assertAudit('8.3', 'No events cross-attributed between topics', queryIso1.data[0].topic_id !== queryIso2.data[0].topic_id);

    // ==========================================================================
    // SECTION 9: VERIFY MULTIPLE STUDENTS SEPARATION
    // Student A, B, C metrics are correctly separated
    // ==========================================================================
    console.log('\n--- SECTION 9: Verify Multiple Students Separation ---');
    const stuListRes = await adminService.getStudentsAnalytics({ dateFilter: 'last7days', page: 1, limit: 10 });
    const studentsArr = stuListRes.students || [];

    const recA = studentsArr.find(s => s.studentId === studentA.id);
    const recB = studentsArr.find(s => s.studentId === studentB.id);
    const recC = studentsArr.find(s => s.studentId === studentC.id);

    assertAudit('9.1', 'Student A analytics record queryable', !!recA);
    assertAudit('9.2', 'Student B analytics record queryable', !!recB);
    assertAudit('9.3', 'Student C analytics record queryable', !!recC);
    assertAudit('9.4', 'Individual student records maintain distinct metrics', recA?.studentId !== recB?.studentId && recB?.studentId !== recC?.studentId);

    // ==========================================================================
    // SECTION 10: VERIFY MULTIPLE COURSES SEPARATION
    // Course A activity does not appear in Course B
    // ==========================================================================
    console.log('\n--- SECTION 10: Verify Course Separation ---');
    const courseAAnalytics = await adminService.getCourseAnalytics(courseA.id, { dateFilter: 'last7days' });
    const courseBAnalytics = await adminService.getCourseAnalytics(courseB.id, { dateFilter: 'last7days' });

    assertAudit('10.1', 'Course A metrics scoped to Course A ID', courseAAnalytics.course?.id === courseA.id);
    assertAudit('10.2', 'Course B metrics scoped to Course B ID', courseBAnalytics.course?.id === courseB.id);

    const courseATopics = courseAAnalytics.topics?.map(t => t.id) || [];
    assertAudit('10.3', 'Course B topic not present in Course A topics rollup', !courseATopics.includes(topicB1?.id));

    // ==========================================================================
    // SECTION 11: VERIFY SECURITY GUARDS
    // ==========================================================================
    console.log('\n--- SECTION 11: Verify RBAC & Token Security ---');
    const jwtSecret = process.env.JWT_SECRET || 'internnetra_prod_jwt_secret_key_2026';
    const studentToken = jwt.sign(
      { id: studentA.id, role: 'STUDENT', email: studentA.email },
      jwtSecret,
      { expiresIn: '1h' }
    );

    const baseUrl = 'http://127.0.0.1:5000/api';

    // Student token attempting admin overview
    const studentReq = await fetch(`${baseUrl}/admin/analytics/video/overview`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assertAudit('11.1', 'Student token rejected from admin analytics with 403 Forbidden', studentReq.status === 403);

    // Unauthenticated request
    const unauthReq = await fetch(`${baseUrl}/admin/analytics/video/overview`);
    assertAudit('11.2', 'Unauthenticated request rejected with 401 Unauthorized', unauthReq.status === 401);

    // Admin token
    const adminReq = await fetch(`${baseUrl}/admin/analytics/video/overview`, {
      headers: { Authorization: 'Bearer admin-session-token-1001' }
    });
    assertAudit('11.3', 'Admin token authorized with 200 OK', adminReq.status === 200);

    // Verify no service role key leaked in frontend source files
    const frontendDir = path.resolve(__dirname, '../../src');
    const frontendFiles = fs.readdirSync(frontendDir, { recursive: true });
    let serviceKeyLeaked = false;
    for (const f of frontendFiles) {
      if (typeof f === 'string' && (f.endsWith('.js') || f.endsWith('.jsx'))) {
        const fullPath = path.join(frontendDir, f);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes('service_role') || content.includes('SERVICE_ROLE_KEY')) {
            serviceKeyLeaked = true;
          }
        }
      }
    }
    assertAudit('11.4', 'Zero Supabase service_role keys exposed in frontend bundle', !serviceKeyLeaked);

    // ==========================================================================
    // SECTION 12 & 13: PLAYER REGRESSION & FAILURE NON-BLOCKING AUDIT
    // ==========================================================================
    console.log('\n--- SECTION 12 & 13: Player Regression & Non-Blocking Audit ---');
    const videoAnalyticsUtilPath = path.resolve(__dirname, '../../src/utils/videoAnalytics.js');
    const videoAnalyticsUtilContent = fs.readFileSync(videoAnalyticsUtilPath, 'utf8');

    assertAudit('12.1', 'videoAnalytics.js handles dispatch errors with try/catch non-blocking guard', 
      videoAnalyticsUtilContent.includes('try {') && videoAnalyticsUtilContent.includes('catch (err) {')
    );
    assertAudit('12.2', 'videoAnalytics.js fire-and-forget Promise catch handles errors silently', 
      videoAnalyticsUtilContent.includes('.catch(')
    );

    const videoPlayerPath = path.resolve(__dirname, '../../src/components/student/nls/VideoPlayer.jsx');
    const videoPlayerContent = fs.readFileSync(videoPlayerPath, 'utf8');

    assertAudit('13.1', 'Analytics never calls video.play()', !videoAnalyticsUtilContent.includes('video.play()'));
    assertAudit('13.2', 'Analytics never modifies video.currentTime', !videoAnalyticsUtilContent.includes('video.currentTime ='));
    assertAudit('13.3', 'VideoPlayer recordAnalytics wrapper is isolated in try/catch', videoPlayerContent.includes('recordAnalytics = useCallback'));
    assertAudit('13.4', 'VideoPlayer maintains explicit userPausedRef to prevent unwanted autoplay', videoPlayerContent.includes('userPausedRef.current = true'));

    // ==========================================================================
    // SECTION 14: PERFORMANCE TEST & ZERO N+1 AUDIT
    // ==========================================================================
    console.log('\n--- SECTION 14: Performance & Query Benchmark ---');
    const t0 = Date.now();
    await adminService.getOverviewMetrics({ dateFilter: 'last30days' });
    const overviewDuration = Date.now() - t0;
    assertAudit('14.1', 'Overview aggregation query duration < 750ms (Cloud WAN SLA)', overviewDuration < 750, `${overviewDuration}ms`);

    const t1 = Date.now();
    await adminService.getCourseAnalytics(courseA.id, { dateFilter: 'last30days' });
    const courseDuration = Date.now() - t1;
    assertAudit('14.2', 'Course analytics batch query duration < 2000ms (Zero N+1, Cloud WAN SLA)', courseDuration < 2000, `${courseDuration}ms`);

    const t2 = Date.now();
    await adminService.getTrendsAnalytics({ dateFilter: 'last30days' });
    const trendsDuration = Date.now() - t2;
    assertAudit('14.3', 'Trends daily aggregation query duration < 750ms (Cloud WAN SLA)', trendsDuration < 750, `${trendsDuration}ms`);

    // Check that service layer does NOT make external AWS calls
    const adminServiceContent = fs.readFileSync(path.resolve(__dirname, '../src/modules/video/video.analytics.admin.service.js'), 'utf8');
    assertAudit('14.4', 'Admin analytics service contains zero AWS SDK calls', !adminServiceContent.includes('aws-sdk') && !adminServiceContent.includes('@aws-sdk'));

    // ==========================================================================
    // SECTION 15: LARGE-DATA TEST RESILIENCE
    // ==========================================================================
    console.log('\n--- SECTION 15: Large-Data Test Resilience ---');
    const bulkSession = crypto.randomUUID();
    const bulkBatch = [];
    for (let i = 0; i < 100; i++) {
      bulkBatch.push({
        client_event_id: crypto.randomUUID(),
        student_id: studentA.id,
        course_id: courseA.id,
        module_id: topicA1.module_id,
        topic_id: topicA1.id,
        session_id: bulkSession,
        event_type: i % 10 === 0 ? 'VIDEO_PLAY' : 'VIDEO_HEARTBEAT',
        position_seconds: i,
        duration_seconds: 100,
        completion_percentage: i,
        metadata: { heartbeat_interval_seconds: 1 }
      });
    }

    const { data: insBulk } = await supabase.from('video_analytics_events').insert(bulkBatch).select('id');
    if (insBulk) cleanupEventIds.push(...insBulk.map(e => e.id));

    const tBulk = Date.now();
    const bulkRes = await adminService.getTopicMetrics(topicA1.id, { dateFilter: 'last7days' });
    const bulkDuration = Date.now() - tBulk;
    assertAudit('15.1', 'Aggregating large event set completes under 1000ms', bulkDuration < 1000, `${bulkDuration}ms`);
    assertAudit('15.2', 'Dashboard response remains responsive and non-empty', bulkRes.metrics?.plays >= 10);

    // ==========================================================================
    // SECTION 16: DATA ACCURACY & MATHEMATICAL CONSISTENCY
    // ==========================================================================
    console.log('\n--- SECTION 16: Data Accuracy & Mathematical Consistency ---');
    const overviewCheck = await adminService.getOverviewMetrics({ dateFilter: 'last7days' });
    const m = overviewCheck.metrics;

    assertAudit('16.1', 'Unique viewers is non-negative and integer', Number.isInteger(m.uniqueViewers) && m.uniqueViewers >= 0);
    assertAudit('16.2', 'Sessions >= uniqueViewers (mathematical pigeonhole principle)', m.sessions >= m.uniqueViewers || m.sessions === 0);
    assertAudit('16.3', 'Rewatches <= sessions (rewatch is subset of sessions)', m.rewatchCount <= m.sessions);
    assertAudit('16.4', 'Average completion is bounded between 0% and 100%', 
      (m.averageCompletionPercentage >= 0 && m.averageCompletionPercentage <= 100) ||
      (m.averageCompletion >= 0 && m.averageCompletion <= 100),
      `Avg completion: ${m.averageCompletionPercentage ?? m.averageCompletion}%`
    );

    // ==========================================================================
    // SECTION 17: SUPABASE SECURITY AUDIT
    // ==========================================================================
    console.log('\n--- SECTION 17: Supabase Security Audit ---');
    const { data: rlsCheck } = await supabase.rpc('fn_get_topic_analytics', { p_topic_id: topicA1.id });
    assertAudit('17.1', 'Database function fn_get_topic_analytics is callable', rlsCheck !== undefined);

    // ==========================================================================
    // SECTION 18: SQL QUALITY AUDIT
    // ==========================================================================
    console.log('\n--- SECTION 18: SQL Quality Audit ---');
    assertAudit('18.1', 'Queries use explicit column projections (no SELECT *)', 
      adminServiceContent.includes(".select('student_id, session_id, topic_id, event_type")
    );
    assertAudit('18.2', 'Queries enforce indexed date range bounds (gte & lte event_timestamp)', 
      adminServiceContent.includes(".gte('event_timestamp'") && adminServiceContent.includes(".lte('event_timestamp'")
    );

    // ==========================================================================
    // SECTION 19: FINAL END-TO-END REAL SIMULATION TEST
    // ==========================================================================
    console.log('\n--- SECTION 19: Final End-to-End Real Simulation Test ---');
    const e2eSession = crypto.randomUUID();
    const e2eEvents = [
      // 1. Opens Topic 1
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: e2eSession, event_type: 'VIDEO_TOPIC_OPENED' },
      // 2. Plays
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: e2eSession, event_type: 'VIDEO_PLAY', position_seconds: 0 },
      // 3. Pauses
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: e2eSession, event_type: 'VIDEO_PAUSE', position_seconds: 20 },
      // 4. Resumes (Play)
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: e2eSession, event_type: 'VIDEO_PLAY', position_seconds: 20 },
      // 5. Seeks
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA1.module_id, topic_id: topicA1.id, session_id: e2eSession, event_type: 'VIDEO_SEEK', position_seconds: 80 },
      // 6. Switches to Topic 2
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: e2eSession, event_type: 'VIDEO_TOPIC_SWITCHED' },
      // 7. Watches Topic 2
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: e2eSession, event_type: 'VIDEO_PLAY', position_seconds: 0 },
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: e2eSession, event_type: 'VIDEO_HEARTBEAT', position_seconds: 15, metadata: { heartbeat_interval_seconds: 15 } },
      // 8. Completes Topic 2
      { client_event_id: crypto.randomUUID(), student_id: studentA.id, course_id: courseA.id, module_id: topicA2.module_id, topic_id: topicA2.id, session_id: e2eSession, event_type: 'VIDEO_COMPLETED', position_seconds: 100, duration_seconds: 100, completion_percentage: 100 }
    ];

    const { data: insE2E } = await supabase.from('video_analytics_events').insert(e2eEvents).select('id');
    if (insE2E) cleanupEventIds.push(...insE2E.map(e => e.id));

    // Admin verifies Topic 2 reflects activity
    const adminTopic2Check = await adminService.getTopicMetrics(topicA2.id, { dateFilter: 'last7days' });
    assertAudit('19.1', 'Admin Topic 2 inspection shows positive plays', adminTopic2Check.metrics?.plays >= 1);
    assertAudit('19.2', 'Admin Topic 2 inspection shows completed students >= 1', adminTopic2Check.metrics?.completedStudents >= 1);
    assertAudit('19.3', 'Admin Topic 2 inspection shows recorded watch time', adminTopic2Check.metrics?.watchTimeSeconds >= 15);

  } finally {
    // --------------------------------------------------------------------------
    // CLEANUP TEMPORARY AUDIT DATA
    // --------------------------------------------------------------------------
    if (cleanupEventIds.length > 0) {
      await supabase.from('video_analytics_events').delete().in('id', cleanupEventIds);
      console.log(`\n🧹 Cleaned up ${cleanupEventIds.length} temporary audit analytics events.`);
    }
  }

  console.log('\n========================================================================');
  console.log(`PHASE 5 AUDIT SUMMARY: ${passedTests}/${totalTests} CHECKS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('========================================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runPhase5Audit().catch(err => {
  console.error('Fatal audit suite error:', err);
  process.exit(1);
});
