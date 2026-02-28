/**
 * Orchestrator — the main interaction loop.
 * Supports multi-turn conversation, agentic tool use, timeouts, and concurrent requests.
 */

import { getActiveBeliefs, getBeliefsAboveThreshold } from "./belief-graph.js";
import { callClaudeWithTools, type ClaudeMessage, type ToolMessage, type ContentBlock, type ToolResultBlock } from "./claude.js";
import { computeDissatisfaction, describeState } from "./dissatisfaction.js";
import { extractEvidence } from "./evidence-extractor.js";
import { formatBeliefsForPrompt } from "./prompts.js";
import { systemPromptWithBeliefs } from "./prompts.js";
import { reviseAllTriggered, getRecentRevisions } from "./revision-engine.js";
import { accumulate } from "./tension-accumulator.js";
import { queryVal, query } from "./db.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import type { InteractionResult, RevisionResult } from "./types.js";

// ── Session History Store ─────────────────────────────────────────

const MAX_HISTORY = 20;
const sessionHistories = new Map<string, ClaudeMessage[]>();

export function getSessionHistory(sessionId: string): ClaudeMessage[] {
  return sessionHistories.get(sessionId) ?? [];
}

function appendToHistory(sessionId: string, role: "user" | "assistant", content: string) {
  let history = sessionHistories.get(sessionId);
  if (!history) {
    history = [];
    sessionHistories.set(sessionId, history);
  }
  history.push({ role, content });
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
    if (history.length && history[0].role === "assistant") {
      history.shift();
    }
  }
}

// ── Timeout helper ────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Processing lock per session ───────────────────────────────────
// Prevents concurrent processing on the same session (queues instead of blocking)

// Track if a user (non-autonomous) request is active
let _userRequestActive = false;
export function isUserRequestActive(): boolean { return _userRequestActive; }

const sessionLocks = new Map<string, Promise<any>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run even if previous errored
  sessionLocks.set(sessionId, next.catch(() => {}));
  // Clean up after completion
  next.finally(() => {
    if (sessionLocks.get(sessionId) === next.catch(() => {})) {
      sessionLocks.delete(sessionId);
    }
  });
  return next;
}

// ── Agentic Tool Loop ─────────────────────────────────────────────

const MAX_TOOL_ITERATIONS = Infinity; // no iteration limit — only time-bound
const LOOP_TIMEOUT_MS = 15 * 60 * 1000; // 15 min overall timeout
const TOOL_EXEC_TIMEOUT_MS = 45_000; // 45s per tool execution

async function runAgenticLoop(
  system: string,
  initialMessages: ToolMessage[],
  onEvent?: (event: string, data: any) => void,
): Promise<{ response: string; toolsUsed: Array<{ name: string; input: any; output: string }> }> {
  const messages: ToolMessage[] = [...initialMessages];
  const toolsUsed: Array<{ name: string; input: any; output: string }> = [];
  let iteration = 0;
  const loopStart = Date.now();

  while (iteration < MAX_TOOL_ITERATIONS) {
    // Check overall timeout
    if (Date.now() - loopStart > LOOP_TIMEOUT_MS) {
      console.warn(`[agentic loop] Overall timeout after ${iteration} iterations`);
      return {
        response: toolsUsed.length
          ? `I ran out of time after ${iteration} tool calls. Here's what I found so far — please ask me to continue if needed.`
          : "I timed out before completing the response. Please try again.",
        toolsUsed,
      };
    }

    iteration++;
    onEvent?.("thinking", { iteration });

    let contentBlocks: ContentBlock[];
    try {
      contentBlocks = await callClaudeWithTools(system, messages, TOOL_DEFINITIONS);
    } catch (err: any) {
      console.error(`[agentic loop] Claude API error on iteration ${iteration}:`, err.message);
      onEvent?.("error", { message: `API error: ${err.message}` });
      return {
        response: toolsUsed.length
          ? `I encountered an error after ${toolsUsed.length} tool call(s): ${err.message}`
          : `Error communicating with the model: ${err.message}`,
        toolsUsed,
      };
    }

    const textBlocks = contentBlocks.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text");
    const toolUseBlocks = contentBlocks.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");

    if (!toolUseBlocks.length) {
      return {
        response: textBlocks.map((b) => b.text).join(""),
        toolsUsed,
      };
    }

    // Execute all tool calls
    const toolResults: ToolResultBlock[] = [];
    for (const tb of toolUseBlocks) {
      onEvent?.("tool_call", { name: tb.name, input: tb.input });
      let output: string;
      try {
        output = await withTimeout(
          executeTool(tb.name, tb.input),
          TOOL_EXEC_TIMEOUT_MS,
          `tool:${tb.name}`,
        );
      } catch (err: any) {
        output = `Tool error: ${err.message}`;
      }
      // Truncate large outputs
      const MAX_TOOL_OUTPUT = 8000;
      if (output.length > MAX_TOOL_OUTPUT) {
        output = output.slice(0, MAX_TOOL_OUTPUT) + `\n\n[truncated — ${output.length} chars total]`;
      }
      onEvent?.("tool_result", { name: tb.name, output: output.slice(0, 2000) }); // truncate SSE event too
      toolResults.push({
        type: "tool_result",
        tool_use_id: tb.id,
        content: output,
      });
      toolsUsed.push({ name: tb.name, input: tb.input, output });
    }

    messages.push({ role: "assistant", content: contentBlocks });
    messages.push({ role: "user", content: toolResults });

    // Compact old tool results to keep context manageable
    // After 10 tool rounds (20 messages = 10 assistant + 10 user), 
    // truncate old tool_result content to summaries
    const toolMsgCount = messages.filter(m => Array.isArray(m.content)).length;
    if (toolMsgCount > 20) {
      // Truncate tool results older than the last 6 exchanges
      const keepRecent = 12; // last 6 pairs
      let toolIdx = 0;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (Array.isArray(msg.content)) {
          toolIdx++;
          const fromEnd = toolMsgCount - toolIdx;
          if (fromEnd >= keepRecent && msg.role === "user") {
            // This is an old tool_result message — truncate content
            for (const block of msg.content as any[]) {
              if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 200) {
                block.content = block.content.slice(0, 200) + "\n[earlier output truncated to save context]";
              }
            }
          }
        }
      }
    }
  }

  return {
    response: toolsUsed.length
      ? "I ran out of time on this task. Ask me to continue where I left off."
      : "Processing timed out. Please try again.",
    toolsUsed,
  };
}

