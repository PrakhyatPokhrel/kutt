async function createWebhookTables(knex) {
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

module.exports = {
  createWebhookTables,
};
