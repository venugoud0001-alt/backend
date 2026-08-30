const { resolveImageUrl, isStaticAsset } = require('../../src/utils/imageUtils');

async function testTwoImageSystems() {
  console.log("=== TESTING TWO-SYSTEM IMAGE RESOLVER ARCHITECTURE ===\n");

  const testCases = [
    // --- SYSTEM 1: STATIC FRONTEND IMAGES (public/ & local assets) ---
    { input: "/images/logo.webp", isStatic: true, expected: "/images/logo.webp" },
    { input: "images/herobg.webp", isStatic: true, expected: "/images/herobg.webp" },
    { input: "/images/home page hero.webp", isStatic: true, expected: "/images/home page hero.webp" },
    { input: "/fallback-image.svg", isStatic: true, expected: "/fallback-image.svg" },
    { input: "/assets/logo.png", isStatic: true, expected: "/assets/logo.png" },

    // --- SYSTEM 2: DYNAMIC ADMIN-UPLOADED IMAGES (backend port 5000) ---
    { input: "/uploads/images/course_123.webp", isStatic: false, expected: "http://localhost:5000/uploads/images/course_123.webp" },
    { input: "uploads/images/course_123.webp", isStatic: false, expected: "http://localhost:5000/uploads/images/course_123.webp" },
    { input: "/uploads/uploads/images/course_123.webp", isStatic: false, expected: "http://localhost:5000/uploads/images/course_123.webp" },
    { input: "http://localhost:5000/uploads/images/course_123.webp", isStatic: false, expected: "http://localhost:5000/uploads/images/course_123.webp" },
    { input: "https://supabase.co/storage/v1/object/public/course.webp", isStatic: false, expected: "https://supabase.co/storage/v1/object/public/course.webp" },

    // --- FALLBACK HANDLING ---
    { input: null, fallback: "/fallback-image.svg", isStatic: true, expected: "/fallback-image.svg" },
    { input: "null", fallback: "/fallback-image.svg", isStatic: true, expected: "/fallback-image.svg" }
  ];

  let passed = 0;
  testCases.forEach((c, idx) => {
    const result = resolveImageUrl(c.input, c.fallback);
    const staticCheck = isStaticAsset(result);

    const passStatic = staticCheck === c.isStatic;
    const passResult = result === c.expected;

    if (passStatic && passResult) {
      console.log(`✅ TEST ${idx + 1} PASS [${c.input}]: resolved -> '${result}'`);
      passed++;
    } else {
      console.error(`❌ TEST ${idx + 1} FAIL [${c.input}]: expected '${c.expected}', got '${result}' (isStatic expected ${c.isStatic}, got ${staticCheck})`);
    }
  });

  // Test Idempotency
  const doubleCall = resolveImageUrl(resolveImageUrl("/uploads/images/course_123.webp"));
  if (doubleCall === "http://localhost:5000/uploads/images/course_123.webp") {
    console.log("✅ IDEMPOTENCY PASS: resolveImageUrl(resolveImageUrl(url)) produced identical URL");
    passed++;
  } else {
    console.error("❌ IDEMPOTENCY FAIL:", doubleCall);
  }

  console.log(`\n=== VERIFICATION COMPLETE: ${passed} / ${testCases.length + 1} PASSED ===`);
  process.exit(passed === testCases.length + 1 ? 0 : 1);
}

testTwoImageSystems();