// ── Main Processing Loop ──────────────────────────────────────────

export async function processInteraction(
  userMessage: string,
  sessionId = "default",
  onRevision?: (rev: RevisionResult) => void,
  onEvent?: (event: string, data: any) => void,
): Promise<InteractionResult> {
  const isUser = sessionId !== "autonomous";
  if (isUser) _userRequestActive = true;
  try {
    return await withSessionLock(sessionId, () =>
      _processInteraction(userMessage, sessionId, onRevision, onEvent),
    );
  } finally {
    if (isUser) _userRequestActive = false;
  }
}

async function _processInteraction(
  userMessage: string,
  sessionId: string,
  onRevision?: (rev: RevisionResult) => void,
  onEvent?: (event: string, data: any) => void,
): Promise<InteractionResult> {
  // 1. Current state
  let dissatisfaction = await computeDissatisfaction();
  let activeBeliefs = await getActiveBeliefs();

  // 2. Pre-check: urgent revisions (with timeout)
  const urgent = await getBeliefsAboveThreshold();
  let preRevisions: RevisionResult[] = [];
  if (urgent.length && dissatisfaction > 0.6) {
    try {
      preRevisions = await withTimeout(
        reviseAllTriggered(urgent),
        60_000,
        "pre-revision",
      );
      for (const rev of preRevisions) onRevision?.(rev);
      activeBeliefs = await getActiveBeliefs();
      dissatisfaction = await computeDissatisfaction();
    } catch (err: any) {
      console.error("[orchestrator] Pre-revision timeout:", err.message);
    }
  }

  // 3. Build system prompt
  const beliefsSummary = formatBeliefsForPrompt(activeBeliefs);
  const recentRevs = await getRecentRevisions(3);
  const revisionText = recentRevs
    .map((r) => `- "${r.old_content}" → "${r.new_content}"`)
    .join("\n");

  const system = systemPromptWithBeliefs(beliefsSummary, dissatisfaction, revisionText);

  // 4. History + current message
  const history = getSessionHistory(sessionId);
  const initialMessages: ToolMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: userMessage },
  ];

  // 5. Agentic loop
  const { response, toolsUsed } = await runAgenticLoop(system, initialMessages, onEvent);

  // 6. Store in history
  appendToHistory(sessionId, "user", userMessage);
  appendToHistory(sessionId, "assistant", response);

  // 7. Evidence extraction (non-blocking — don't let it freeze the response)
  let evidence: any[] = [];
  try {
    evidence = await withTimeout(
      extractEvidence(userMessage, response, activeBeliefs),
      30_000,
      "evidence-extraction",
    );
  } catch (err: any) {
    console.error("[orchestrator] Evidence extraction timeout:", err.message);
  }

  // 8. Log interaction
  const interactionId = await queryVal<string>(
    `INSERT INTO interactions (session_id, user_message, assistant_response, extracted_claims, dissatisfaction_at_time)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [sessionId, userMessage, response, JSON.stringify(evidence), dissatisfaction],
  );

  // 9. Tension + revisions (fire-and-forget — don't block the response)
  setImmediate(async () => {
    try {
      const triggered = await accumulate(evidence, interactionId);
      if (triggered.length) {
        const postRevisions = await withTimeout(
          reviseAllTriggered(triggered),
          60_000,
          "post-revision",
        );
        for (const rev of postRevisions) onRevision?.(rev);
        if (interactionId) {
          await query("UPDATE interactions SET revision_triggered = true WHERE id = $1", [interactionId]);
        }
      }
    } catch (err: any) {
      console.error("[orchestrator] Post-processing error:", err.message);
    }
  });

  const finalDissatisfaction = await computeDissatisfaction();

  return {
    response,
    session_id: sessionId,
    dissatisfaction: finalDissatisfaction,
    dissatisfaction_state: describeState(finalDissatisfaction),
    evidence_extracted: evidence.length,
    pre_revisions: preRevisions,
    post_revisions: [],
    beliefs_count: activeBeliefs.length,
    tools_used: toolsUsed,
  };
}
