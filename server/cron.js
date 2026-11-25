const env = require("./env");
const query = require("./queries");
const services = require("./services");
const utils = require("./utils");

if (env.ENABLE_BACKGROUND_JOBS) {
  // Check and delete expired links every 30 seconds
  setInterval(function () {
    query.link.batchRemove({ expire_in: ["<", utils.dateToUTC(new Date())] }).catch(() => {});
  }, 30_000).unref();

  // Process pending webhook delivery retries every 10 seconds (US4, NF3)
  setInterval(function () {
    services.webhook.processPendingRetries().catch(() => {});
  }, 10_000).unref();

  // Check stale link destination health every 5 minutes (US5)
  setInterval(function () {
    services.linkHealth.checkStaleLinks(10).catch(() => {});
  }, 5 * 60_000).unref();
}
