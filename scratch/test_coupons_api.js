const axios = require('axios');
const { supabase } = require('../src/config/supabase');

const API_BASE = 'http://localhost:5000/api';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function runCouponLifecycleVerification() {
  console.log('=== STARTING MANDATORY STEP-BY-STEP COUPON LIFECYCLE VERIFICATION ===\n');

  try {
    // 0. Cleanup WELCOME if pre-existing for deterministic test
    console.log('--- 0. Pre-Test Cleanup ---');
    try {
      const getExisting = await axios.get(`${API_BASE}/coupons`);
      const existingList = getExisting.data?.data?.coupons || getExisting.data?.coupons || [];
      const match = existingList.find(c => c.code === 'WELCOME');
      if (match) {
        await axios.delete(`${API_BASE}/coupons/${match.id}`);
        console.log(`✓ Cleaned pre-existing WELCOME coupon (ID: ${match.id}) via DELETE API.`);
      }
    } catch (e) {
      console.log('No pre-existing WELCOME coupon found to clean.');
    }

    // 1. POST /api/coupons (Create WELCOME)
    console.log('\n--- 1. Testing POST /api/coupons (Create WELCOME) ---');
    const createPayload = {
      code: 'WELCOME',
      description: 'Welcome test coupon',
      discount_type: 'PERCENTAGE',
      discount_value: 10,
      applicability: 'GLOBAL',
      status: 'ACTIVE'
    };

    const createRes = await axios.post(`${API_BASE}/coupons`, createPayload);
    assert(createRes.status === 201 || createRes.status === 200, 'POST /api/coupons returned HTTP 201/200');
    const createdCoupon = createRes.data?.data?.coupon || createRes.data?.coupon;
    assert(createdCoupon && createdCoupon.code === 'WELCOME', "Created coupon code === 'WELCOME'");
    console.log(`✓ POST /api/coupons response success! Created Coupon:`, createdCoupon);

    // 2. VERIFY DATABASE PERSISTENCE DIRECTLY
    console.log('\n--- 2. Checking Database Persistence Directly ---');
    const dbCheck = await supabase.from('coupons').select('*').eq('code', 'WELCOME').maybeSingle();
    assert(dbCheck.error === null, 'Supabase query error === null');
    assert(dbCheck.data !== null, "Database record for 'WELCOME' MUST exist");
    console.log('✓ Database Row Verified in Supabase:', dbCheck.data);

    // 3. GET /api/coupons (Call List API after creation)
    console.log('\n--- 3. Testing GET /api/coupons ---');
    const getRes = await axios.get(`${API_BASE}/coupons`);
    assert(getRes.status === 200, 'GET /api/coupons returned HTTP 200');
    const catalog = getRes.data?.data?.coupons || getRes.data?.coupons || [];
    console.log(`✓ GET /api/coupons returned ${catalog.length} coupons.`);
    
    const foundWelcome = catalog.find(c => c.code === 'WELCOME');
    assert(foundWelcome !== undefined, "WELCOME coupon MUST be present in GET list response!");
    console.log('✓ WELCOME Coupon found in GET response list:', foundWelcome);

    // 4. VALIDATE COUPON FOR CHECKOUT
    console.log('\n--- 4. Testing POST /api/coupons/validate with WELCOME ---');
    const coursesRes = await axios.get(`${API_BASE}/courses`);
    const coursesList = coursesRes.data?.courses || coursesRes.data?.data?.courses || [];
    const testCourseId = coursesList[0]?.id || '00000000-0000-0000-0000-000000000001';

    const valRes = await axios.post(`${API_BASE}/coupons/validate`, {
      code: 'WELCOME',
      courseId: testCourseId,
      paymentMode: 'FULL'
    });
    assert(valRes.status === 200, 'Validate returned HTTP 200');
    const valData = valRes.data?.data || valRes.data;
    assert(valData.valid === true, 'valData.valid === true');
    console.log('✓ Validation successful! Breakdown:', valData.pricing);

    // 5. TEST MULTIPLE COUPONS (EARLYBIRD, SAVE20)
    console.log('\n--- 5. Testing Multiple Coupon Creation & List Consistency ---');
    await axios.post(`${API_BASE}/coupons`, {
      code: 'EARLYBIRD',
      description: 'Early Bird ₹500 Instant Discount',
      discount_type: 'FIXED_AMOUNT',
      discount_value: 500,
      status: 'ACTIVE'
    });

    await axios.post(`${API_BASE}/coupons`, {
      code: 'SAVE20',
      description: 'Save 20% Off Coupon',
      discount_type: 'PERCENTAGE',
      discount_value: 20,
      status: 'ACTIVE'
    });

    const getMultiRes = await axios.get(`${API_BASE}/coupons`);
    const multiCatalog = getMultiRes.data?.data?.coupons || getMultiRes.data?.coupons || [];
    const codes = multiCatalog.map(c => c.code);
    console.log('✓ Catalog contains coupon codes:', codes);
    assert(codes.includes('WELCOME'), "Catalog contains WELCOME");
    assert(codes.includes('EARLYBIRD'), "Catalog contains EARLYBIRD");
    assert(codes.includes('SAVE20'), "Catalog contains SAVE20");

    console.log('\n=== ALL PHASE 8 COUPON LIFECYCLE TESTS PASSED 100%! ===');
  } catch (err) {
    console.error('❌ E2E LIFECYCLE TEST FAILED:', err.response?.data || err.message);
    process.exit(1);
  }
}

runCouponLifecycleVerification();
