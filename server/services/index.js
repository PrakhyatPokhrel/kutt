const anomaly = require("./anomaly.service");
const clickQuality = require("./clickQuality.service");
const linkHealth = require("./linkHealth.service");
const metrics = require("./metrics.service");
const urlSafety = require("./urlSafety");
const webhook = require("./webhook.service");

module.exports = {
  anomaly,
  clickQuality,
  linkHealth,
  metrics,
  urlSafety,
  webhook,
};
