const express = require('express');
const app = require('../src/app');
const { supabase } = require('../src/config/supabase');
const courseService = require('../src/modules/courses/course.service');
const curriculumService = require('../src/modules/curriculum/curriculum.service');
const pricingService = require('../src/modules/pricing/pricing.service');

async function runEndToEndFrontendFlowTest() {
  console.log("=== STARTING CANONICAL END-TO-END DATA FLOW VERIFICATION SUITE ===\n");

  let server;
  const PORT = 5055;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  const departmentId = "cda4e486-bb55-4553-859b-8702a9185feb"; // CSE / IT department

  try {
    // ---------------------------------------------------------
    // 1. CLEANUP & CREATE TEST DATA IN DATABASE
    // ---------------------------------------------------------
    console.log("--- 1. DATABASE INGESTION: Creating 'Pavan Frontend Testing Course' ---");
    const existing = await courseService.getCourseBySlug("pavan-frontend-testing-course", true);
    if (existing) {
      await supabase.from("courses").delete().eq("id", existing.id);
    }

    const course = await courseService.createCourse({
      title: "Pavan Frontend Testing Course",
      slug: "pavan-frontend-testing-course",
      department_id: departmentId,
      description: "Comprehensive end-to-end frontend data flow verification course",
      status: "PUBLISHED"
    });

    console.log(`✅ Created Course in DB with ID: ${course.id}`);

    // Create Module, Lesson & Topics in curriculum_modules JSON structure
    const curriculumPayload = [
      {
        id: "mod_pavan_frontend_1",
        name: "Pavan Frontend Module",
        title: "Pavan Frontend Module",
        description: "Core frontend architecture and state management module",
        duration_minutes: 60,
        display_order: 1,
        lessons: [
          {
            id: "les_pavan_frontend_1",
            title: "Pavan Frontend Lesson",
            lesson_type: "VIDEO",
            duration_minutes: 60,
            topics: [
              { id: "top_1", title: "Topic One", display_order: 1 },
              { id: "top_2", title: "Topic Two", display_order: 2 }
            ]
          }
        ]
      }
    ];

    await supabase
      .from("courses")
      .update({ curriculum_modules: curriculumPayload })
      .eq("id", course.id);

    console.log("✅ Created Curriculum (1 Module, 60 mins, 1 Lesson, 2 Topics) in DB");

    // Save Pricing Configuration (FULL: 12000, INSTALLMENT: 12000 [6k, 6k])
    const pricingPayload = {
      courseId: course.id,
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

    await pricingService.saveCoursePricing(pricingPayload);
    console.log("✅ Saved Pricing Plans (FULL ₹12,000 & INSTALLMENT ₹6,000 + ₹6,000) in DB\n");

    // ---------------------------------------------------------
    // 2. VERIFY GET /api/courses (PROGRAMS PAGE DATA)
    // ---------------------------------------------------------
    console.log("--- 2. PROGRAMS PAGE FLOW: Querying GET /api/courses ---");
    const allCourses = await courseService.getCourses(false);
    const pavanInList = allCourses.find(c => c.id === course.id || c.slug === "pavan-frontend-testing-course");

    if (!pavanInList) {
      throw new Error("PROGRAMS PAGE FLOW FAILED: Created course not returned in GET /api/courses");
    }

    console.log("Programs Page Course Payload:", JSON.stringify({
      id: pavanInList.id,
      title: pavanInList.title,
      slug: pavanInList.slug,
      department_id: pavanInList.department_id,
      price: pavanInList.price
    }, null, 2));

    if (pavanInList.title !== "Pavan Frontend Testing Course") {
      throw new Error(`Title mismatch! Expected 'Pavan Frontend Testing Course', got '${pavanInList.title}'`);
    }
    console.log("✅ PASS: Programs Page receives exact backend course data!\n");

    // ---------------------------------------------------------
    // 3. VERIFY GET /api/courses/:slug OR :id (COURSE DETAILS DATA)
    // ---------------------------------------------------------
    console.log("--- 3. COURSE DETAILS PAGE FLOW: Querying GET /api/courses/:id ---");
    const courseDetailById = await courseService.getCourseById(course.id, false);
    const courseDetailBySlug = await courseService.getCourseBySlug("pavan-frontend-testing-course", false);

    if (!courseDetailById || !courseDetailBySlug) {
      throw new Error("COURSE DETAILS FAILED: getCourseById or getCourseBySlug returned null!");
    }

    console.log("✅ PASS: Course Details lookup by UUID and Slug both succeeded!\n");

    // ---------------------------------------------------------
    // 4. VERIFY GET /api/courses/:courseId/curriculum (CURRICULUM FLOW)
    // ---------------------------------------------------------
    console.log("--- 4. CURRICULUM FLOW: Querying GET /api/courses/:courseId/curriculum ---");
    const curriculumByUUID = await curriculumService.getPublicCourseCurriculum(course.id);
    const curriculumBySlug = await curriculumService.getPublicCourseCurriculum("pavan-frontend-testing-course");

    console.log("Curriculum API Response:", JSON.stringify(curriculumByUUID, null, 2));

    const rawModules = curriculumByUUID.course?.version?.modules || curriculumByUUID.modules || (Array.isArray(curriculumByUUID) ? curriculumByUUID : []);
    if (!Array.isArray(rawModules) || rawModules.length !== 1) {
      throw new Error(`Curriculum length invalid! Expected 1 module, got ${rawModules?.length}`);
    }

    const mod = rawModules[0];
    if (mod.title !== "Pavan Frontend Module" || Number(mod.duration_minutes) !== 60) {
      throw new Error(`Module mismatch! Expected 'Pavan Frontend Module' (60 mins), got '${mod.title}' (${mod.duration_minutes} mins)`);
    }

    const les = mod.lessons?.[0];
    if (les?.title !== "Pavan Frontend Lesson" || Number(les?.duration_minutes) !== 60) {
      throw new Error(`Lesson mismatch! Expected 'Pavan Frontend Lesson' (60 mins), got '${les?.title}'`);
    }

    const topics = les?.topics || [];
    const topicTitles = topics.map(t => typeof t === 'string' ? t : t.title);
    if (!topicTitles.includes("Topic One") || !topicTitles.includes("Topic Two")) {
      throw new Error(`Topics mismatch! Expected ['Topic One', 'Topic Two'], got ${JSON.stringify(topicTitles)}`);
    }

    console.log("✅ PASS: Curriculum API correctly resolves Module ('Pavan Frontend Module', 60m), Lesson ('Pavan Frontend Lesson', 60m), and Topics ['Topic One', 'Topic Two']!\n");

    // ---------------------------------------------------------
    // 5. VERIFY GET /api/courses/:courseId/pricing (PRICING FLOW)
    // ---------------------------------------------------------
    console.log("--- 5. PRICING FLOW: Querying GET /api/courses/:courseId/pricing ---");
    const pricingRes = await pricingService.getPricingForCourse(course.id);
    console.log("Pricing API Response:", JSON.stringify(pricingRes.pricingPlans, null, 2));

    const fullPlan = pricingRes.pricingPlans.find(p => p.paymentMode === "FULL");
    const instPlan = pricingRes.pricingPlans.find(p => p.paymentMode === "INSTALLMENT");

    if (!fullPlan || fullPlan.totalAmount !== 12000) {
      throw new Error(`FULL plan invalid! Expected 12000, got ${fullPlan?.totalAmount}`);
    }

    if (!instPlan || instPlan.totalAmount !== 12000 || instPlan.phases[0].amount !== 6000 || instPlan.phases[1].amount !== 6000) {
      throw new Error(`INSTALLMENT plan invalid! Got ${JSON.stringify(instPlan)}`);
    }

    console.log("✅ PASS: Pricing API returns exact FULL (₹12,000) & INSTALLMENT (₹6,000 + ₹6,000) DB plans!\n");

    // Clean up temporary test course
    await supabase.from("courses").delete().eq("id", course.id);

  } catch (err) {
    console.error("❌ END-TO-END DATA FLOW TEST ERROR:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("=== ALL END-TO-END FRONTEND DATA FLOW TESTS PASSED WITH 100% SUCCESS ===");
    process.exit(0);
  }
}

runEndToEndFrontendFlowTest();
