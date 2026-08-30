const { PAYMENT_MODES, PLAN_STATUSES, DEFAULT_CURRENCY } = require("./pricing.constants");

/**
 * Normalizes monetary amounts safely to 2 decimal places
 */
const parseMonetaryAmount = (val) => {
  if (val === null || val === undefined || val === "") return NaN;
  const num = typeof val === "number" ? val : parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  if (isNaN(num) || !isFinite(num)) return NaN;
  return Math.round(num * 100) / 100;
};

/**
 * Validates pricing plan creation / update payload
 */
const validatePricingPlanPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    throw { statusCode: 400, message: "Pricing plan payload must be an object." };
  }

  const { course_id, courseId, name, payment_mode, paymentMode, total_amount, totalAmount, currency, phases } = payload;
  const targetCourseId = course_id || courseId;
  const targetName = name || "Standard Pricing Plan";
  const targetMode = String(payment_mode || paymentMode || "").toUpperCase();
  const targetAmount = parseMonetaryAmount(total_amount !== undefined ? total_amount : totalAmount);
  const targetCurrency = String(currency || DEFAULT_CURRENCY).toUpperCase();

  if (!targetCourseId) {
    throw { statusCode: 400, message: "course_id is required." };
  }

  if (!targetName.trim()) {
    throw { statusCode: 400, message: "Plan name is required." };
  }

  if (targetMode && [PAYMENT_MODES.FULL, PAYMENT_MODES.INSTALLMENT].includes(targetMode)) {
    if (isNaN(targetAmount) || targetAmount <= 0) {
      throw { statusCode: 400, message: "total_amount must be a valid positive number greater than zero." };
    }
    return {
      courseId: targetCourseId,
      name: targetName.trim(),
      paymentMode: targetMode,
      totalAmount: targetAmount,
      currency: targetCurrency,
      phases: Array.isArray(phases) ? phases : []
    };
  }

  // If payment_mode is omitted, perform unified course pricing validation
  return validateCoursePricingPayload(payload);
};

/**
 * Validates unified course pricing options (FULL only, INSTALLMENT only, or BOTH)
 */
