const express = require('express');
const app = require('../src/app');
const { supabase } = require('../src/config/supabase');
const pricingService = require('../src/modules/pricing/pricing.service');
const courseService = require('../src/modules/courses/course.service');

async function runPaymentModeArchitectureTests() {
  console.log("=== STARTING COMPREHENSIVE PAYMENT MODE ARCHITECTURE TEST SUITE ===\n");

  let server;
  const PORT = 5053;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  const departmentId = "cda4e486-bb55-4553-859b-8702a9185feb";

  try {
    // ---------------------------------------------------------
    // TEST 1: Course 'Test Full Only' (FULL: 15000, INSTALLMENT: disabled)
    // ---------------------------------------------------------
    console.log("--- TEST 1: Course 'Test Full Only' (FULL: 15000, INSTALLMENT: disabled) ---");
    const existingFullOnly = await courseService.getCourseBySlug("test-full-only", true);
    if (existingFullOnly) await supabase.from("courses").delete().eq("id", existingFullOnly.id);

    const fullOnlyCourse = await courseService.createCourse({
      title: "Test Full Only",
      slug: "test-full-only",
      department_id: departmentId,
      status: "PUBLISHED"
    });

    const payload1 = {
      course_id: fullOnlyCourse.id,
      is_full_enabled: true,
      is_installment_enabled: false,
      full_payment_amount: 15000,
      currency: "INR"
    };

    await pricingService.saveCoursePricing(payload1);
    const res1 = await pricingService.getPricingForCourse(fullOnlyCourse.id);
    console.log("GET API Response (Full Only):", JSON.stringify(res1.pricingPlans, null, 2));

    if (res1.pricingPlans.length !== 1 || res1.pricingPlans[0].paymentMode !== "FULL" || res1.pricingPlans[0].totalAmount !== 15000) {
      throw new Error(`TEST 1 FAILED: Expected 1 FULL plan with 15000 total. Got: ${JSON.stringify(res1.pricingPlans)}`);
    }
    console.log("✅ PASS TEST 1: FULL ONLY mode verified cleanly!\n");

    // ---------------------------------------------------------
    // TEST 2: Course 'Test Installment Only' (FULL: disabled, INSTALLMENT: 12000 [6k, 6k])
    // ---------------------------------------------------------
    console.log("--- TEST 2: Course 'Test Installment Only' (FULL: disabled, INSTALLMENT: 12000 [6k, 6k]) ---");
    const existingInstOnly = await courseService.getCourseBySlug("test-installment-only", true);
    if (existingInstOnly) await supabase.from("courses").delete().eq("id", existingInstOnly.id);

    const instOnlyCourse = await courseService.createCourse({
      title: "Test Installment Only",
      slug: "test-installment-only",
      department_id: departmentId,
      status: "PUBLISHED"
    });

    const payload2 = {
      course_id: instOnlyCourse.id,
      is_full_enabled: false,
      is_installment_enabled: true,
      installment_total_amount: 12000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 6000 },
        { phase_number: 2, name: "2nd Installment", amount: 6000 }
      ]
    };

    await pricingService.saveCoursePricing(payload2);
    const res2 = await pricingService.getPricingForCourse(instOnlyCourse.id);
    console.log("GET API Response (Installment Only):", JSON.stringify(res2.pricingPlans, null, 2));

    if (res2.pricingPlans.length !== 1 || res2.pricingPlans[0].paymentMode !== "INSTALLMENT" || res2.pricingPlans[0].totalAmount !== 12000) {
      throw new Error(`TEST 2 FAILED: Expected 1 INSTALLMENT plan with 12000 total. Got: ${JSON.stringify(res2.pricingPlans)}`);
    }
    console.log("✅ PASS TEST 2: INSTALLMENT ONLY mode verified cleanly!\n");

    // ---------------------------------------------------------
    // TEST 3: Course 'Test Both' (FULL: 15000, INSTALLMENT: 12000 [6k, 6k])
    // ---------------------------------------------------------
    console.log("--- TEST 3: Course 'Test Both' (FULL: 15000, INSTALLMENT: 12000 [6k, 6k]) ---");
    const existingBoth = await courseService.getCourseBySlug("test-both", true);
    if (existingBoth) await supabase.from("courses").delete().eq("id", existingBoth.id);

    const bothCourse = await courseService.createCourse({
      title: "Test Both",
      slug: "test-both",
      department_id: departmentId,
      status: "PUBLISHED"
    });

    const payload3 = {
      course_id: bothCourse.id,
      is_full_enabled: true,
      is_installment_enabled: true,
      full_payment_amount: 15000,
      installment_total_amount: 12000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 6000 },
        { phase_number: 2, name: "2nd Installment", amount: 6000 }
      ]
    };

    await pricingService.saveCoursePricing(payload3);
    const res3 = await pricingService.getPricingForCourse(bothCourse.id);
    console.log("GET API Response (Both Enabled):", JSON.stringify(res3.pricingPlans, null, 2));

    if (res3.pricingPlans.length !== 2) {
      throw new Error(`TEST 3 FAILED: Expected 2 active pricing plans. Got: ${res3.pricingPlans.length}`);
    }
    console.log("✅ PASS TEST 3: BOTH payment options mode verified cleanly!\n");

    // ---------------------------------------------------------
    // TEST 4: Transition FULL + INST -> FULL ONLY
    // ---------------------------------------------------------
    console.log("--- TEST 4: Transition FULL + INST -> FULL ONLY ---");
    await pricingService.saveCoursePricing({
      course_id: bothCourse.id,
      is_full_enabled: true,
      is_installment_enabled: false,
      full_payment_amount: 15000
    });
    const res4 = await pricingService.getPricingForCourse(bothCourse.id);
    if (res4.pricingPlans.length !== 1 || res4.pricingPlans[0].paymentMode !== "FULL") {
      throw new Error(`TEST 4 FAILED: Expected Installment plan to disappear. Got: ${JSON.stringify(res4.pricingPlans)}`);
    }
    console.log("✅ PASS TEST 4: Transition FULL+INST -> FULL ONLY verified (Installment disappeared)!\n");

    // ---------------------------------------------------------
    // TEST 5: Transition FULL ONLY -> INST ONLY
    // ---------------------------------------------------------
    console.log("--- TEST 5: Transition FULL ONLY -> INST ONLY ---");
    await pricingService.saveCoursePricing({
      course_id: bothCourse.id,
      is_full_enabled: false,
      is_installment_enabled: true,
      installment_total_amount: 12000,
      phases: [
        { phase_number: 1, amount: 6000 },
        { phase_number: 2, amount: 6000 }
      ]
    });
    const res5 = await pricingService.getPricingForCourse(bothCourse.id);
    if (res5.pricingPlans.length !== 1 || res5.pricingPlans[0].paymentMode !== "INSTALLMENT") {
      throw new Error(`TEST 5 FAILED: Expected Full plan to disappear. Got: ${JSON.stringify(res5.pricingPlans)}`);
    }
    console.log("✅ PASS TEST 5: Transition FULL ONLY -> INST ONLY verified (Full payment disappeared)!\n");

    // Clean up temporary test courses
    await supabase.from("courses").delete().eq("id", fullOnlyCourse.id);
    await supabase.from("courses").delete().eq("id", instOnlyCourse.id);
    await supabase.from("courses").delete().eq("id", bothCourse.id);

  } catch (err) {
    console.error("❌ PAYMENT MODE TEST ERROR:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("=== ALL PAYMENT MODE ARCHITECTURE TESTS PASSED WITH 100% SUCCESS ===");
    process.exit(0);
  }
}

runPaymentModeArchitectureTests();
