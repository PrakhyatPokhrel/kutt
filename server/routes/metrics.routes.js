const { Router } = require("express");

const asyncHandler = require("../utils/asyncHandler");
const auth = require("../handlers/auth.handler");
const intelligence = require("../handlers/intelligence.handler");

const router = Router();

// Admin-only observability endpoint (US6, NF2)
router.get(
  "/",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(auth.admin),
  asyncHandler(intelligence.getMetrics)
);

module.exports = router;
