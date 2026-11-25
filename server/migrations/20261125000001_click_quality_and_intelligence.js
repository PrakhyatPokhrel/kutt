async function up(knex) {
  const hasBotCount = await knex.schema.hasColumn("links", "bot_count");
  if (!hasBotCount) {
    await knex.schema.alterTable("links", table => {
      table.integer("bot_count").notNullable().defaultTo(0);
      table.integer("suspicious_count").notNullable().defaultTo(0);
      table.string("health_status").notNullable().defaultTo("unknown");
      table.dateTime("last_checked_at");
      table.integer("last_status_code");
      table.string("last_health_error", 1000);
    });
  }

  const hasClickEvents = await knex.schema.hasTable("click_events");
  if (!hasClickEvents) {
    await knex.schema.createTable("click_events", table => {
      table.increments("id").primary();
      table.integer("link_id").unsigned().notNullable();
      table.foreign("link_id").references("id").inTable("links").onDelete("CASCADE");
      table.integer("user_id").unsigned();
      table.foreign("user_id").references("id").inTable("users").onDelete("CASCADE");
      table.string("classification").notNullable();
      table.string("reason");
      table.string("ip_hash");
      table.string("user_agent", 1024);
      table.string("browser");
      table.string("os");
      table.string("country");
      table.string("referrer");
      table.float("latency_ms");
      table.dateTime("created_at").notNullable().defaultTo(knex.fn.now());
      table.index(["link_id", "created_at"]);
      table.index(["user_id", "classification"]);
    });
  }

  const hasAlerts = await knex.schema.hasTable("traffic_alerts");
  if (!hasAlerts) {
    await knex.schema.createTable("traffic_alerts", table => {
      table.increments("id").primary();
      table.uuid("uuid").notNullable().defaultTo(knex.fn.uuid());
      table.integer("link_id").unsigned();
      table.foreign("link_id").references("id").inTable("links").onDelete("CASCADE");
      table.integer("user_id").unsigned().notNullable();
      table.foreign("user_id").references("id").inTable("users").onDelete("CASCADE");
      table.string("alert_type").notNullable();
      table.string("severity").notNullable().defaultTo("warning");
      table.string("message", 1000).notNullable();
      table.jsonb("metadata");
      table.boolean("acknowledged").notNullable().defaultTo(false);
      table.dateTime("acknowledged_at");
      table.dateTime("created_at").notNullable().defaultTo(knex.fn.now());
      table.index(["user_id", "acknowledged"]);
    });
  }

  const hasWebhooks = await knex.schema.hasTable("webhooks");
  if (!hasWebhooks) {
    await knex.schema.createTable("webhooks", table => {
      table.increments("id").primary();
      table.uuid("uuid").notNullable().defaultTo(knex.fn.uuid());
      table.integer("user_id").unsigned().notNullable();
      table.foreign("user_id").references("id").inTable("users").onDelete("CASCADE");
      table.string("url", 2040).notNullable();
      table.string("secret").notNullable();
      table.jsonb("events").notNullable();
      table.boolean("enabled").notNullable().defaultTo(true);
      table.timestamps(false, true);
      table.index(["user_id", "enabled"]);
    });
  }

  const hasDeliveries = await knex.schema.hasTable("webhook_deliveries");
  if (!hasDeliveries) {
    await knex.schema.createTable("webhook_deliveries", table => {
      table.increments("id").primary();
      table.uuid("uuid").notNullable().defaultTo(knex.fn.uuid());
      table.integer("webhook_id").unsigned().notNullable();
      table.foreign("webhook_id").references("id").inTable("webhooks").onDelete("CASCADE");
      table.integer("user_id").unsigned().notNullable();
      table.foreign("user_id").references("id").inTable("users").onDelete("CASCADE");
      table.string("event_type").notNullable();
      table.jsonb("payload").notNullable();
      table.string("status").notNullable().defaultTo("pending");
      table.integer("attempts").notNullable().defaultTo(0);
      table.integer("max_attempts").notNullable().defaultTo(3);
      table.integer("last_status_code");
      table.string("last_error", 1000);
      table.dateTime("next_retry_at");
      table.dateTime("delivered_at");
      table.dateTime("created_at").notNullable().defaultTo(knex.fn.now());
      table.dateTime("updated_at").defaultTo(knex.fn.now());
      table.index(["status", "next_retry_at"]);
      table.index(["webhook_id", "created_at"]);
    });
  }
}

async function down(knex) {
  await knex.schema.dropTableIfExists("webhook_deliveries");
  await knex.schema.dropTableIfExists("webhooks");
  await knex.schema.dropTableIfExists("traffic_alerts");
  await knex.schema.dropTableIfExists("click_events");
  const hasBotCount = await knex.schema.hasColumn("links", "bot_count");
  if (hasBotCount) {
    await knex.schema.alterTable("links", table => {
      table.dropColumn("bot_count");
      table.dropColumn("suspicious_count");
      table.dropColumn("health_status");
      table.dropColumn("last_checked_at");
      table.dropColumn("last_status_code");
      table.dropColumn("last_health_error");
    });
  }
}

module.exports = {
  up,
  down,
};
