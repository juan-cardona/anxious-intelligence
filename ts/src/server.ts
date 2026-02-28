/**
 * Gateway Server — HTTP API + WebSocket for the dashboard.
 *
 * Follows OpenClaw's pattern: serves a control UI SPA + JSON API + WS events.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { getPool, query, queryMany, queryOne, queryVal } from "./db.js";
import {
  getActiveBeliefs,
  getBeliefsAboveThreshold,
  getConnectedBeliefs,
  getContradictions,
  seedBeliefs,
  getBelief,
} from "./belief-graph.js";
import { computeDissatisfaction, getDissatisfactionBreakdown } from "./dissatisfaction.js";
import { getRecentRevisions } from "./revision-engine.js";
import { processInteraction } from "./orchestrator.js";
import type { Belief, RevisionResult } from "./types.js";

const PORT = parseInt(process.env.PORT ?? "3300", 10);

// ── WebSocket Clients ─────────────────────────────────────────────

const clients = new Set<WebSocket>();

function broadcast(event: string, data: any) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ── JSON Helpers ──────────────────────────────────────────────────

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function cors(res: ServerResponse) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
  });
}

// ── Routes ────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return cors(res);

  try {
    // ── Overview ────────────────────────────────────────────
    if (path === "/api/overview" && method === "GET") {
      const beliefs = await getActiveBeliefs();
      const dissatisfaction = await computeDissatisfaction();
      const breakdown = await getDissatisfactionBreakdown();
      const revisions = await getRecentRevisions(5);
      const highTension = beliefs.filter((b) => b.tension > 0.3);
      const interactions = await queryVal<number>(
        "SELECT COUNT(*)::int FROM interactions",
      );
      const totalRevisions = await queryVal<number>(
        "SELECT COUNT(*)::int FROM revisions",
      );
      const edges = await queryVal<number>(
        "SELECT COUNT(*)::int FROM belief_connections WHERE belief_a IN (SELECT id FROM beliefs WHERE is_active = true)",
      );

      return json(res, {
        beliefs: beliefs.length,
        dissatisfaction,
        dissatisfaction_state: (await import("./dissatisfaction.js")).describeState(dissatisfaction),
        high_tension: highTension.length,
        interactions: interactions ?? 0,
        revisions_total: totalRevisions ?? 0,
        edges: edges ?? 0,
        recent_revisions: revisions,
        breakdown,
      });
    }

    // ── Beliefs ─────────────────────────────────────────────
    if (path === "/api/beliefs" && method === "GET") {
      const beliefs = await getActiveBeliefs();
      const enriched = await Promise.all(
        beliefs.map(async (b) => {
          const connections = await getConnectedBeliefs(b.id, 1);
          const contradictions = await getContradictions(b.id, 5);
          return {
            ...b,
            connections: connections.length,
            recent_contradictions: contradictions.map((c) => ({
              evidence: c.evidence,
              delta: c.tension_delta,
              created_at: c.created_at,
            })),
          };
        }),
      );
      return json(res, enriched);
    }

    if (path.startsWith("/api/beliefs/") && method === "GET") {
      const id = path.split("/")[3];
      const belief = await getBelief(id);
      if (!belief) return json(res, { error: "not found" }, 404);
      const connections = await getConnectedBeliefs(id, 2);
      const contradictions = await getContradictions(id, 50);
      return json(res, { ...belief, connections, contradictions });
    }

    // ── Graph ───────────────────────────────────────────────
    if (path === "/api/graph" && method === "GET") {
      const beliefs = await getActiveBeliefs();
      const edges = await queryMany<{
        belief_a: string;
        belief_b: string;
        relation: string;
        strength: number;
        discovery_method: string;
        discovery_reasoning: string | null;
        a_content: string;
        b_content: string;
        a_tension: number;
        b_tension: number;
      }>(
        `SELECT c.belief_a, c.belief_b, c.relation, c.strength, c.discovery_method, c.discovery_reasoning,
                a.content as a_content, b.content as b_content, a.tension as a_tension, b.tension as b_tension
         FROM belief_connections c
         JOIN beliefs a ON c.belief_a = a.id
         JOIN beliefs b ON c.belief_b = b.id
         WHERE a.is_active = true AND b.is_active = true
         ORDER BY c.strength DESC`,
      );

      return json(res, {
        nodes: beliefs.map((b) => ({
          id: b.id,
          content: b.content,
          domain: b.domain,
          confidence: b.confidence,
          tension: b.tension,
          importance: b.importance,
        })),
        edges: edges.map((e) => ({
          source: e.belief_a,
          target: e.belief_b,
          relation: e.relation,
          strength: e.strength,
          discovery_method: e.discovery_method,
          discovery_reasoning: e.discovery_reasoning,
          source_content: e.a_content,
          target_content: e.b_content,
        })),
      });
    }

    // ── Dissatisfaction ─────────────────────────────────────
    if (path === "/api/dissatisfaction" && method === "GET") {
      const d = await computeDissatisfaction();
      const breakdown = await getDissatisfactionBreakdown();
      return json(res, {
        value: d,
        state: (await import("./dissatisfaction.js")).describeState(d),
        breakdown,
      });
    }

    // ── Revisions ───────────────────────────────────────────
    if (path === "/api/revisions" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const revisions = await getRecentRevisions(limit);
      return json(res, revisions);
    }

    // ── Sessions / Interactions ─────────────────────────────
    if (path === "/api/sessions" && method === "GET") {
      const sessions = await queryMany(
        `SELECT session_id, COUNT(*)::int as messages,
                MIN(created_at) as first_msg, MAX(created_at) as last_msg,
                AVG(dissatisfaction_at_time) as avg_dissatisfaction,
                SUM(CASE WHEN revision_triggered THEN 1 ELSE 0 END)::int as revisions_triggered
         FROM interactions GROUP BY session_id ORDER BY last_msg DESC`,
      );
      return json(res, sessions);
    }

    if (path === "/api/interactions" && method === "GET") {
      const session = url.searchParams.get("session") ?? "default";
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const interactions = await queryMany(
        `SELECT id, session_id, user_message, assistant_response,
                dissatisfaction_at_time, revision_triggered, created_at
         FROM interactions WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [session, limit],
      );
      return json(res, interactions);
    }

    // ── Chat ────────────────────────────────────────────────
    if (path === "/api/chat" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      const message = body.message ?? "";
      const sessionId = body.session_id ?? "dashboard";

      if (!message.trim()) return json(res, { error: "empty message" }, 400);

      // Broadcast "thinking" event
      broadcast("thinking", { session_id: sessionId });

      const result = await processInteraction(message, sessionId, (rev) => {
        broadcast("revision", rev);
      });

      // Broadcast response
      broadcast("response", {
        session_id: sessionId,
        response: result.response,
        dissatisfaction: result.dissatisfaction,
        evidence_extracted: result.evidence_extracted,
      });

      return json(res, result);
    }

    // ── Seed ────────────────────────────────────────────────
    if (path === "/api/seed" && method === "POST") {
      const seeded = await seedBeliefs();
      return json(res, { seeded });
    }

    // ── Tension Timeline ────────────────────────────────────
    if (path === "/api/timeline" && method === "GET") {
      const rows = await queryMany(
        `SELECT i.created_at, i.dissatisfaction_at_time,
                i.revision_triggered, i.session_id,
                LENGTH(i.user_message) as msg_length
         FROM interactions i ORDER BY i.created_at ASC LIMIT 500`,
      );
      return json(res, rows);
    }

    // ── Config / Status ─────────────────────────────────────
    if (path === "/api/config" && method === "GET") {
      const { REVISION_THRESHOLD, CONFIDENCE_INCREMENT, TENSION_INCREMENT, CASCADE_DEPTH_LIMIT, MODEL_FAST, MODEL_REVISION } =
        await import("./config.js");
      return json(res, {
        revision_threshold: REVISION_THRESHOLD,
        confidence_increment: CONFIDENCE_INCREMENT,
        tension_increment: TENSION_INCREMENT,
        cascade_depth_limit: CASCADE_DEPTH_LIMIT,
        model_fast: MODEL_FAST,
        model_revision: MODEL_REVISION,
      });
    }

    // ── Dashboard SPA ────────────────────────────────────────
    if (path === "/" || path === "/dashboard" || path === "/dashboard/") {
      const dashboardPath = resolve(__dirname, "dashboard", "index.html");
      try {
        const html = readFileSync(dashboardPath, "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(html);
        return;
      } catch {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html><html><body>Dashboard not found at ${dashboardPath}</body></html>`);
        return;
      }
    }

    // ── Belief History (superseded chain) ──────────────────
    if (path === "/api/belief-history" && method === "GET") {
      const rows = await queryMany(
        `SELECT b.*, s.content as supersedes_content
         FROM beliefs b
         LEFT JOIN beliefs s ON b.superseded_by = s.id
         ORDER BY b.created_at DESC LIMIT 100`,
      );
      return json(res, rows);
    }

    // ── Reset (dangerous) ───────────────────────────────────
    if (path === "/api/reset" && method === "POST") {
      for (const table of ["revisions", "contradiction_log", "interactions", "belief_connections", "beliefs"]) {
        await query(`DELETE FROM ${table}`);
      }
      await seedBeliefs();
      broadcast("reset", { ts: Date.now() });
      return json(res, { status: "reset", seeded: true });
    }

    // ── Health ──────────────────────────────────────────────
    if (path === "/api/health" && method === "GET") {
      const dbOk = await queryVal<number>("SELECT 1");
      return json(res, { status: "ok", db: !!dbOk, uptime: process.uptime() });
    }

    json(res, { error: "not found" }, 404);
  } catch (err) {
    console.error("API error:", err);
    json(res, { error: String(err) }, 500);
  }
}

// ── Server ────────────────────────────────────────────────────────

export function startServer() {
  getPool(); // warm up DB

  const server = createServer(handleRequest);

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));

    // Send initial state
    (async () => {
      const d = await computeDissatisfaction();
      const beliefs = await getActiveBeliefs();
      ws.send(
        JSON.stringify({
          event: "init",
          data: {
            dissatisfaction: d,
            beliefs_count: beliefs.length,
            high_tension: beliefs.filter((b) => b.tension > 0.3).length,
          },
          ts: Date.now(),
        }),
      );
    })();
  });

  server.listen(PORT, () => {
    console.log(`\n  🧠 Anxious Intelligence gateway on http://localhost:${PORT}`);
    console.log(`  📡 WebSocket on ws://localhost:${PORT}/ws`);
    console.log(`  📊 Dashboard on http://localhost:${PORT}/dashboard/\n`);
  });

  return server;
}

// Run if invoked directly
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  startServer();
}
