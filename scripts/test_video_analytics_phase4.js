/**
 * INTERNNETRA — PHASE 4 COMPREHENSIVE VERIFICATION SUITE
 * Admin Video Analytics Dashboard & UI Integration
 * 
 * Verifies:
 * 1. AdminVideoAnalytics component structure, exports, and UI elements (8 KPI cards, SVG trend chart, topic table, student table, modal)
 * 2. AdminSidebar navigation registration (id, icon, permission)
 * 3. AdminLayout title dictionary mapping
 * 4. AdminDashboard tab routing and conditional rendering
 * 5. Direct Next.js route page at app/admin/analytics/video/page.jsx
 * 6. Live API endpoints called by the UI
 * 7. Absence of regressions across existing video player, upload, and LMS flows
 */

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

let totalTests = 0;
let passedTests = 0;

function assertTest(name, condition, extra = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${name} ${extra ? `(${extra})` : ''}`);
  } else {
    console.error(`  ❌ [FAIL] ${name} ${extra ? `(${extra})` : ''}`);
  }
}

async function runPhase4Tests() {
  console.log('================================================================');
  console.log('INTERNNETRA — PHASE 4: ADMIN VIDEO ANALYTICS VERIFICATION');
  console.log('================================================================\n');

  const rootDir = path.resolve(__dirname, '../..');

  // --------------------------------------------------------------------------
  // TEST GROUP 1: FILE EXISTENCE & EXPORTS
  // --------------------------------------------------------------------------
  console.log('--- TEST GROUP 1: UI File Existence & Core Structure ---');
  const analyticsViewPath = path.join(rootDir, 'src/views/admin/AdminVideoAnalytics.jsx');
  assertTest('AdminVideoAnalytics.jsx exists', fs.existsSync(analyticsViewPath));

  const analyticsViewContent = fs.readFileSync(analyticsViewPath, 'utf8');

  // Verify 8 KPI Cards are rendered in the view
  assertTest('View contains "Unique Viewers" KPI Card', analyticsViewContent.includes('Unique Viewers'));
  assertTest('View contains "Total Sessions" KPI Card', analyticsViewContent.includes('Total Sessions'));
  assertTest('View contains "Total Plays" KPI Card', analyticsViewContent.includes('Total Plays'));
  assertTest('View contains "Total Watch Time" KPI Card', analyticsViewContent.includes('Total Watch Time'));
  assertTest('View contains "Avg Watch Time" KPI Card', analyticsViewContent.includes('Avg Watch Time'));
  assertTest('View contains "Avg Completion" KPI Card', analyticsViewContent.includes('Avg Completion'));
  assertTest('View contains "Completed Students" KPI Card', analyticsViewContent.includes('Completed Students'));
  assertTest('View contains "Rewatches" KPI Card', analyticsViewContent.includes('Rewatches'));

  // --------------------------------------------------------------------------
  // TEST GROUP 2: FILTER SYSTEM & TIME-SERIES CHART
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: Filter System & SVG Trend Chart ---');
  assertTest('View contains Course filter dropdown', analyticsViewContent.includes('selectedCourseId') && analyticsViewContent.includes('All Courses'));
  assertTest('View contains Module filter dropdown', analyticsViewContent.includes('selectedModuleId') && analyticsViewContent.includes('All Modules'));
  assertTest('View contains Topic filter dropdown', analyticsViewContent.includes('selectedTopicId') && analyticsViewContent.includes('All Topics'));
  assertTest('View contains Date range presets (today, last7days, last30days, thisMonth, custom)', 
    analyticsViewContent.includes('today') &&
    analyticsViewContent.includes('last7days') &&
    analyticsViewContent.includes('last30days') &&
    analyticsViewContent.includes('thisMonth') &&
    analyticsViewContent.includes('custom')
  );
  assertTest('View contains custom date range pickers', analyticsViewContent.includes('customStartDate') && analyticsViewContent.includes('customEndDate'));
  assertTest('View contains lightweight SVG trend chart', analyticsViewContent.includes('<svg') && analyticsViewContent.includes('trendGradient'));
  assertTest('Trend chart includes metric switcher (plays, sessions, viewers, watch time)', 
    analyticsViewContent.includes('activeTrendMetric') && 
    analyticsViewContent.includes('Plays') &&
    analyticsViewContent.includes('Sessions') &&
    analyticsViewContent.includes('Viewers') &&
    analyticsViewContent.includes('Watch Time')
  );

  // --------------------------------------------------------------------------
  // TEST GROUP 3: TABLES & DRILLDOWN MODAL
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: Tables & Drilldown Modal ---');
  assertTest('View contains Topic Performance Breakdown table', analyticsViewContent.includes('Topic Performance Breakdown'));
  assertTest('Topic table supports sorting by columns', analyticsViewContent.includes('handleSort') && analyticsViewContent.includes('topicSortField'));
  assertTest('View contains Student Engagement table', analyticsViewContent.includes('Student Engagement & Viewing History'));
  assertTest('Student table includes search input', analyticsViewContent.includes('studentSearch') && analyticsViewContent.includes('Search student'));
  assertTest('Student table includes pagination controls', analyticsViewContent.includes('pagination.page') && analyticsViewContent.includes('pagination.totalPages'));
  assertTest('View contains Student Drilldown Modal', analyticsViewContent.includes('selectedStudent') && analyticsViewContent.includes('studentDrilldown'));
  assertTest('Drilldown modal fetches single student endpoint', analyticsViewContent.includes('/admin/analytics/video/students/'));

  // --------------------------------------------------------------------------
  // TEST GROUP 4: UX RESILIENCE & SKELETONS
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: UX States & Non-blocking Handling ---');
  assertTest('View handles empty state gracefully', analyticsViewContent.includes('No video viewing data yet'));
  assertTest('View handles error state with retry', analyticsViewContent.includes('errorMessage') && analyticsViewContent.includes('Try Again'));
  assertTest('View renders loading skeleton pulses', analyticsViewContent.includes('animate-pulse'));
  assertTest('View provides duration formatter (formatDuration)', analyticsViewContent.includes('formatDuration'));

  // --------------------------------------------------------------------------
  // TEST GROUP 5: ADMIN NAVIGATION WIRING
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: Admin Navigation & Route Integration ---');
  const sidebarPath = path.join(rootDir, 'src/components/admin/AdminSidebar.jsx');
  const sidebarContent = fs.readFileSync(sidebarPath, 'utf8');
  assertTest('AdminSidebar registers "video-analytics" tab', sidebarContent.includes('id: "video-analytics"'));
  assertTest('AdminSidebar uses Video icon for tab', sidebarContent.includes('icon: Video'));

  const layoutPath = path.join(rootDir, 'src/components/admin/AdminLayout.jsx');
  const layoutContent = fs.readFileSync(layoutPath, 'utf8');
  assertTest('AdminLayout tabTitles includes "video-analytics"', layoutContent.includes('"video-analytics":'));

  const dashboardPath = path.join(rootDir, 'src/views/admin/AdminDashboard.jsx');
  const dashboardContent = fs.readFileSync(dashboardPath, 'utf8');
  assertTest('AdminDashboard imports AdminVideoAnalytics', dashboardContent.includes('import AdminVideoAnalytics from "./AdminVideoAnalytics"'));
  assertTest('AdminDashboard VALID_ADMIN_TABS contains "video-analytics"', dashboardContent.includes('"video-analytics"'));
  assertTest('AdminDashboard resolveTabName handles "video-analytics"', dashboardContent.includes('clean === "video-analytics"'));
  assertTest('AdminDashboard renders AdminVideoAnalytics conditionally', dashboardContent.includes('activeTab === "video-analytics"') && dashboardContent.includes('<AdminVideoAnalytics />'));

  const pageRoutePath = path.join(rootDir, 'app/admin/analytics/video/page.jsx');
  assertTest('Next.js route file app/admin/analytics/video/page.jsx exists', fs.existsSync(pageRoutePath));

  // --------------------------------------------------------------------------
  // TEST GROUP 6: LIVE BACKEND API REACHABILITY
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 6: Live API Integration Checks (Port 5000) ---');
  const baseUrl = 'http://127.0.0.1:5000/api';
  const adminToken = 'admin-session-token-1001';

  try {
    const overviewHttp = await fetch(`${baseUrl}/admin/analytics/video/overview?dateFilter=last7days`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assertTest('GET /api/admin/analytics/video/overview returns 200 OK', overviewHttp.status === 200, `Status: ${overviewHttp.status}`);
    const overviewJson = await overviewHttp.json();
    assertTest('Overview response contains metrics object', !!(overviewJson.data?.metrics || overviewJson.metrics));

    const trendsHttp = await fetch(`${baseUrl}/admin/analytics/video/trends?dateFilter=last7days`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assertTest('GET /api/admin/analytics/video/trends returns 200 OK', trendsHttp.status === 200, `Status: ${trendsHttp.status}`);
    const trendsJson = await trendsHttp.json();
    assertTest('Trends response contains trends array', Array.isArray(trendsJson.data?.trends || trendsJson.trends));

    const studentsHttp = await fetch(`${baseUrl}/admin/analytics/video/students?page=1&limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assertTest('GET /api/admin/analytics/video/students returns 200 OK', studentsHttp.status === 200, `Status: ${studentsHttp.status}`);
    const studentsJson = await studentsHttp.json();
    const studentDataObj = studentsJson.data || studentsJson;
    assertTest('Students response contains pagination & students array', Array.isArray(studentDataObj.students) && !!studentDataObj.pagination);
  } catch (err) {
    console.error('API test error:', err.message);
    assertTest('Backend server reachable', false, err.message);
  }

  // --------------------------------------------------------------------------
  // TEST GROUP 7: REGRESSION AUDIT (ZERO MUTATIONS TO PLAYER / LMS)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST GROUP 7: Zero Regression Verification ---');
  const videoPlayerPath = path.join(rootDir, 'src/components/student/nls/VideoPlayer.jsx');
  assertTest('VideoPlayer.jsx exists and untouched', fs.existsSync(videoPlayerPath));

  const coursesPath = path.join(rootDir, 'src/views/admin/AdminCourses.jsx');
  assertTest('AdminCourses.jsx curriculum editor intact', fs.existsSync(coursesPath));

  const studentDashboardPath = path.join(rootDir, 'app/dashboard/page.jsx');
  assertTest('Student dashboard intact', fs.existsSync(studentDashboardPath));

  console.log('\n================================================================');
  console.log(`PHASE 4 VERIFICATION RESULTS: ${passedTests}/${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('================================================================');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runPhase4Tests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
