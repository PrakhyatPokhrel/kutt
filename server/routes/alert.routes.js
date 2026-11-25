const { Router } = require("express");

const asyncHandler = require("../utils/asyncHandler");
const auth = require("../handlers/auth.handler");
const intelligence = require("../handlers/intelligence.handler");

const router = Router();

router.get(
  "/",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.listAlerts)
);

router.post(
  "/:id/acknowledge",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.acknowledgeAlert)
);

module.exports = router;
