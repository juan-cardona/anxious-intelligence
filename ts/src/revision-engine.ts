/**
 * Revision Engine — phase transition when tension crosses threshold.
 *
 * Production features:
 * - Database transactions for atomic belief revision (create new + supersede old)
 * - Structured logging throughout the revision lifecycle
 * - Error isolation — failed revisions don't corrupt belief graph
 * - Cascade depth limiting with logging
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
import { query, queryMany, withTx } from "./db.js";
import type { Belief, RelationType, RevisionResult } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("revision");

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
  } catch (err) {
    log.warn("Connection discovery failed", { belief: triggered.content.slice(0, 50), error: String(err) });
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

  log.info("Connections discovered", {
    belief: triggered.content.slice(0, 50),
    discovered: discovered.length,
  });
  return discovered;
}

// ── Revision ──────────────────────────────────────────────────────

export async function reviseBelief(
  belief: Belief,
  depth = 0,
): Promise<RevisionResult> {
  const timer = log.time(`revision:${belief.id.slice(0, 8)}`);

  if (depth >= CASCADE_DEPTH_LIMIT) {
    log.warn("Cascade depth limit reached", { belief_id: belief.id, depth });
    return { status: "cascade_limit", belief_id: belief.id };
  }

  log.info("Starting revision", {
    belief_id: belief.id,
    tension: belief.tension,
    depth,
    content: belief.content.slice(0, 60),
  });

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
    log.error("Revision LLM call failed", e, { belief_id: belief.id });
    return { status: "error", error: String(e), belief_id: belief.id };
  }

  // 6. TRANSACTION: Create new belief + supersede old atomically
  let newBelief: Belief;
  try {
    newBelief = await withTx(async (tx) => {
      // Create the replacement belief
      const newRow = await tx.queryOne<Belief>(
        `INSERT INTO beliefs (content, domain, confidence, importance)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [
          result.revised_belief ?? belief.content,
          belief.domain,
          Math.min(1, Math.max(0, parseFloat(result.confidence ?? "0.5"))),
          belief.importance,
        ],
      );
      if (!newRow) throw new Error("Failed to create replacement belief");

      // Supersede old belief
      await tx.query(
        `UPDATE beliefs SET is_active = false, superseded_by = $2, revised_at = now()
         WHERE id = $1`,
        [belief.id, newRow.id],
      );

      // Log revision
      await tx.query(
        `INSERT INTO revisions (old_belief_id, new_belief_id, trigger_tension, evidence_summary, cascaded_beliefs, reasoning)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          belief.id,
          newRow.id,
          belief.tension,
          contradictionTexts.slice(0, 10).join("\n"),
          JSON.stringify([]),
          result.reasoning ?? "",
        ],
      );

      return newRow;
    });
  } catch (err) {
    log.error("Revision transaction failed — belief graph unchanged", err, { belief_id: belief.id });
    return { status: "error", error: `Transaction failed: ${err}`, belief_id: belief.id };
  }

  log.info("Belief revised atomically", {
    old_id: belief.id,
    new_id: newBelief.id,
    old_content: belief.content.slice(0, 60),
    new_content: (result.revised_belief ?? "").slice(0, 60),
  });

  // 7. Transfer connections (outside transaction — non-critical)
  const allConnected = new Map<string, Belief>();
  for (const b of storedConnected) allConnected.set(b.id, b);
  for (const b of newlyConnected) allConnected.set(b.id, b);

  for (const conn of allConnected.values()) {
    try {
      await connectBeliefs(newBelief.id, conn.id, "supports", 0.5);
    } catch (err) {
      log.warn("Failed to transfer connection", { from: newBelief.id, to: conn.id, error: String(err) });
    }
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
          try {
            await connectBeliefs(newBelief.id, b.id, rel as RelationType, 0.5);
          } catch (err) {
            log.warn("Failed to write new connection", { error: String(err) });
          }
        }
        break;
      }
    }
  }

  // 8. Cascade
  const cascadeResults: RevisionResult[] = [];
  const cascadedIds: string[] = [];

  for (const ci of result.cascade_updates ?? []) {
    const delta = parseFloat(ci.new_tension_delta ?? "0.1");
    for (const conn of allConnected.values()) {
      if (conn.content.includes(ci.belief ?? "")) {
        try {
          const updated = await addTension(conn.id, delta);
          if (updated && updated.tension >= REVISION_THRESHOLD) {
            const cr = await reviseBelief(updated, depth + 1);
            cascadeResults.push(cr);
            cascadedIds.push(conn.id);
          }
        } catch (err) {
          log.error("Cascade tension update failed", err, { conn_id: conn.id });
        }
        break;
      }
    }
  }

  // Also cascade beliefs already near threshold
  for (const conn of allConnected.values()) {
    if (cascadedIds.includes(conn.id)) continue;
    if (conn.tension >= REVISION_THRESHOLD * 0.8) {
      try {
        const current = await getBelief(conn.id);
        if (current?.is_active && current.tension >= REVISION_THRESHOLD) {
          const cr = await reviseBelief(current, depth + 1);
          cascadeResults.push(cr);
          cascadedIds.push(conn.id);
        }
      } catch (err) {
        log.error("Cascade revision failed", err, { conn_id: conn.id });
      }
    }
  }

  // Update revision record with cascade info
  if (cascadedIds.length > 0) {
    try {
      await query(
        `UPDATE revisions SET cascaded_beliefs = $1
         WHERE old_belief_id = $2 AND new_belief_id = $3`,
        [JSON.stringify(cascadedIds), belief.id, newBelief.id],
      );
    } catch (err) {
      log.warn("Failed to update cascaded_beliefs in revision record", { error: String(err) });
    }
  }

  timer();

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
      try {
        const result = await reviseBelief(current);
        results.push(result);
      } catch (err) {
        log.error("Revision failed for belief", err, { belief_id: belief.id });
        results.push({ status: "error", error: String(err), belief_id: belief.id });
      }
    }
  }
  return results;
}

export async function getRecentRevisions(limit = 5): Promise<any[]> {
  return queryMany(
    `SELECT r.*,
       old_b.content as old_content,
       new_b.content as new_content
     FROM revisions r
     LEFT JOIN beliefs old_b ON r.old_belief_id = old_b.id
     LEFT JOIN beliefs new_b ON r.new_belief_id = new_b.id
     ORDER BY r.created_at DESC LIMIT $1`,
    [limit],
  );
}
