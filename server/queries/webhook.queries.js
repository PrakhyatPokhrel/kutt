const crypto = require("node:crypto");

const knex = require("../knex");
const utils = require("../utils");

function parseWebhook(row) {
  if (!row) return row;
  return {
    ...row,
    enabled: !!row.enabled,
    events: typeof row.events === "string" ? JSON.parse(row.events) : row.events,
  };
}

function parseDelivery(row) {
  if (!row) return row;
  return {
    ...row,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
  };
}

function sanitizeWebhook(row, includeSecret = false) {
  const parsed = parseWebhook(row);
  if (!parsed) return parsed;
  const out = {
    id: parsed.uuid,
    url: parsed.url,
    events: parsed.events,
    enabled: parsed.enabled,
    secret_preview: parsed.secret ? `${parsed.secret.slice(0, 6)}...` : null,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  };
  if (includeSecret) {
    out.secret = parsed.secret;
  }
  return out;
}

async function create({ user_id, url, events, secret, enabled = true }) {
  const signingSecret = secret || `whsec_${crypto.randomBytes(24).toString("hex")}`;
  let [row] = await knex("webhooks").insert(
    {
      user_id,
      url,
      secret: signingSecret,
      events: JSON.stringify(events || ["traffic_spike", "bot_surge", "link_broken"]),
      enabled: !!enabled,
    },
    "*"
  );
  if (typeof row === "number") {
    row = await knex("webhooks").where({ id: row }).first();
  }
  return parseWebhook(row);
}

async function findByUser(userId) {
  const rows = await knex("webhooks").where({ user_id: userId }).orderBy("id", "desc");
  return rows.map(parseWebhook);
}

async function findActiveForEvent(userId, eventType) {
  const rows = await knex("webhooks").where({ user_id: userId, enabled: true });
  return rows
    .map(parseWebhook)
    .filter(w => Array.isArray(w.events) && (w.events.includes("*") || w.events.includes(eventType)));
}

async function findOne(match) {
  const row = await knex("webhooks").where(match).first();
  return parseWebhook(row);
}

async function update(match, changes) {
  const payload = { ...changes, updated_at: utils.dateToUTC(new Date()) };
  if (changes.events) {
    payload.events = JSON.stringify(changes.events);
  }
  await knex("webhooks").where(match).update(payload);
  return findOne(match);
}

async function remove(match) {
  const deleted = await knex("webhooks").where(match).delete();
  return deleted > 0;
}

async function createDelivery({ webhook_id, user_id, event_type, payload, max_attempts }) {
  let [row] = await knex("webhook_deliveries").insert(
    {
      webhook_id,
      user_id,
      event_type,
      payload: JSON.stringify(payload),
      status: "pending",
      attempts: 0,
      max_attempts: max_attempts || 3,
    },
    "*"
  );
  if (typeof row === "number") {
    row = await knex("webhook_deliveries").where({ id: row }).first();
  }
  return parseDelivery(row);
}

async function getDelivery(id) {
  const row = await knex("webhook_deliveries").where({ id }).first();
  return parseDelivery(row);
}

async function updateDelivery(id, changes) {
  await knex("webhook_deliveries")
    .where({ id })
    .update({ ...changes, updated_at: utils.dateToUTC(new Date()) });
  return getDelivery(id);
}

async function listDeliveries(webhookId, userId, limit = 30) {
  const rows = await knex("webhook_deliveries")
    .where({ webhook_id: webhookId, user_id: userId })
    .orderBy("id", "desc")
    .limit(limit);
  return rows.map(parseDelivery);
}

async function findDueRetries(nowUTC, limit = 25) {
  const rows = await knex("webhook_deliveries")
    .where({ status: "pending" })
    .whereNotNull("next_retry_at")
    .andWhere("next_retry_at", "<=", nowUTC)
    .orderBy("next_retry_at", "asc")
    .limit(limit);
  return rows.map(parseDelivery);
}

module.exports = {
  create,
  createDelivery,
  findActiveForEvent,
  findByUser,
  findDueRetries,
  findOne,
  getDelivery,
  listDeliveries,
  remove,
  sanitizeWebhook,
  update,
  updateDelivery,
};
