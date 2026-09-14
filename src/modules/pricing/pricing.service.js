const repository = require("./pricing.repository");
const { PAYMENT_MODES, PLAN_STATUSES, DEFAULT_CURRENCY } = require("./pricing.constants");
const { validatePricingPlanPayload, validateCoursePricingPayload, parseMonetaryAmount } = require("./pricing.validator");

class PricingService {
  /**
   * Helper to format DB course_pricing record into normalized API pricing plans (FULL + INSTALLMENT)
   */
  formatPricingRecordToPlans(pricingRecord, course) {
    const fullTotal = parseMonetaryAmount(pricingRecord?.sale_price || pricingRecord?.full_payment_amount || course?.price || 0);
    const inst1 = parseMonetaryAmount(pricingRecord?.installment_1_price || course?.installment_price || 0);
    const inst2 = parseMonetaryAmount(pricingRecord?.installment_2_price || (fullTotal > inst1 ? fullTotal - inst1 : 0));
    const currency = pricingRecord?.currency || DEFAULT_CURRENCY;
    const isActive = pricingRecord ? pricingRecord.is_active !== false : true;
    const courseId = course?.id || pricingRecord?.course_id;
    const planIdPrefix = pricingRecord?.id || courseId || "default";

    const isFullEnabled = fullTotal > 0;
    const isInstallmentEnabled = inst1 > 0 || parseMonetaryAmount(pricingRecord?.installment_total_amount || course?.installment_price || 0) > 0;

    const plans = [];

    // 1. Full Payment Plan
    if (isFullEnabled) {
      plans.push({
        id: `plan_full_${planIdPrefix}`,
        courseId,
        name: "Full Payment",
        paymentMode: PAYMENT_MODES.FULL,
        totalAmount: fullTotal,
        currency,
        isDefault: true,
        status: isActive ? PLAN_STATUSES.ACTIVE : PLAN_STATUSES.INACTIVE
      });
    }

    // 2. Installment Plan
    if (isInstallmentEnabled) {
      let phases = [];
      if (inst1 > 0) {
        phases = [
          {
            id: `phase_1_${planIdPrefix}`,
            planId: `plan_inst_${planIdPrefix}`,
            phaseNumber: 1,
            name: "1st Installment",
            amount: inst1,
            currency
          }
        ];

        if (inst2 > 0) {
          phases.push({
            id: `phase_2_${planIdPrefix}`,
            planId: `plan_inst_${planIdPrefix}`,
            phaseNumber: 2,
            name: "2nd Installment",
            amount: inst2,
            currency
          });
        }
      }

      const instTotal = (inst1 + inst2 > 0) ? (inst1 + inst2) : fullTotal;

      plans.push({
        id: `plan_inst_${planIdPrefix}`,
        courseId,
        name: `${phases.length > 0 ? phases.length : 2}-Phase Flexible Installment Plan`,
        paymentMode: PAYMENT_MODES.INSTALLMENT,
        totalAmount: instTotal,
        currency,
        isDefault: !isFullEnabled,
        status: isActive ? PLAN_STATUSES.ACTIVE : PLAN_STATUSES.INACTIVE,
        phases
      });
    }

    return plans;
  }

  /**
   * Fetch active pricing records for all published courses in a single bulk query
   */
  async getAllPricing() {
    try {
      const { data, error } = await repository.findAllActivePricing();
      return data || [];
    } catch (err) {
      console.warn("getAllPricing note:", err.message || err);
      return [];
    }
  }

  /**
   * Get active pricing plans for a published course
   */
  async getPricingForCourse(courseIdOrSlug, activeOnly = true) {
    let resolvedId = courseIdOrSlug;
    if (typeof courseIdOrSlug === 'object' && courseIdOrSlug !== null) {
      resolvedId = courseIdOrSlug.courseId || courseIdOrSlug.course_id || courseIdOrSlug.id || courseIdOrSlug.slug;
    }
    const cleanId = String(resolvedId || '').trim();
    if (!cleanId || cleanId === '[object Object]') {
      throw { statusCode: 400, message: 'Valid course identifier is required.' };
    }

    const course = await repository.findCourseByIdOrSlug(cleanId);
    if (!course) {
      throw { statusCode: 404, message: `Course not found for identifier '${cleanId}'.` };
    }

    const records = await repository.findPricingByCourseId(course.id, activeOnly);
    if (!records || records.length === 0) {
      const fallbackPlans = this.formatPricingRecordToPlans(null, course);
      return {
        course: { id: course.id, title: course.title, slug: course.slug },
        pricingPlans: fallbackPlans
      };
    }

    const plans = this.formatPricingRecordToPlans(records[0], course);
    return {
      course: { id: course.id, title: course.title, slug: course.slug },
      pricingPlans: plans
    };
  }

