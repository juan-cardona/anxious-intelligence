/**
 * Orchestrator — the main interaction loop.
 * 
 * Features:
 * - Unlimited tool iterations (time-bound only)
 * - Context compaction to stay under token limits
 * - Rate limit handling with backoff
 * - Session locking for concurrent safety
 * - Non-blocking post-processing (evidence, revisions)
 */

import { getActiveBeliefs, getBeliefsAboveThreshold } from "./belief-graph.js";
import { callClaude, callClaudeWithTools, type ClaudeMessage, type ToolMessage, type ContentBlock, type ToolResultBlock, type TextBlock, type ToolUseBlock } from "./claude.js";
import { computeDissatisfaction, describeState } from "./dissatisfaction.js";
import { extractEvidence } from "./evidence-extractor.js";
import { formatBeliefsForPrompt } from "./prompts.js";
import { systemPromptWithBeliefs } from "./prompts.js";
import { reviseAllTriggered, getRecentRevisions } from "./revision-engine.js";
import { accumulate } from "./tension-accumulator.js";
import { queryVal, query } from "./db.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import type { InteractionResult, RevisionResult } from "./types.js";

// ── Session History ───────────────────────────────────────────────

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
    if (history.length && history[0].role === "assistant") history.shift();
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── User request priority ─────────────────────────────────────────

let _userRequestActive = false;
export function isUserRequestActive(): boolean { return _userRequestActive; }

// ── Session locking ───────────────────────────────────────────────

const sessionLocks = new Map<string, Promise<any>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  sessionLocks.set(sessionId, next.catch(() => {}));
  next.finally(() => {
    if (sessionLocks.get(sessionId) === next.catch(() => {})) {
      sessionLocks.delete(sessionId);
    }
  });
  return next;
}

// ── Token estimation ──────────────────────────────────────────────

function estimateTokens(messages: ToolMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ("text" in block) chars += (block as any).text.length;
        if ("content" in block) chars += String((block as any).content).length;
        if ("input" in block) chars += JSON.stringify((block as any).input).length;
      }
    }
  }
  return Math.ceil(chars / 3.5); // rough chars-to-tokens ratio
}

// ── Context compaction ────────────────────────────────────────────
// When messages get too large, summarize old tool exchanges

// ── Session Pruning (OpenClaw-style) ──────────────────────────────
// Two mechanisms, matching OpenClaw's approach:
//
// 1. PRUNING (per-request, transient): Soft-trim/hard-clear old tool results
//    - Only affects tool_result messages
//    - Keeps last N assistant exchanges fully intact
//    - Soft-trim: head + tail of oversized results
//    - Hard-clear: replace very old results with placeholder
//
// 2. COMPACTION (at context limit): LLM-powered summarization
//    - Only triggers near context window limit (180k tokens)
//    - Summarizes and replaces old exchanges
//    - Last resort, not the primary mechanism

const KEEP_LAST_ASSISTANTS = 3;
const SOFT_TRIM_MAX_CHARS = 4000;
const SOFT_TRIM_HEAD = 1500;
const SOFT_TRIM_TAIL = 1500;
const HARD_CLEAR_PLACEHOLDER = "[Old tool result content cleared]";
const MIN_PRUNABLE_CHARS = 2000; // Don't bother trimming small results
const COMPACTION_TRIGGER_TOKENS = 180_000; // Only compact near context window limit

