/**
 * Database client with connection pooling, transactions, and health monitoring.
 *
 * Production features:
 * - Connection pool with health monitoring
 * - Transaction support with automatic rollback on error
 * - Query timeout enforcement
 * - Connection error recovery
 * - Structured logging
 */

import pg from "pg";
import { DATABASE_URL } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

// ── Pool Configuration ────────────────────────────────────────────

const POOL_CONFIG: pg.PoolConfig = {
  connectionString: DATABASE_URL,
  min: 2,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000, // Kill queries after 30s
};

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool(POOL_CONFIG);

    pool.on("error", (err) => {
    });

    pool.on("connect", () => {
    });

  }
  return pool;
}

// ── Health Check ──────────────────────────────────────────────────

export interface DbHealth {
  connected: boolean;
  pool_total: number;
  pool_idle: number;
  pool_waiting: number;
  latency_ms: number;
}

export async function checkHealth(): Promise<DbHealth> {
  const p = getPool();
  const start = performance.now();
  try {
    await p.query("SELECT 1");
    return {
      connected: true,
      pool_total: p.totalCount,
      pool_idle: p.idleCount,
      pool_waiting: p.waitingCount,
      latency_ms: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      connected: false,
      pool_total: p.totalCount,
      pool_idle: p.idleCount,
      pool_waiting: p.waitingCount,
      latency_ms: -1,
    };
  }
}

// ── Basic Queries ─────────────────────────────────────────────────

export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  try {
    return await getPool().query<T>(sql, params);
  } catch (err) {
    throw err;
  }
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

// ── Transactions ──────────────────────────────────────────────────

export type TransactionClient = pg.PoolClient;

/**
 * Execute a function within a database transaction.
 * Automatically commits on success, rolls back on error.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query("INSERT INTO ...");
 *     await client.query("UPDATE ...");
 *     return someResult;
 *   });
 */
export async function withTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr) => {
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute queries within a transaction using the simple query helpers.
 * Provides txQuery, txQueryOne, etc. that use the transaction client.
 */
export async function withTx<T>(
  fn: (tx: {
    query: <R extends pg.QueryResultRow = any>(sql: string, params?: any[]) => Promise<pg.QueryResult<R>>;
    queryOne: <R extends pg.QueryResultRow = any>(sql: string, params?: any[]) => Promise<R | null>;
    queryMany: <R extends pg.QueryResultRow = any>(sql: string, params?: any[]) => Promise<R[]>;
    queryVal: (sql: string, params?: any[]) => Promise<any>;
  }) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    const txQuery = async <R extends pg.QueryResultRow = any>(sql: string, params?: any[]) => {
      try {
        return await client.query<R>(sql, params);
      } catch (err) {
        throw err;
      }
    };
    const txQueryOne = async <R extends pg.QueryResultRow = any>(sql: string, params?: any[]) => {
      const r = await txQuery<R>(sql, params);
      return r.rows[0] ?? null;
    };
    const txQueryMany = async <R extends pg.QueryResultRow = any>(sql: string, params?: any[]) => {
      const r = await txQuery<R>(sql, params);
      return r.rows;
    };
    const txQueryVal = async (sql: string, params?: any[]): Promise<any> => {
      const row = await txQueryOne(sql, params);
      if (!row) return null;
      const keys = Object.keys(row);
      return (row as any)[keys[0]] ?? null;
    };
    return fn({ query: txQuery, queryOne: txQueryOne as any, queryMany: txQueryMany, queryVal: txQueryVal });
  });
}

// ── Graceful Shutdown ─────────────────────────────────────────────

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
