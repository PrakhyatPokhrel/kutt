const env = require("../env");
const query = require("../queries");
const webhookService = require("./webhook.service");

const WINDOW_MS = 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;

const linkActivity = new Map();
const alertCooldowns = new Map();

function pruneAndPush(buckets, key, now) {
  const cutoff = now - WINDOW_MS;
  const list = (buckets.get(key) || []).filter(ts => ts > cutoff);
  list.push(now);
  buckets.set(key, list);
  return list.length;
}

async function emitAlert({ link, alertType, severity, message, metadata }) {
  const cooldownKey = `${link.id}:${alertType}`;
  const now = Date.now();
  const lastEmitted = alertCooldowns.get(cooldownKey) || 0;
  if (now - lastEmitted < COOLDOWN_MS) {
    return null;
  }
  alertCooldowns.set(cooldownKey, now);

  const alert = await query.alert.create({
    link_id: link.id,
    user_id: link.user_id,
    alert_type: alertType,
    severity,
    message,
    metadata,
  });

  await webhookService
    .dispatchEvent(link.user_id, alertType, {
      alert_id: alert.uuid,
      alert_type: alertType,
      severity,
      message,
      link_id: link.uuid,
      link_address: link.address,
      target: link.target,
      ...metadata,
    })
    .catch(err => {
      console.error("Failed dispatching anomaly webhook:", err);
    });

  return alert;
}

/**
 * Evaluate click volume and bot surge anomalies for a link asynchronously (US3).
 */
async function evaluateClickAnomaly(link, classification) {
  if (!link || !link.user_id) return null;

  const now = Date.now();
  let state = linkActivity.get(link.id);
  if (!state) {
    state = { all: new Map(), flagged: new Map() };
    linkActivity.set(link.id, state);
  }

  const totalRate = pruneAndPush(state.all, "clicks", now);
  if (totalRate >= env.SPIKE_THRESHOLD_PER_MIN) {
    return emitAlert({
      link,
      alertType: "traffic_spike",
      severity: "warning",
      message: `Traffic spike detected on /${link.address}: ${totalRate} clicks in the last minute.`,
      metadata: {
        clicks_per_minute: totalRate,
        threshold: env.SPIKE_THRESHOLD_PER_MIN,
      },
    });
  }

  if (classification === "bot" || classification === "suspicious") {
    const flaggedRate = pruneAndPush(state.flagged, "flagged", now);
    if (flaggedRate >= env.BOT_SURGE_THRESHOLD_PER_MIN) {
      return emitAlert({
        link,
        alertType: "bot_surge",
        severity: "critical",
        message: `Automated/suspicious traffic surge on /${link.address}: ${flaggedRate} flagged clicks in the last minute.`,
        metadata: {
          flagged_clicks_per_minute: flaggedRate,
          threshold: env.BOT_SURGE_THRESHOLD_PER_MIN,
          last_classification: classification,
        },
      });
    }
  }

  return null;
}

function resetAnomalyState() {
  linkActivity.clear();
  alertCooldowns.clear();
}

module.exports = {
  evaluateClickAnomaly,
  resetAnomalyState,
};
