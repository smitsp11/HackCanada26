import dns from "node:dns";
import pg from "pg";

dns.setDefaultResultOrder("ipv4first");

async function migrate() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      company TEXT NOT NULL,
      model_number TEXT NOT NULL,
      display_name TEXT,
      product_type TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_products_company_model
      ON products (LOWER(company), LOWER(model_number));
  `);

  console.log("Migration complete: products table created.");
  await client.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
