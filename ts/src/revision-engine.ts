/**
 * Revision Engine — phase transition when tension crosses threshold.
 *
 * Hybrid connection discovery: stored edges for fast lookups +
 * LLM-driven discovery at revision time for emergent connections.
 * Discovered connections are written back to the edges table,
 * so the graph grows organically through revision events.
 */

import {
  getBelief,
  getActiveBeliefs,
  getContradictions,
  getConnectedBeliefs,
  createBelief,
  supersedeBelief,
  addTension,
  connectBeliefs,
} from "./belief-graph.js";
import { callClaudeJson, callRevision } from "./claude.js";
import { connectionDiscoveryPrompt, revisionPrompt } from "./prompts.js";
import { CASCADE_DEPTH_LIMIT, REVISION_THRESHOLD } from "./config.js";
import { query } from "./db.js";
import type { Belief, RelationType, RevisionResult } from "./types.js";
import { queryMany } from "./db.js";

// ── Connection Discovery ──────────────────────────────────────────

interface DiscoveredConnection {
  belief_id: string;
  belief_content: string;
  relation: RelationType;
  strength: number;
  reasoning: string;
}

async function discoverConnections(
  triggered: Belief,
  allBeliefs: Belief[],
): Promise<DiscoveredConnection[]> {
  const others = allBeliefs
    .filter((b) => b.id !== triggered.id)
    .map((b) => ({
      content: b.content,
      confidence: b.confidence,
      tension: b.tension,
      domain: b.domain,
      id: b.id,
    }));

  if (!others.length) return [];

  const prompt = connectionDiscoveryPrompt(triggered.content, others);

  let raw: any[];
  try {
    raw = await callClaudeJson<any[]>(
      "You are a belief connection analysis system. Respond only in valid JSON array.",
      prompt,
    );
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) return [];

  const validRelations = new Set<string>([
    "supports",
    "contradicts",
    "depends_on",
    "generalizes",
    "tension_shares",
  ]);

  const discovered: DiscoveredConnection[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || !item) continue;
    const idx = item.belief_index;
    if (typeof idx !== "number" || idx < 0 || idx >= others.length) continue;

    let relation = item.relation ?? "supports";
    if (!validRelations.has(relation)) relation = "supports";

    discovered.push({
      belief_id: others[idx].id,
      belief_content: others[idx].content,
      relation: relation as RelationType,
      strength: Math.min(1, Math.max(0, parseFloat(item.strength ?? "0.5"))),
      reasoning: item.reasoning ?? "",
    });
  }

  return discovered;
}

// ── Revision ──────────────────────────────────────────────────────

