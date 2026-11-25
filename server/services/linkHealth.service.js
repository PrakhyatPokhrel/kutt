const env = require("../env");
const query = require("../queries");
const utils = require("../utils");
const { validateOutboundUrl } = require("./urlSafety");
const webhookService = require("./webhook.service");

/**
 * Check whether a link's destination URL responds cleanly (US5).
 * Updates `links.health_status` and emits a `link_broken` alert/webhook on failure.
 */
async function checkLinkHealth(link, { notifyOnBroken = true } = {}) {
  const previousStatus = link.health_status || "unknown";
  let healthStatus = "healthy";
  let statusCode = null;
  let errorMessage = null;

  try {
    await validateOutboundUrl(link.target);
    let response = await fetch(link.target, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "Kutt-LinkHealthMonitor/1.0" },
    });

    if (response.status === 405 || response.status === 501) {
      response = await fetch(link.target, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "Kutt-LinkHealthMonitor/1.0" },
      });
      await response.body?.cancel().catch(() => {});
    }

    statusCode = response.status;
    if (statusCode >= 400) {
      healthStatus = "broken";
      errorMessage = `Destination returned HTTP ${statusCode}`;
    }
  } catch (err) {
    healthStatus = "broken";
    errorMessage = err?.message || "Destination unreachable";
  }

  const checkedAt = utils.dateToUTC(new Date());
  const [updatedLink] = await query.link.update(
    { id: link.id },
    {
      health_status: healthStatus,
      last_checked_at: checkedAt,
      last_status_code: statusCode,
      last_health_error: errorMessage ? String(errorMessage).slice(0, 1000) : null,
    }
  );

  if (
    healthStatus === "broken" &&
    link.user_id &&
    notifyOnBroken &&
    previousStatus !== "broken"
  ) {
    const alert = await query.alert.create({
      link_id: link.id,
      user_id: link.user_id,
      alert_type: "link_broken",
      severity: "critical",
      message: `Destination for /${link.address} appears broken (${errorMessage}).`,
      metadata: {
        target: link.target,
        status_code: statusCode,
        error: errorMessage,
      },
    });

    await webhookService
      .dispatchEvent(link.user_id, "link_broken", {
        alert_id: alert.uuid,
        alert_type: "link_broken",
        link_id: link.uuid,
        link_address: link.address,
        target: link.target,
        status_code: statusCode,
        error: errorMessage,
      })
      .catch(err => {
        console.error("Failed dispatching link_broken webhook:", err);
      });
  }

  return {
    link: updatedLink,
    health_status: healthStatus,
    last_checked_at: checkedAt,
    last_status_code: statusCode,
    last_health_error: errorMessage,
  };
}

/**
 * Periodically check stale links whose health hasn't been checked recently.
 */
async function checkStaleLinks(limit = 10) {
  const cutoff = utils.dateToUTC(new Date(Date.now() - env.LINK_HEALTH_RECHECK_MS));
  const stale = await query.link.findStaleForHealthCheck(cutoff, limit);
  const results = [];
  for (const link of stale) {
    results.push(await checkLinkHealth(link));
  }
  return results;
}

module.exports = {
  checkLinkHealth,
  checkStaleLinks,
};