  /**
   * Reusable Authoritative Payment Amount Calculation Service
   * NEVER TRUSTS FRONTEND-SUPPLIED AMOUNT
   */
  async calculatePayableAmount(params) {
    if (!params || typeof params !== "object") {
      throw { statusCode: 400, message: "Calculation params must be an object." };
    }

    const { courseId, course_id, planId, pricingPlanId, phaseId, paymentMode } = params;
    const targetCourseId = courseId || course_id || pricingPlanId;
    const targetPlanId = planId || pricingPlanId;

    if (!targetCourseId) {
      throw { statusCode: 400, message: "courseId or pricingPlanId is required." };
    }

    const { pricingPlans } = await this.getPricingForCourse(targetCourseId, true);
    if (!pricingPlans || pricingPlans.length === 0) {
      throw { statusCode: 404, message: "No active pricing plan found for this course." };
    }

    // Match selected plan by ID or by paymentMode
    let selectedPlan = null;
    if (targetPlanId && targetPlanId !== targetCourseId) {
      selectedPlan = pricingPlans.find(p => p.id === targetPlanId || String(p.id).includes(String(targetPlanId)));
      if (!selectedPlan && !paymentMode && !phaseId) {
        throw { statusCode: 404, message: `Pricing plan not found: '${targetPlanId}'` };
      }
    }
    if (!selectedPlan && paymentMode) {
      selectedPlan = pricingPlans.find(p => p.paymentMode === String(paymentMode).toUpperCase());
    }
    if (!selectedPlan && phaseId) {
      selectedPlan = pricingPlans.find(p => p.paymentMode === PAYMENT_MODES.INSTALLMENT);
    }
    if (!selectedPlan) {
      selectedPlan = pricingPlans[0];
    }

    if (!selectedPlan) {
      throw { statusCode: 404, message: "Selected pricing plan not found or inactive." };
    }

    // 1. FULL Payment Calculation
    if (selectedPlan.paymentMode === PAYMENT_MODES.FULL) {
      if (phaseId && !String(phaseId).includes("full")) {
        throw { statusCode: 422, message: "Full payment mode does not support installment phase selection." };
      }
      return {
        courseId: selectedPlan.courseId,
        pricingPlanId: selectedPlan.id,
        paymentMode: PAYMENT_MODES.FULL,
        totalAmount: selectedPlan.totalAmount,
        payableAmount: selectedPlan.totalAmount,
        currency: selectedPlan.currency,
        selectedPhase: null
      };
    }

    // 2. INSTALLMENT Payment Calculation
    if (selectedPlan.paymentMode === PAYMENT_MODES.INSTALLMENT) {
      const phases = selectedPlan.phases || [];
      if (phases.length === 0) {
        throw { statusCode: 422, message: "Selected installment plan has no active phases." };
      }

      let selectedPhase = null;
      if (phaseId) {
        selectedPhase = phases.find(
          ph => ph.id === phaseId || String(ph.id) === String(phaseId) || String(ph.phaseNumber) === String(phaseId)
        );
        if (!selectedPhase) {
          throw { statusCode: 404, message: `Selected phase '${phaseId}' does not belong to this pricing plan.` };
        }
      } else {
        selectedPhase = phases[0]; // Default to 1st installment phase
      }

      return {
        courseId: selectedPlan.courseId,
        pricingPlanId: selectedPlan.id,
        paymentMode: PAYMENT_MODES.INSTALLMENT,
        totalAmount: selectedPlan.totalAmount,
        payableAmount: selectedPhase.amount,
        currency: selectedPlan.currency,
        selectedPhase: {
          id: selectedPhase.id,
          phaseNumber: selectedPhase.phaseNumber,
          name: selectedPhase.name,
          amount: selectedPhase.amount
        }
      };
    }

    throw { statusCode: 400, message: "Invalid payment mode configuration." };
  }

  /**
   * Admin Create / Update Pricing Plan
   */
  async createPricingPlan(payload) {
    return this.saveCoursePricing(payload);
  }

  /**
   * Unified Atomic Course Pricing Save (Full Payment Amount + Installment Plan Phases)
   */
  async saveCoursePricing(payload) {
    const validated = validateCoursePricingPayload(payload);
    const course = await repository.findCourseByIdOrSlug(validated.courseId);
    if (!course) {
      throw { statusCode: 404, message: `Course '${validated.courseId}' does not exist.` };
    }

    const { isFullEnabled, isInstallmentEnabled, fullTotalAmount, installmentTotalAmount, phases } = validated;

    let inst1 = 0;
    let inst2 = 0;
    if (isInstallmentEnabled) {
      if (Array.isArray(phases) && phases.length > 0) {
        inst1 = parseMonetaryAmount(phases[0]?.amount || 0);
        inst2 = Math.max(0, installmentTotalAmount - inst1);
      } else {
        inst1 = Math.round(installmentTotalAmount * 0.4);
        inst2 = Math.max(0, installmentTotalAmount - inst1);
      }
    } else {
      inst1 = Math.round(fullTotalAmount * 0.4);
      inst2 = Math.max(0, fullTotalAmount - inst1);
    }

    const existingRecords = await repository.findPricingByCourseId(course.id, false);
    const existing = existingRecords?.[0] || null;

    const recordPayload = {
      course_id: course.id,
      currency: validated.currency || DEFAULT_CURRENCY,
      sale_price: (inst1 + inst2 > 0) ? (inst1 + inst2) : (fullTotalAmount || installmentTotalAmount),
      original_price: Math.max((fullTotalAmount || installmentTotalAmount) * 3, 12000),
      installment_1_price: inst1,
      installment_2_price: inst2,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    if (existing?.id) {
      recordPayload.id = existing.id;
    }

    const saved = await repository.upsertPricing(recordPayload);

    // Sync parent courses table
    try {
      const { supabase } = require("../../config/supabase");
      const courseUpdate = {
        price: isFullEnabled ? fullTotalAmount : 0,
        installment_price: isInstallmentEnabled ? inst1 : 0,
        updated_at: new Date().toISOString()
      };
      await supabase
        .from("courses")
        .update(courseUpdate)
        .eq("id", course.id);

      Object.assign(course, courseUpdate);
    } catch (syncErr) {
      console.warn("Failed to sync legacy courses table pricing columns:", syncErr.message);
    }

    const updatedCourse = { ...course, price: isFullEnabled ? fullTotalAmount : 0, installment_price: isInstallmentEnabled ? inst1 : 0 };
    const formatted = this.formatPricingRecordToPlans(saved, updatedCourse);
    return {
      status: "SUCCESS",
      pricingPlans: formatted
    };
  }
}

module.exports = new PricingService();
