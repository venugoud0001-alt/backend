/**
 * Centralized Canonical Pricing & Coupon Engine for InternNetra NLS
 * 
 * CORE PRINCIPLE:
 * The course's configured pricing is the CANONICAL PRICE.
 * Coupons are a separate discount calculation layer.
 * Coupons MUST NEVER corrupt, overwrite, recalculate, or mutate the original course pricing or database installment records.
 * 
 * FINANCIAL ARITHMETIC:
 * All monetary calculations use integer paise internally (1 INR = 100 paise)
 * to avoid floating-point rounding errors.
 */

/**
 * Convert INR amount (number or string) to integer paise
 */
function toPaise(amount) {
  const num = Number(amount) || 0;
  return Math.round(num * 100);
}

/**
 * Convert integer paise back to INR display amount (rounded to 2 decimals)
 */
function toINR(paise) {
  const num = Math.round(paise) / 100;
  // Return integer if whole number for clean display, otherwise 2 decimal places
  return Number.isInteger(num) ? num : Number(num.toFixed(2));
}

/**
 * Calculate canonical pricing and coupon discounts
 * 
 * @param {Object} params
 * @param {Object} params.course - Canonical course object from DB
 * @param {Object} [params.pricingPlan] - Active pricing plan (optional)
 * @param {Array} [params.installments] - Active installment phases array (optional)
 * @param {Object} [params.coupon] - Validated coupon object (optional)
 * @param {string} [params.paymentMode='FULL'] - Selected payment mode ('FULL' | 'INSTALLMENT')
 * @returns {Object} Canonical pricing breakdown and snapshot
 */
