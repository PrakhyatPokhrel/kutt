const query = require("../queries");
const services = require("../services");
const utils = require("../utils");

const CustomError = utils.CustomError;
const ALLOWED_WEBHOOK_EVENTS = new Set([
  "traffic_spike",
  "bot_surge",
  "link_broken",
  "webhook.test",
  "*",
]);

function normalizeEvents(events) {
  if (!events) return ["traffic_spike", "bot_surge", "link_broken"];
  const list = Array.isArray(events)
    ? events
    : String(events)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
  if (!list.length) {
    throw new CustomError("At least one webhook event must be selected.", 400);
  }
  for (const ev of list) {
    if (!ALLOWED_WEBHOOK_EVENTS.has(ev)) {
      throw new CustomError(`Unsupported webhook event: ${ev}`, 400);
    }
  }
  return [...new Set(list)];
}

async function listWebhooks(req, res) {
  const webhooks = await query.webhook.findByUser(req.user.id);
  const sanitized = webhooks.map(w => query.webhook.sanitizeWebhook(w, false));
  if (req.isHTML) {
    return res.render("partials/settings/webhooks", {
      layout: false,
      webhooks: sanitized,
    });
  }
  return res.status(200).send({ data: sanitized });
}

async function createWebhook(req, res) {
  const { url, events, secret } = req.body;
  if (!url || typeof url !== "string") {
    throw new CustomError("Webhook URL is required.", 400);
  }

  try {
    await services.urlSafety.validateOutboundUrl(url.trim());
  } catch (err) {
    throw new CustomError(err.message || "Invalid webhook URL.", 400);
  }

  const parsedEvents = normalizeEvents(events);
  const created = await query.webhook.create({
    user_id: req.user.id,
    url: url.trim(),
    events: parsedEvents,
    secret: secret && String(secret).trim() ? String(secret).trim() : undefined,
  });

  if (req.isHTML) {
    const webhooks = (await query.webhook.findByUser(req.user.id)).map(w =>
      query.webhook.sanitizeWebhook(w, false)
    );
    return res.render("partials/settings/webhooks", {
      layout: false,
      webhooks,
      created_secret: created.secret,
      success: "Webhook registered. Copy your signing secret now.",
    });
  }

  return res.status(201).send(query.webhook.sanitizeWebhook(created, true));
}

async function updateWebhook(req, res) {
  const webhook = await query.webhook.findOne({
    uuid: req.params.id,
    user_id: req.user.id,
  });
  if (!webhook) {
    throw new CustomError("Webhook not found.", 404);
  }

  const changes = {};
  if (req.body.url !== undefined) {
    try {
      await services.urlSafety.validateOutboundUrl(String(req.body.url).trim());
    } catch (err) {
      throw new CustomError(err.message || "Invalid webhook URL.", 400);
    }
    changes.url = String(req.body.url).trim();
  }
  if (req.body.events !== undefined) {
    changes.events = normalizeEvents(req.body.events);
  }
  if (req.body.enabled !== undefined) {
    changes.enabled = req.body.enabled === true || req.body.enabled === "true";
  }

  const updated = await query.webhook.update({ id: webhook.id }, changes);
  return res.status(200).send(query.webhook.sanitizeWebhook(updated, false));
}

async function deleteWebhook(req, res) {
  const webhook = await query.webhook.findOne({
    uuid: req.params.id,
    user_id: req.user.id,
  });
  if (!webhook) {
    throw new CustomError("Webhook not found.", 404);
  }

  await query.webhook.remove({ id: webhook.id });

  if (req.isHTML) {
    const webhooks = (await query.webhook.findByUser(req.user.id)).map(w =>
      query.webhook.sanitizeWebhook(w, false)
    );
    return res.render("partials/settings/webhooks", {
      layout: false,
      webhooks,
      success: "Webhook deleted.",
    });
  }

  return res.status(200).send({ message: "Webhook deleted successfully." });
}

async function testWebhook(req, res) {
  const webhook = await query.webhook.findOne({
    uuid: req.params.id,
    user_id: req.user.id,
  });
  if (!webhook) {
    throw new CustomError("Webhook not found.", 404);
  }

  const delivery = await services.webhook.sendTestEvent(webhook);

  if (req.isHTML) {
    const webhooks = (await query.webhook.findByUser(req.user.id)).map(w =>
      query.webhook.sanitizeWebhook(w, false)
    );
    return res.render("partials/settings/webhooks", {
      layout: false,
      webhooks,
      success:
        delivery.status === "success"
          ? `Test webhook delivered (HTTP ${delivery.last_status_code}).`
          : `Test delivery queued for retry (${delivery.last_error || "pending"}).`,
    });
  }

  return res.status(200).send({ delivery });
}

async function listDeliveries(req, res) {
  const webhook = await query.webhook.findOne({
    uuid: req.params.id,
    user_id: req.user.id,
  });
  if (!webhook) {
    throw new CustomError("Webhook not found.", 404);
  }

  const deliveries = await query.webhook.listDeliveries(webhook.id, req.user.id);
  return res.status(200).send({ data: deliveries });
}

async function listAlerts(req, res) {
  const acknowledged = utils.parseBooleanQuery(req.query.acknowledged);
  const alert_type = req.query.alert_type;
  const alerts = await query.alert.findByUser(req.user.id, {
    acknowledged,
    alert_type,
  });

  if (req.isHTML) {
    return res.render("partials/settings/alerts", {
      layout: false,
      alerts,
    });
  }

  return res.status(200).send({ data: alerts });
}

async function acknowledgeAlert(req, res) {
  const alert = await query.alert.acknowledge(req.params.id, req.user.id);
  if (!alert) {
    throw new CustomError("Alert not found.", 404);
  }

  if (req.isHTML) {
    const alerts = await query.alert.findByUser(req.user.id);
    return res.render("partials/settings/alerts", {
      layout: false,
      alerts,
    });
  }

  return res.status(200).send({ alert });
}

async function getMetrics(req, res) {
  const snapshot = await services.metrics.getMetricsSnapshot();
  const wantsPrometheus =
    req.query.format === "prometheus" ||
    (req.headers.accept && req.headers.accept.includes("text/plain"));

  if (wantsPrometheus) {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return res.status(200).send(services.metrics.formatPrometheus(snapshot));
  }

  if (req.isHTML) {
    return res.render("partials/admin/metrics", {
      layout: false,
      metrics: snapshot,
    });
  }

  return res.status(200).send(snapshot);
}

module.exports = {
  acknowledgeAlert,
  createWebhook,
  deleteWebhook,
  getMetrics,
  listAlerts,
  listDeliveries,
  listWebhooks,
  testWebhook,
  updateWebhook,
};
