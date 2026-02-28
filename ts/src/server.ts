/**
 * Gateway Server — HTTP API + WebSocket for the dashboard.
 *
 * Full feature parity with OpenClaw's control UI plumbing:
 * - WebSocket with event streaming (init, thinking, response, revision, tension, reset)
 * - REST API for all data access
 * - Dashboard SPA served at /dashboard/
 * - Session management, belief graph, config, logs, health
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { getPool, query, queryMany, queryOne, queryVal, closePool } from "./db.js";
import {
  getActiveBeliefs,
  getBeliefsAboveThreshold,
  getConnectedBeliefs,
  getContradictions,
  seedBeliefs,
  getBelief,
  createBelief,
  connectBeliefs,
  addTension,
  reinforceBelief,
} from "./belief-graph.js";
import { computeDissatisfaction, getDissatisfactionBreakdown, describeState } from "./dissatisfaction.js";
import { getRecentRevisions, reviseBelief } from "./revision-engine.js";
import { processInteraction } from "./orchestrator.js";
import type { Belief, RevisionResult, RelationType } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3300", 10);
const startTime = Date.now();

// ── Event Log (in-memory ring buffer) ─────────────────────────────

interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
  data?: any;
}

const LOG_MAX = 500;
const eventLog: LogEntry[] = [];

function log(level: LogEntry["level"], source: string, message: string, data?: any) {
  const entry: LogEntry = { ts: Date.now(), level, source, message, data };
  eventLog.push(entry);
  if (eventLog.length > LOG_MAX) eventLog.shift();
  if (level === "error") console.error(`[${source}] ${message}`, data ?? "");
}

// ── WebSocket Clients ─────────────────────────────────────────────

interface WsClient {
  ws: WebSocket;
  id: string;
  connectedAt: number;
  sessionKey?: string;
  subscriptions: Set<string>;
}

let clientIdCounter = 0;
const clients = new Map<string, WsClient>();

function broadcast(event: string, data: any) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
  log("debug", "ws", `broadcast: ${event}`, { clients: clients.size });
}

function sendTo(clientId: string, event: string, data: any) {
  const client = clients.get(clientId);
  if (client?.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({ event, data, ts: Date.now() }));
  }
}

// ── JSON Helpers ──────────────────────────────────────────────────

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function cors(res: ServerResponse) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function parseJson(raw: string): any {
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Route Handler ─────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return cors(res);

  try {
    // ════════════════════════════════════════════════════════
    // OVERVIEW / SNAPSHOT (OpenClaw: connect → hello.snapshot)
    // ════════════════════════════════════════════════════════
    if (path === "/api/overview" && method === "GET") {
      const beliefs = await getActiveBeliefs();
      const dissatisfaction = await computeDissatisfaction();
      const breakdown = await getDissatisfactionBreakdown();
      const revisions = await getRecentRevisions(5);
      const highTension = beliefs.filter((b) => b.tension > 0.3);
      const interactions = await queryVal<number>("SELECT COUNT(*)::int FROM interactions");
      const totalRevisions = await queryVal<number>("SELECT COUNT(*)::int FROM revisions");
      const edges = await queryVal<number>(
        "SELECT COUNT(*)::int FROM belief_connections WHERE belief_a IN (SELECT id FROM beliefs WHERE is_active = true)",
      );
      const contradictions = await queryVal<number>("SELECT COUNT(*)::int FROM contradiction_log");

      return json(res, {
        beliefs: beliefs.length,
        dissatisfaction,
        dissatisfaction_state: describeState(dissatisfaction),
        high_tension: highTension.length,
        interactions: interactions ?? 0,
        revisions_total: totalRevisions ?? 0,
        edges: edges ?? 0,
        contradictions_total: contradictions ?? 0,
        uptime_ms: Date.now() - startTime,
        ws_clients: clients.size,
        recent_revisions: revisions,
        breakdown,
      });
    }

    // ════════════════════════════════════════════════════════
    // BELIEFS (OpenClaw: agents.list, agents.files)
    // ════════════════════════════════════════════════════════
    if (path === "/api/beliefs" && method === "GET") {
      const domain = url.searchParams.get("domain") ?? undefined;
      const beliefs = await getActiveBeliefs(domain);
      const enriched = await Promise.all(
        beliefs.map(async (b) => {
          const connections = await getConnectedBeliefs(b.id, 1);
          const contras = await getContradictions(b.id, 5);
          return {
            ...b,
            connections_count: connections.length,
            recent_contradictions: contras.map((c) => ({
              evidence: c.evidence,
              delta: c.tension_delta,
              created_at: c.created_at,
            })),
          };
        }),
      );
      return json(res, enriched);
    }

    if (path === "/api/beliefs" && method === "POST") {
      const body = parseJson(await readBody(req));
      if (!body?.content) return json(res, { error: "content required" }, 400);
      const belief = await createBelief(
        body.content,
        body.domain ?? "self",
        body.confidence ?? 0.5,
        body.importance ?? 0.5,
      );
      log("info", "beliefs", `Created belief: ${belief.content.slice(0, 50)}`);
      broadcast("belief.created", belief);
      return json(res, belief, 201);
    }

    if (path.match(/^\/api\/beliefs\/[^/]+$/) && method === "GET") {
      const id = path.split("/")[3];
      const belief = await getBelief(id);
      if (!belief) return json(res, { error: "not found" }, 404);
      const connections = await getConnectedBeliefs(id, 2);
      const contradictions = await getContradictions(id, 50);
      return json(res, { ...belief, connections, contradictions });
    }

    // Manually trigger revision on a belief
    if (path.match(/^\/api\/beliefs\/[^/]+\/revise$/) && method === "POST") {
      const id = path.split("/")[3];
      const belief = await getBelief(id);
      if (!belief) return json(res, { error: "not found" }, 404);
      log("info", "revision", `Manual revision triggered for: ${belief.content.slice(0, 40)}`);
      broadcast("revision.started", { belief_id: id });
      const result = await reviseBelief(belief);
      broadcast("revision", result);
      log("info", "revision", `Revision complete: ${result.status}`);
      return json(res, result);
    }

    // Add tension to a belief manually
    if (path.match(/^\/api\/beliefs\/[^/]+\/tension$/) && method === "POST") {
      const id = path.split("/")[3];
      const body = parseJson(await readBody(req));
      const delta = parseFloat(body?.delta ?? "0.1");
      const updated = await addTension(id, delta);
      if (!updated) return json(res, { error: "not found" }, 404);
      broadcast("tension.update", { belief_id: id, tension: updated.tension, delta });
      return json(res, updated);
    }

    // Reinforce a belief
    if (path.match(/^\/api\/beliefs\/[^/]+\/reinforce$/) && method === "POST") {
      const id = path.split("/")[3];
      const updated = await reinforceBelief(id);
      if (!updated) return json(res, { error: "not found" }, 404);
      broadcast("confidence.update", { belief_id: id, confidence: updated.confidence });
      return json(res, updated);
    }

    // ════════════════════════════════════════════════════════
    // CONNECTIONS (OpenClaw: nodes)
    // ════════════════════════════════════════════════════════
    if (path === "/api/connections" && method === "GET") {
      const edges = await queryMany(
        `SELECT c.*, a.content as a_content, b.content as b_content,
                a.tension as a_tension, b.tension as b_tension
         FROM belief_connections c
         JOIN beliefs a ON c.belief_a = a.id
         JOIN beliefs b ON c.belief_b = b.id
         WHERE a.is_active = true AND b.is_active = true
         ORDER BY c.strength DESC`,
      );
      return json(res, edges);
    }

    if (path === "/api/connections" && method === "POST") {
      const body = parseJson(await readBody(req));
      if (!body?.belief_a || !body?.belief_b) return json(res, { error: "belief_a and belief_b required" }, 400);
      await connectBeliefs(
        body.belief_a, body.belief_b,
        body.relation ?? "supports",
        body.strength ?? 0.5,
        body.method ?? "manual",
        body.reasoning,
      );
      broadcast("connection.created", body);
      return json(res, { status: "connected" });
    }

    // ════════════════════════════════════════════════════════
    // GRAPH (visual data for canvas rendering)
    // ════════════════════════════════════════════════════════
    if (path === "/api/graph" && method === "GET") {
      const beliefs = await getActiveBeliefs();
      const edges = await queryMany(
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
          id: b.id, content: b.content, domain: b.domain,
          confidence: b.confidence, tension: b.tension, importance: b.importance,
        })),
        edges: edges.map((e: any) => ({
          source: e.belief_a, target: e.belief_b, relation: e.relation,
          strength: e.strength, discovery_method: e.discovery_method,
          discovery_reasoning: e.discovery_reasoning,
          source_content: e.a_content, target_content: e.b_content,
        })),
      });
    }

    // ════════════════════════════════════════════════════════
    // DISSATISFACTION (OpenClaw: usage.status)
    // ════════════════════════════════════════════════════════
    if (path === "/api/dissatisfaction" && method === "GET") {
      const d = await computeDissatisfaction();
      const breakdown = await getDissatisfactionBreakdown();
      return json(res, { value: d, state: describeState(d), breakdown });
    }

    // ════════════════════════════════════════════════════════
    // REVISIONS (OpenClaw: logs)
    // ════════════════════════════════════════════════════════
    if (path === "/api/revisions" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const revisions = await getRecentRevisions(limit);
      return json(res, revisions);
    }

    // ════════════════════════════════════════════════════════
    // SESSIONS (OpenClaw: sessions.list, sessions.preview)
    // ════════════════════════════════════════════════════════
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

    // Session delete (OpenClaw: sessions.delete)
    if (path.match(/^\/api\/sessions\/[^/]+$/) && method === "DELETE") {
      const sid = decodeURIComponent(path.split("/")[3]);
      await query("DELETE FROM interactions WHERE session_id = $1", [sid]);
      log("info", "sessions", `Deleted session: ${sid}`);
      return json(res, { status: "deleted", session_id: sid });
    }

    // ════════════════════════════════════════════════════════
    // INTERACTIONS / CHAT HISTORY (OpenClaw: chat.history)
    // ════════════════════════════════════════════════════════
    if (path === "/api/interactions" && method === "GET") {
      const session = url.searchParams.get("session") ?? "default";
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const interactions = await queryMany(
        `SELECT id, session_id, user_message, assistant_response,
                dissatisfaction_at_time, revision_triggered, created_at
         FROM interactions WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [session, limit, offset],
      );
      return json(res, interactions);
    }

    // ════════════════════════════════════════════════════════
    // CHAT (OpenClaw: chat.send)
    // ════════════════════════════════════════════════════════
    if (path === "/api/chat" && method === "POST") {
      const body = parseJson(await readBody(req));
      const message = body?.message ?? "";
      const sessionId = body?.session_id ?? "dashboard";

      if (!message.trim()) return json(res, { error: "empty message" }, 400);

      log("info", "chat", `Message in session ${sessionId}: ${message.slice(0, 60)}`);
      broadcast("thinking", { session_id: sessionId });

      const result = await processInteraction(message, sessionId, (rev) => {
        broadcast("revision", rev);
        log("info", "revision", `Phase transition: ${rev.old_belief?.slice(0, 40)} → ${rev.new_belief?.slice(0, 40)}`);
      });

      broadcast("response", {
        session_id: sessionId,
        response: result.response,
        dissatisfaction: result.dissatisfaction,
        evidence_extracted: result.evidence_extracted,
      });

      // Broadcast tension updates
      broadcast("state.update", {
        dissatisfaction: result.dissatisfaction,
        beliefs_count: result.beliefs_count,
        evidence_extracted: result.evidence_extracted,
      });

      log("info", "chat", `Response generated. d=${result.dissatisfaction.toFixed(3)} evidence=${result.evidence_extracted}`);
      return json(res, result);
    }

    // ════════════════════════════════════════════════════════
    // CHAT ABORT (OpenClaw: chat.abort) — stub for now
    // ════════════════════════════════════════════════════════
    if (path === "/api/chat/abort" && method === "POST") {
      // TODO: implement actual abort via AbortController
      return json(res, { status: "abort_requested" });
    }

    // ════════════════════════════════════════════════════════
    // SEED (OpenClaw: wizard)
    // ════════════════════════════════════════════════════════
    if (path === "/api/seed" && method === "POST") {
      const seeded = await seedBeliefs();
      if (seeded) log("info", "seed", "Initial beliefs seeded");
      return json(res, { seeded });
    }

    // ════════════════════════════════════════════════════════
    // TIMELINE (OpenClaw: sessions.usage.timeseries)
    // ════════════════════════════════════════════════════════
    if (path === "/api/timeline" && method === "GET") {
      const rows = await queryMany(
        `SELECT i.created_at, i.dissatisfaction_at_time,
                i.revision_triggered, i.session_id,
                LENGTH(i.user_message) as msg_length
         FROM interactions i ORDER BY i.created_at ASC LIMIT 500`,
      );
      return json(res, rows);
    }

    // ════════════════════════════════════════════════════════
    // USAGE STATS (OpenClaw: usage.status, sessions.usage)
    // ════════════════════════════════════════════════════════
    if (path === "/api/usage" && method === "GET") {
      const totalInteractions = await queryVal<number>("SELECT COUNT(*)::int FROM interactions");
      const totalRevisions = await queryVal<number>("SELECT COUNT(*)::int FROM revisions");
      const totalContradictions = await queryVal<number>("SELECT COUNT(*)::int FROM contradiction_log");
      const totalBeliefs = await queryVal<number>("SELECT COUNT(*)::int FROM beliefs");
      const activeBeliefs = await queryVal<number>("SELECT COUNT(*)::int FROM beliefs WHERE is_active = true");
      const superseded = await queryVal<number>("SELECT COUNT(*)::int FROM beliefs WHERE is_active = false");
      const totalEdges = await queryVal<number>("SELECT COUNT(*)::int FROM belief_connections");
      const discoveredEdges = await queryVal<number>(
        "SELECT COUNT(*)::int FROM belief_connections WHERE discovery_method = 'llm_revision'",
      );

      // Per-session usage
      const sessionUsage = await queryMany(
        `SELECT session_id, COUNT(*)::int as interactions,
                SUM(CASE WHEN revision_triggered THEN 1 ELSE 0 END)::int as revisions,
                AVG(dissatisfaction_at_time) as avg_dissatisfaction,
                MAX(created_at) as last_active
         FROM interactions GROUP BY session_id ORDER BY last_active DESC`,
      );

      return json(res, {
        totals: {
          interactions: totalInteractions ?? 0,
          revisions: totalRevisions ?? 0,
          contradictions: totalContradictions ?? 0,
          beliefs_total: totalBeliefs ?? 0,
          beliefs_active: activeBeliefs ?? 0,
          beliefs_superseded: superseded ?? 0,
          edges_total: totalEdges ?? 0,
          edges_discovered: discoveredEdges ?? 0,
        },
        sessions: sessionUsage,
        uptime_ms: Date.now() - startTime,
      });
    }

    // ════════════════════════════════════════════════════════
    // CONFIG (OpenClaw: config.get, config.schema)
    // ════════════════════════════════════════════════════════
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
        port: PORT,
        database: "postgresql://...:" + PORT.toString().slice(-2) + "/anxious_intelligence",
      });
    }

    // ════════════════════════════════════════════════════════
    // LOGS (OpenClaw: logs.tail)
    // ════════════════════════════════════════════════════════
    if (path === "/api/logs" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      const level = url.searchParams.get("level") ?? undefined;
      const source = url.searchParams.get("source") ?? undefined;
      let filtered = eventLog;
      if (level) filtered = filtered.filter((l) => l.level === level);
      if (source) filtered = filtered.filter((l) => l.source === source);
      return json(res, filtered.slice(-limit));
    }

    // ════════════════════════════════════════════════════════
    // BELIEF HISTORY (superseded chain)
    // ════════════════════════════════════════════════════════
    if (path === "/api/belief-history" && method === "GET") {
      const rows = await queryMany(
        `SELECT b.*, s.content as supersedes_content
         FROM beliefs b
         LEFT JOIN beliefs s ON b.superseded_by = s.id
         ORDER BY b.created_at DESC LIMIT 100`,
      );
      return json(res, rows);
    }

    // ════════════════════════════════════════════════════════
    // CONTRADICTION LOG (detailed)
    // ════════════════════════════════════════════════════════
    if (path === "/api/contradictions" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      const rows = await queryMany(
        `SELECT cl.*, b.content as belief_content
         FROM contradiction_log cl
         JOIN beliefs b ON cl.belief_id = b.id
         ORDER BY cl.created_at DESC LIMIT $1`,
        [limit],
      );
      return json(res, rows);
    }

    // ════════════════════════════════════════════════════════
    // PRESENCE (OpenClaw: system-presence)
    // ════════════════════════════════════════════════════════
    if (path === "/api/presence" && method === "GET") {
      const entries = Array.from(clients.values()).map((c) => ({
        id: c.id,
        connected_at: c.connectedAt,
        session_key: c.sessionKey,
        subscriptions: Array.from(c.subscriptions),
      }));
      return json(res, { count: entries.length, clients: entries });
    }

    // ════════════════════════════════════════════════════════
    // RESET (danger zone)
    // ════════════════════════════════════════════════════════
    if (path === "/api/reset" && method === "POST") {
      for (const table of ["revisions", "contradiction_log", "interactions", "belief_connections", "beliefs"]) {
        await query(`DELETE FROM ${table}`);
      }
      await seedBeliefs();
      broadcast("reset", { ts: Date.now() });
      log("warn", "system", "Full system reset performed");
      return json(res, { status: "reset", seeded: true });
    }

    // ════════════════════════════════════════════════════════
    // HEALTH (OpenClaw: health)
    // ════════════════════════════════════════════════════════
    if (path === "/api/health" && method === "GET") {
      const dbOk = await queryVal<number>("SELECT 1");
      return json(res, {
        status: "ok",
        db: !!dbOk,
        uptime_ms: Date.now() - startTime,
        uptime_s: Math.round((Date.now() - startTime) / 1000),
        ws_clients: clients.size,
        log_entries: eventLog.length,
        version: "0.1.0",
      });
    }

    // ════════════════════════════════════════════════════════
    // EXPORT (full state dump)
    // ════════════════════════════════════════════════════════
    if (path === "/api/export" && method === "GET") {
      const beliefs = await queryMany("SELECT * FROM beliefs ORDER BY created_at");
      const connections = await queryMany("SELECT * FROM belief_connections");
      const interactions_data = await queryMany("SELECT * FROM interactions ORDER BY created_at");
      const revisions = await queryMany("SELECT * FROM revisions ORDER BY created_at");
      const contradictions = await queryMany("SELECT * FROM contradiction_log ORDER BY created_at");
      return json(res, {
        exported_at: new Date().toISOString(),
        beliefs, connections, interactions: interactions_data, revisions, contradictions,
      });
    }

    // ════════════════════════════════════════════════════════
    // DASHBOARD SPA
    // ════════════════════════════════════════════════════════
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

    json(res, { error: "not found", path }, 404);
  } catch (err) {
    log("error", "api", `${method} ${path}: ${err}`);
    json(res, { error: String(err) }, 500);
  }
}

// ── WebSocket Handler ─────────────────────────────────────────────

function handleWsMessage(client: WsClient, raw: string) {
  const msg = parseJson(raw);
  if (!msg) return;

  // Client can subscribe to specific events
  if (msg.action === "subscribe" && typeof msg.event === "string") {
    client.subscriptions.add(msg.event);
    sendTo(client.id, "subscribed", { event: msg.event });
  }

  // Client can set their session key
  if (msg.action === "session" && typeof msg.session_key === "string") {
    client.sessionKey = msg.session_key;
    sendTo(client.id, "session.set", { session_key: msg.session_key });
  }

  // Ping/pong
  if (msg.action === "ping") {
    sendTo(client.id, "pong", { ts: Date.now() });
  }
}

// ── Server ────────────────────────────────────────────────────────

export function startServer() {
  getPool();

  const server = createServer(handleRequest);

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    const id = `ws-${++clientIdCounter}`;
    const client: WsClient = {
      ws, id,
      connectedAt: Date.now(),
      subscriptions: new Set(["*"]),
    };
    clients.set(id, client);
    log("info", "ws", `Client connected: ${id}`);

    ws.on("message", (raw) => handleWsMessage(client, raw.toString()));
    ws.on("close", () => {
      clients.delete(id);
      log("info", "ws", `Client disconnected: ${id}`);
    });
    ws.on("error", () => clients.delete(id));

    // Send initial state
    (async () => {
      const d = await computeDissatisfaction();
      const beliefs = await getActiveBeliefs();
      sendTo(id, "init", {
        dissatisfaction: d,
        dissatisfaction_state: describeState(d),
        beliefs_count: beliefs.length,
        high_tension: beliefs.filter((b) => b.tension > 0.3).length,
        ws_clients: clients.size,
        uptime_ms: Date.now() - startTime,
      });
    })();
  });

  // Graceful shutdown
  const shutdown = async () => {
    log("info", "system", "Shutting down...");
    for (const client of clients.values()) {
      client.ws.close(1001, "server shutting down");
    }
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(PORT, "0.0.0.0", () => {
    log("info", "system", `Gateway started on port ${PORT}`);
    console.log(`\n  🧠 Anxious Intelligence gateway on http://0.0.0.0:${PORT}`);
    console.log(`  📡 WebSocket on ws://localhost:${PORT}/ws`);
    console.log(`  📊 Dashboard on http://localhost:${PORT}/dashboard/`);
    console.log(`  📋 API docs: GET /api/health, /api/overview, /api/beliefs, /api/graph, ...`);
    console.log(`  📦 Export: GET /api/export\n`);
  });

  return server;
}

// Run if invoked directly
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  startServer();
}