function pruneMessages(messages: ToolMessage[]): ToolMessage[] {
  // Find assistant message indices (tool exchange pairs)
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant" && Array.isArray(messages[i].content)) {
      assistantIndices.push(i);
    }
  }

  if (assistantIndices.length <= KEEP_LAST_ASSISTANTS) return messages;

  // Determine cutoff: protect last N assistant exchanges
  const protectedFrom = assistantIndices[assistantIndices.length - KEEP_LAST_ASSISTANTS];

  for (let i = 0; i < messages.length; i++) {
    if (i >= protectedFrom) break; // Protected zone

    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content as any[]) {
      if (block.type !== "tool_result" || typeof block.content !== "string") continue;

      const len = block.content.length;
      if (len < MIN_PRUNABLE_CHARS) continue;

      if (len > SOFT_TRIM_MAX_CHARS) {
        // Hard-clear very old, very large results
        const assistantsAfter = assistantIndices.filter(a => a > i).length;
        if (assistantsAfter > KEEP_LAST_ASSISTANTS + 2) {
          block.content = HARD_CLEAR_PLACEHOLDER;
          continue;
        }

        // Soft-trim: keep head + tail
        const head = block.content.slice(0, SOFT_TRIM_HEAD);
        const tail = block.content.slice(-SOFT_TRIM_TAIL);
        block.content = `${head}\n\n... [${len} chars, soft-trimmed] ...\n\n${tail}`;
      }
    }
  }

  // Check if compaction needed (near context window)
  const est = estimateTokens(messages);
  if (est < COMPACTION_TRIGGER_TOKENS) return messages;

  // Full compaction: summarize old exchanges
  console.log(`[compaction] ~${est} tokens (near limit), compacting old exchanges`);

  let toolStartIdx = assistantIndices[0] ?? -1;
  if (toolStartIdx < 0) return messages;

  const prefix = messages.slice(0, toolStartIdx);
  const toolExchanges = messages.slice(toolStartIdx);
  const pairCount = Math.floor(toolExchanges.length / 2);
  const keepPairs = KEEP_LAST_ASSISTANTS;
  const dropCount = pairCount - keepPairs;
  if (dropCount <= 0) return messages;

  const kept = toolExchanges.slice(dropCount * 2);

  // Brief summary of dropped exchanges
  const lines: string[] = [];
  for (let i = 0; i < dropCount * 2; i += 2) {
    const a = toolExchanges[i];
    if (Array.isArray(a?.content)) {
      for (const b of a.content as any[]) {
        if (b.type === "tool_use") {
          lines.push(`- ${b.name}(${JSON.stringify(b.input).slice(0, 60)})`);
        }
      }
    }
  }

  const summary = `[Compacted: ${dropCount} tool exchanges dropped]\nTools used: ${lines.slice(0, 20).join(", ")}${lines.length > 20 ? ` +${lines.length - 20} more` : ""}`;

  const result: ToolMessage[] = [
    ...prefix,
    { role: "user", content: summary },
    { role: "assistant", content: "Understood, continuing." },
    ...kept,
  ];

  const newEst = estimateTokens(result);
  console.log(`[compaction] ${est} → ${newEst} tokens`);
  return result;
}

// ── Agentic Tool Loop ─────────────────────────────────────────────

const LOOP_TIMEOUT_MS = 15 * 60 * 1000; // 15 min
const TOOL_EXEC_TIMEOUT_MS = 45_000;
const MAX_TOOL_OUTPUT = 8000; // Pruning handles old results — keep fresh ones useful

