/**
 * Orchestrator — the main interaction loop.
 * 
 * Production features:
 * - Input validation and sanitization
 * - Structured logging throughout
 * - Session locking for concurrent safety
 * - Timeouts on all async operations
 * - Non-blocking post-processing
 * - Error isolation (evidence/revision failures don't break response)
 * - Unlimited tool iterations (time-bound only)
 * - Context compaction to stay under token limits
 */

import { getActiveBeliefs, getBeliefsAboveThreshold } from "./belief-graph.js";
import { callClaude, callClaudeWithTools, type ClaudeMessage, type ToolMessage, type ContentBlock, type ToolResultBlock, type TextBlock, type ToolUseBlock } from "./claude.js";
import { computeDissatisfaction, describeState, invalidateCache } from "./dissatisfaction.js";
import { extractEvidence } from "./evidence-extractor.js";
import { formatBeliefsForPrompt } from "./prompts.js";
import { systemPromptWithBeliefs } from "./prompts.js";
import { reviseAllTriggered, getRecentRevisions } from "./revision-engine.js";
import { accumulate } from "./tension-accumulator.js";
import { queryVal, query } from "./db.js";
import { TOOL_DEFINITIONS, executeTool, setDelegateContext } from "./tools.js";
import { appendProgress } from "./progress.js";
import type { InteractionResult, RevisionResult } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("orchestrator");

// ── Input Validation ──────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_SESSION_ID_LENGTH = 100;

function validateInput(userMessage: string, sessionId: string): string | null {
  if (!userMessage || typeof userMessage !== "string") return "User message is required";
  if (userMessage.length > MAX_MESSAGE_LENGTH) return `Message too long (max ${MAX_MESSAGE_LENGTH} chars)`;
  if (!sessionId || typeof sessionId !== "string") return "Session ID is required";
  if (sessionId.length > MAX_SESSION_ID_LENGTH) return "Session ID too long";
  return null;
}

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
  }
}

// ── Session Locking ───────────────────────────────────────────────

const activeSessions = new Set<string>();
const _userRequestActive = { value: false };

export function isUserRequestActive(): boolean {
  return _userRequestActive.value;
}

// ── Timeout Wrapper ───────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

// ── Token Estimation ──────────────────────────────────────────────

