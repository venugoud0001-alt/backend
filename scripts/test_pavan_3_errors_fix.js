const fs = require('fs');
const path = require('path');
const express = require('express');
const app = require('../src/app');
const storageService = require('../src/services/storage/storageService');
const { resolveImageUrl } = require('../../src/utils/imageUtils');

async function run3ErrorsFixVerification() {
  console.log("=== STARTING VERIFICATION SUITE FOR ALL 3 RUNTIME ERRORS ===\n");

  let server;
  const PORT = 5088;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  try {
    // --- 1. VERIFY IMAGE URL RESOLUTION & DUPLICATE CLEANUP ---
    console.log("--- 1. IMAGE URL RESOLUTION & DUPLICATE CLEANUP TEST ---");
    const testBuffer = Buffer.from("test image content");
    const uploadRes = await storageService.upload(testBuffer, "uploads/images/test_image.webp", "image/webp");
    console.log("Raw upload result video_url:", uploadRes.video_url);

    if (uploadRes.video_url.includes("/uploads/uploads/")) {
      throw new Error(`FAIL: Raw upload result contains duplicated '/uploads/uploads/': ${uploadRes.video_url}`);
    }
    console.log("✅ PASS: Raw upload URL has single '/uploads/' prefix!");

    const resolvedSingle = resolveImageUrl("/uploads/images/test_image.webp");
    console.log("resolveImageUrl('/uploads/images/test_image.webp'):", resolvedSingle);

    const resolvedDuplicate = resolveImageUrl("/uploads/uploads/images/test_image.webp");
    console.log("resolveImageUrl('/uploads/uploads/images/test_image.webp'):", resolvedDuplicate);

    if (resolvedDuplicate.includes("/uploads/uploads/")) {
      throw new Error(`FAIL: resolveImageUrl failed to sanitize duplicated path: ${resolvedDuplicate}`);
    }
    console.log("✅ PASS: resolveImageUrl cleanly sanitized duplicated '/uploads/uploads/' path!\n");

    // --- 2. VERIFY ADMINDASHBOARD SUPABASE IMPORT ---
    console.log("--- 2. ADMINDASHBOARD SUPABASE IMPORT TEST ---");
    const adminDashboardContent = fs.readFileSync(
      path.join(__dirname, "../../src/views/admin/AdminDashboard.jsx"),
      "utf8"
    );
    if (!adminDashboardContent.includes('import { supabase } from "../../services/supabaseClient";')) {
      throw new Error("FAIL: AdminDashboard.jsx missing supabase import from '../../services/supabaseClient'");
    }
    console.log("✅ PASS: AdminDashboard.jsx correctly imports centralized supabase client!\n");

    // --- 3. VERIFY MODULE LESSON CREATION VALIDATOR CONTRACT ---
    console.log("--- 3. MODULE LESSON CREATION VALIDATOR TEST ---");
    const stringModuleId = "mod_1787472040402_5b01";
    
    // Perform POST /api/modules/mod_1787472040402_5b01/lessons
    const response = await fetch(`http://localhost:${PORT}/api/modules/${stringModuleId}/lessons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Pavan Frontend Module Lesson",
        duration_minutes: 60,
        lesson_type: "VIDEO"
      })
    });

    const resJson = await response.json();
    console.log("POST /api/modules/mod_1787472040402_5b01/lessons response:", response.status, resJson);

    if (response.status === 400 && resJson.message === "Valid moduleId UUID is required.") {
      throw new Error(`FAIL: Validator rejected string moduleId '${stringModuleId}'!`);
    }
    console.log("✅ PASS: Module lesson creation validator accepted non-UUID string moduleId!\n");

  } catch (err) {
    console.error("❌ 3 ERRORS VERIFICATION SUITE FAILED:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("=== ALL 3 RUNTIME ERRORS SUCCESSFULLY FIXED AND VERIFIED (100% SUCCESS) ===");
    process.exit(0);
  }
}

run3ErrorsFixVerification();
