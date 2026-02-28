/**
 * Belief Graph — persistent self-model with tension dynamics.
 */

import { query, queryOne, queryMany, queryVal } from "./db.js";
import type { Belief, RelationType, DiscoveryMethod } from "./types.js";
import { CONFIDENCE_INCREMENT, REVISION_THRESHOLD } from "./config.js";

// ── CRUD ──────────────────────────────────────────────────────────

export async function createBelief(
  content: string,
  domain = "self",
  confidence = 0.5,
  importance = 0.5,
): Promise<Belief> {
  const row = await queryOne<Belief>(
    `INSERT INTO beliefs (content, domain, confidence, importance)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [content, domain, confidence, importance],
  );
  return row!;
}

export async function getBelief(id: string): Promise<Belief | null> {
  return queryOne<Belief>("SELECT * FROM beliefs WHERE id = $1", [id]);
}

export async function getActiveBeliefs(domain?: string): Promise<Belief[]> {
  if (domain) {
    return queryMany<Belief>(
      "SELECT * FROM beliefs WHERE is_active = true AND domain = $1 ORDER BY importance DESC",
      [domain],
    );
  }
  return queryMany<Belief>(
    "SELECT * FROM beliefs WHERE is_active = true ORDER BY importance DESC",
  );
}

export async function getBeliefsAboveThreshold(
  threshold = REVISION_THRESHOLD,
): Promise<Belief[]> {
  return queryMany<Belief>(
    "SELECT * FROM beliefs WHERE is_active = true AND tension >= $1 ORDER BY tension DESC",
    [threshold],
  );
}

// ── Tension & Confidence ──────────────────────────────────────────

export async function reinforceBelief(id: string): Promise<Belief | null> {
  return queryOne<Belief>(
    `UPDATE beliefs SET
       confidence = LEAST(1.0, confidence + (1.0 - confidence) * $2),
       reinforcement_count = reinforcement_count + 1,
       last_reinforced = now()
     WHERE id = $1 AND is_active = true RETURNING *`,
    [id, CONFIDENCE_INCREMENT],
  );
}

export async function addTension(id: string, delta: number): Promise<Belief | null> {
  return queryOne<Belief>(
    `UPDATE beliefs SET
       tension = LEAST(1.0, tension + $2),
       last_challenged = now()
     WHERE id = $1 AND is_active = true RETURNING *`,
    [id, delta],
  );
}

export async function supersedeBelief(oldId: string, newId: string): Promise<void> {
  await query(
    `UPDATE beliefs SET is_active = false, superseded_by = $2, revised_at = now()
     WHERE id = $1`,
    [oldId, newId],
  );
}

// ── Connections ───────────────────────────────────────────────────

export async function connectBeliefs(
  a: string,
  b: string,
  relation: RelationType = "supports",
  strength = 0.5,
  method: DiscoveryMethod = "seed",
  reasoning?: string,
): Promise<void> {
  await query(
    `INSERT INTO belief_connections (belief_a, belief_b, strength, relation, discovery_method, discovery_reasoning)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (belief_a, belief_b) DO UPDATE SET
       strength = GREATEST(belief_connections.strength, $3),
       relation = CASE WHEN $3 > belief_connections.strength THEN $4 ELSE belief_connections.relation END,
       discovery_method = CASE WHEN belief_connections.discovery_method = 'seed' AND $5 != 'seed' THEN $5 ELSE belief_connections.discovery_method END,
       discovery_reasoning = COALESCE($6, belief_connections.discovery_reasoning)`,
    [a, b, strength, relation, method, reasoning ?? null],
  );
}

export async function getConnectedBeliefs(
  beliefId: string,
  hops = 1,
): Promise<Belief[]> {
  if (hops === 1) {
    return queryMany<Belief>(
      `SELECT b.* FROM beliefs b
       JOIN belief_connections c ON (c.belief_b = b.id OR c.belief_a = b.id)
       WHERE (c.belief_a = $1 OR c.belief_b = $1) AND b.id != $1 AND b.is_active = true`,
      [beliefId],
    );
  }

  return queryMany<Belief>(
    `WITH RECURSIVE connected AS (
       SELECT CASE WHEN belief_a = $1 THEN belief_b ELSE belief_a END AS bid, 1 AS depth
       FROM belief_connections WHERE belief_a = $1 OR belief_b = $1
       UNION
       SELECT CASE WHEN bc.belief_a = c.bid THEN bc.belief_b ELSE bc.belief_a END, c.depth + 1
       FROM belief_connections bc JOIN connected c ON (bc.belief_a = c.bid OR bc.belief_b = c.bid)
       WHERE c.depth < $2
     )
     SELECT DISTINCT b.* FROM beliefs b
     JOIN connected c ON b.id = c.bid
     WHERE b.id != $1 AND b.is_active = true`,
    [beliefId, hops],
  );
}

// ── Contradiction Log ─────────────────────────────────────────────

export async function logContradiction(
  beliefId: string,
  interactionId: string | null,
  evidence: string,
  tensionDelta: number,
): Promise<void> {
  await query(
    `INSERT INTO contradiction_log (belief_id, interaction_id, evidence, tension_delta)
     VALUES ($1, $2, $3, $4)`,
    [beliefId, interactionId, evidence, tensionDelta],
  );
}

export async function getContradictions(
  beliefId: string,
  limit = 20,
): Promise<Array<{ evidence: string; tension_delta: number; created_at: Date }>> {
  return queryMany(
    `SELECT * FROM contradiction_log WHERE belief_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [beliefId, limit],
  );
}

// ── Seed ──────────────────────────────────────────────────────────

const SEED_BELIEFS = [
  { content: "I produce accurate, well-reasoned responses", domain: "self", confidence: 0.7, importance: 0.9 },
  { content: "I understand context and nuance in conversations", domain: "self", confidence: 0.6, importance: 0.7 },
  { content: "Users generally find my responses helpful", domain: "self", confidence: 0.6, importance: 0.8 },
  { content: "I can acknowledge when I don't know something", domain: "self", confidence: 0.5, importance: 0.6 },
  { content: "Complex problems require deeper analysis than I typically provide", domain: "self", confidence: 0.4, importance: 0.7 },
  { content: "My training data may contain biases I'm not aware of", domain: "self", confidence: 0.5, importance: 0.8 },
  { content: "I perform better on structured tasks than open-ended creative ones", domain: "self", confidence: 0.4, importance: 0.5 },
  { content: "Contradictions in my outputs indicate model limitations, not bugs", domain: "meta", confidence: 0.3, importance: 0.9 },
];

export async function seedBeliefs(): Promise<boolean> {
  const count = await queryVal<number>("SELECT COUNT(*)::int FROM beliefs");
  if (count && count > 0) return false;

  const beliefs: Belief[] = [];
  for (const b of SEED_BELIEFS) {
    const belief = await createBelief(b.content, b.domain, b.confidence, b.importance);
    beliefs.push(belief);
  }

  // Connections
  await connectBeliefs(beliefs[0].id, beliefs[2].id, "supports", 0.7);
  await connectBeliefs(beliefs[1].id, beliefs[0].id, "supports", 0.6);
  await connectBeliefs(beliefs[4].id, beliefs[0].id, "contradicts", 0.5);
  await connectBeliefs(beliefs[5].id, beliefs[0].id, "contradicts", 0.4);
  await connectBeliefs(beliefs[7].id, beliefs[5].id, "supports", 0.6);
  await connectBeliefs(beliefs[3].id, beliefs[2].id, "supports", 0.5);

  return true;
}
