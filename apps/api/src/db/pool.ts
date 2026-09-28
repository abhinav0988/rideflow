import fs from "fs";
import path from "path";
import { Pool } from "pg";

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
}
