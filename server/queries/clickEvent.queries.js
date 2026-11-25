const knex = require("../knex");

/**
 * Insert a click classification event record.
 * @param {object} event
 */
async function add(event) {
  const [inserted] = await knex("click_events").insert(
    {
      link_id: event.link_id,
      user_id: event.user_id || null,
      classification: event.classification,
      reason: event.reason || null,
      ip_hash: event.ip_hash || null,
      user_agent: event.user_agent ? String(event.user_agent).slice(0, 1024) : null,
      browser: event.browser || null,
      os: event.os || null,
      country: event.country || null,
      referrer: event.referrer || null,
      latency_ms: event.latency_ms ?? null,
    },
    "*"
  );
  return inserted;
}

/**
 * List recent click events for a link, optionally filtered by classification.
 */
function findByLink(linkId, { limit = 50, classification } = {}) {
  const q = knex("click_events")
    .where({ link_id: linkId })
    .orderBy("id", "desc")
    .limit(limit);
  if (classification) {
    q.andWhere({ classification });
  }
  return q;
}

/**
 * Summarize click counts grouped by classification and reason for a link.
 */
async function summarizeByLink(linkId) {
  const byClassification = await knex("click_events")
    .where({ link_id: linkId })
    .select("classification")
    .count("* as count")
    .groupBy("classification");

  const byReason = await knex("click_events")
    .where({ link_id: linkId })
    .select("classification", "reason")
    .count("* as count")
    .groupBy("classification", "reason");

  const summary = { human: 0, bot: 0, suspicious: 0, reasons: [] };
  for (const row of byClassification) {
    const count = Number(row.count) || 0;
    if (row.classification in summary) {
      summary[row.classification] = count;
    }
  }
  summary.reasons = byReason.map(r => ({
    classification: r.classification,
    reason: r.reason || "unknown",
    count: Number(r.count) || 0,
  }));
  return summary;
}

module.exports = {
  add,
  findByLink,
  summarizeByLink,
};
