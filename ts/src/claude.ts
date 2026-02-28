/**
 * Claude API client via Azure AI Foundry.
 */

import { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MODEL_FAST, MODEL_REVISION } from "./config.js";

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export async function callClaude(
  system: string,
  userMessage: string,
  opts?: { model?: string; maxTokens?: number },
): Promise<string> {
  const model = opts?.model ?? MODEL_FAST;
  const maxTokens = opts?.maxTokens ?? 4096;

  const resp = await fetch(`${ANTHROPIC_BASE_URL}v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }] satisfies ClaudeMessage[],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as ClaudeResponse;
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
