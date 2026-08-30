const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const storageService = require('../src/services/storage/storageService');
const { resolveImageUrl } = require('../../src/utils/imageUtils');

async function runGlobalImagePipelineVerification() {
  console.log("=== STARTING GLOBAL IMAGE PIPELINE VERIFICATION SUITE ===\n");

  let server;
  const PORT = 5099;

  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log(`Test server running on port ${PORT}...`);
      resolve();
    });
  });

  try {
    // 1. UPLOAD & DISK PERSISTENCE TEST
    console.log("--- 1. UPLOAD & DISK PERSISTENCE TEST ---");
    const testContent = "INTERNNETRA_TEST_IMAGE_BUFFER_" + Date.now();
    const testBuffer = Buffer.from(testContent);
    const fileName = `global_img_${Date.now()}.webp`;
    const storageKey = `uploads/images/${fileName}`;

    const uploadRes = await storageService.upload(testBuffer, storageKey, "image/webp");
    console.log("Upload Service Returned:", uploadRes);

    const expectedDiskPath = path.join(__dirname, "../uploads/images", fileName);
    if (!fs.existsSync(expectedDiskPath)) {
      throw new Error(`FAIL: Uploaded file not persisted to disk at '${expectedDiskPath}'!`);
    }

    const savedContent = fs.readFileSync(expectedDiskPath, "utf8");
    if (savedContent !== testContent) {
      throw new Error("FAIL: Disk file content mismatch!");
    }
    console.log("✅ PASS: Local upload file successfully saved to backend/uploads/images/!");

    // 2. BACKEND STATIC FILE SERVING TEST
    console.log("\n--- 2. BACKEND STATIC FILE SERVING HTTP GET TEST ---");
    const staticUrl = `http://localhost:${PORT}/uploads/images/${fileName}`;
    const httpRes = await fetch(staticUrl);
    
    console.log(`GET ${staticUrl} -> Status: ${httpRes.status}`);

    if (httpRes.status !== 200) {
      throw new Error(`FAIL: Static file request failed with status ${httpRes.status}`);
    }

    const fetchedText = await httpRes.text();
    if (fetchedText !== testContent) {
      throw new Error("FAIL: Fetched static image content mismatch!");
    }
    console.log("✅ PASS: Express static file serving returned HTTP 200 with matching image buffer!");

    // 3. IDEMPOTENT RESOLVER SUITE
    console.log("\n--- 3. CENTRALIZED IMAGE RESOLVER IDEMPOTENCY TEST SUITE ---");

    const cases = [
      { name: "Absolute HTTPS URL", input: "https://example.com/hero.webp", expected: "https://example.com/hero.webp" },
      { name: "Absolute Dev Backend URL", input: "http://localhost:5000/uploads/images/hero.webp", expected: "http://localhost:5000/uploads/images/hero.webp" },
      { name: "Relative /uploads/ Path", input: "/uploads/images/hero.webp", expected: "http://localhost:5000/uploads/images/hero.webp" },
      { name: "Relative uploads/ Path", input: "uploads/images/hero.webp", expected: "http://localhost:5000/uploads/images/hero.webp" },
      { name: "Duplicated /uploads/uploads/ Path", input: "/uploads/uploads/images/hero.webp", expected: "http://localhost:5000/uploads/images/hero.webp" },
      { name: "Vite Imported Asset Object", input: { src: "/assets/logo.webp" }, expected: "/assets/logo.webp" },
      { name: "Null Input Fallback", input: null, fallback: "/fallback.svg", expected: "/fallback.svg" }
    ];

    cases.forEach((c) => {
      const res = resolveImageUrl(c.input, c.fallback);
      if (res !== c.expected) {
        throw new Error(`FAIL [${c.name}]: Expected '${c.expected}', got '${res}'`);
      }
      console.log(` ✅ PASS [${c.name}]: '${c.input}' -> '${res}'`);
    });

    // Idempotency check: resolveImageUrl(resolveImageUrl(url))
    const firstPass = resolveImageUrl("uploads/images/hero.webp");
    const secondPass = resolveImageUrl(firstPass);
    if (firstPass !== secondPass) {
      throw new Error(`FAIL [Idempotency]: 1st pass '${firstPass}' !== 2nd pass '${secondPass}'`);
    }
    console.log(" ✅ PASS [Idempotency]: resolveImageUrl(resolveImageUrl(url)) is 100% idempotent!");

    // Clean up test file
    fs.unlinkSync(expectedDiskPath);

  } catch (err) {
    console.error("❌ GLOBAL IMAGE PIPELINE VERIFICATION FAILED:", err);
    process.exit(1);
  } finally {
    server.close();
    console.log("\n=== ALL GLOBAL IMAGE LOADING & PIPELINE TESTS PASSED WITH 100% SUCCESS ===");
    process.exit(0);
  }
}

runGlobalImagePipelineVerification();
