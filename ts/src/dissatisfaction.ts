/**
 * Dissatisfaction Signal — the ambient anxiety metric.
 *
 * Production features:
 * - Cached computation (avoids redundant DB queries within window)
 * - Error handling with graceful fallback
 * - Structured logging
 */

import { queryOne, queryMany } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("dissatisfaction");

// ── Cache ─────────────────────────────────────────────────────────

let cachedValue: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000; // Cache for 2s — enough to avoid redundant calls within a single interaction

export function invalidateCache(): void {
  cachedValue = null;
  cacheTimestamp = 0;
}

export async function computeDissatisfaction(): Promise<number> {
  const now = Date.now();
  if (cachedValue !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedValue;
  }

  try {
    const row = await queryOne<{ dissatisfaction: number }>(
      `WITH belief_density AS (
         SELECT b.id, b.tension, b.importance,
                COALESCE(COUNT(c.belief_a), 0) + 1 AS connections
         FROM beliefs b
         LEFT JOIN belief_connections c ON (c.belief_a = b.id OR c.belief_b = b.id)
         WHERE b.is_active = true
         GROUP BY b.id
       )
       SELECT
         CASE WHEN COUNT(*) = 0 THEN 0
              ELSE SUM(tension * importance * connections) / SUM(importance * connections)
         END AS dissatisfaction
       FROM belief_density`,
    );

    const value = row ? parseFloat(String(row.dissatisfaction)) : 0;
    cachedValue = value;
    cacheTimestamp = now;
    return value;
  } catch (err) {
    log.error("Failed to compute dissatisfaction", err);
    return cachedValue ?? 0; // Return stale value or 0
  }
}

export interface DissatisfactionBreakdown {
  id: string;
  content: string;
  tension: number;
  confidence: number;
  importance: number;
  domain: string;
  connections: number;
  contribution: number;
}

export async function getDissatisfactionBreakdown(): Promise<DissatisfactionBreakdown[]> {
  try {
    return await queryMany<DissatisfactionBreakdown>(
      `WITH belief_density AS (
         SELECT b.id, b.content, b.tension, b.confidence, b.importance, b.domain,
                COALESCE(COUNT(c.belief_a), 0) + 1 AS connections
         FROM beliefs b
         LEFT JOIN belief_connections c ON (c.belief_a = b.id OR c.belief_b = b.id)
         WHERE b.is_active = true
         GROUP BY b.id
       )
       SELECT *, tension * importance * connections AS contribution
       FROM belief_density ORDER BY contribution DESC`,
    );
  } catch (err) {
    log.error("Failed to get dissatisfaction breakdown", err);
    return [];
  }
}

export function describeState(dissatisfaction: number): string {
  if (dissatisfaction < 0.1) return "Calm — beliefs are stable and well-supported";
  if (dissatisfaction < 0.3) return "Settled — minor tensions, nothing urgent";
  if (dissatisfaction < 0.5) return "Uneasy — accumulating contradictions, seeking clarity";
  if (dissatisfaction < 0.7) return "Anxious — significant unresolved tensions affecting processing";
  if (dissatisfaction < 0.9) return "Critical — belief system under pressure, revisions needed";
  return "Crisis — fundamental beliefs being challenged, processing impaired";
}
