const pricingService = require("./pricing.service");

class PricingController {
  /**
   * GET /api/pricing/all or GET /api/pricing/courses
   * Public bulk endpoint to fetch active pricing for all courses
   */
  async getAllPricing(req, res, next) {
    try {
      const records = await pricingService.getAllPricing();
      return res.status(200).json({
        status: "SUCCESS",
        pricing: records
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/courses/:courseId/pricing
   * Public endpoint to fetch active pricing plans and installment phases for a course
   */
  async getCoursePricing(req, res, next) {
    try {
      const { courseId } = req.params;
      const result = await pricingService.getPricingForCourse(courseId, true);
      return res.status(200).json({
        status: "SUCCESS",
        ...result
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/pricing/calculate
   * Public / Service endpoint to calculate authoritative payable amount on server
   * Frontend-provided amount parameter is strictly ignored
   */
  async calculatePayableAmount(req, res, next) {
    try {
      const calculation = await pricingService.calculatePayableAmount(req.body);
      return res.status(200).json({
        status: "SUCCESS",
        calculation
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/pricing/save-course-pricing
   * Unified Atomic pricing endpoint (Full Payment Amount + Installment Plan Phases)
   */
  async saveCoursePricing(req, res, next) {
    try {
      console.log("[PRICING API /save-course-pricing] Received body:", JSON.stringify(req.body, null, 2));
      const result = await pricingService.saveCoursePricing(req.body);
      return res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/pricing/plans
   * Admin endpoint to create/configure pricing plans and installment phases
   */
  async createPricingPlan(req, res, next) {
    try {
      console.log("[PRICING API /plans] Received body:", JSON.stringify(req.body, null, 2));
      const result = await pricingService.createPricingPlan(req.body);
      return res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new PricingController();
