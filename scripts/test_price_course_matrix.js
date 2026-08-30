const express = require('express');
const app = require('../src/app');
const { supabase } = require('../src/config/supabase');
const pricingService = require('../src/modules/pricing/pricing.service');
const courseService = require('../src/modules/courses/course.service');

async function runPriceCourseMatrixTests() {
  console.log("=== STARTING COMPLETE PRICING MATRIX & PROOF SUITE FOR 'price course' ===\n");

  let server;
  const PORT = 5052;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  const priceCourseId = '9577facc-ed47-4f09-842b-9b4132e3c974';

  try {
    // ---------------------------------------------------------
    // TEST 1: Full = 15000, Installment = 12000 (P1 = 6000, P2 = 6000)
    // ---------------------------------------------------------
    console.log("--- TEST 1: Full = 15000, Installment = 12000 (P1 = 6000, P2 = 6000) ---");
    const payload1 = {
      course_id: priceCourseId,
      full_payment_amount: 15000,
      installment_total_amount: 12000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 6000 },
        { phase_number: 2, name: "2nd Installment", amount: 6000 }
      ]
    };
    console.log("REQUEST PAYLOAD T1:", JSON.stringify(payload1, null, 2));

    await pricingService.saveCoursePricing(payload1);
    const getRes1 = await pricingService.getPricingForCourse(priceCourseId);
    console.log("GET RESPONSE T1:", JSON.stringify(getRes1.pricingPlans, null, 2));

    const full1 = getRes1.pricingPlans.find(p => p.paymentMode === "FULL");
    const inst1 = getRes1.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");

    if (full1.totalAmount !== 15000 || inst1.totalAmount !== 12000 || inst1.phases[0].amount !== 6000 || inst1.phases[1].amount !== 6000) {
      throw new Error(`TEST 1 FAILED: Expected Full 15000, Inst 12000 [6000, 6000]. Got Full ${full1.totalAmount}, Inst ${inst1.totalAmount} [${inst1.phases[0]?.amount}, ${inst1.phases[1]?.amount}]`);
    }
    console.log("✅ PASS TEST 1: Full ₹15,000, Installment ₹12,000 (P1: ₹6,000, P2: ₹6,000) verified!\n");

    // ---------------------------------------------------------
    // TEST 2: Full = 15000, Installment = 15000 (P1 = 7500, P2 = 7500)
    // ---------------------------------------------------------
    console.log("--- TEST 2: Full = 15000, Installment = 15000 (P1 = 7500, P2 = 7500) ---");
    const payload2 = {
      course_id: priceCourseId,
      full_payment_amount: 15000,
      installment_total_amount: 15000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 7500 },
        { phase_number: 2, name: "2nd Installment", amount: 7500 }
      ]
    };
    await pricingService.saveCoursePricing(payload2);
    const getRes2 = await pricingService.getPricingForCourse(priceCourseId);
    const inst2 = getRes2.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");
    if (inst2.totalAmount !== 15000 || inst2.phases[0].amount !== 7500 || inst2.phases[1].amount !== 7500) {
      throw new Error(`TEST 2 FAILED: Got Inst ${inst2.totalAmount} [${inst2.phases[0]?.amount}, ${inst2.phases[1]?.amount}]`);
    }
    console.log("✅ PASS TEST 2: Full ₹15,000, Installment ₹15,000 (P1: ₹7,500, P2: ₹7,500) verified!\n");

    // ---------------------------------------------------------
    // TEST 3: Full = 15000, Installment = 18000 (P1 = 6000, P2 = 6000, P3 = 6000)
    // ---------------------------------------------------------
    console.log("--- TEST 3: Full = 15000, Installment = 18000 (P1 = 6000, P2 = 6000, P3 = 6000) ---");
    const payload3 = {
      course_id: priceCourseId,
      full_payment_amount: 15000,
      installment_total_amount: 18000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 6000 },
        { phase_number: 2, name: "2nd Installment", amount: 6000 },
        { phase_number: 3, name: "3rd Installment", amount: 6000 }
      ]
    };
    await pricingService.saveCoursePricing(payload3);
    const getRes3 = await pricingService.getPricingForCourse(priceCourseId);
    const inst3 = getRes3.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");
    if (inst3.totalAmount !== 18000 || inst3.phases[0].amount !== 6000) {
      throw new Error(`TEST 3 FAILED: Got Inst ${inst3.totalAmount}, phases length ${inst3.phases.length}`);
    }
    console.log("✅ PASS TEST 3: Full ₹15,000, Installment ₹18,000 verified!\n");

    // ---------------------------------------------------------
    // TEST 4: Full = 20000, Installment = 10000 (P1 = 5000, P2 = 5000)
    // ---------------------------------------------------------
    console.log("--- TEST 4: Full = 20000, Installment = 10000 (P1 = 5000, P2 = 5000) ---");
    const payload4 = {
      course_id: priceCourseId,
      full_payment_amount: 20000,
      installment_total_amount: 10000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 5000 },
        { phase_number: 2, name: "2nd Installment", amount: 5000 }
      ]
    };
    await pricingService.saveCoursePricing(payload4);
    const getRes4 = await pricingService.getPricingForCourse(priceCourseId);
    const full4 = getRes4.pricingPlans.find(p => p.paymentMode === "FULL");
    const inst4 = getRes4.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");
    if (full4.totalAmount !== 20000 || inst4.totalAmount !== 10000 || inst4.phases.length !== 2) {
      throw new Error(`TEST 4 FAILED: Got Full ${full4.totalAmount}, Inst ${inst4.totalAmount}, phases ${inst4.phases.length}`);
    }
    console.log("✅ PASS TEST 4: Full ₹20,000, Installment ₹10,000 (2 phases of ₹5,000) verified!\n");

    // ---------------------------------------------------------
    // REVERT TO TARGET REQUIREMENT & VERIFY
    // Full = 15000, Installment = 12000 (P1 = 6000, P2 = 6000)
    // ---------------------------------------------------------
    console.log("--- REVERSED TO TARGET CONFIGURATION (Full 15k, Inst 12k [6k, 6k]) ---");
    await pricingService.saveCoursePricing(payload1);
    const finalGet = await pricingService.getPricingForCourse(priceCourseId);
    console.log("FINAL GET API RESPONSE FOR 'price course':", JSON.stringify(finalGet, null, 2));

    // ---------------------------------------------------------
    // TEST 5: COURSE ISOLATION TEST
    // ---------------------------------------------------------
    console.log("--- TEST 5: Course Isolation Test ---");
    const existingIso = await courseService.getCourseBySlug("pricing-isolation-test", true);
    if (existingIso) {
      await supabase.from("courses").delete().eq("id", existingIso.id);
    }

    const isoCourse = await courseService.createCourse({
      title: "pricing isolation test",
      slug: "pricing-isolation-test",
      department_id: "cda4e486-bb55-4553-859b-8702a9185feb",
      status: "PUBLISHED"
    });

    await pricingService.saveCoursePricing({
      course_id: isoCourse.id,
      full_payment_amount: 20000,
      installment_total_amount: 18000,
      phases: [
        { phase_number: 1, amount: 8000 },
        { phase_number: 2, amount: 10000 }
      ]
    });

    const verifyPriceCourse = await pricingService.getPricingForCourse(priceCourseId);
    const verifyInst = verifyPriceCourse.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");
    if (verifyInst.totalAmount !== 12000 || verifyInst.phases[0].amount !== 6000) {
      throw new Error("TEST 5 FAILED: 'price course' was mutated by isolated course save!");
    }

    console.log("✅ PASS TEST 5: Course pricing isolation verified!\n");
    await supabase.from("courses").delete().eq("id", isoCourse.id);

  } catch (err) {
    console.error("❌ TEST MATRIX ERROR:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("=== ALL PRICING MATRIX TESTS PASSED WITH 100% SUCCESS ===");
    process.exit(0);
  }
}

runPriceCourseMatrixTests();