const validateCoursePricingPayload = (payload) => {
  if (!payload || typeof payload !== "object") {
    throw { statusCode: 400, message: "Pricing payload must be an object." };
  }

  const {
    course_id, courseId,
    is_full_enabled, isFullEnabled, paymentOptions,
    is_installment_enabled, isInstallmentEnabled,
    full_payment_amount, fullPaymentAmount, fullTotalAmount, full_total_amount, full,
    installment_total_amount, installmentTotalAmount, installment,
    currency, phases
  } = payload;

  const targetCourseId = course_id || courseId;
  if (!targetCourseId) {
    throw { statusCode: 400, message: "course_id is required." };
  }

  let fullEnabled = is_full_enabled !== undefined ? Boolean(is_full_enabled) :
                    (isFullEnabled !== undefined ? Boolean(isFullEnabled) :
                    (paymentOptions?.full !== undefined ? Boolean(paymentOptions.full) : true));

  let instEnabled = is_installment_enabled !== undefined ? Boolean(is_installment_enabled) :
                    (isInstallmentEnabled !== undefined ? Boolean(isInstallmentEnabled) :
                    (paymentOptions?.installment !== undefined ? Boolean(paymentOptions.installment) : true));

  // Explicit overrides if amounts/phases provided
  const rawFullAmount = full_payment_amount !== undefined ? full_payment_amount :
                        (fullPaymentAmount !== undefined ? fullPaymentAmount :
                        (fullTotalAmount !== undefined ? fullTotalAmount :
                        (full_total_amount !== undefined ? full_total_amount :
                        (full?.totalAmount !== undefined ? full.totalAmount : payload.totalAmount || payload.total_amount))));

  const rawInstAmount = installment_total_amount !== undefined ? installment_total_amount :
                        (installmentTotalAmount !== undefined ? installmentTotalAmount :
                        (installment?.totalAmount !== undefined ? installment.totalAmount : rawFullAmount));

  const fullAmount = parseMonetaryAmount(rawFullAmount);
  const rawPhases = Array.isArray(phases) ? phases : (Array.isArray(installment?.phases) ? installment.phases : []);

  const modeUpper = String(payload.paymentMode || payload.payment_mode || "").toUpperCase();
  if (modeUpper === PAYMENT_MODES.FULL) {
    instEnabled = false;
    fullEnabled = true;
  } else if (modeUpper === PAYMENT_MODES.INSTALLMENT) {
    fullEnabled = false;
    instEnabled = true;
  }

  if (!fullEnabled && !instEnabled) {
    throw { statusCode: 400, message: "At least one payment option (Full Payment or Installment) must be enabled for the course." };
  }

  // 1. Full Payment Validation
  if (fullEnabled) {
    if (isNaN(fullAmount) || fullAmount <= 0) {
      throw { statusCode: 400, message: "Full payment amount must be a valid positive number greater than zero." };
    }
  }

  // 2. Installment Validation
  let validatedPhases = [];
  let instAmount = parseMonetaryAmount(rawInstAmount);

  if (instEnabled) {
    if (rawPhases.length > 0) {
      let phaseSum = 0;
      const seenPhaseNumbers = new Set();

      for (let i = 0; i < rawPhases.length; i++) {
        const phase = rawPhases[i];
        if (!phase || typeof phase !== "object") {
          throw { statusCode: 422, message: `Phase at index ${i} is invalid.` };
        }

        const phaseNum = Number(phase.phase_number || phase.phaseNumber || i + 1);
        const pAmt = parseMonetaryAmount(phase.amount);

        if (!Number.isInteger(phaseNum) || phaseNum <= 0) {
          throw { statusCode: 422, message: `Phase at index ${i} has an invalid phase_number (${phaseNum}).` };
        }
        if (seenPhaseNumbers.has(phaseNum)) {
          throw { statusCode: 422, message: `Duplicate phase_number (${phaseNum}) detected.` };
        }
        seenPhaseNumbers.add(phaseNum);

        if (isNaN(pAmt) || pAmt <= 0) {
          throw { statusCode: 422, message: `Phase ${phaseNum} amount must be a positive number greater than zero. Received: ${phase.amount}` };
        }

        phaseSum += pAmt;
        validatedPhases.push({
          phaseNumber: phaseNum,
          name: phase.name || `${phaseNum}${phaseNum === 1 ? "st" : phaseNum === 2 ? "nd" : phaseNum === 3 ? "rd" : "th"} Installment`,
          amount: pAmt
        });
      }

      phaseSum = Math.round(phaseSum * 100) / 100;
      if (isNaN(instAmount) || instAmount <= 0) {
        instAmount = phaseSum;
      }

      if (Math.abs(phaseSum - instAmount) > 0.01) {
        throw {
          statusCode: 422,
          message: `Sum of installment phase amounts (₹${phaseSum}) does not equal total installment fee (₹${instAmount}).`
        };
      }
    } else {
      if (isNaN(instAmount) || instAmount <= 0) {
        instAmount = fullAmount || 12000;
      }
      const p1 = Math.round(instAmount * 0.4);
      const p2 = instAmount - p1;
      validatedPhases = [
        { phaseNumber: 1, name: "1st Installment", amount: p1 },
        { phaseNumber: 2, name: "2nd Installment", amount: p2 }
      ];
    }
  }

  return {
    courseId: targetCourseId,
    isFullEnabled: fullEnabled,
    isInstallmentEnabled: instEnabled,
    fullTotalAmount: fullAmount || instAmount || 0,
    installmentTotalAmount: instAmount || fullAmount || 0,
    currency: String(currency || DEFAULT_CURRENCY).toUpperCase(),
    phases: validatedPhases
  };
};

module.exports = {
  parseMonetaryAmount,
  validatePricingPlanPayload,
  validateCoursePricingPayload
};
