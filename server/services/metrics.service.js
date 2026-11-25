const knex = require("../knex");

const runtimeStats = {
  startedAt: Date.now(),
  classifications: {
    human: 0,
    bot: 0,
    suspicious: 0,
  },
  latencyCount: 0,
  latencySumMs: 0,
  latencyMaxMs: 0,
};

/**
 * Record in-memory classification and latency telemetry on the hot redirect path.
 */
function recordClassification(classification, latencyMs) {
  if (classification in runtimeStats.classifications) {
    runtimeStats.classifications[classification] += 1;
  }
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
    runtimeStats.latencyCount += 1;
    runtimeStats.latencySumMs += latencyMs;
    if (latencyMs > runtimeStats.latencyMaxMs) {
      runtimeStats.latencyMaxMs = latencyMs;
    }
  }
}

/**
 * Collect combined runtime + database observability snapshot for admin metrics.
 */
async function getMetricsSnapshot() {
  const [
    linkAgg,
    brokenLinksRow,
    alertsTotalRow,
    alertsUnackRow,
    deliveriesByStatus,
  ] = await Promise.all([
    knex("links")
      .count("* as total_links")
      .sum({
        human_visits: "visit_count",
        bot_clicks: "bot_count",
        suspicious_clicks: "suspicious_count",
      })
      .first(),
    knex("links").where({ health_status: "broken" }).count("* as count").first(),
    knex("traffic_alerts").count("* as count").first(),
    knex("traffic_alerts").where({ acknowledged: false }).count("* as count").first(),
    knex("webhook_deliveries").select("status").count("* as count").groupBy("status"),
  ]);

  const deliveries = { pending: 0, success: 0, failed: 0 };
  for (const row of deliveriesByStatus) {
    if (row.status in deliveries) {
      deliveries[row.status] = Number(row.count) || 0;
    }
  }

  const avgLatencyMs =
    runtimeStats.latencyCount > 0
      ? Number((runtimeStats.latencySumMs / runtimeStats.latencyCount).toFixed(4))
      : 0;

  return {
    uptime_seconds: Math.floor(process.uptime()),
    memory_rss_bytes: process.memoryUsage().rss,
    links: {
      total: Number(linkAgg?.total_links) || 0,
      broken: Number(brokenLinksRow?.count) || 0,
    },
    clicks: {
      human_visits: Number(linkAgg?.human_visits) || 0,
      bot_filtered: Number(linkAgg?.bot_clicks) || 0,
      suspicious_filtered: Number(linkAgg?.suspicious_clicks) || 0,
      runtime_classifications: { ...runtimeStats.classifications },
      avg_classification_latency_ms: avgLatencyMs,
      max_classification_latency_ms: Number(runtimeStats.latencyMaxMs.toFixed(4)),
    },
    alerts: {
      total: Number(alertsTotalRow?.count) || 0,
      unacknowledged: Number(alertsUnackRow?.count) || 0,
    },
    webhooks: {
      deliveries,
    },
  };
}

/**
 * Render metrics snapshot in Prometheus exposition text format.
 */
function formatPrometheus(snapshot) {
  const lines = [
    "# HELP kutt_uptime_seconds Process uptime in seconds",
    "# TYPE kutt_uptime_seconds gauge",
    `kutt_uptime_seconds ${snapshot.uptime_seconds}`,
    "# HELP kutt_memory_rss_bytes Resident set size memory in bytes",
    "# TYPE kutt_memory_rss_bytes gauge",
    `kutt_memory_rss_bytes ${snapshot.memory_rss_bytes}`,
    "# HELP kutt_links_total Total shortened links",
    "# TYPE kutt_links_total gauge",
    `kutt_links_total ${snapshot.links.total}`,
    "# HELP kutt_links_broken_total Links currently marked broken",
    "# TYPE kutt_links_broken_total gauge",
    `kutt_links_broken_total ${snapshot.links.broken}`,
    "# HELP kutt_clicks_total Clicks recorded by classification",
    "# TYPE kutt_clicks_total counter",
    `kutt_clicks_total{classification="human"} ${snapshot.clicks.human_visits}`,
    `kutt_clicks_total{classification="bot"} ${snapshot.clicks.bot_filtered}`,
    `kutt_clicks_total{classification="suspicious"} ${snapshot.clicks.suspicious_filtered}`,
    "# HELP kutt_redirect_classification_latency_ms Average click classification latency in ms",
    "# TYPE kutt_redirect_classification_latency_ms gauge",
    `kutt_redirect_classification_latency_ms ${snapshot.clicks.avg_classification_latency_ms}`,
    "# HELP kutt_alerts_unacknowledged Active unacknowledged traffic/health alerts",
    "# TYPE kutt_alerts_unacknowledged gauge",
    `kutt_alerts_unacknowledged ${snapshot.alerts.unacknowledged}`,
    "# HELP kutt_webhook_deliveries_total Webhook delivery counts by status",
    "# TYPE kutt_webhook_deliveries_total counter",
    `kutt_webhook_deliveries_total{status="success"} ${snapshot.webhooks.deliveries.success}`,
    `kutt_webhook_deliveries_total{status="failed"} ${snapshot.webhooks.deliveries.failed}`,
    `kutt_webhook_deliveries_total{status="pending"} ${snapshot.webhooks.deliveries.pending}`,
  ];
  return lines.join("\n") + "\n";
}

function resetRuntimeStats() {
  runtimeStats.classifications = { human: 0, bot: 0, suspicious: 0 };
  runtimeStats.latencyCount = 0;
  runtimeStats.latencySumMs = 0;
  runtimeStats.latencyMaxMs = 0;
}

module.exports = {
  formatPrometheus,
  getMetricsSnapshot,
  recordClassification,
  resetRuntimeStats,
};
