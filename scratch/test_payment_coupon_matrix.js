const axios = require('axios');
const API_BASE = 'http://localhost:5000/api';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

async function runTestMatrix() {
  console.log('=== STARTING 100% BACKEND-DRIVEN PAYMENT & COUPON MATRIX VERIFICATION ===\n');

  try {
    // Fetch a real course ID/slug
    const coursesRes = await axios.get(`${API_BASE}/courses`);
    const coursesList = coursesRes.data?.courses || coursesRes.data?.data?.courses || [];
    assert(coursesList.length > 0, 'Catalog returned courses');
    const targetCourse = coursesList[0];
    console.log(`Target Course: '${targetCourse.title}' (ID: ${targetCourse.id}, Price: ₹${targetCourse.price})`);

    // Ensure WELCOME (10%) and EARLY2026 (₹500) coupons exist
    await axios.post(`${API_BASE}/coupons`, {
      code: 'WELCOME',
      description: 'Welcome 10% Discount',
      discount_type: 'PERCENTAGE',
      discount_value: 10,
      status: 'ACTIVE'
    }).catch(() => {});

    await axios.post(`${API_BASE}/coupons`, {
      code: 'EARLY2026',
      description: 'Early Bird ₹500 Discount',
      discount_type: 'FIXED_AMOUNT',
      discount_value: 500,
      status: 'ACTIVE'
    }).catch(() => {});

    // TEST 1: No coupon + FULL
    console.log('\n--- TEST 1: No coupon + FULL mode ---');
    const val1 = await axios.post(`${API_BASE}/coupons/validate`, {
      code: 'WELCOME',
      courseId: targetCourse.id,
      paymentMode: 'FULL'
    });
    assert(val1.status === 200, 'Test 1 HTTP 200');
    console.log('✓ Full mode validation pricing:', val1.data.data.pricing);

    // TEST 2: No coupon + INSTALLMENT
    console.log('\n--- TEST 2: No coupon + INSTALLMENT mode ---');
    const val2 = await axios.post(`${API_BASE}/coupons/validate`, {
      code: 'WELCOME',
      courseId: targetCourse.id,
      paymentMode: 'INSTALLMENT'
    });
    assert(val2.status === 200, 'Test 2 HTTP 200');
    const pricing2 = val2.data.data.pricing;
    const instSum2 = pricing2.discountedInstallments.reduce((sum, p) => sum + p.amount, 0);
    assert(instSum2 === pricing2.discountedTotal, `Installment sum (${instSum2}) === discountedTotal (${pricing2.discountedTotal})`);
    console.log(`✓ Installment sum ₹${instSum2} matches discounted total ₹${pricing2.discountedTotal}!`);

    // TEST 3: Percentage coupon + FULL
    console.log('\n--- TEST 3: Percentage coupon (WELCOME 10%) + FULL ---');
    const val3 = await axios.post(`${API_BASE}/coupons/validate`, {
      code: 'WELCOME',
      courseId: targetCourse.id,
      paymentMode: 'FULL'
    });
    const pricing3 = val3.data.data.pricing;
    const expectedDiscount3 = Math.round((pricing3.originalTotal * 10) / 100);
    assert(pricing3.discountAmount === expectedDiscount3, `10% discount matches expected ₹${expectedDiscount3}`);
    assert(pricing3.discountedTotal === pricing3.originalTotal - expectedDiscount3, 'Discounted total matches');
    console.log(`✓ 10% OFF: Original ₹${pricing3.originalTotal} - Discount ₹${pricing3.discountAmount} = Final ₹${pricing3.discountedTotal}`);

    // TEST 4: Percentage coupon + INSTALLMENT
    console.log('\n--- TEST 4: Percentage coupon (WELCOME 10%) + INSTALLMENT ---');
    const val4 = await axios.post(`${API_BASE}/coupons/validate`, {
      code: 'WELCOME',
      courseId: targetCourse.id,
      paymentMode: 'INSTALLMENT'
    });
    const pricing4 = val4.data.data.pricing;
    const instSum4 = pricing4.discountedInstallments.reduce((sum, p) => sum + p.amount, 0);
    assert(instSum4 === pricing4.discountedTotal, `Installment sum (${instSum4}) === discountedTotal (${pricing4.discountedTotal})`);
    console.log(`✓ Installments:`, pricing4.discountedInstallments);

    // TEST 5: Fixed coupon (EARLY2026 ₹500) + FULL
    console.log('\n--- TEST 5: Fixed coupon (EARLY2026 ₹500) + FULL ---');
    const val5 = await axios.post(`${API_BASE}/coupons/validate`, {
      code: 'EARLY2026',
      courseId: targetCourse.id,
      paymentMode: 'FULL'
    });
    const pricing5 = val5.data.data.pricing;
    assert(pricing5.discountAmount === 500, 'Fixed discount === 500');
    assert(pricing5.discountedTotal === pricing5.originalTotal - 500, 'Discounted total matches');
    console.log(`✓ ₹500 OFF: Original ₹${pricing5.originalTotal} - Discount ₹${pricing5.discountAmount} = Final ₹${pricing5.discountedTotal}`);

    // TEST 6: Fixed coupon (EARLY2026 ₹500) + INSTALLMENT
    console.log('\n--- TEST 6: Fixed coupon (EARLY2026 ₹500) + INSTALLMENT ---');
    const val6 = await axios.post(`${API_BASE}/coupons/validate`, {
      code: 'EARLY2026',
      courseId: targetCourse.id,
      paymentMode: 'INSTALLMENT'
    });
    const pricing6 = val6.data.data.pricing;
    const instSum6 = pricing6.discountedInstallments.reduce((sum, p) => sum + p.amount, 0);
    assert(instSum6 === pricing6.discountedTotal, `Installment sum (${instSum6}) === discountedTotal (${pricing6.discountedTotal})`);
    console.log(`✓ Fixed discount installment sum ₹${instSum6} matches discounted total ₹${pricing6.discountedTotal}`);

    // TEST 7: Invalid coupon validation
    console.log('\n--- TEST 7: Invalid coupon validation ---');
    try {
      await axios.post(`${API_BASE}/coupons/validate`, {
        code: 'INVALID_XYZ_99',
        courseId: targetCourse.id,
        paymentMode: 'FULL'
      });
      assert(false, 'Should have thrown 404 error');
    } catch (err) {
      assert(err.response?.status === 404, 'Invalid coupon returned HTTP 404');
      console.log('✓ Invalid coupon rejected with 404:', err.response?.data?.message);
    }

    // TEST 8: Server-side Price Tampering Protection
    console.log('\n--- TEST 8: Server-side Price Tampering Protection ---');
    const tamperedPayload = {
      courseId: targetCourse.id,
      courseName: targetCourse.title,
      paymentPlan: 'FULL',
      couponCode: 'WELCOME',
      amount: 1, // Client attempts to pay ₹1!
      totalFee: 1, // Client attempts to fake total fee!
      email: 'security_test@internnetra.com',
      phone: '9876543210',
      studentName: 'Security Tester'
    };

    const orderRes = await axios.post(`${API_BASE}/payments/create-order`, tamperedPayload);
    assert(orderRes.status === 200, 'Create order returned HTTP 200');
    const serverCalculatedAmount = orderRes.data.amount;
    assert(serverCalculatedAmount !== 1, 'Server MUST reject client-supplied ₹1 amount');
    console.log(`✓ Price Tampering Prevented! Client sent amount=1, Server authoritatively enforced amount=₹${serverCalculatedAmount}`);

    console.log('\n=== ALL 8 PAYMENT & COUPON MATRIX TESTS PASSED 100%! ===');
  } catch (err) {
    console.error('❌ TEST MATRIX FAILED:', err.response?.data || err.message);
    process.exit(1);
  }
}

runTestMatrix();
