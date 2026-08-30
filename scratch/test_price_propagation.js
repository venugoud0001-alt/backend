const axios = require('axios');
const API_BASE = 'http://localhost:5000/api';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function verifyCoursePricing(courseId, expectedFull, expectedInstTotal, expectedPhase1, expectedPhase2) {
  console.log(`\n--- VERIFYING PRICING FOR COURSE ID: ${courseId} ---`);
  
  // 1. Fetch Course details
  const courseRes = await axios.get(`${API_BASE}/courses/${courseId}`);
  assert(courseRes.status === 200, 'Course details API returned 200');
  const courseObj = courseRes.data?.data?.course || courseRes.data?.course || courseRes.data;
  console.log(`✓ Course Loaded: '${courseObj.title}' (ID: ${courseObj.id})`);

  // 2. Fetch Pricing Plans
  const pricingRes = await axios.get(`${API_BASE}/courses/${courseId}/pricing`);
  assert(pricingRes.status === 200, 'Course pricing API returned 200');
  const plans = pricingRes.data?.pricingPlans || pricingRes.data?.data?.pricingPlans || [];
  assert(plans.length >= 2, 'Course has both FULL and INSTALLMENT pricing plans');

  const fullPlan = plans.find(p => p.paymentMode === 'FULL');
  const instPlan = plans.find(p => p.paymentMode === 'INSTALLMENT');

  assert(fullPlan, 'FULL payment plan exists');
  assert(instPlan, 'INSTALLMENT payment plan exists');
  assert(fullPlan.totalAmount === expectedFull, `FULL payment totalAmount is ₹${expectedFull} (got ${fullPlan.totalAmount})`);
  assert(instPlan.totalAmount === expectedInstTotal, `INSTALLMENT payment totalAmount is ₹${expectedInstTotal} (got ${instPlan.totalAmount})`);
  assert(instPlan.phases[0].amount === expectedPhase1, `Installment phase 1 is ₹${expectedPhase1} (got ${instPlan.phases[0].amount})`);
  assert(instPlan.phases[1].amount === expectedPhase2, `Installment phase 2 is ₹${expectedPhase2} (got ${instPlan.phases[1].amount})`);

  console.log(`✓ FULL Plan: ₹${fullPlan.totalAmount}`);
  console.log(`✓ INSTALLMENT Plan: ₹${instPlan.totalAmount} (Pay Today: ₹${instPlan.phases[0].amount}, Phase 2: ₹${instPlan.phases[1].amount})`);

  // 3. Test Order Creation for FULL mode
  const fullOrderRes = await axios.post(`${API_BASE}/payments/create-order`, {
    courseId,
    paymentPlan: 'FULL',
    studentName: 'Price Prop Test Student',
    email: 'price_test@internnetra.com',
    phone: '9876543210'
  });
  assert(fullOrderRes.status === 200, 'FULL Order creation HTTP 200');
  assert(fullOrderRes.data.amount === expectedFull, `FULL order amount is ₹${expectedFull} (got ${fullOrderRes.data.amount})`);
  console.log(`✓ Cashfree FULL Order Amount: ₹${fullOrderRes.data.amount}`);

  // 4. Test Order Creation for INSTALLMENT mode
  const instOrderRes = await axios.post(`${API_BASE}/payments/create-order`, {
    courseId,
    paymentPlan: 'INSTALLMENT',
    studentName: 'Price Prop Test Student',
    email: 'price_test@internnetra.com',
    phone: '9876543210'
  });
  assert(instOrderRes.status === 200, 'INSTALLMENT Order creation HTTP 200');
  assert(instOrderRes.data.amount === expectedPhase1, `INSTALLMENT order 1st phase amount is ₹${expectedPhase1} (got ${instOrderRes.data.amount})`);
  console.log(`✓ Cashfree INSTALLMENT Order 1st Phase Amount: ₹${instOrderRes.data.amount}`);
}

async function runPricePropagationVerification() {
  console.log('=== STARTING COMPLETE PRICE PROPAGATION VERIFICATION SUITE ===');

  try {
    // Audit Test 1: AI + Machine Learning (af753d70-d782-49a6-9c0b-0db0db54733a)
    await verifyCoursePricing('af753d70-d782-49a6-9c0b-0db0db54733a', 10000, 10000, 2000, 8000);

    // Audit Test 2: price course (9577facc-ed47-4f09-842b-9b4132e3c974)
    await verifyCoursePricing('9577facc-ed47-4f09-842b-9b4132e3c974', 15000, 15000, 6000, 9000);

    console.log('\n=== ALL PRICE PROPAGATION VERIFICATION TESTS PASSED 100%! ===');
  } catch (err) {
    console.error('❌ VERIFICATION SUITE FAILED:', err.response?.data || err.message);
    process.exit(1);
  }
}

runPricePropagationVerification();
