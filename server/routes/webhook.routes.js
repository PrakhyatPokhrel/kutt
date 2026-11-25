const { Router } = require("express");

const asyncHandler = require("../utils/asyncHandler");
const auth = require("../handlers/auth.handler");
const intelligence = require("../handlers/intelligence.handler");

const router = Router();

router.get(
  "/",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.listWebhooks)
);

router.post(
  "/",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.createWebhook)
);

router.patch(
  "/:id",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.updateWebhook)
);

router.delete(
  "/:id",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.deleteWebhook)
);

router.post(
  "/:id/test",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.testWebhook)
);

router.get(
  "/:id/deliveries",
  asyncHandler(auth.apikey),
  asyncHandler(auth.jwt),
  asyncHandler(intelligence.listDeliveries)
);

module.exports = router;
