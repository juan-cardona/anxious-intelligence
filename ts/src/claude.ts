/**
 * Claude API client via Azure AI Foundry.
 * Supports: text responses, JSON parsing, tool use (agentic loop).
 */

import { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MODEL_FAST, MODEL_REVISION } from "./config.js";
import type { ToolDefinition, ToolCall } from "./tools.js";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: any;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
}

interface ClaudeResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage?: { input_tokens: number; output_tokens: number };
}

export async function callClaudeRaw(
  system: string,
  messages: ClaudeMessage[],
  opts?: { model?: string; maxTokens?: number; tools?: ToolDefinition[] },
): Promise<ClaudeResponse> {
  const model = opts?.model ?? MODEL_FAST;
  const maxTokens = opts?.maxTokens ?? 4096;

  const body: Record<string, any> = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
  };

  if (opts?.tools?.length) {
    body.tools = opts.tools;
  }

  const resp = await fetch(`${ANTHROPIC_BASE_URL}v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${text}`);
  }

  return (await resp.json()) as ClaudeResponse;
}

export async function callClaude(
  system: string,
  userMessage: string,
  opts?: { model?: string; maxTokens?: number },
): Promise<string> {
  const data = await callClaudeRaw(
    system,
    [{ role: "user", content: userMessage }],
    opts,
  );
  return data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");
}

export async function callClaudeJson<T = any>(
  system: string,
  userMessage: string,
  opts?: { model?: string },
): Promise<T> {
  let text = await callClaude(system, userMessage, opts);

  text = text.trim();
  if (text.startsWith("```")) {
    const lines = text.split("\n");
    const end = lines.length - 1;
    text = lines
      .slice(1, lines[end]?.trim() === "```" ? end : undefined)
      .join("\n");
  }

  return JSON.parse(text) as T;
}

export async function callRevision(
  system: string,
  userMessage: string,
): Promise<Record<string, any>> {
  return callClaudeJson(system, userMessage, { model: MODEL_REVISION });
}

/**
 * Agentic loop: call Claude with tools, execute tool calls, feed results back.
 * Continues until Claude responds with no tool_use blocks (pure text).
 *
 * IMPORTANT: If tool_use blocks are present, we MUST execute them and send
 * tool_result back — otherwise the next API call will 400 with orphaned IDs.
 * Only stop_reason="tool_use" guarantees tools; but we check blocks defensively.
 */
export async function callClaudeWithTools(
  system: string,
  userMessage: string,
  tools: ToolDefinition[],
  executeTool: (call: ToolCall) => Promise<{ tool_use_id: string; content: string; is_error?: boolean }>,
  opts?: { model?: string; maxTokens?: number; maxTurns?: number; onToolCall?: (call: ToolCall) => void; onToolResult?: (result: any) => void },
): Promise<{ text: string; toolCalls: ToolCall[]; turns: number }> {
  const maxTurns = opts?.maxTurns ?? 10;
  const messages: ClaudeMessage[] = [{ role: "user", content: userMessage }];
  const allToolCalls: ToolCall[] = [];
  let finalText = "";
  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    const response = await callClaudeRaw(system, messages, {
      model: opts?.model,
      maxTokens: opts?.maxTokens ?? 4096,
      tools,
    });

    // Add assistant response to messages
    messages.push({ role: "assistant", content: response.content });

    // Collect any text blocks from this turn
    const textParts = response.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text!)
      .join("");
    if (textParts) finalText = textParts; // keep latest text

    // Check for tool_use blocks
    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    // No tool calls → we're done
    if (toolUseBlocks.length === 0) {
      return { text: finalText, toolCalls: allToolCalls, turns };
    }

    // Execute ALL tool calls (must match every tool_use block with a tool_result)
    const toolResults: any[] = [];
    for (const block of toolUseBlocks) {
      const call: ToolCall = {
        id: block.id!,
        name: block.name!,
        input: block.input ?? {},
      };
      allToolCalls.push(call);
      opts?.onToolCall?.(call);

      const result = await executeTool(call);
      opts?.onToolResult?.(result);
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: result.content,
        is_error: result.is_error,
      });
    }

    // Feed tool results back as a user message
    messages.push({ role: "user", content: toolResults });

    // If stop_reason was end_turn (Claude said tools + done), we still
    // need one more round for Claude to see the results and give final text
  }

  // Max turns reached
  return { text: finalText || "(max tool turns reached)", toolCalls: allToolCalls, turns };
}
