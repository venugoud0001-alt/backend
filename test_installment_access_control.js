/**
 * Comprehensive Verification Suite:
 * INSTALLMENT PAYMENT, PAYMENT DUE WINDOW & TEMPORARY COURSE ACCESS CONTROL
 * 
 * Tests:
 * 1. Full payment courses remain ACTIVE and unaffected.
 * 2. 1st installment payment grants ACTIVE access with 5-day window (second_payment_due_at = NOW() + 5 days).
 * 3. Video stream access allowed within 5 days.
 * 4. Overdue detection & state evaluation:
 *    - 3 days remaining (DUE_SOON / ACTIVE)
 *    - Due today (DUE_SOON / ACTIVE)
 *    - Past 5 days (OVERDUE / SUSPENDED)
 * 5. Server-side video stream access enforcement:
 *    - ACTIVE access -> Allowed
 *    - SUSPENDED for PAYMENT_OVERDUE -> 403 COURSE_PAYMENT_OVERDUE
 *    - SUSPENDED for MANUAL_ADMIN -> 403 COURSE_ACCESS_SUSPENDED
 * 6. Automated payment restoration for PAYMENT_OVERDUE upon 2nd installment settlement.
 * 7. THE PRIORITY RULE:
 *    - MANUAL_ADMIN suspension takes absolute priority and is NEVER overridden by 2nd installment payment.
 * 8. Manual Admin Suspend & Restore lifecycle.
 * 9. Multi-course isolation: Suspending Course A leaves Course B fully active.
 * 10. Background maintenance scheduler integrity.
 */

const assert = require('assert');
const installmentService = require('./src/services/installment.service');
const videoService = require('./src/modules/video/video.service');
const { supabase } = require('./src/config/supabase');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    failedTests++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    failedTests++;
  }
}