export async function reviseBelief(
  belief: Belief,
  depth = 0,
): Promise<RevisionResult> {
  if (depth >= CASCADE_DEPTH_LIMIT) {
    return { status: "cascade_limit", belief_id: belief.id };
  }

  // 1. Contradiction history
  const contradictions = await getContradictions(belief.id, 50);
  const contradictionTexts = contradictions.map((c) => c.evidence);

  // 2. Stored connections (fast path)
  const storedConnected = await getConnectedBeliefs(belief.id, 1);
  const storedTexts = storedConnected.map(
    (b) =>
      `[stored] ${b.content} (conf=${b.confidence.toFixed(2)}, tension=${b.tension.toFixed(2)})`,
  );

  // 3. Discover NEW connections via LLM
  const allBeliefs = await getActiveBeliefs();
  const discovered = await discoverConnections(belief, allBeliefs);

  // 4. Write discovered connections back to edges table
  const discoveredTexts: string[] = [];
  const newlyConnected: Belief[] = [];
  for (const disc of discovered) {
    await connectBeliefs(
      belief.id,
      disc.belief_id,
      disc.relation,
      disc.strength,
      "llm_revision",
      disc.reasoning.slice(0, 500),
    );

    discoveredTexts.push(
      `[discovered] ${disc.belief_content} (relation=${disc.relation}, strength=${disc.strength.toFixed(2)}) — ${disc.reasoning}`,
    );

    const discBelief = await getBelief(disc.belief_id);
    if (discBelief?.is_active) newlyConnected.push(discBelief);
  }

  // 5. Claude Opus revision
  const prompt = revisionPrompt({
    belief: belief.content,
    confidence: belief.confidence,
    tension: belief.tension,
    contradictions: contradictionTexts,
    storedConnections: storedTexts,
    discoveredConnections: discoveredTexts,
  });

  let result: Record<string, any>;
  try {
    result = await callRevision(
      "You are performing a deep belief revision. Respond in valid JSON only.",
      prompt,
    );
  } catch (e) {
    return { status: "error", error: String(e), belief_id: belief.id };
  }

  // 6. Create new belief, supersede old
  const newBelief = await createBelief(
    result.revised_belief ?? belief.content,
    belief.domain,
    Math.min(1, Math.max(0, parseFloat(result.confidence ?? "0.5"))),
    belief.importance,
  );
  await supersedeBelief(belief.id, newBelief.id);

  // Transfer connections
  const allConnected = new Map<string, Belief>();
  for (const b of storedConnected) allConnected.set(b.id, b);
  for (const b of newlyConnected) allConnected.set(b.id, b);

  for (const conn of allConnected.values()) {
    await connectBeliefs(newBelief.id, conn.id, "supports", 0.5);
  }

  // Write connections from revision suggestions
  for (const nc of result.new_connections ?? []) {
    for (const b of allBeliefs) {
      if (
        b.content.includes(nc.to_belief ?? "") ||
        (nc.to_belief ?? "").includes(b.content)
      ) {
        const rel = nc.relation;
        if (["supports", "contradicts", "depends_on", "generalizes", "tension_shares"].includes(rel)) {
          await connectBeliefs(newBelief.id, b.id, rel as RelationType, 0.5);
        }
        break;
      }
    }
  }

  // 7. Log revision
  const cascadedIds: string[] = [];
  await query(
    `INSERT INTO revisions (old_belief_id, new_belief_id, trigger_tension, evidence_summary, cascaded_beliefs, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      belief.id,
      newBelief.id,
      belief.tension,
      contradictionTexts.slice(0, 10).join("\n"),
      cascadedIds,
      result.reasoning ?? "",
    ],
  );

  // 8. Cascade
  const cascadeResults: RevisionResult[] = [];

  for (const ci of result.cascade_updates ?? []) {
    const delta = parseFloat(ci.new_tension_delta ?? "0.1");
    for (const conn of allConnected.values()) {
      if (conn.content.includes(ci.belief ?? "")) {
        const updated = await addTension(conn.id, delta);
        if (updated && updated.tension >= REVISION_THRESHOLD) {
          const cr = await reviseBelief(updated, depth + 1);
          cascadeResults.push(cr);
          cascadedIds.push(conn.id);
        }
        break;
      }
    }
  }

  // Also cascade beliefs already near threshold
  for (const conn of allConnected.values()) {
    if (cascadedIds.includes(conn.id)) continue;
    if (conn.tension >= REVISION_THRESHOLD * 0.8) {
      const current = await getBelief(conn.id);
      if (current?.is_active && current.tension >= REVISION_THRESHOLD) {
        const cr = await reviseBelief(current, depth + 1);
        cascadeResults.push(cr);
        cascadedIds.push(conn.id);
      }
    }
  }

  return {
    status: "revised",
    old_belief: belief.content,
    new_belief: result.revised_belief,
    analysis: result.analysis,
    reasoning: result.reasoning,
    behavioral_changes: result.behavioral_changes ?? [],
    stored_connections: storedConnected.length,
    discovered_connections: discovered.length,
    discovered_details: discovered.map((d) => ({
      content: d.belief_content.slice(0, 60),
      relation: d.relation,
      reasoning: d.reasoning.slice(0, 100),
    })),
    cascades: cascadeResults,
  };
}

export async function reviseAllTriggered(
  beliefs: Belief[],
): Promise<RevisionResult[]> {
  const results: RevisionResult[] = [];
  for (const belief of beliefs) {
    const current = await getBelief(belief.id);
    if (current?.is_active && current.tension >= REVISION_THRESHOLD) {
      results.push(await reviseBelief(current));
    }
  }
  return results;
}

export async function getRecentRevisions(
  limit = 5,
): Promise<Array<Record<string, any>>> {
  return queryMany(
    `SELECT r.*, old.content as old_content, new.content as new_content
     FROM revisions r
     JOIN beliefs old ON r.old_belief_id = old.id
     JOIN beliefs new ON r.new_belief_id = new.id
     ORDER BY r.created_at DESC LIMIT $1`,
    [limit],
  );
}
