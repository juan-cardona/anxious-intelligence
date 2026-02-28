import pg from "pg";
import { DATABASE_URL } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      min: 2,
      max: 10,
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function queryMany<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

export async function queryVal<T = any>(
  sql: string,
  params?: any[],
): Promise<T | null> {
  const row = await queryOne(sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return (row as any)[keys[0]] ?? null;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
