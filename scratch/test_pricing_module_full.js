const pricingService = require("../src/modules/pricing/pricing.service");
const { validatePricingPlanPayload } = require("../src/modules/pricing/pricing.validator");
const { PAYMENT_MODES, PLAN_STATUSES } = require("../src/modules/pricing/pricing.constants");

async function runTestSuite() {
  console.log("\n🧪 Running 18-Point Pricing & Flexible Installment Backend Integration Test Suite...\n");
  let passed = 0;
  let failed = 0;

  function assertTest(name, condition, details = "") {
    if (condition) {
      console.log(`  ✅ [PASS] ${name} ${details}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name} ${details}`);
      failed++;
    }
  }

  const sampleCourseId = "49e82791-fd1d-4a94-90ff-2732f9b2fcfd"; // Embedded Systems

  // TEST 1: Create FULL plan validation
  try {
    const validFull = validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Full Payment Track",
      payment_mode: "FULL",
      total_amount: 4000,
      currency: "INR"
    });
    assertTest("1. Create FULL plan validation", validFull.paymentMode === "FULL" && validFull.totalAmount === 4000);
  } catch (err) {
    assertTest("1. Create FULL plan validation", false, err.message);
  }

  // TEST 2: Create INSTALLMENT plan validation
  try {
    const validInst = validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Installment Track",
      payment_mode: "INSTALLMENT",
      total_amount: 4000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "Phase 1", amount: 1500 },
        { phase_number: 2, name: "Phase 2", amount: 2500 }
      ]
    });
    assertTest("2. Create INSTALLMENT plan validation", validInst.paymentMode === "INSTALLMENT" && validInst.phases.length === 2);
  } catch (err) {
    assertTest("2. Create INSTALLMENT plan validation", false, err.message);
  }

  // TEST 3: Installment phases sum correctly
  try {
    const validSum = validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Sum Check",
      payment_mode: "INSTALLMENT",
      total_amount: 5000,
      currency: "INR",
      phases: [
        { phase_number: 1, amount: 2000 },
        { phase_number: 2, amount: 3000 }
      ]
    });
    assertTest("3. Installment phases sum correctly (2000 + 3000 = 5000)", validSum.totalAmount === 5000);
  } catch (err) {
    assertTest("3. Installment phases sum correctly", false, err.message);
  }

  // TEST 4: Reject incorrect phase total (sum != total_amount)
  try {
    validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Bad Sum",
      payment_mode: "INSTALLMENT",
      total_amount: 4000,
      currency: "INR",
      phases: [
        { phase_number: 1, amount: 1500 },
        { phase_number: 2, amount: 2000 } // Sum = 3500 != 4000
      ]
    });
    assertTest("4. Reject incorrect phase total", false, "Should have thrown 422 error for mismatched sum");
  } catch (err) {
    assertTest("4. Reject incorrect phase total", err.statusCode === 422 && err.message.includes("Sum of installment phases"));
  }

  // TEST 5: Reject zero phase amount
  try {
    validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Zero Phase",
      payment_mode: "INSTALLMENT",
      total_amount: 4000,
      currency: "INR",
      phases: [
        { phase_number: 1, amount: 0 },
        { phase_number: 2, amount: 4000 }
      ]
    });
    assertTest("5. Reject zero phase amount", false, "Should have rejected phase amount = 0");
  } catch (err) {
    assertTest("5. Reject zero phase amount", err.statusCode === 422 && err.message.includes("greater than zero"));
  }

  // TEST 6: Reject negative phase amount
  try {
    validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Negative Phase",
      payment_mode: "INSTALLMENT",
      total_amount: 4000,
      currency: "INR",
      phases: [
        { phase_number: 1, amount: -500 },
        { phase_number: 2, amount: 4500 }
      ]
    });
    assertTest("6. Reject negative phase amount", false, "Should have rejected negative phase amount");
  } catch (err) {
    assertTest("6. Reject negative phase amount", err.statusCode === 422);
  }

  // TEST 7: Reject duplicate phase numbers
  try {
    validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Duplicate Phase Num",
      payment_mode: "INSTALLMENT",
      total_amount: 4000,
      currency: "INR",
      phases: [
        { phase_number: 1, amount: 2000 },
        { phase_number: 1, amount: 2000 }
      ]
    });
    assertTest("7. Reject duplicate phase numbers", false, "Should have rejected duplicate phase numbers");
  } catch (err) {
    assertTest("7. Reject duplicate phase numbers", err.statusCode === 422 && err.message.includes("Duplicate phase_number"));
  }

  // TEST 8: Reject FULL plan containing phases
  try {
    validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "Full With Phases",
      payment_mode: "FULL",
      total_amount: 4000,
      currency: "INR",
      phases: [{ phase_number: 1, amount: 4000 }]
    });
    assertTest("8. Reject FULL plan containing phases", false, "Should have rejected phases in FULL plan");
  } catch (err) {
    assertTest("8. Reject FULL plan containing phases", err.statusCode === 400 && err.message.includes("cannot contain installment phases"));
  }

  // TEST 9: Reject INSTALLMENT plan with no phases
  try {
    validatePricingPlanPayload({
      course_id: sampleCourseId,
      name: "No Phases Inst",
      payment_mode: "INSTALLMENT",
      total_amount: 4000,
      currency: "INR",
      phases: []
    });
    assertTest("9. Reject INSTALLMENT plan with no phases", false, "Should have rejected empty phases array");
  } catch (err) {
    assertTest("9. Reject INSTALLMENT plan with no phases", err.statusCode === 422);
  }

  // TEST 10: Retrieve active pricing for course
  try {
    const res = await pricingService.getPricingForCourse("embedded-systems", true);
    assertTest("10. Retrieve active pricing for course", res.pricingPlans && res.pricingPlans.length >= 2, `(Found ${res.pricingPlans?.length} plans)`);
  } catch (err) {
    assertTest("10. Retrieve active pricing for course", false, err.message);
  }

  // TEST 11: Inactive pricing does not appear publicly
  try {
    const res = await pricingService.getPricingForCourse("embedded-systems", true);
    const hasInactive = res.pricingPlans.some(p => p.status !== "ACTIVE");
    assertTest("11. Inactive pricing hidden from public API", !hasInactive);
  } catch (err) {
    assertTest("11. Inactive pricing hidden from public API", false, err.message);
  }

  // TEST 12: Invalid course ID rejected
  try {
    await pricingService.getPricingForCourse("non-existent-course-slug-9999", true);
    assertTest("12. Invalid course ID rejected", false, "Should have thrown 404 for invalid course");
  } catch (err) {
    assertTest("12. Invalid course ID rejected", err.statusCode === 404);
  }

  // TEST 13: calculatePayableAmount() returns exact FULL price
  try {
    const calcFull = await pricingService.calculatePayableAmount({
      courseId: "embedded-systems",
      paymentMode: "FULL",
      amount: 1 // Attempting frontend price injection
    });
    assertTest("13. calculatePayableAmount() returns exact FULL price (4000)", calcFull.payableAmount === 4000);
  } catch (err) {
    assertTest("13. calculatePayableAmount() returns exact FULL price", false, err.message);
  }

  // TEST 14: calculatePayableAmount() returns selected installment amount
  try {
    const calcInst1 = await pricingService.calculatePayableAmount({
      courseId: "embedded-systems",
      paymentMode: "INSTALLMENT",
      phaseId: 1
    });
    assertTest("14. calculatePayableAmount() returns 1st installment amount (1500)", calcInst1.payableAmount === 1500);
  } catch (err) {
    assertTest("14. calculatePayableAmount() returns 1st installment amount", false, err.message);
  }

  // TEST 15: FINANCIAL INTEGRITY TEST — Frontend-provided amount is ignored
  try {
    const calcHack = await pricingService.calculatePayableAmount({
      courseId: "embedded-systems",
      paymentMode: "INSTALLMENT",
      phaseId: 2,
      amount: 1, // Malicious frontend payload trying to pay ₹1 instead of ₹2500
      totalAmount: 1
    });
    assertTest("15. FINANCIAL INTEGRITY: Frontend amount=1 is ignored and server calculates ₹2500", calcHack.payableAmount === 2500);
  } catch (err) {
    assertTest("15. FINANCIAL INTEGRITY TEST", false, err.message);
  }

  // TEST 16: Non-existent pricing plan rejected
  try {
    await pricingService.calculatePayableAmount({
      courseId: "embedded-systems",
      planId: "non-existent-plan-id-9999"
    });
    assertTest("16. Non-existent pricing plan rejected", false, "Should have thrown 404 for invalid planId");
  } catch (err) {
    assertTest("16. Non-existent pricing plan rejected", err.statusCode === 404);
  }

  // TEST 17: Non-existent phase rejected
  try {
    await pricingService.calculatePayableAmount({
      courseId: "embedded-systems",
      paymentMode: "INSTALLMENT",
      phaseId: "phase_99_invalid"
    });
    assertTest("17. Non-existent phase rejected", false, "Should have thrown 404 for invalid phaseId");
  } catch (err) {
    assertTest("17. Non-existent phase rejected", err.statusCode === 404);
  }

  // TEST 18: Phase belonging to another pricing plan rejected
  try {
    await pricingService.calculatePayableAmount({
      courseId: "embedded-systems",
      paymentMode: "FULL",
      phaseId: "phase_2_other"
    });
    assertTest("18. Phase on FULL plan rejected", false, "Should have rejected phase selection on FULL plan");
  } catch (err) {
    assertTest("18. Phase on FULL plan rejected", err.statusCode === 422);
  }

  console.log(`\n===========================================`);
  console.log(`📊 FINAL PRICING MODULE TEST RUN RESULTS:`);
  console.log(`Passed: ${passed} / ${passed + failed}`);
  console.log(`Failed: ${failed} / ${passed + failed}`);
  console.log(`===========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
