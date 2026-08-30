const express = require("express");
const router = express.Router({ mergeParams: true });
const pricingController = require("./pricing.controller");

const { authenticateJWT } = require("../../middleware/authenticate");
const { requireAdminRole, requirePermission } = require("../../middleware/authorize");

// Public endpoints
router.get("/all", pricingController.getAllPricing);
router.get("/courses", pricingController.getAllPricing);
router.get("/courses/:courseId/pricing", pricingController.getCoursePricing);
router.get("/:courseId/pricing", pricingController.getCoursePricing);
router.post("/calculate", pricingController.calculatePayableAmount);

// Admin endpoints
router.post("/save-course-pricing", authenticateJWT, requirePermission('pricing.edit'), pricingController.saveCoursePricing);
router.post("/plans", authenticateJWT, requirePermission('pricing.create'), pricingController.createPricingPlan);

module.exports = router;