async function runAgenticLoop(
  system: string,
  initialMessages: ToolMessage[],
  onEvent?: (event: string, data: any) => void,
): Promise<{ response: string; toolsUsed: Array<{ name: string; input: any; output: string }> }> {
  let messages: ToolMessage[] = [...initialMessages];
  const toolsUsed: Array<{ name: string; input: any; output: string }> = [];
  let iteration = 0;
  const loopStart = Date.now();

  while (true) {
    // Time check
    const elapsed = Date.now() - loopStart;
    if (elapsed > LOOP_TIMEOUT_MS) {
      console.warn(`[agentic] Timeout after ${iteration} iterations, ${elapsed}ms`);
      return {
        response: toolsUsed.length
          ? "I ran out of time. Ask me to continue where I left off."
          : "Processing timed out.",
        toolsUsed,
      };
    }

    iteration++;
    onEvent?.("thinking", { iteration, elapsed: Math.round(elapsed / 1000) });

    // Compact context if too large
    messages = pruneMessages(messages);

    // Call Claude
    let contentBlocks: ContentBlock[];
    try {
      contentBlocks = await callClaudeWithTools(system, messages, TOOL_DEFINITIONS);
    } catch (err: any) {
      console.error(`[agentic] API error iteration ${iteration}:`, err.message);
      onEvent?.("error", { message: err.message });
      return {
        response: toolsUsed.length
          ? `Error after ${toolsUsed.length} tool calls: ${err.message}. Ask me to continue.`
          : `Error: ${err.message}`,
        toolsUsed,
      };
    }

    const textBlocks = contentBlocks.filter((b): b is TextBlock => b.type === "text");
    const toolUseBlocks = contentBlocks.filter((b): b is ToolUseBlock => b.type === "tool_use");

    // If no tool calls, we're done
    if (!toolUseBlocks.length) {
      return {
        response: textBlocks.map((b) => b.text).join(""),
        toolsUsed,
      };
    }

    // Execute tools
    const toolResults: ToolResultBlock[] = [];
    for (const tb of toolUseBlocks) {
      onEvent?.("tool_call", { name: tb.name, input: tb.input });

      let output: string;
      try {
        output = await withTimeout(executeTool(tb.name, tb.input), TOOL_EXEC_TIMEOUT_MS, `tool:${tb.name}`);
      } catch (err: any) {
        output = `Error: ${err.message}`;
      }

      // Truncate
      if (output.length > MAX_TOOL_OUTPUT) {
        output = output.slice(0, MAX_TOOL_OUTPUT) + `\n[truncated, ${output.length} chars total]`;
      }

      onEvent?.("tool_result", { name: tb.name, output: output.slice(0, 2000) });

      toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: output });
      toolsUsed.push({ name: tb.name, input: tb.input, output });
    }

    // Add to conversation
    messages.push({ role: "assistant", content: contentBlocks });
    messages.push({ role: "user", content: toolResults });
  }
}

// ── Main Entry Point ──────────────────────────────────────────────

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
  // 1. State
  let dissatisfaction = await computeDissatisfaction();
  let activeBeliefs = await getActiveBeliefs();

  // 2. Pre-revisions (with timeout, non-fatal)
  const urgent = await getBeliefsAboveThreshold();
  let preRevisions: RevisionResult[] = [];
  if (urgent.length && dissatisfaction > 0.6) {
    try {
      preRevisions = await withTimeout(reviseAllTriggered(urgent), 60_000, "pre-revision");
      for (const rev of preRevisions) onRevision?.(rev);
      activeBeliefs = await getActiveBeliefs();
      dissatisfaction = await computeDissatisfaction();
    } catch (err: any) {
      console.error("[orchestrator] Pre-revision error:", err.message);
    }
  }

  // 3. System prompt
  const beliefsSummary = formatBeliefsForPrompt(activeBeliefs);
  const recentRevs = await getRecentRevisions(3);
  const revisionText = recentRevs.map((r) => `- "${r.old_content}" → "${r.new_content}"`).join("\n");
  const system = systemPromptWithBeliefs(beliefsSummary, dissatisfaction, revisionText);

  // 4. Messages
  const history = getSessionHistory(sessionId);
  const initialMessages: ToolMessage[] = [
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user" as const, content: userMessage },
  ];

  // 5. Agentic loop
  const { response, toolsUsed } = await runAgenticLoop(system, initialMessages, onEvent);

  // 6. History
  appendToHistory(sessionId, "user", userMessage);
  appendToHistory(sessionId, "assistant", response);

  // 7. Evidence extraction (non-blocking, timeout)
  let evidence: any[] = [];
  try {
    evidence = await withTimeout(extractEvidence(userMessage, response, activeBeliefs), 30_000, "evidence");
  } catch (err: any) {
    console.error("[orchestrator] Evidence extraction error:", err.message);
  }

  // 8. Log
  const interactionId = await queryVal<string>(
    `INSERT INTO interactions (session_id, user_message, assistant_response, extracted_claims, dissatisfaction_at_time)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [sessionId, userMessage, response, JSON.stringify(evidence), dissatisfaction],
  );

  // 9. Post-processing: tension + revisions (fire and forget)
  setImmediate(async () => {
    try {
      const triggered = await accumulate(evidence, interactionId);
      if (triggered.length) {
        const postRevisions = await withTimeout(reviseAllTriggered(triggered), 90_000, "post-revision");
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