function estimateTokens(messages: ToolMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ("text" in block) chars += block.text.length;
        else if ("content" in block) chars += (block as any).content.length;
        else chars += JSON.stringify(block).length;
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

// ── Context Compaction ────────────────────────────────────────────

const TOKEN_BUDGET = 120_000;
const KEEP_LAST_ASSISTANTS = 6;

function pruneMessages(messages: ToolMessage[]): ToolMessage[] {
  const est = estimateTokens(messages);
  if (est < TOKEN_BUDGET) return messages;

  const assistantIndices = messages
    .map((m, i) => (m.role === "assistant" && Array.isArray(m.content) ? i : -1))
    .filter((i) => i >= 0);

  let toolStartIdx = assistantIndices[0] ?? -1;
  if (toolStartIdx < 0) return messages;

  const prefix = messages.slice(0, toolStartIdx);
  const toolExchanges = messages.slice(toolStartIdx);
  const pairCount = Math.floor(toolExchanges.length / 2);
  const keepPairs = KEEP_LAST_ASSISTANTS;
  const dropCount = pairCount - keepPairs;
  if (dropCount <= 0) return messages;

  const kept = toolExchanges.slice(dropCount * 2);

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
  log.info("Context compacted", { from_tokens: est, to_tokens: newEst, dropped: dropCount });
  return result;
}

// ── Agentic Tool Loop ─────────────────────────────────────────────

const LOOP_TIMEOUT_MS = 15 * 60 * 1000; // 15 min
const TOOL_EXEC_TIMEOUT_MS = 45_000;
const MAX_TOOL_OUTPUT = 8000;

async function runAgenticLoop(
  system: string,
  initialMessages: ToolMessage[],
  sessionId: string,
  onEvent?: (event: string, data: any) => void,
): Promise<{ response: string; toolsUsed: Array<{ name: string; input: any; output: string }> }> {
  // Set delegate context so sub-agents get the system prompt
  setDelegateContext(system, sessionId);

  let messages: ToolMessage[] = [...initialMessages];
  const toolsUsed: Array<{ name: string; input: any; output: string }> = [];
  let iteration = 0;
  const loopStart = Date.now();

  while (true) {
    const elapsed = Date.now() - loopStart;
    if (elapsed > LOOP_TIMEOUT_MS) {
      log.warn("Agentic loop timeout", { iteration, elapsed_ms: elapsed });
      return {
        response: toolsUsed.length
          ? "I ran out of time. Ask me to continue where I left off."
          : "Processing timed out.",
        toolsUsed,
      };
    }

    iteration++;
    onEvent?.("thinking", { iteration, elapsed: Math.round(elapsed / 1000) });

    messages = pruneMessages(messages);

    let contentBlocks: ContentBlock[];
    try {
      contentBlocks = await callClaudeWithTools(system, messages, TOOL_DEFINITIONS, {
        maxTokens: 16384,
      });
    } catch (err: any) {
      log.error("LLM call failed in agentic loop", err, { iteration });
      return {
        response: `I encountered an error: ${err.message}`,
        toolsUsed,
      };
    }

    messages.push({ role: "assistant", content: contentBlocks });

    const toolUses = contentBlocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const textParts = contentBlocks.filter((b): b is TextBlock => b.type === "text");

    if (!toolUses.length) {
      return {
        response: textParts.map((b) => b.text).join("") || "(no response)",
        toolsUsed,
      };
    }

    const toolResults: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      onEvent?.("tool_use", { name: tu.name, input: tu.input, iteration });
      log.debug("Executing tool", { name: tu.name, input_preview: JSON.stringify(tu.input).slice(0, 100) });

      let output: string;
      try {
        output = await withTimeout(
          executeTool(tu.name, tu.input),
          TOOL_EXEC_TIMEOUT_MS,
          `tool:${tu.name}`,
        );
      } catch (err: any) {
        output = `Tool error: ${err.message}`;
        log.warn("Tool execution failed", { name: tu.name, error: err.message });
      }

      if (output.length > MAX_TOOL_OUTPUT) {
        const half = Math.floor(MAX_TOOL_OUTPUT / 2);
        output = output.slice(0, half) + `\n\n... [${output.length - MAX_TOOL_OUTPUT} chars, soft-trimmed] ...\n\n` + output.slice(-half);
      }

      toolsUsed.push({ name: tu.name, input: tu.input, output });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ── Main Entry Point ──────────────────────────────────────────────

export async function processInteraction(
  userMessage: string,
  sessionId: string = "default",
  onRevision?: (rev: RevisionResult) => void,
  onEvent?: (event: string, data: any) => void,
): Promise<InteractionResult> {
  const timer = log.time("interaction");

  // Input validation
  const validationError = validateInput(userMessage, sessionId);
  if (validationError) {
    log.warn("Input validation failed", { error: validationError, session_id: sessionId });
    return {
      response: `Input error: ${validationError}`,
      session_id: sessionId,
      dissatisfaction: 0,
      dissatisfaction_state: "unknown",
      evidence_extracted: 0,
      pre_revisions: [],
      post_revisions: [],
      beliefs_count: 0,
    };
  }

  // Session locking — reject concurrent requests for same session
  if (activeSessions.has(sessionId)) {
    log.warn("Concurrent request rejected", { session_id: sessionId });
    return {
      response: "I'm still processing a previous request. Please wait.",
      session_id: sessionId,
      dissatisfaction: await computeDissatisfaction(),
      dissatisfaction_state: describeState(await computeDissatisfaction()),
      evidence_extracted: 0,
      pre_revisions: [],
      post_revisions: [],
      beliefs_count: 0,
    };
  }

  activeSessions.add(sessionId);
  _userRequestActive.value = true;

  try {
    log.info("Processing interaction", { session_id: sessionId, message_length: userMessage.length });

    // 1. Current state
    const dissatisfaction = await computeDissatisfaction();
    let activeBeliefs = await getActiveBeliefs();

    // 2. Pre-check: urgent revisions
    const urgent = await getBeliefsAboveThreshold();
    const preRevisions: RevisionResult[] = [];
    if (urgent.length && dissatisfaction > 0.6) {
      log.info("Processing urgent revisions", { count: urgent.length, dissatisfaction });
      try {
        const urgentResults = await withTimeout(reviseAllTriggered(urgent), 90_000, "pre-revision");
        preRevisions.push(...urgentResults);
        for (const rev of urgentResults) onRevision?.(rev);
        activeBeliefs = await getActiveBeliefs();
        invalidateCache();
      } catch (err) {
        log.error("Urgent revision failed (continuing)", err);
      }
    }

    // 3. Build system prompt
    const beliefsSummary = formatBeliefsForPrompt(activeBeliefs);
    const recentRevs = await getRecentRevisions(3);
    const revisionText = recentRevs.length
      ? recentRevs.map((r: any) => `- "${r.old_content}" → "${r.new_content}"`).join("\n")
      : "";

    const currentDissatisfaction = await computeDissatisfaction();
    const system = systemPromptWithBeliefs(beliefsSummary, currentDissatisfaction, revisionText);

    // 4. Build messages
    const history = getSessionHistory(sessionId);
    const messages: ToolMessage[] = [
      ...history.map((h) => ({ role: h.role, content: h.content }) as ToolMessage),
      { role: "user" as const, content: userMessage },
    ];

    // 5. Run agentic loop
    onEvent?.("thinking", { iteration: 0 });
    const { response, toolsUsed } = await runAgenticLoop(system, messages, sessionId, onEvent);

    // 6. Update history
    appendToHistory(sessionId, "user", userMessage);
    appendToHistory(sessionId, "assistant", response);

    // 7. Evidence extraction (isolated — failures don't break response)
    let evidence: any[] = [];
    try {
      evidence = await withTimeout(extractEvidence(userMessage, response, activeBeliefs), 30_000, "evidence");
    } catch (err) {
      log.error("Evidence extraction failed (continuing)", err);
    }

    // 8. Log interaction to DB
    let interactionId: string | null = null;
    try {
      interactionId = await queryVal<string>(
        `INSERT INTO interactions (session_id, user_message, assistant_response, extracted_claims, dissatisfaction_at_time)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [sessionId, userMessage, response, JSON.stringify(evidence), dissatisfaction],
      );
    } catch (err) {
      log.error("Failed to log interaction to DB", err);
    }

    // 9. Post-processing: tension + revisions (async, non-blocking)
    setImmediate(async () => {
      try {
        const triggered = await accumulate(evidence, interactionId);
        if (triggered.length) {
          log.info("Beliefs triggered for revision", { count: triggered.length });
          const postRevisions = await withTimeout(reviseAllTriggered(triggered), 90_000, "post-revision");
          for (const rev of postRevisions) onRevision?.(rev);
          if (interactionId) {
            await query("UPDATE interactions SET revision_triggered = true WHERE id = $1", [interactionId]);
          }
        }
        invalidateCache();
      } catch (err) {
        log.error("Post-processing failed", err);
      }
    });

    const finalDissatisfaction = await computeDissatisfaction();
    timer();

    log.info("Interaction complete", {
      session_id: sessionId,
      evidence_count: evidence.length,
      tools_used: toolsUsed.length,
      dissatisfaction: finalDissatisfaction,
    });

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
  } catch (err) {
    log.error("Fatal error in interaction", err, { session_id: sessionId });
    throw err;
  } finally {
    activeSessions.delete(sessionId);
    _userRequestActive.value = false;
  }
}
