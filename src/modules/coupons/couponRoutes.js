const express = require('express');
const router = express.Router();
const couponController = require('./coupon.controller'); // controller
const {
  validateCreateCoupon,
  validateUpdateCoupon,
  validatePublicValidation
} = require('./coupon.validator');
const { authenticateJWT, requirePermission } = require('../../../middleware/auth');

// Middleware helper to attach validated data
function handleValidation(validatorFn) {
  return (req, res, next) => {
    const result = validatorFn(req);
    if (!result.isValid) {
      return res.status(400).json({
        status: 'ERROR',
        message: result.error
      });
    }
    req.validatedData = result.sanitizedData;
    next();
  };
}

// 1. PUBLIC: Validate Coupon for Course Checkout
router.post(['/validate', '/coupons/validate'], handleValidation(validatePublicValidation), (req, res, next) => {
  couponController.validateCoupon(req, res, next);
});

// 2. ADMIN/PUBLIC: Get Coupon Details by Code
router.get('/code/:code', (req, res, next) => {
  couponController.getCouponByCode(req, res, next);
});

// 2b. PUBLIC: Get visible active coupons for main site display
router.get(['/public', '/coupons/public'], (req, res, next) => {
  couponController.getPublicCoupons(req, res, next);
});

// 3. ADMIN: Get All Coupons Catalog
router.get('/', authenticateJWT, requirePermission('coupon.view'), (req, res, next) => {
  couponController.getCoupons(req, res, next);
});

// 4. ADMIN: Create New Coupon
router.post('/', authenticateJWT, requirePermission('coupon.create'), handleValidation(validateCreateCoupon), (req, res, next) => {
  couponController.createCoupon(req, res, next);
});

// 5. ADMIN: Update Coupon
router.put('/:id', authenticateJWT, requirePermission('coupon.edit'), handleValidation(validateUpdateCoupon), (req, res, next) => {
  couponController.updateCoupon(req, res, next);
});

// 6. ADMIN: Delete Coupon
router.delete('/:id', authenticateJWT, requirePermission('coupon.deactivate'), (req, res, next) => {
  couponController.deleteCoupon(req, res, next);
});

module.exports = router;
