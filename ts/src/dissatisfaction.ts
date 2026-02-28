/**
 * Dissatisfaction Signal — the ambient anxiety metric.
 */

import { queryOne, queryMany } from "./db.js";

export async function computeDissatisfaction(): Promise<number> {
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
  return row ? parseFloat(String(row.dissatisfaction)) : 0;
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
  return queryMany<DissatisfactionBreakdown>(
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
}

export function describeState(dissatisfaction: number): string {
  if (dissatisfaction < 0.1) return "Calm — beliefs are stable and well-supported";
  if (dissatisfaction < 0.3) return "Settled — minor tensions, nothing urgent";
  if (dissatisfaction < 0.5) return "Uneasy — accumulating contradictions, seeking clarity";
  if (dissatisfaction < 0.7) return "Anxious — significant unresolved tensions affecting processing";
  if (dissatisfaction < 0.9) return "Critical — belief system under pressure, revisions needed";
  return "Crisis — fundamental beliefs being challenged, processing impaired";
}
