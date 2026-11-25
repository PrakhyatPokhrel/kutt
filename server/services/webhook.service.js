const crypto = require("node:crypto");

const env = require("../env");
const query = require("../queries");
const utils = require("../utils");
const { validateOutboundUrl } = require("./urlSafety");

/**
 * Compute HMAC-SHA256 webhook signature header value.
 * @param {string} secret
 * @param {string} timestamp
 * @param {string} bodyString
 * @returns {string}
 */
function signPayload(secret, timestamp, bodyString) {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${bodyString}`)
    .digest("hex");
  return `sha256=${hmac}`;
}

/**
 * Attempt a single HTTP delivery for a queued webhook delivery record.
 * Updates status, attempt count, HTTP status, error message, and retry schedule (NF3).
 */
async function attemptDelivery(deliveryId) {
  const delivery = await query.webhook.getDelivery(deliveryId);
  if (!delivery || delivery.status === "success") {
    return delivery;
  }

  const webhook = await query.webhook.findOne({ id: delivery.webhook_id });
  if (!webhook || !webhook.enabled) {
    return query.webhook.updateDelivery(deliveryId, {
      status: "failed",
      last_error: "Webhook deleted or disabled.",
      next_retry_at: null,
    });
  }

  const nextAttempt = delivery.attempts + 1;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyObj = {
    id: delivery.uuid,
    event: delivery.event_type,
    timestamp: new Date().toISOString(),
    data: delivery.payload,
  };
  const bodyString = JSON.stringify(bodyObj);
  const signature = signPayload(webhook.secret, timestamp, bodyString);

  let statusCode = null;
  let errorMessage = null;

  try {
    await validateOutboundUrl(webhook.url);
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Kutt-Webhook/1.0",
        "X-Kutt-Event": delivery.event_type,
        "X-Kutt-Delivery": delivery.uuid,
        "X-Kutt-Timestamp": timestamp,
        "X-Kutt-Signature": signature,
      },
      body: bodyString,
      signal: AbortSignal.timeout(5000),
    });

    statusCode = response.status;
    if (response.ok) {
      return query.webhook.updateDelivery(deliveryId, {
        status: "success",
        attempts: nextAttempt,
        last_status_code: statusCode,
        last_error: null,
        next_retry_at: null,
        delivered_at: utils.dateToUTC(new Date()),
      });
    }
    errorMessage = `HTTP ${response.status}`;
  } catch (err) {
    errorMessage = err?.message || "Webhook delivery failed.";
  }

  const exhausted = nextAttempt >= delivery.max_attempts;
  const backoffMs = env.WEBHOOK_RETRY_BASE_MS * Math.pow(2, nextAttempt - 1);
  const nextRetryAt = exhausted ? null : utils.dateToUTC(new Date(Date.now() + backoffMs));

  return query.webhook.updateDelivery(deliveryId, {
    status: exhausted ? "failed" : "pending",
    attempts: nextAttempt,
    last_status_code: statusCode,
    last_error: String(errorMessage).slice(0, 1000),
    next_retry_at: nextRetryAt,
  });
}

/**
 * Dispatch an event to all enabled webhooks subscribed by the user.
 */
async function dispatchEvent(userId, eventType, data) {
  if (!userId) return [];
  const webhooks = await query.webhook.findActiveForEvent(userId, eventType);
  if (!webhooks.length) return [];

  const results = [];
  for (const webhook of webhooks) {
    const delivery = await query.webhook.createDelivery({
      webhook_id: webhook.id,
      user_id: userId,
      event_type: eventType,
      payload: data,
      max_attempts: env.WEBHOOK_MAX_ATTEMPTS,
    });
    const attempted = await attemptDelivery(delivery.id);
    results.push(attempted);
  }
  return results;
}

/**
 * Send a one-off test event to a specific webhook owned by the user.
 */
async function sendTestEvent(webhook) {
  const delivery = await query.webhook.createDelivery({
    webhook_id: webhook.id,
    user_id: webhook.user_id,
    event_type: "webhook.test",
    payload: {
      message: "Test webhook delivery from Kutt Click Quality & Traffic Intelligence.",
      webhook_id: webhook.uuid,
    },
    max_attempts: env.WEBHOOK_MAX_ATTEMPTS,
  });
  return attemptDelivery(delivery.id);
}

/**
 * Process all pending webhook deliveries whose retry timestamp is due.
 */
async function processPendingRetries() {
  const due = await query.webhook.findDueRetries(utils.dateToUTC(new Date()));
  const processed = [];
  for (const delivery of due) {
    processed.push(await attemptDelivery(delivery.id));
  }
  return processed;
}

module.exports = {
  attemptDelivery,
  dispatchEvent,
  processPendingRetries,
  sendTestEvent,
  signPayload,
};