function calculateDiscountedPricing({
  course,
  pricingPlan = null,
  installments = [],
  coupon = null,
  paymentMode = 'FULL'
}) {
  if (!course) {
    throw new Error('Canonical course object is required for pricing calculation.');
  }

  // 1. Determine canonical total course price (in paise)
  let rawTotal = 0;
  if (pricingPlan && pricingPlan.total_amount !== undefined && pricingPlan.total_amount !== null) {
    rawTotal = Number(pricingPlan.total_amount);
  } else if (course.price !== undefined && course.price !== null) {
    rawTotal = Number(course.price);
  } else {
    rawTotal = 15000; // Fallback default
  }

  const originalTotalPaise = Math.max(0, toPaise(rawTotal));

  // 2. Prepare original installment schedule (in paise)
  let origInstallmentPhases = [];
  if (Array.isArray(installments) && installments.length > 0) {
    origInstallmentPhases = installments.map((inst, index) => ({
      phaseNumber: inst.installment_number || inst.phaseNumber || index + 1,
      amountPaise: toPaise(inst.amount),
      title: inst.title || `Phase ${inst.installment_number || index + 1}`,
      dueAfterDays: inst.due_after_days || 30
    }));
  } else if (course.installment_price) {
    // Standard 2-phase fallback if no explicit installments table record
    const p1Paise = toPaise(course.installment_price);
    const p2Paise = Math.max(0, originalTotalPaise - p1Paise);
    origInstallmentPhases = [
      { phaseNumber: 1, amountPaise: p1Paise, title: 'Phase 1 (Token)', dueAfterDays: 0 },
      { phaseNumber: 2, amountPaise: p2Paise, title: 'Phase 2 (Balance)', dueAfterDays: 30 }
    ];
  } else {
    // Default 40% / 60% split if installment mode selected without custom plan
    const p1Paise = Math.round(originalTotalPaise * 0.4);
    const p2Paise = originalTotalPaise - p1Paise;
    origInstallmentPhases = [
      { phaseNumber: 1, amountPaise: p1Paise, title: 'Phase 1', dueAfterDays: 0 },
      { phaseNumber: 2, amountPaise: p2Paise, title: 'Phase 2', dueAfterDays: 30 }
    ];
  }

  // Reconcile original installments sum to equal originalTotalPaise
  const origInstallmentsSumPaise = origInstallmentPhases.reduce((sum, p) => sum + p.amountPaise, 0);
  if (origInstallmentsSumPaise !== originalTotalPaise && origInstallmentPhases.length > 0) {
    const diff = originalTotalPaise - origInstallmentsSumPaise;
    origInstallmentPhases[origInstallmentPhases.length - 1].amountPaise += diff;
  }

  // 3. Calculate Coupon Discount (in paise)
  let discountPaise = 0;
  let discountType = null;
  let discountValue = 0;

  if (coupon && coupon.status === 'ACTIVE') {
    discountType = (coupon.discount_type || coupon.discountType || 'PERCENTAGE').toUpperCase();
    discountValue = Number(coupon.discount_value !== undefined ? coupon.discount_value : (coupon.discountValue || 0));

    if (discountType === 'PERCENTAGE') {
      const pct = Math.min(100, Math.max(0, discountValue));
      discountPaise = Math.round((originalTotalPaise * pct) / 100);
    } else if (discountType === 'FIXED_AMOUNT') {
      const fixedPaise = Math.max(0, toPaise(discountValue));
      discountPaise = Math.min(fixedPaise, originalTotalPaise); // Business Rule: Never exceed total course price
    }

    // Optional maximum discount cap check
    if (coupon.maximum_discount_amount || coupon.maximumDiscountAmount) {
      const maxCapPaise = toPaise(coupon.maximum_discount_amount || coupon.maximumDiscountAmount);
      if (maxCapPaise > 0) {
        discountPaise = Math.min(discountPaise, maxCapPaise);
      }
    }
  }

  // 4. Calculate final discounted total (never negative)
  const discountedTotalPaise = Math.max(0, originalTotalPaise - discountPaise);
  const actualDiscountAmountPaise = originalTotalPaise - discountedTotalPaise;

  // 5. Distribute discounted total across installments proportionally
  let discountedInstallmentPhases = [];

  if (origInstallmentPhases.length > 0 && originalTotalPaise > 0) {
    let accumulatedDiscountedPaise = 0;

    discountedInstallmentPhases = origInstallmentPhases.map((orig, index) => {
      // Calculate original proportion: ratio = origAmount / originalTotal
      const ratio = orig.amountPaise / originalTotalPaise;
      
      let phaseDiscountedPaise = Math.round(discountedTotalPaise * ratio);

      // On the LAST phase, apply remainder reconciliation to guarantee SUM === discountedTotal
      if (index === origInstallmentPhases.length - 1) {
        phaseDiscountedPaise = discountedTotalPaise - accumulatedDiscountedPaise;
      } else {
        accumulatedDiscountedPaise += phaseDiscountedPaise;
      }

      return {
        phaseNumber: orig.phaseNumber,
        originalAmount: toINR(orig.amountPaise),
        amount: toINR(phaseDiscountedPaise),
        discountedAmount: toINR(phaseDiscountedPaise),
        title: orig.title,
        dueAfterDays: orig.dueAfterDays
      };
    });
  }

  // Final Invariant Validation: SUM(discounted installments) === discountedTotal
  if (paymentMode === 'INSTALLMENT' && discountedInstallmentPhases.length > 0) {
    const sumPaise = discountedInstallmentPhases.reduce((s, p) => s + toPaise(p.amount), 0);
    if (sumPaise !== discountedTotalPaise) {
      const diffPaise = discountedTotalPaise - sumPaise;
      const lastIdx = discountedInstallmentPhases.length - 1;
      const updatedLastPaise = toPaise(discountedInstallmentPhases[lastIdx].amount) + diffPaise;
      discountedInstallmentPhases[lastIdx].amount = toINR(updatedLastPaise);
      discountedInstallmentPhases[lastIdx].discountedAmount = toINR(updatedLastPaise);
    }
  }

  const finalPaymentMode = (paymentMode || 'FULL').toUpperCase();

  return {
    originalTotal: toINR(originalTotalPaise),
    originalTotalPaise,
    discountType,
    discountValue,
    discountAmount: toINR(actualDiscountAmountPaise),
    discountAmountPaise: actualDiscountAmountPaise,
    discountedTotal: toINR(discountedTotalPaise),
    discountedTotalPaise,
    paymentMode: finalPaymentMode,
    couponCode: coupon?.code ? String(coupon.code).trim().toUpperCase() : null,
    couponId: coupon?.id || null,
    originalInstallments: origInstallmentPhases.map(p => ({
      phaseNumber: p.phaseNumber,
      amount: toINR(p.amountPaise),
      title: p.title,
      dueAfterDays: p.dueAfterDays
    })),
    discountedInstallments: discountedInstallmentPhases,
    currency: 'INR'
  };
}

module.exports = {
  toPaise,
  toINR,
  calculateDiscountedPricing
};
