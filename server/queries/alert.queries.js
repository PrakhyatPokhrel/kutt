const knex = require("../knex");
const utils = require("../utils");

function parseMetadata(row) {
  if (!row) return row;
  return {
    ...row,
    acknowledged: !!row.acknowledged,
    metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
  };
}

/**
 * Create a new traffic or link health alert.
 */
async function create(params) {
  let [alert] = await knex("traffic_alerts").insert(
    {
      link_id: params.link_id || null,
      user_id: params.user_id,
      alert_type: params.alert_type,
      severity: params.severity || "warning",
      message: params.message,
      metadata: JSON.stringify(params.metadata || {}),
    },
    "*"
  );

  if (typeof alert === "number") {
    alert = await knex("traffic_alerts").where({ id: alert }).first();
  }
  return parseMetadata(alert);
}

/**
 * List alerts for a user with optional filters.
 */
async function findByUser(userId, { limit = 50, acknowledged, alert_type, link_id } = {}) {
  const q = knex("traffic_alerts")
    .select("traffic_alerts.*", "links.address as link_address", "links.uuid as link_uuid")
    .leftJoin("links", "traffic_alerts.link_id", "links.id")
    .where("traffic_alerts.user_id", userId)
    .orderBy("traffic_alerts.id", "desc")
    .limit(limit);

  if (acknowledged !== undefined) {
    q.andWhere("traffic_alerts.acknowledged", acknowledged);
  }
  if (alert_type) {
    q.andWhere("traffic_alerts.alert_type", alert_type);
  }
  if (link_id) {
    q.andWhere("traffic_alerts.link_id", link_id);
  }

  const rows = await q;
  return rows.map(parseMetadata);
}

/**
 * Acknowledge an alert owned by the user.
 */
async function acknowledge(uuid, userId) {
  const existing = await knex("traffic_alerts").where({ uuid, user_id: userId }).first();
  if (!existing) return null;

  await knex("traffic_alerts")
    .where({ id: existing.id })
    .update({
      acknowledged: true,
      acknowledged_at: utils.dateToUTC(new Date()),
    });

  const updated = await knex("traffic_alerts").where({ id: existing.id }).first();
  return parseMetadata(updated);
}

module.exports = {
  acknowledge,
  create,
  findByUser,
};
