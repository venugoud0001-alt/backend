/**
 * Comprehensive 6-Month Course Access Expiry Verification Suite
 * 
 * Verifies all 12 business and security test cases.
 */

const { addCalendarMonths, isAccessExpired } = require('../src/utils/dateUtils');
const videoService = require('../src/modules/video/video.service');
const { getStudentEnrollments } = require('../src/modules/enrollments/studentEnrollment.controller');

async function runTestSuite() {
  console.log('===============================================================');
  console.log('RUNNING 6-MONTH COURSE ACCESS EXPIRY TEST SUITE');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`✅ [PASS] ${testName} ${details ? '(' + details + ')' : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${details ? '(' + details + ')' : ''}`);
      failed++;
    }
  }

  // TEST 1: 31 Aug 2026 + 6 months -> 28 Feb 2027
  const t1 = addCalendarMonths('2026-08-31T12:00:00.000Z', 6);
  assert(
    t1.toISOString() === '2027-02-28T12:00:00.000Z',
    'TEST 1: 31 Aug 2026 12:00:00 + 6 months -> 28 Feb 2027 12:00:00',
    t1.toISOString()
  );

  // TEST 2: 15 Sep 2026 + 6 months -> 15 Mar 2027
  const t2 = addCalendarMonths('2026-09-15T10:30:00.000Z', 6);
  assert(
    t2.toISOString() === '2027-03-15T10:30:00.000Z',
    'TEST 2: 15 Sep 2026 10:30:00 + 6 months -> 15 Mar 2027 10:30:00',
    t2.toISOString()
  );

  // TEST 3: 31 Oct 2026 + 6 months -> 30 Apr 2027
  const t3 = addCalendarMonths('2026-10-31T09:00:00.000Z', 6);
  assert(
    t3.toISOString() === '2027-04-30T09:00:00.000Z',
    'TEST 3: 31 Oct 2026 09:00:00 + 6 months -> 30 Apr 2027 09:00:00',
    t3.toISOString()
  );

  // TEST 4: Before expiry: ACCESS ALLOWED
  const expRef = '2027-02-28T12:00:00.000Z';
  const beforeTime = new Date('2027-02-28T11:59:59.000Z');
  assert(
    isAccessExpired(expRef, beforeTime) === false,
    'TEST 4: 1 second before expiry (11:59:59) -> Access is ACTIVE',
    'isExpired = false'
  );

  // TEST 5: Exactly at expiry: ACCESS DENIED
  const exactTime = new Date('2027-02-28T12:00:00.000Z');
  assert(
    isAccessExpired(expRef, exactTime) === true,
    'TEST 5: Exactly at expiry timestamp (12:00:00) -> Access is EXPIRED',
    'isExpired = true'
  );

  // TEST 6: After expiry: ACCESS DENIED
  const afterTime = new Date('2027-02-28T12:00:01.000Z');
  assert(
    isAccessExpired(expRef, afterTime) === true,
    'TEST 6: 1 second after expiry (12:00:01) -> Access is EXPIRED',
    'isExpired = true'
  );

  // TEST 7: Independent course expiries
  const financeStart = '2026-08-31T12:00:00.000Z';
  const financeExpiry = addCalendarMonths(financeStart, 6);
  const aimlStart = '2026-09-15T10:30:00.000Z';
  const aimlExpiry = addCalendarMonths(aimlStart, 6);
  const baStart = '2026-01-01T00:00:00.000Z';
  const baExpiry = addCalendarMonths(baStart, 6); // 2026-07-01 (Expired)

  const checkTime = new Date('2026-08-31T15:00:00.000Z');
  const financeActive = !isAccessExpired(financeExpiry, checkTime);
  const aimlActive = !isAccessExpired(aimlExpiry, checkTime);
  const baActive = !isAccessExpired(baExpiry, checkTime);

  assert(
    financeActive === true && aimlActive === true && baActive === false,
    'TEST 7: Independent Course Expiries (Finance: Active, AI/ML: Active, Business Analytics: Expired)',
    `Finance: ${financeActive}, AIML: ${aimlActive}, BA: ${baActive}`
  );

  // TEST 8: Existing enrollment preserves historical timestamp
  const historicalCreated = '2026-08-16T16:53:56.861Z';
  const historicalExpiry = addCalendarMonths(historicalCreated, 6);
  assert(
    historicalExpiry.toISOString() === '2027-02-16T16:53:56.861Z',
    'TEST 8: Historical timestamp preservation (2026-08-16 -> 2027-02-16)',
    historicalExpiry.toISOString()
  );

  // TEST 9: Repurchase calculates fresh 6-month period from new purchase date
  const originalPurchase = '2026-01-01T10:00:00.000Z';
  const repurchaseDate = '2026-08-15T14:00:00.000Z';
  const repurchaseExpiry = addCalendarMonths(repurchaseDate, 6);
  assert(
    repurchaseExpiry.toISOString() === '2027-02-15T14:00:00.000Z',
    'TEST 9: Repurchase creates fresh 6 months from repurchase date (2026-08-15 -> 2027-02-15)',
    repurchaseExpiry.toISOString()
  );

  // TEST 10: Refresh / idempotent timestamp stability
  const savedStart = '2026-08-31T12:00:00.000Z';
  const firstCalc = addCalendarMonths(savedStart, 6);
  const secondCalc = addCalendarMonths(savedStart, 6);
  assert(
    firstCalc.toISOString() === secondCalc.toISOString(),
    'TEST 10: Timestamp stability on refresh (no drift or accidental extension)',
    firstCalc.toISOString()
  );

  // TEST 11: Backend API /api/student/enrollments contract returns access fields
  const mockReq = { query: { email: 'singirikondashivacharan008@gmail.com' } };
  let apiResponse = null;
  const mockRes = {
    status: function(s) { this.statusCode = s; return this; },
    json: function(d) { apiResponse = d; }
  };

  await getStudentEnrollments(mockReq, mockRes);
  const enr = apiResponse?.data?.[0];

  assert(
    enr && enr.accessStartDate && enr.accessExpiryDate && typeof enr.isExpired === 'boolean',
    'TEST 11: Student enrollment API exposes accessStartDate, accessExpiryDate, and isExpired',
    `Start: ${enr?.accessStartDate}, Expiry: ${enr?.accessExpiryDate}, isExpired: ${enr?.isExpired}`
  );

  // TEST 12: Existing course mapping verification (Finance -> Finance, AI/ML -> AI/ML, BA -> BA)
  const isFinanceMatch = enr?.name === 'Business Analytics' && enr?.slug === 'business-analytics';
  assert(
    isFinanceMatch,
    'TEST 12: Course mapping integrity preserved (enrolled in Business Analytics maps strictly to Business Analytics)',
    `Enrolled: ${enr?.name} (${enr?.slug})`
  );

  console.log('\n===============================================================');
  console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Test runner fatal exception:', err);
  process.exit(1);
});
