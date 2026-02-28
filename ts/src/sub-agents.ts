/**
 * Sub-agent system — isolated agentic loops for parallel subtasks.
 *
 * - Max 3 concurrent sub-agents
 * - Max depth 1 (no sub-sub-agents)
 * - Each sub-agent gets fresh context, runs full agentic loop
 * - Parent collects results; sub-agents cannot spawn sub-agents
 */

import {
  callClaudeWithTools,
  type ToolMessage,
  type ContentBlock,
  type TextBlock,
  type ToolUseBlock,
  type ToolResultBlock,
} from "./claude.js";

// ── Concurrency limit ─────────────────────────────────────────────

let activeSubAgents = 0;
const MAX_CONCURRENT = 3;

// ── Timeouts ──────────────────────────────────────────────────────

const LOOP_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const TOOL_EXEC_TIMEOUT_MS = 30_000;
const MAX_TOOL_OUTPUT = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Sub-agent timeout: ${label} exceeded ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Types ─────────────────────────────────────────────────────────

export interface SubAgentResult {
  response: string;
  toolsUsed: number;
  error?: string;
}

// ── System prompt for sub-agents ──────────────────────────────────

const SUB_AGENT_SYSTEM = `You are a focused sub-agent within a larger AI system. Your job is to complete a specific delegated task efficiently.

Rules:
- Complete the task using the provided tools
- Be thorough but stay focused on the specific task
- Do NOT attempt to spawn additional sub-agents
- When done, return a clear, complete result
- Act immediately — don't describe what you'll do, just do it`;

// ── Main entry point ──────────────────────────────────────────────

/**
 * Run a sub-agent for a focused task.
 * toolDefs should NOT include spawn_sub_agent (prevents recursion).
 * executeFn is the tool executor from tools.ts.
 */
export async function runSubAgent(
  task: string,
  context: string | undefined,
  toolDefs: any[],
  executeFn: (name: string, input: Record<string, any>) => Promise<string>,
  signal?: AbortSignal,
): Promise<SubAgentResult> {
  if (activeSubAgents >= MAX_CONCURRENT) {
    return {
      response: `Error: max concurrent sub-agents (${MAX_CONCURRENT}) already running. Try sequentially.`,
      toolsUsed: 0,
    };
  }

  activeSubAgents++;
  try {
    return await _runLoop(task, context, toolDefs, executeFn, signal);
  } finally {
    activeSubAgents--;
  }
}

// ── Internal loop ─────────────────────────────────────────────────

async function _runLoop(
  task: string,
  context: string | undefined,
  toolDefs: any[],
  executeFn: (name: string, input: Record<string, any>) => Promise<string>,
  signal?: AbortSignal,
): Promise<SubAgentResult> {
  const userContent = context
    ? `Context:\n${context}\n\nTask:\n${task}`
    : task;

  let messages: ToolMessage[] = [{ role: "user", content: userContent }];
  let toolsUsed = 0;
  const loopStart = Date.now();

  while (true) {
    // Abort check
    if (signal?.aborted) {
      return { response: "Sub-agent aborted by parent", toolsUsed };
    }

    // Time check
    const elapsed = Date.now() - loopStart;
    if (elapsed > LOOP_TIMEOUT_MS) {
      return { response: `Sub-agent timed out after ${toolsUsed} tool calls`, toolsUsed };
    }

    // Call Claude (no streaming for sub-agents)
    let contentBlocks: ContentBlock[];
    try {
      contentBlocks = await callClaudeWithTools(SUB_AGENT_SYSTEM, messages, toolDefs, { signal });
    } catch (err: any) {
      return {
        response: `Sub-agent API error: ${err.message}`,
        toolsUsed,
        error: err.message,
      };
    }

    const textBlocks = contentBlocks.filter((b): b is TextBlock => b.type === "text");
    const toolUseBlocks = contentBlocks.filter((b): b is ToolUseBlock => b.type === "tool_use");

    // No tool calls = done
    if (!toolUseBlocks.length) {
      return {
        response: textBlocks.map((b) => b.text).join(""),
        toolsUsed,
      };
    }

    // Execute tools
    const toolResults: ToolResultBlock[] = [];
    for (const tb of toolUseBlocks) {
      let output: string;
      try {
        output = await withTimeout(
          executeFn(tb.name, tb.input),
          TOOL_EXEC_TIMEOUT_MS,
          `tool:${tb.name}`,
        );
      } catch (err: any) {
        output = `Error: ${err.message}`;
      }

      if (output.length > MAX_TOOL_OUTPUT) {
        output = output.slice(0, MAX_TOOL_OUTPUT) + `\n[truncated, ${output.length} chars total]`;
      }

      toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: output });
      toolsUsed++;
    }

    messages.push({ role: "assistant", content: contentBlocks });
    messages.push({ role: "user", content: toolResults });
  }
}
