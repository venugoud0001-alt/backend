const http = require('http');
const express = require('express');
const app = require('../src/app');
const { supabase } = require('../src/config/supabase');
const pricingService = require('../src/modules/pricing/pricing.service');
const curriculumService = require('../src/modules/curriculum/curriculum.service');
const courseService = require('../src/modules/courses/course.service');
const departmentService = require('../src/modules/departments/department.service');

async function runEndToEndTests() {
  console.log("=== STARTING FULL END-TO-END PRICING & CURRICULUM VERIFICATION ===\n");

  let server;
  const PORT = 5051;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  try {
    // ---------------------------------------------------------
    // TEST 1: UPDATE PRICING FOR 'fee testing' (343f3dc3-355e-4a8a-999a-1247f8f7e37e)
    // ---------------------------------------------------------
    console.log("\n--- TEST 1: Updating Pricing for 'fee testing' ---");
    const feeTestingId = '343f3dc3-355e-4a8a-999a-1247f8f7e37e';

    // 1. Save Full Payment Plan (15,000)
    await pricingService.createPricingPlan({
      course_id: feeTestingId,
      name: "Full Payment Plan",
      payment_mode: "FULL",
      total_amount: 15000,
      currency: "INR"
    });

    // 2. Save Installment Plan (12,000: 6,000 + 6,000)
    await pricingService.createPricingPlan({
      course_id: feeTestingId,
      name: "2-Phase Flexible Installment Plan",
      payment_mode: "INSTALLMENT",
      total_amount: 12000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 6000 },
        { phase_number: 2, name: "2nd Installment", amount: 6000 }
      ]
    });

    // 3. GET Pricing API Response
    const feeTestingPricing = await pricingService.getPricingForCourse(feeTestingId);
    console.log("Returned Pricing Plans for 'fee testing':", JSON.stringify(feeTestingPricing.pricingPlans, null, 2));

    const fullPlan = feeTestingPricing.pricingPlans.find(p => p.paymentMode === "FULL");
    const instPlan = feeTestingPricing.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");

    if (fullPlan.totalAmount !== 12000) {
      throw new Error(`TEST 1 FAILED: Full Plan totalAmount expected 12000, got ${fullPlan.totalAmount}`);
    }
    if (instPlan.totalAmount !== 12000) {
      throw new Error(`TEST 1 FAILED: Installment Plan totalAmount expected 12000, got ${instPlan.totalAmount}`);
    }
    if (instPlan.phases[0].amount !== 6000 || instPlan.phases[1].amount !== 6000) {
      throw new Error(`TEST 1 FAILED: Installment phases expected [6000, 6000], got [${instPlan.phases[0].amount}, ${instPlan.phases[1].amount}]`);
    }
    console.log("✅ PASS: 'fee testing' pricing updated correctly! Full: ₹12,000, Installment: ₹12,000 (P1: ₹6,000, P2: ₹6,000)");

    // ---------------------------------------------------------
    // TEST 2: CREATE EXACT TEST DATA 'pavan course'
    // ---------------------------------------------------------
    console.log("\n--- TEST 2: Creating Exact Test Course 'pavan course' ---");

    // Get active department
    const depts = await departmentService.getAllDepartments(true);
    const targetDept = depts.find(d => d.name.toLowerCase().includes("cse") || d.name.toLowerCase().includes("it")) || depts[0];

    if (!targetDept) {
      throw new Error("TEST 2 FAILED: No department available to attach 'pavan course'.");
    }

    const testSlug = "pavan-course";

    // Clean up existing 'pavan course' if present from prior runs to keep test idempotent
    const existingPavan = await courseService.getCourseBySlug(testSlug, true);
    if (existingPavan) {
      console.log(`Cleaning up pre-existing '${testSlug}' course...`);
      await supabase.from("courses").delete().eq("id", existingPavan.id);
    }

    // Create Course
    const pavanCourse = await courseService.createCourse({
      title: "pavan course",
      slug: testSlug,
      department_id: targetDept.id,
      short_description: "pavan course short description",
      description: "pavan course full description",
      status: "PUBLISHED"
    });

    console.log(`'pavan course' created with ID: ${pavanCourse.id}`);

    // Create Pricing Plans for 'pavan course'
    await pricingService.createPricingPlan({
      course_id: pavanCourse.id,
      name: "Full Payment Plan",
      payment_mode: "FULL",
      total_amount: 12000,
      currency: "INR"
    });

    await pricingService.createPricingPlan({
      course_id: pavanCourse.id,
      name: "2-Phase Flexible Installment Plan",
      payment_mode: "INSTALLMENT",
      total_amount: 12000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 6000 },
        { phase_number: 2, name: "2nd Installment", amount: 6000 }
      ]
    });

    // Create Module 'pavan frontend module' (Duration: 60 mins)
    await curriculumService.createModule({
      course_id: pavanCourse.id,
      name: "pavan frontend module",
      duration_minutes: 60,
      description: "pavan frontend module description"
    });

    // GET Curriculum & Pricing API
    const pavanCurriculum = await curriculumService.getPublicCourseCurriculum(testSlug);
    const pavanPricing = await pricingService.getPricingForCourse(pavanCourse.id);

    console.log("Returned Curriculum for 'pavan course':", JSON.stringify(pavanCurriculum, null, 2));
    console.log("Returned Pricing for 'pavan course':", JSON.stringify(pavanPricing, null, 2));

    const pavanMod = pavanCurriculum.course.modules[0];
    if (!pavanMod) throw new Error("TEST 2 FAILED: 'pavan frontend module' not found in returned curriculum.");
    if (pavanMod.duration_minutes !== 60) {
      throw new Error(`TEST 2 FAILED: Module duration_minutes expected 60, got ${pavanMod.duration_minutes}`);
    }
    if (pavanMod.duration !== "1 hr") {
      throw new Error(`TEST 2 FAILED: Module duration string expected '1 hr', got '${pavanMod.duration}'`);
    }
    if (pavanMod.lessons.length !== 0) {
      throw new Error(`TEST 2 FAILED: Module lessons expected empty array [0], got ${pavanMod.lessons.length} lessons`);
    }

    const pavanInstPlan = pavanPricing.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");
    if (pavanInstPlan.totalAmount !== 12000 || pavanInstPlan.phases[0].amount !== 6000 || pavanInstPlan.phases[1].amount !== 6000) {
      throw new Error(`TEST 2 FAILED: 'pavan course' pricing mismatch.`);
    }

    console.log("✅ PASS: 'pavan course' created & verified end-to-end with 100% data consistency!");

    // ---------------------------------------------------------
    // TEST 3: PRICING ISOLATION & MULTIPLE UPDATES TEST
    // ---------------------------------------------------------
    console.log("\n--- TEST 3: Pricing Isolation & Multiple Updates ---");

    // Clean up second test course if present
    const existingIso = await courseService.getCourseBySlug("pricing-isolation-test", true);
    if (existingIso) {
      await supabase.from("courses").delete().eq("id", existingIso.id);
    }

    const isoCourse = await courseService.createCourse({
      title: "pricing isolation test",
      slug: "pricing-isolation-test",
      department_id: targetDept.id,
      status: "PUBLISHED"
    });

    await pricingService.createPricingPlan({
      course_id: isoCourse.id,
      name: "Full Payment",
      payment_mode: "FULL",
      total_amount: 20000,
      currency: "INR"
    });

    await pricingService.createPricingPlan({
      course_id: isoCourse.id,
      name: "Installment Plan",
      payment_mode: "INSTALLMENT",
      total_amount: 18000,
      currency: "INR",
      phases: [
        { phase_number: 1, name: "1st Installment", amount: 8000 },
        { phase_number: 2, name: "2nd Installment", amount: 10000 }
      ]
    });

    // Re-verify 'pavan course' pricing to guarantee ZERO cross-course interference
    const rePavanPricing = await pricingService.getPricingForCourse(pavanCourse.id);
    const rePavanInst = rePavanPricing.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");
    if (rePavanInst.totalAmount !== 12000 || rePavanInst.phases[0].amount !== 6000) {
      throw new Error("TEST 3 FAILED: 'pavan course' pricing was affected by second course creation!");
    }

    console.log("✅ PASS: Pricing isolation verified between independent courses!");

    // Cleanup second test course
    await supabase.from("courses").delete().eq("id", isoCourse.id);

  } catch (err) {
    console.error("❌ TEST RUNNER ERROR:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("\n=== ALL END-TO-END VERIFICATION TESTS PASSED SUCCESSFULLY ===");
    process.exit(0);
  }
}

runEndToEndTests();
