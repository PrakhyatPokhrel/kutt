const crypto = require("node:crypto");
const { isbot } = require("isbot");

const env = require("../env");
const query = require("../queries");
const metrics = require("./metrics.service");

const CLICK_WINDOW_MS = 60 * 1000;
const MAX_TRACKED_KEYS = 10000;

const AUTOMATION_UA_REGEX =
  /(headlesschrome|phantomjs|playwright|puppeteer|selenium|webdriver|curl|wget|python-requests|python-urllib|httpie|go-http-client|postmanruntime|insomnia|axios|node-fetch|undici|scrapy|apachebench|wrk)/i;

// Sliding windows stored in-memory for O(1) non-blocking hot-path checks (NF1)
const linkIpHits = new Map();
const globalIpHits = new Map();

function hashIp(ip) {
  return crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(String(ip || "unknown"))
    .digest("hex")
    .slice(0, 16);
}

function recordSlidingHit(map, key, now) {
  if (map.size > MAX_TRACKED_KEYS) {
    map.clear();
  }
  const cutoff = now - CLICK_WINDOW_MS;
  const timestamps = (map.get(key) || []).filter(ts => ts > cutoff);
  timestamps.push(now);
  map.set(key, timestamps);
  return timestamps.length;
}

/**
 * Synchronously classify an incoming redirect click as human, bot, or suspicious.
 * Performs strictly in-memory checks so redirect latency stays minimal (NF1).
 *
 * @param {{ userAgent?: string, ip?: string, headers?: object, linkId?: number }} input
 * @returns {{ classification: "human"|"bot"|"suspicious", reason: string, ipHash: string, latencyMs: number }}
 */
function classifyClick({ userAgent, ip, headers = {}, linkId } = {}) {
  const startNs = process.hrtime.bigint();
  const ua = typeof userAgent === "string" ? userAgent.trim() : "";
  const ipHash = hashIp(ip);
  const now = Date.now();

  let classification = "human";
  let reason = "verified_human";

  if (!ua) {
    classification = "bot";
    reason = "empty_user_agent";
  } else if (AUTOMATION_UA_REGEX.test(ua)) {
    classification = "bot";
    reason = "automation_tool";
  } else if (isbot(ua)) {
    classification = "bot";
    reason = "known_bot_ua";
  } else {
    const linkHits = recordSlidingHit(linkIpHits, `${linkId || 0}:${ipHash}`, now);
    const totalIpHits = recordSlidingHit(globalIpHits, ipHash, now);

    if (linkHits > env.CLICK_REPEAT_LIMIT) {
      classification = "suspicious";
      reason = "rapid_repeat_ip";
    } else if (totalIpHits > env.CLICK_IP_BURST_LIMIT) {
      classification = "suspicious";
      reason = "ip_burst";
    } else if (
      /^Mozilla\/5\.0/i.test(ua) &&
      !headers["accept"] &&
      !headers["accept-language"]
    ) {
      classification = "suspicious";
      reason = "header_anomaly";
    }
  }

  const latencyMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  metrics.recordClassification(classification, latencyMs);

  return {
    classification,
    reason,
    ipHash,
    latencyMs: Number(latencyMs.toFixed(4)),
  };
}

/**
 * Persist click classification telemetry asynchronously without delaying redirects.
 */
async function recordClickTelemetry({
  link,
  classification,
  reason,
  ipHash,
  latencyMs,
  userAgent,
  browser,
  os,
  country,
  referrer,
}) {
  const tasks = [
    query.clickEvent.add({
      link_id: link.id,
      user_id: link.user_id,
      classification,
      reason,
      ip_hash: ipHash,
      user_agent: userAgent,
      browser,
      os,
      country,
      referrer,
      latency_ms: latencyMs,
    }),
  ];

  if (classification === "bot") {
    tasks.push(query.link.incrementBotCount({ id: link.id }));
  } else if (classification === "suspicious") {
    tasks.push(query.link.incrementSuspiciousCount({ id: link.id }));
  }

  await Promise.all(tasks);
}

function resetTrackers() {
  linkIpHits.clear();
  globalIpHits.clear();
}

module.exports = {
  classifyClick,
  hashIp,
  recordClickTelemetry,
  resetTrackers,
};
