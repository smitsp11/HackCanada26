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

  await client.query(`
    CREATE TABLE IF NOT EXISTS cases (
      case_id TEXT PRIMARY KEY,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      appliance_type_hint TEXT,
      description_raw TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS assets (
      asset_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
      asset_type TEXT NOT NULL,
      slot_key TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      original_filename TEXT,
      cloudinary_public_id TEXT,
      cloudinary_url TEXT,
      checksum_sha256 TEXT,
      storage_uri_raw TEXT,
      storage_uri_normalized TEXT,
      storage_uri_thumbnail TEXT,
      upload_status TEXT NOT NULL DEFAULT 'pending',
      validation_status TEXT NOT NULL DEFAULT 'pending',
      processing_status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add Phase B columns if they don't exist (safe for existing DBs)
  const phaseB_asset_cols = [
    ["original_filename", "TEXT"],
    ["checksum_sha256", "TEXT"],
    ["storage_uri_raw", "TEXT"],
    ["storage_uri_normalized", "TEXT"],
    ["storage_uri_thumbnail", "TEXT"],
    ["upload_status", "TEXT NOT NULL DEFAULT 'pending'"],
  ];
  for (const [col, typedef] of phaseB_asset_cols) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE assets ADD COLUMN ${col} ${typedef};
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_assets_case_id ON assets(case_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
      asset_id TEXT REFERENCES assets(asset_id) ON DELETE SET NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      result JSONB,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
  `);

  // Add Phase B columns to jobs if they don't exist
  for (const [col, typedef] of [["error_code", "TEXT"], ["retry_count", "INTEGER NOT NULL DEFAULT 0"]]) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE jobs ADD COLUMN ${col} ${typedef};
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  }

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_jobs_case_id ON jobs(case_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS asset_metadata (
      asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
      width INTEGER,
      height INTEGER,
      duration_sec NUMERIC,
      codec TEXT,
      frame_rate NUMERIC,
      orientation INTEGER,
      exif_json JSONB,
      derived_metadata_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("Migration complete: products, cases, assets, jobs, asset_metadata tables created.");
  await client.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
