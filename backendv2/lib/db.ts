import dns from "node:dns";
import pg from "pg";

dns.setDefaultResultOrder("ipv4first");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export default pool;
