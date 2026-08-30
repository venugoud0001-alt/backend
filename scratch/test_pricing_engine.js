const { calculateDiscountedPricing, toPaise, toINR } = require('../src/utils/pricingEngine');

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

console.log('=== RUNNING PRICING ENGINE UNIT TESTS ===\n');

// TEST 1: ₹15,000, No coupon, FULL
const t1 = calculateDiscountedPricing({
  course: { id: 'c1', title: 'Course 1', price: 15000 }
});
console.log('TEST 1 (No Coupon FULL):', t1.discountedTotal);
assert(t1.originalTotal === 15000, 'T1 originalTotal === 15000');
assert(t1.discountedTotal === 15000, 'T1 discountedTotal === 15000');
assert(t1.discountAmount === 0, 'T1 discountAmount === 0');
console.log('✓ TEST 1 PASSED');

// TEST 2: ₹15,000, 10% coupon, FULL
const t2 = calculateDiscountedPricing({
  course: { id: 'c1', title: 'Course 1', price: 15000 },
  coupon: { status: 'ACTIVE', discount_type: 'PERCENTAGE', discount_value: 10, code: 'WELCOME10' }
});
console.log('TEST 2 (10% Coupon FULL):', t2.discountedTotal);
assert(t2.originalTotal === 15000, 'T2 originalTotal === 15000');
assert(t2.discountAmount === 1500, 'T2 discountAmount === 1500');
assert(t2.discountedTotal === 13500, 'T2 discountedTotal === 13500');
console.log('✓ TEST 2 PASSED');

// TEST 3: ₹15,000, ₹2,000 fixed coupon, FULL
const t3 = calculateDiscountedPricing({
  course: { id: 'c1', title: 'Course 1', price: 15000 },
  coupon: { status: 'ACTIVE', discount_type: 'FIXED_AMOUNT', discount_value: 2000, code: 'FLAT2000' }
});
console.log('TEST 3 (₹2,000 Fixed Coupon FULL):', t3.discountedTotal);
assert(t3.discountAmount === 2000, 'T3 discountAmount === 2000');
assert(t3.discountedTotal === 13000, 'T3 discountedTotal === 13000');
console.log('✓ TEST 3 PASSED');

// TEST 4: ₹15,000 (P1 ₹6,000, P2 ₹9,000), 10% coupon, INSTALLMENT
const t4 = calculateDiscountedPricing({
  course: { id: 'c1', title: 'Course 1', price: 15000, installment_price: 6000 },
  installments: [
    { installment_number: 1, amount: 6000 },
    { installment_number: 2, amount: 9000 }
  ],
  coupon: { status: 'ACTIVE', discount_type: 'PERCENTAGE', discount_value: 10, code: 'WELCOME10' },
  paymentMode: 'INSTALLMENT'
});
console.log('TEST 4 (10% Installments):', t4.discountedInstallments);
assert(t4.discountedTotal === 13500, 'T4 discountedTotal === 13500');
assert(t4.discountedInstallments[0].amount === 5400, 'T4 P1 === 5400');
assert(t4.discountedInstallments[1].amount === 8100, 'T4 P2 === 8100');
assert(t4.discountedInstallments[0].amount + t4.discountedInstallments[1].amount === 13500, 'T4 sum === 13500');
console.log('✓ TEST 4 PASSED');

// TEST 5: ₹15,000 (P1 ₹6,000, P2 ₹9,000), ₹2,000 fixed coupon, INSTALLMENT
const t5 = calculateDiscountedPricing({
  course: { id: 'c1', title: 'Course 1', price: 15000 },
  installments: [
    { installment_number: 1, amount: 6000 },
    { installment_number: 2, amount: 9000 }
  ],
  coupon: { status: 'ACTIVE', discount_type: 'FIXED_AMOUNT', discount_value: 2000, code: 'FLAT2000' },
  paymentMode: 'INSTALLMENT'
});
console.log('TEST 5 (₹2,000 Fixed Installments):', t5.discountedInstallments);
assert(t5.discountedTotal === 13000, 'T5 discountedTotal === 13000');
assert(t5.discountedInstallments[0].amount === 5200, 'T5 P1 === 5200');
assert(t5.discountedInstallments[1].amount === 7800, 'T5 P2 === 7800');
assert(t5.discountedInstallments[0].amount + t5.discountedInstallments[1].amount === 13000, 'T5 sum === 13000');
console.log('✓ TEST 5 PASSED');

// TEST 6: ₹10,000, 3 installments (₹3,333, ₹3,333, ₹3,334), ₹3,000 fixed coupon
const t6 = calculateDiscountedPricing({
  course: { id: 'c1', title: 'Course 1', price: 10000 },
  installments: [
    { installment_number: 1, amount: 3333 },
    { installment_number: 2, amount: 3333 },
    { installment_number: 3, amount: 3334 }
  ],
  coupon: { status: 'ACTIVE', discount_type: 'FIXED_AMOUNT', discount_value: 3000, code: 'FLAT3000' },
  paymentMode: 'INSTALLMENT'
});
console.log('TEST 6 (3 Installments Rounding Check):', t6.discountedInstallments);
const t6Sum = t6.discountedInstallments.reduce((s, p) => s + p.amount, 0);
assert(t6.discountedTotal === 7000, 'T6 discountedTotal === 7000');
assert(t6Sum === 7000, `T6 SUM(installments) === 7000 (got ${t6Sum})`);
console.log('✓ TEST 6 PASSED (Rounding Reconciliation Verified)');

// TEST 7: ₹10,000 course, ₹20,000 coupon (Exceeds Total)
const t7 = calculateDiscountedPricing({
  course: { id: 'c1', title: 'Course 1', price: 10000 },
  coupon: { status: 'ACTIVE', discount_type: 'FIXED_AMOUNT', discount_value: 20000, code: 'HUGE20K' }
});
console.log('TEST 7 (Coupon Exceeds Total):', t7.discountedTotal);
assert(t7.discountedTotal === 0, 'T7 discountedTotal === 0 (Never negative)');
assert(t7.discountAmount === 10000, 'T7 discountAmount === 10000');
console.log('✓ TEST 7 PASSED (No Negative Total)');

console.log('\n=== ALL PRICING ENGINE UNIT TESTS PASSED 100%! ===');
