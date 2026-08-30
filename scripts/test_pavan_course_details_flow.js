const express = require('express');
const app = require('../src/app');
const { supabase } = require('../src/config/supabase');
const courseService = require('../src/modules/courses/course.service');
const curriculumService = require('../src/modules/curriculum/curriculum.service');
const pricingService = require('../src/modules/pricing/pricing.service');

async function runCourseDetailsDataFlowTest() {
  console.log("=== STARTING CANONICAL COURSE DETAILS DATA FLOW VERIFICATION SUITE ===\n");

  let server;
  const PORT = 5066;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  const departmentId = "cda4e486-bb55-4553-859b-8702a9185feb"; // CSE department

  try {
    // 1. Clean up & Insert exact test course
    console.log("--- 1. DATABASE INGESTION: Creating 'Pavan Course' ---");
    const existing = await courseService.getCourseBySlug("pavan-course", true);
    if (existing) {
      await supabase.from("courses").delete().eq("id", existing.id);
    }

    const course = await courseService.createCourse({
      title: "Pavan Course",
      slug: "pavan-course",
      department_id: departmentId,
      description: "Canonical test course for Course Details hierarchy verification",
      status: "PUBLISHED"
    });

    console.log(`✅ Created Course in DB: '${course.title}' (ID: ${course.id})`);

    // Create Module, Lesson & Topics in curriculum_modules JSON structure
    const curriculumPayload = [
      {
        id: "mod_pavan_details_1",
        name: "Pavan Module",
        title: "Pavan Module",
        description: "Core module for Pavan Course",
        duration_minutes: 60,
        display_order: 1,
        lessons: [
          {
            id: "les_pavan_details_1",
            title: "Pavan Frontend Module",
            lesson_type: "VIDEO",
            duration_minutes: 60,
            topics: [
              { id: "top_det_1", title: "Topic 1", display_order: 1 },
              { id: "top_det_2", title: "Topic 2", display_order: 2 }
            ]
          }
        ]
      }
    ];

    await supabase
      .from("courses")
      .update({ curriculum_modules: curriculumPayload })
      .eq("id", course.id);

    console.log("✅ Created Curriculum (1 Module 'Pavan Module' 60m, 1 Lesson 'Pavan Frontend Module' 60m, Topics ['Topic 1', 'Topic 2']) in DB");

    // Save Pricing Configuration (FULL: ₹12,000 & INSTALLMENT: ₹6,000 + ₹6,000)
    const pricingPayload = {
      courseId: course.id,
      isFullEnabled: true,
      isInstallmentEnabled: true,
      fullTotalAmount: 12000,
      installmentTotalAmount: 12000,
      currency: "INR",
      phases: [
        { phaseNumber: 1, name: "Phase 1", amount: 6000 },
        { phaseNumber: 2, name: "Phase 2", amount: 6000 }
      ]
    };

    await pricingService.saveCoursePricing(pricingPayload);
    console.log("✅ Saved Pricing Plans (FULL ₹12,000 & INSTALLMENT Phase 1 ₹6,000 + Phase 2 ₹6,000) in DB\n");

    // 2. Query GET /api/courses/pavan-course/curriculum
    console.log("--- 2. CURRICULUM FLOW: GET /api/courses/pavan-course/curriculum ---");
    const curriculumRes = await curriculumService.getPublicCourseCurriculum("pavan-course");

    console.log("Curriculum API Result:", JSON.stringify(curriculumRes, null, 2));

    const rawModules = curriculumRes.course?.version?.modules || curriculumRes.course?.modules || (Array.isArray(curriculumRes) ? curriculumRes : []);

    if (!Array.isArray(rawModules) || rawModules.length !== 1) {
      throw new Error(`Curriculum modules length invalid! Expected 1, got ${rawModules?.length}`);
    }

    const mod = rawModules[0];
    if (mod.title !== "Pavan Module" || Number(mod.duration_minutes) !== 60) {
      throw new Error(`Module mismatch! Expected 'Pavan Module' (60 mins), got '${mod.title}' (${mod.duration_minutes} mins)`);
    }

    const les = mod.lessons?.[0];
    if (les?.title !== "Pavan Frontend Module" || Number(les?.duration_minutes) !== 60) {
      throw new Error(`Lesson mismatch! Expected 'Pavan Frontend Module' (60 mins), got '${les?.title}'`);
    }

    const topicTitles = (les?.topics || []).map(t => typeof t === 'string' ? t : t.title);
    if (!topicTitles.includes("Topic 1") || !topicTitles.includes("Topic 2")) {
      throw new Error(`Topic mismatch! Expected ['Topic 1', 'Topic 2'], got ${JSON.stringify(topicTitles)}`);
    }

    console.log("✅ PASS: Curriculum API correctly resolves Module ('Pavan Module', 1 hr), Lesson ('Pavan Frontend Module', 1 hr), and Topics ['Topic 1', 'Topic 2']!\n");

    // 3. Query GET /api/courses/:courseId/pricing
    console.log("--- 3. PRICING FLOW: GET /api/courses/:courseId/pricing ---");
    const pricingRes = await pricingService.getPricingForCourse(course.id);
    console.log("Pricing API Result:", JSON.stringify(pricingRes.pricingPlans, null, 2));

    const fullPlan = pricingRes.pricingPlans.find(p => p.paymentMode === "FULL");
    const instPlan = pricingRes.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");

    if (!fullPlan || fullPlan.totalAmount !== 12000) {
      throw new Error(`FULL plan invalid! Expected 12000, got ${fullPlan?.totalAmount}`);
    }

    if (!instPlan || instPlan.totalAmount !== 12000 || instPlan.phases[0].amount !== 6000 || instPlan.phases[1].amount !== 6000) {
      throw new Error(`INSTALLMENT plan invalid! Got ${JSON.stringify(instPlan)}`);
    }

    console.log("✅ PASS: Pricing API returns exact FULL (₹12,000) & INSTALLMENT (Phase 1 ₹6,000, Phase 2 ₹6,000) DB plans!\n");

    // Clean up temporary test course
    await supabase.from("courses").delete().eq("id", course.id);

  } catch (err) {
    console.error("❌ COURSE DETAILS DATA FLOW TEST ERROR:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("=== ALL COURSE DETAILS DATA FLOW TESTS PASSED WITH 100% SUCCESS ===");
    process.exit(0);
  }
}

runCourseDetailsDataFlowTest();
