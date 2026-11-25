const useragent = require("express-useragent").default;
const geoip = require("geoip-lite");
const URL = require("node:url");

const { removeWww, getUseragentBrowser, getUseragentOS } = require("../utils");
const services = require("../services");
const query = require("../queries");

module.exports = async function ({ data }) {
  const userAgent = data.userAgent || data.headers?.["user-agent"] || "";
  const agent = useragent.parse(userAgent);
  const browser = getUseragentBrowser(agent);
  const os = getUseragentOS(agent);
  const referrerDomain = data.referrer && removeWww(URL.parse(data.referrer).hostname);
  const referrer = (referrerDomain && referrerDomain.replace(/\./gi, "[dot]")) || "Direct";
  const country = (data.country || geoip.lookup(data.ip)?.country)?.slice(0, 2).toUpperCase() || "Unknown";

  const quality = data.quality || services.clickQuality.classifyClick({
    userAgent,
    ip: data.ip,
    headers: data.headers,
    linkId: data.link.id,
  });

  const tasks = [
    services.clickQuality.recordClickTelemetry({
      link: data.link,
      classification: quality.classification,
      reason: quality.reason,
      ipHash: quality.ipHash,
      latencyMs: quality.latencyMs,
      userAgent,
      browser,
      os,
      country,
      referrer,
    }),
  ];

  // Only real human clicks increment visit_count and aggregate into visitor stats (US1 & US2)
  if (quality.classification === "human") {
    tasks.push(query.link.incrementVisit({ id: data.link.id }));
    tasks.push(
      query.visit.add({
        browser,
        country,
        os,
        link_id: data.link.id,
        user_id: data.link.user_id,
        referrer,
      })
    );
  }

  await Promise.all(tasks);

  // Evaluate spike and bot-surge anomaly alerts asynchronously (US3)
  await services.anomaly.evaluateClickAnomaly(data.link, quality.classification);
};
