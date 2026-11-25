async function createAlertTable(knex) {
  const hasTable = await knex.schema.hasTable("traffic_alerts");
  if (!hasTable) {
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
}

module.exports = {
  createAlertTable,
};
