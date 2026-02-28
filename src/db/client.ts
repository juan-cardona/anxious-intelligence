import pg from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString:
        process.env.DATABASE_URL ||
        "postgresql://anxious:anxious123@127.0.0.1:5433/anxious_intelligence",
      max: 10,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T = any>(
  sql: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  return getPool().query(sql, params);
}

export async function queryOne<T = any>(
  sql: string,
  params?: any[]
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function queryVal<T = any>(
  sql: string,
  params?: any[]
): Promise<T | null> {
  const result = await query(sql, params);
  const row = result.rows[0];
  return row ? (Object.values(row)[0] as T) : null;
}

export async function runMigrations(): Promise<void> {
  const schemaPath = join(__dirname, "..", "..", "migrations", "001_initial.sql");
  try {
    const schema = readFileSync(schemaPath, "utf-8");
    // Check if tables exist
    const check = await queryVal<number>(
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'beliefs'"
    );
    if (Number(check) === 0) {
      await query(schema);
      console.log("✓ Database schema created");
    }
  } catch (e: any) {
    if (e.code === "ENOENT") {
      console.error("Migration file not found:", schemaPath);
    } else {
      throw e;
    }
  }
}