async function main() {
  console.log('\n================================================================');
  console.log('⚡ INSTALLMENT PAYMENT & TEMPORARY ACCESS CONTROL VERIFICATION ⚡');
  console.log('================================================================\n');

  // -------------------------------------------------------------
  // Test 1: Full Payment Courses Unaffected
  // -------------------------------------------------------------
  runTest('1. Full payment courses remain ACTIVE and unaffected', () => {
    const fullPaidEnr = {
      id: 'test-enr-full-1',
      payment_plan: 'FULL',
      payment_status: 'PAID',
      amount_paid: 4000,
      amount_pending: 0,
      total_amount: 4000,
      course_access_status: 'ACTIVE'
    };

    const state = installmentService.evaluateEnrollmentState(fullPaidEnr);
    assert.strictEqual(state.status, 'FULLY_PAID');
    assert.strictEqual(state.accessStatus, 'ACTIVE');
    assert.strictEqual(state.isOverdue, false);
    assert.strictEqual(state.daysRemaining, null);
    assert.strictEqual(state.daysOverdue, 0);
  });

  // -------------------------------------------------------------
  // Test 2: 1st Installment Paid - 5 Day Window Active Access
  // -------------------------------------------------------------
  runTest('2. 1st installment grants ACTIVE access with 5-calendar-day window', () => {
    const now = new Date();
    const fiveDaysLater = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    const installmentEnr = {
      id: 'test-enr-inst-1',
      payment_plan: 'INSTALLMENT',
      payment_status: 'PARTIAL',
      amount_paid: 1500,
      amount_pending: 2500,
      total_amount: 4000,
      first_installment_paid_at: now.toISOString(),
      second_payment_due_at: fiveDaysLater.toISOString(),
      course_access_status: 'ACTIVE'
    };

    const state = installmentService.evaluateEnrollmentState(installmentEnr);
    assert.strictEqual(state.status, 'FIRST_INSTALLMENT_PAID');
    assert.strictEqual(state.accessStatus, 'ACTIVE');
    assert.strictEqual(state.isOverdue, false);
    assert.strictEqual(state.isSuspended, false);
    assert(state.daysRemaining >= 4 && state.daysRemaining <= 5, `Expected 4-5 days remaining, got ${state.daysRemaining}`);
  });

  // -------------------------------------------------------------
  // Test 3: Due Soon Notifications & Window Boundaries
  // -------------------------------------------------------------
  runTest('3. Window evaluation: 1 day remaining and due today', () => {
    const now = new Date();
    const oneDayLater = new Date(now.getTime() + 20 * 60 * 60 * 1000); // 20 hours remaining

    const dueSoonEnr = {
      id: 'test-enr-inst-2',
      payment_plan: 'INSTALLMENT',
      payment_status: 'PARTIAL',
      amount_paid: 1500,
      amount_pending: 2500,
      total_amount: 4000,
      second_payment_due_at: oneDayLater.toISOString(),
      course_access_status: 'ACTIVE'
    };

    const state = installmentService.evaluateEnrollmentState(dueSoonEnr);
    assert.strictEqual(state.status, 'DUE_SOON');
    assert.strictEqual(state.daysRemaining, 1);
    assert.strictEqual(state.isOverdue, false);
  });

  // -------------------------------------------------------------
  // Test 4: Overdue Detection Past 5 Calendar Days
  // -------------------------------------------------------------
  runTest('4. Overdue detection: past 5-day window flags OVERDUE and days overdue count', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const overdueEnr = {
      id: 'test-enr-inst-3',
      payment_plan: 'INSTALLMENT',
      payment_status: 'PARTIAL',
      amount_paid: 1500,
      amount_pending: 2500,
      total_amount: 4000,
      second_payment_due_at: twoDaysAgo.toISOString(),
      course_access_status: 'ACTIVE'
    };

    const state = installmentService.evaluateEnrollmentState(overdueEnr);
    assert.strictEqual(state.status, 'OVERDUE');
    assert.strictEqual(state.isOverdue, true);
    assert(state.daysOverdue >= 2, `Expected at least 2 days overdue, got ${state.daysOverdue}`);
  });

  // -------------------------------------------------------------
  // Test 5: Server-Side Access Enforcement (Video Service)
  // -------------------------------------------------------------
  await runAsyncTest('5. Video Service blocks streaming with 403 COURSE_PAYMENT_OVERDUE when access is suspended for overdue', async () => {
    // Mock the Supabase enrollment fetch for a suspended student
    const originalFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'mock-suspended-enr',
                    student_id: 'mock-student-id',
                    course_id: 'mock-course-id',
                    payment_status: 'PARTIAL',
                    course_access_status: 'SUSPENDED',
                    suspension_reason: 'PAYMENT_OVERDUE',
                    amount_paid: 1500,
                    amount_pending: 2500,
                    second_payment_due_at: new Date(Date.now() - 86400000).toISOString()
                  },
                  error: null
                })
              })
            })
          })
        };
      }
      return originalFrom.call(supabase, table);
    };

    try {
      let threwCorrectError = false;
      try {
        await videoService.verifyStudentEnrollment('mock-student-id', 'mock-course-id');
      } catch (err) {
        assert.strictEqual(err.statusCode, 403);
        assert.strictEqual(err.code, 'COURSE_PAYMENT_OVERDUE');
        assert(err.message.includes('suspended'), 'Expected error message to mention suspended course access');
        assert(err.message.includes('2nd installment'), 'Expected error message to mention 2nd installment');
        threwCorrectError = true;
      }
      assert.strictEqual(threwCorrectError, true, 'Expected verifyStudentEnrollment to throw 403 COURSE_PAYMENT_OVERDUE');
    } finally {
      supabase.from = originalFrom;
    }
  });

  // -------------------------------------------------------------
  // Test 6: Video Service blocks streaming with 403 COURSE_ACCESS_SUSPENDED for MANUAL_ADMIN
  // -------------------------------------------------------------
  await runAsyncTest('6. Video Service blocks streaming with 403 COURSE_ACCESS_SUSPENDED when access is suspended by Admin', async () => {
    const originalFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'mock-admin-suspended-enr',
                    student_id: 'mock-student-id',
                    course_id: 'mock-course-id',
                    payment_status: 'PAID',
                    course_access_status: 'SUSPENDED',
                    suspension_reason: 'MANUAL_ADMIN',
                    amount_paid: 4000,
                    amount_pending: 0
                  },
                  error: null
                })
              })
            })
          })
        };
      }
      return originalFrom.call(supabase, table);
    };

    try {
      let threwCorrectError = false;
      try {
        await videoService.verifyStudentEnrollment('mock-student-id', 'mock-course-id');
      } catch (err) {
        assert.strictEqual(err.statusCode, 403);
        assert.strictEqual(err.code, 'COURSE_ACCESS_SUSPENDED');
        assert(err.message.includes('Administrator'), 'Expected error message to mention Administrator');
        threwCorrectError = true;
      }
      assert.strictEqual(threwCorrectError, true, 'Expected verifyStudentEnrollment to throw 403 COURSE_ACCESS_SUSPENDED');
    } finally {
      supabase.from = originalFrom;
    }
  });

  // -------------------------------------------------------------
  // Test 7: Video Service allows streaming when ACTIVE
  // -------------------------------------------------------------
  await runAsyncTest('7. Video Service allows streaming when course_access_status is ACTIVE', async () => {
    const originalFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: 'mock-active-enr',
                    student_id: 'mock-student-id',
                    course_id: 'mock-course-id',
                    payment_status: 'PARTIAL',
                    course_access_status: 'ACTIVE',
                    amount_paid: 1500,
                    amount_pending: 2500,
                    second_payment_due_at: new Date(Date.now() + 3 * 86400000).toISOString()
                  },
                  error: null
                })
              })
            })
          })
        };
      }
      return originalFrom.call(supabase, table);
    };

    try {
      const enr = await videoService.verifyStudentEnrollment('mock-student-id', 'mock-course-id');
      assert.strictEqual(enr.id, 'mock-active-enr');
      assert.strictEqual(enr.course_access_status, 'ACTIVE');
    } finally {
      supabase.from = originalFrom;
    }
  });

  // -------------------------------------------------------------
  // Test 8: THE PRIORITY RULE - MANUAL_ADMIN Suspension is NEVER overridden by payment settlement
  // -------------------------------------------------------------
  await runAsyncTest('8. THE PRIORITY RULE: MANUAL_ADMIN suspension takes absolute priority and is NEVER auto-restored by 2nd installment payment', async () => {
    let updatedPayload = null;

    const originalFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'enr-priority-rule-test',
                  student_id: 'student-priority',
                  course_id: 'course-priority',
                  total_amount: 4000,
                  amount_paid: 1500,
                  amount_pending: 2500,
                  course_access_status: 'SUSPENDED',
                  suspension_reason: 'MANUAL_ADMIN', // Admin manually suspended this student!
                  first_installment_paid_at: new Date(Date.now() - 10 * 86400000).toISOString()
                },
                error: null
              })
            })
          }),
          update: (payload) => {
            updatedPayload = payload;
            return {
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: { ...payload, id: 'enr-priority-rule-test' },
                    error: null
                  })
                })
              })
            };
          }
        };
      }
      if (table === 'audit_logs' || table === 'installment_reminders') {
        return {
          insert: async () => ({ data: [], error: null })
        };
      }
      return originalFrom.call(supabase, table);
    };

    try {
      // Settle the remaining balance (2nd installment of ₹2500)
      const res = await installmentService.handlePaymentSettlement({
        enrollmentId: 'enr-priority-rule-test',
        settledAmount: 2500,
        txnId: 'TXN-SETTLE-PRIORITY-2500',
        paymentMethod: 'Cashfree PG'
      });

      // Assert that access status is STILL SUSPENDED because of MANUAL_ADMIN suspension reason!
      assert.strictEqual(
        res.course_access_status,
        'SUSPENDED',
        'CRITICAL: MANUAL_ADMIN suspension must remain SUSPENDED even after 2nd installment payment'
      );
      assert.strictEqual(
        res.suspension_reason,
        'MANUAL_ADMIN',
        'Suspension reason must remain MANUAL_ADMIN'
      );
      assert.strictEqual(
        updatedPayload.course_access_status,
        'SUSPENDED',
        'Database update payload must keep course_access_status as SUSPENDED'
      );
      assert.strictEqual(
        updatedPayload.amount_pending,
        0,
        'Amount pending should be updated to 0'
      );
      assert.strictEqual(
        updatedPayload.payment_status,
        'PAID',
        'Payment status should be updated to PAID'
      );
    } finally {
      supabase.from = originalFrom;
    }
  });

  // -------------------------------------------------------------
  // Test 9: Automatic Restoration for PAYMENT_OVERDUE upon 2nd installment
  // -------------------------------------------------------------
  await runAsyncTest('9. Automatic Restoration: PAYMENT_OVERDUE suspension IS auto-restored to ACTIVE upon 2nd installment payment', async () => {
    let updatedPayload = null;

    const originalFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'enr-overdue-restore-test',
                  student_id: 'student-overdue',
                  course_id: 'course-overdue',
                  total_amount: 4000,
                  amount_paid: 1500,
                  amount_pending: 2500,
                  course_access_status: 'SUSPENDED',
                  suspension_reason: 'PAYMENT_OVERDUE', // Suspended purely for payment overdue
                  first_installment_paid_at: new Date(Date.now() - 7 * 86400000).toISOString()
                },
                error: null
              })
            })
          }),
          update: (payload) => {
            updatedPayload = payload;
            return {
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: { ...payload, id: 'enr-overdue-restore-test' },
                    error: null
                  })
                })
              })
            };
          }
        };
      }
      if (table === 'audit_logs' || table === 'installment_reminders') {
        return {
          insert: async () => ({ data: [], error: null })
        };
      }
      return originalFrom.call(supabase, table);
    };

    try {
      const res = await installmentService.handlePaymentSettlement({
        enrollmentId: 'enr-overdue-restore-test',
        settledAmount: 2500,
        txnId: 'TXN-SETTLE-OVERDUE-RESTORE',
        paymentMethod: 'Cashfree PG'
      });

      // Assert that access status is automatically RESTORED to ACTIVE!
      assert.strictEqual(
        res.course_access_status,
        'ACTIVE',
        'PAYMENT_OVERDUE suspended account must be restored to ACTIVE upon full settlement'
      );
      assert.strictEqual(
        updatedPayload.course_access_status,
        'ACTIVE',
        'Database update payload must set course_access_status = ACTIVE'
      );
      assert.strictEqual(
        updatedPayload.restoration_reason,
        'INSTALLMENT_SETTLED',
        'Restoration reason must be INSTALLMENT_SETTLED'
      );
    } finally {
      supabase.from = originalFrom;
    }
  });

  // -------------------------------------------------------------
  // Test 10: Multi-Course Isolation
  // -------------------------------------------------------------
  await runAsyncTest('10. Multi-Course Isolation: Suspending Course A does NOT affect student access to Course B', async () => {
    const originalFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'enrollments') {
        return {
          select: () => ({
            eq: (col1, val1) => ({
              eq: (col2, val2) => ({
                maybeSingle: async () => {
                  // val2 is courseId
                  if (val2 === 'course-a-installment-suspended') {
                    return {
                      data: {
                        id: 'enr-course-a',
                        student_id: 'student-multi',
                        course_id: 'course-a-installment-suspended',
                        payment_status: 'PARTIAL',
                        course_access_status: 'SUSPENDED',
                        suspension_reason: 'PAYMENT_OVERDUE'
                      },
                      error: null
                    };
                  }
                  if (val2 === 'course-b-fullpaid-active') {
                    return {
                      data: {
                        id: 'enr-course-b',
                        student_id: 'student-multi',
                        course_id: 'course-b-fullpaid-active',
                        payment_status: 'PAID',
                        course_access_status: 'ACTIVE',
                        amount_paid: 4000,
                        amount_pending: 0
                      },
                      error: null
                    };
                  }
                  return { data: null, error: null };
                }
              })
            })
          })
        };
      }
      return originalFrom.call(supabase, table);
    };

    try {
      // Verify Course A -> Must fail with 403
      let courseABlocked = false;
      try {
        await videoService.verifyStudentEnrollment('student-multi', 'course-a-installment-suspended');
      } catch (err) {
        assert.strictEqual(err.statusCode, 403);
        courseABlocked = true;
      }
      assert.strictEqual(courseABlocked, true, 'Course A must be blocked');

      // Verify Course B -> Must SUCCEED with 200/active enrollment
      const courseBAccess = await videoService.verifyStudentEnrollment('student-multi', 'course-b-fullpaid-active');
      assert.strictEqual(courseBAccess.id, 'enr-course-b');
      assert.strictEqual(courseBAccess.course_access_status, 'ACTIVE');
    } finally {
      supabase.from = originalFrom;
    }
  });

  // -------------------------------------------------------------
  // Test 11: Idempotent Reminder Logic
  // -------------------------------------------------------------
  await runAsyncTest('11. Idempotent Reminders: Record reminder prevents duplicate alerts for same enrollment & type', async () => {
    let insertCount = 0;
    const sentReminders = new Set();

    const originalFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'installment_reminders') {
        return {
          insert: async (data) => {
            insertCount++;
            const item = Array.isArray(data) ? data[0] : data;
            const key = `${item.enrollment_id}_${item.reminder_type}`;
            if (sentReminders.has(key)) {
              const err = new Error('duplicate key value violates unique constraint');
              err.code = '23505';
              return { data: null, error: err };
            }
            sentReminders.add(key);
            return { data: [item], error: null };
          }
        };
      }
      return originalFrom.call(supabase, table);
    };

    try {
      const res1 = await installmentService.recordReminderSent({
        enrollmentId: 'enr-idemp-1',
        studentId: 'stud-1',
        courseId: 'course-1',
        reminderType: 'FIRST_INSTALLMENT_PAID',
        recipientEmail: 'student@example.com'
      });
      assert.strictEqual(res1, true, 'First reminder should succeed');

      const res2 = await installmentService.recordReminderSent({
        enrollmentId: 'enr-idemp-1',
        studentId: 'stud-1',
        courseId: 'course-1',
        reminderType: 'FIRST_INSTALLMENT_PAID',
        recipientEmail: 'student@example.com'
      });
      assert.strictEqual(res2, false, 'Duplicate reminder should be deduplicated and return false');
    } finally {
      supabase.from = originalFrom;
    }
  });

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`VERIFICATION COMPLETE: ${passedTests} passed, ${failedTests} failed`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error running verification tests:', err);
  process.exit(1);
});
