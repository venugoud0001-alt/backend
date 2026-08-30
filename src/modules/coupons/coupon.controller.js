const couponService = require('./coupon.service');
const { successResponse } = require('../../utils/response');

class CouponController {
  /**
   * Public API: Validate coupon for course checkout
   * POST /api/coupons/validate
   */
  async validateCoupon(req, res, next) {
    try {
      const result = await couponService.validateCouponForCourse(req.validatedData);
      return successResponse(res, result, 200, 'Coupon validated successfully.');
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({
          status: 'ERROR',
          message: err.message
        });
      }
      next(err);
    }
  }

  /**
   * Admin API: Get all coupons
   * GET /api/coupons
   */
  async getCoupons(req, res, next) {
    try {
      const coupons = await couponService.getAllCoupons();
      return successResponse(res, { coupons });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/coupons/code/:code
   */
  async getCouponByCode(req, res, next) {
    try {
      const { code } = req.params;
      const coupon = await couponService.getCouponByCode(code);
      if (!coupon) {
        return res.status(404).json({ status: 'ERROR', message: `Coupon code '${code}' not found.` });
      }
      return successResponse(res, { coupon });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Admin API: Create coupon
   * POST /api/coupons
   */
  async createCoupon(req, res, next) {
    try {
      const coupon = await couponService.createCoupon(req.validatedData);
      return successResponse(res, { coupon }, 201, 'Coupon created successfully.');
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ status: 'ERROR', message: err.message });
      }
      next(err);
    }
  }

  /**
   * Admin API: Update coupon
   * PUT /api/coupons/:id
   */
  async updateCoupon(req, res, next) {
    try {
      const { id } = req.params;
      const coupon = await couponService.updateCoupon(id, req.validatedData);
      return successResponse(res, { coupon }, 200, 'Coupon updated successfully.');
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ status: 'ERROR', message: err.message });
      }
      next(err);
    }
  }

  /**
   * Admin API: Delete coupon
   * DELETE /api/coupons/:id
   */
  async deleteCoupon(req, res, next) {
    try {
      const { id } = req.params;
      await couponService.deleteCoupon(id);
      return successResponse(res, null, 200, 'Coupon deleted successfully.');
    } catch (err) {
      if (err.statusCode) {
        return res.status(err.statusCode).json({ status: 'ERROR', message: err.message });
      }
      next(err);
    }
  }
}

module.exports = new CouponController();
