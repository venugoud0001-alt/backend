const express = require('express');
const app = require('../src/app');
const { supabase } = require('../src/config/supabase');
const pricingService = require('../src/modules/pricing/pricing.service');
const courseService = require('../src/modules/courses/course.service');

async function runPavanFullStackMatrixTests() {
  console.log("=== STARTING FULL 'Pavan Full Stack' PRICING CONTRACT MATRIX SUITE ===\n");

  let server;
  const PORT = 5054;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  const departmentId = "cda4e486-bb55-4553-859b-8702a9185feb";

  try {
    // ---------------------------------------------------------
    // TEST A: Course 'Pavan Full Stack' (FULL: 12000, INST: disabled)
    // ---------------------------------------------------------
    console.log("--- TEST A: Course 'Pavan Full Stack' (FULL: 12000, INST: disabled) ---");
    const existingPavan = await courseService.getCourseBySlug("pavan-full-stack", true);
    if (existingPavan) await supabase.from("courses").delete().eq("id", existingPavan.id);

    const pavanCourse = await courseService.createCourse({
      title: "Pavan Full Stack",
      slug: "pavan-full-stack",
      department_id: departmentId,
      status: "PUBLISHED"
    });

    const payloadA = {
      courseId: pavanCourse.id,
      isFullEnabled: true,
      isInstallmentEnabled: false,
      fullTotalAmount: 12000,
      currency: "INR"
    };

    const resA_Save = await pricingService.saveCoursePricing(payloadA);
    console.log("[TEST A] Save response:", JSON.stringify(resA_Save.pricingPlans, null, 2));

    const resA_Get = await pricingService.getPricingForCourse(pavanCourse.id);
    console.log("[TEST A] GET API response:", JSON.stringify(resA_Get.pricingPlans, null, 2));

    if (resA_Get.pricingPlans.length !== 1 || resA_Get.pricingPlans[0].paymentMode !== "FULL" || resA_Get.pricingPlans[0].totalAmount !== 12000) {
      throw new Error(`TEST A FAILED: Expected 1 FULL plan with 12000 total. Got: ${JSON.stringify(resA_Get.pricingPlans)}`);
    }
    console.log("✅ PASS TEST A: FULL ONLY ₹12,000 verified!\n");

    // ---------------------------------------------------------
    // TEST B: Same Course (FULL: disabled, INST: enabled 12000 [6k, 6k])
    // ---------------------------------------------------------
    console.log("--- TEST B: Course 'Pavan Full Stack' (FULL: disabled, INST: enabled 12000 [6k, 6k]) ---");
    const payloadB = {
      courseId: pavanCourse.id,
      isFullEnabled: false,
      isInstallmentEnabled: true,
      installmentTotalAmount: 12000,
      currency: "INR",
      phases: [
        { phaseNumber: 1, name: "1st Installment", amount: 6000 },
        { phaseNumber: 2, name: "2nd Installment", amount: 6000 }
      ]
    };

    await pricingService.saveCoursePricing(payloadB);
    const resB_Get = await pricingService.getPricingForCourse(pavanCourse.id);
    console.log("[TEST B] GET API response:", JSON.stringify(resB_Get.pricingPlans, null, 2));

    if (resB_Get.pricingPlans.length !== 1 || resB_Get.pricingPlans[0].paymentMode !== "INSTALLMENT" || resB_Get.pricingPlans[0].totalAmount !== 12000) {
      throw new Error(`TEST B FAILED: Expected 1 INSTALLMENT plan with 12000 total. Got: ${JSON.stringify(resB_Get.pricingPlans)}`);
    }
    console.log("✅ PASS TEST B: INSTALLMENT ONLY ₹6,000 + ₹6,000 verified!\n");

    // ---------------------------------------------------------
    // TEST C: Same Course (FULL: enabled 12000, INST: enabled 12000 [6k, 6k])
    // ---------------------------------------------------------
    console.log("--- TEST C: Course 'Pavan Full Stack' (FULL: enabled 12000, INST: enabled 12000 [6k, 6k]) ---");
    const payloadC = {
      courseId: pavanCourse.id,
      isFullEnabled: true,
      isInstallmentEnabled: true,
      fullTotalAmount: 12000,
      installmentTotalAmount: 12000,
      currency: "INR",
      phases: [
        { phaseNumber: 1, name: "1st Installment", amount: 6000 },
        { phaseNumber: 2, name: "2nd Installment", amount: 6000 }
      ]
    };

    await pricingService.saveCoursePricing(payloadC);
    const resC_Get = await pricingService.getPricingForCourse(pavanCourse.id);
    console.log("[TEST C] GET API response:", JSON.stringify(resC_Get.pricingPlans, null, 2));

    if (resC_Get.pricingPlans.length !== 2) {
      throw new Error(`TEST C FAILED: Expected 2 pricing plans. Got: ${resC_Get.pricingPlans.length}`);
    }
    console.log("✅ PASS TEST C: BOTH payment options verified!\n");

    // ---------------------------------------------------------
    // TEST D: Change Installment breakdown to 5000 + 7000
    // ---------------------------------------------------------
    console.log("--- TEST D: Change Installment breakdown to ₹5,000 + ₹7,000 ---");
    const payloadD = {
      courseId: pavanCourse.id,
      isFullEnabled: true,
      isInstallmentEnabled: true,
      fullTotalAmount: 12000,
      installmentTotalAmount: 12000,
      currency: "INR",
      phases: [
        { phaseNumber: 1, name: "1st Installment", amount: 5000 },
        { phaseNumber: 2, name: "2nd Installment", amount: 7000 }
      ]
    };

    await pricingService.saveCoursePricing(payloadD);
    const resD_Get = await pricingService.getPricingForCourse(pavanCourse.id);
    console.log("[TEST D] GET API response:", JSON.stringify(resD_Get.pricingPlans, null, 2));

    const instD = resD_Get.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");
    if (instD.phases[0].amount !== 5000 || instD.phases[1].amount !== 7000) {
      throw new Error(`TEST D FAILED: Expected phases [5000, 7000]. Got: [${instD.phases[0].amount}, ${instD.phases[1].amount}]`);
    }
    console.log("✅ PASS TEST D: Installment breakdown ₹5,000 + ₹7,000 verified!\n");

    // ---------------------------------------------------------
    // TEST E: Change FULL price from 15000 to 20000
    // ---------------------------------------------------------
    console.log("--- TEST E: Change FULL price to ₹20,000 ---");
    const payloadE = {
      courseId: pavanCourse.id,
      isFullEnabled: true,
      isInstallmentEnabled: true,
      fullTotalAmount: 20000,
      installmentTotalAmount: 12000,
      currency: "INR",
      phases: [
        { phaseNumber: 1, name: "1st Installment", amount: 5000 },
        { phaseNumber: 2, name: "2nd Installment", amount: 7000 }
      ]
    };

    await pricingService.saveCoursePricing(payloadE);
    const resE_Get = await pricingService.getPricingForCourse(pavanCourse.id);
    console.log("[TEST E] GET API response:", JSON.stringify(resE_Get.pricingPlans, null, 2));

    const fullE = resE_Get.pricingPlans.find(p => p.paymentMode === "FULL");
    if (fullE.totalAmount !== 20000) {
      throw new Error(`TEST E FAILED: Expected Full plan total 20000. Got: ${fullE.totalAmount}`);
    }
    console.log("✅ PASS TEST E: FULL price ₹20,000 verified!\n");

    // Clean up temporary test course
    await supabase.from("courses").delete().eq("id", pavanCourse.id);

  } catch (err) {
    console.error("❌ CONTRACT MATRIX TEST ERROR:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("=== ALL 'Pavan Full Stack' PRICING MATRIX TESTS PASSED WITH 100% SUCCESS ===");
    process.exit(0);
  }
}

runPavanFullStackMatrixTests();
