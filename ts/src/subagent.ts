/**
 * Sub-agent system — spawn focused subtasks with fresh context windows.
 *
 * Each sub-agent gets its own context, tool loop, and pruning.
 * Cannot delegate further (no recursion).
 */

import { callClaudeWithTools, type ToolMessage, type ContentBlock, type ToolResultBlock, type TextBlock, type ToolUseBlock } from "./claude.js";
import { TOOLS_NO_DELEGATE, executeTool } from "./tools.js";
import { appendProgress } from "./progress.js";

const MAX_ITERATIONS = 30;
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOOL_OUTPUT = 8000;

export interface SubagentResult {
  response: string;
  toolsUsed: number;
  error?: string;
}

export async function runSubagent(
  task: string,
  parentSystem: string,
  parentSessionId: string,
): Promise<SubagentResult> {
  const system = `${parentSystem}

## Sub-agent Mode
You are a focused sub-agent handling a specific subtask.
- Complete the task thoroughly, then return a CONCISE summary of what you did and found.
- Do NOT ask questions — just do the work.
- Combine commands for efficiency. Be thorough but focused.
- Your response goes back to the parent agent — be informative but brief.`;

  const messages: ToolMessage[] = [{ role: "user", content: task }];
  let toolCount = 0;
  const start = Date.now();

  await appendProgress(parentSessionId, {
    timestamp: new Date().toISOString(),
    type: "task_start",
    summary: `Sub-agent: ${task.slice(0, 120)}`,
  });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (Date.now() - start > TIMEOUT_MS) {
      return { response: `Timed out after ${toolCount} tool calls.`, toolsUsed: toolCount, error: "timeout" };
    }

    let blocks: ContentBlock[];
    try {
      blocks = await callClaudeWithTools(system, messages, TOOLS_NO_DELEGATE);
    } catch (err: any) {
      return { response: `API error: ${err.message}`, toolsUsed: toolCount, error: err.message };
    }

    const text = blocks.filter((b): b is TextBlock => b.type === "text");
    const tools = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");

    if (!tools.length) {
      const response = text.map((b) => b.text).join("");
      await appendProgress(parentSessionId, {
        timestamp: new Date().toISOString(),
        type: "response",
        summary: `Sub-agent done: ${toolCount} tools, ${response.slice(0, 100)}`,
      });
      return { response, toolsUsed: toolCount };
    }

    const results: ToolResultBlock[] = [];
    for (const tb of tools) {
      toolCount++;
      let output: string;
      try {
        output = await Promise.race([
          executeTool(tb.name, tb.input),
          new Promise<string>((_, r) => setTimeout(() => r(new Error("timeout")), 45_000)),
        ]);
      } catch (err: any) {
        output = `Error: ${err.message}`;
      }
      if (output.length > MAX_TOOL_OUTPUT) {
        output = output.slice(0, MAX_TOOL_OUTPUT) + "\n[truncated]";
      }
      results.push({ type: "tool_result", tool_use_id: tb.id, content: output });
    }

    messages.push({ role: "assistant", content: blocks });
    messages.push({ role: "user", content: results });

    // Prune old tool results after 8 iterations
    if (i > 8) {
      const keepFrom = messages.length - 6;
      for (let j = 0; j < keepFrom; j++) {
        const m = messages[j];
        if (m.role === "user" && Array.isArray(m.content)) {
          for (const block of m.content as any[]) {
            if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > 400) {
              block.content = block.content.slice(0, 400) + "\n[pruned]";
            }
          }
        }
      }
    }
  }

  return { response: `Hit ${MAX_ITERATIONS} iterations with ${toolCount} tool calls.`, toolsUsed: toolCount, error: "iteration_limit" };
}
