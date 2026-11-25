async function createClickEventTable(knex) {
  const hasTable = await knex.schema.hasTable("click_events");
  if (!hasTable) {
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
}

module.exports = {
  createClickEventTable,
};
