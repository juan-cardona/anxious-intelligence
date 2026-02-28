/**
 * Claude API client via Azure AI Foundry.
 * Supports multi-turn conversation history and agentic tool use.
 */

import { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MODEL_FAST, MODEL_REVISION } from "./config.js";

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Tool Use Types ────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock;

/** Messages for tool use loop — content can be string or blocks */
export interface ToolMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[] | ToolResultBlock[];
}

// ── Internal API Response ─────────────────────────────────────────

interface ClaudeApiResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

// ── Core Fetch ────────────────────────────────────────────────────

async function callClaudeRaw(
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: any }>,
  opts?: {
    model?: string;
    maxTokens?: number;
    tools?: any[];
  },
): Promise<ClaudeApiResponse> {
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

  // Retry loop for rate limits
  for (let attempt = 0; attempt < 10; attempt++) {
    const resp = await fetch(`${ANTHROPIC_BASE_URL}v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (resp.status === 429) {
      // Parse retry-after from response if available
      const retryText = await resp.text().catch(() => "");
      const retryMatch = retryText.match(/wait (\d+) second/);
      const waitSec = retryMatch ? parseInt(retryMatch[1]) : (attempt + 1) * 2;
      const waitMs = Math.max(waitSec * 1000, 2000);
      console.warn(`[claude] Rate limited, waiting ${waitMs}ms (attempt ${attempt + 1}/10)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Claude API error ${resp.status}: ${text}`);
    }

    return (await resp.json()) as ClaudeApiResponse;
  }

  throw new Error("Claude API: rate limited after 10 retries");
}

// ── Public Functions ──────────────────────────────────────────────

export async function callClaude(
  system: string,
  userMessage: string,
  opts?: { model?: string; maxTokens?: number; history?: ClaudeMessage[] },
): Promise<string> {
  const messages = [
    ...(opts?.history ?? []),
    { role: "user" as const, content: userMessage },
  ];

  const data = await callClaudeRaw(system, messages, opts);
  return data.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Call Claude with tools enabled.
 * Returns the full content array (may include tool_use blocks).
 * The caller is responsible for executing tools and looping.
 */
export async function callClaudeWithTools(
  system: string,
  messages: ToolMessage[],
  tools: any[],
  opts?: { model?: string; maxTokens?: number },
): Promise<ContentBlock[]> {
  const data = await callClaudeRaw(system, messages as any, {
    ...opts,
    tools,
  });
  return data.content;
}

export async function callClaudeJson<T = any>(
  system: string,
  userMessage: string,
  opts?: { model?: string; history?: ClaudeMessage[] },
): Promise<T> {
  let text = await callClaude(system, userMessage, opts);

  // Strip markdown code fences
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
