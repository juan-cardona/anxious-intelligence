/**
 * Claude API client via Azure AI Foundry.
 * Supports multi-turn conversation history and agentic tool use.
 *
 * Production features:
 * - Structured logging
 * - Exponential backoff with jitter for rate limits and transient errors
 * - Token usage tracking
 * - Request timeout management
 * - Rate limiting (token bucket)
 */

import { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MODEL_FAST, MODEL_REVISION } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("claude");

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

// ── Token Usage Tracking ──────────────────────────────────────────

interface UsageStats {
  total_input_tokens: number;
  total_output_tokens: number;
  total_requests: number;
  failed_requests: number;
  retries: number;
  last_reset: Date;
}

const usage: UsageStats = {
  total_input_tokens: 0,
  total_output_tokens: 0,
  total_requests: 0,
  failed_requests: 0,
  retries: 0,
  last_reset: new Date(),
};

export function getUsageStats(): UsageStats & { estimated_cost_usd: number } {
  // Rough cost estimate (Claude Sonnet-level pricing)
  const inputCost = (usage.total_input_tokens / 1_000_000) * 3;
  const outputCost = (usage.total_output_tokens / 1_000_000) * 15;
  return { ...usage, estimated_cost_usd: Math.round((inputCost + outputCost) * 100) / 100 };
}

// ── Rate Limiter (Token Bucket) ───────────────────────────────────

const RATE_LIMIT = {
  maxRequestsPerMinute: parseInt(process.env.LLM_RPM ?? "50", 10),
  tokens: 0,
  lastRefill: Date.now(),
};

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - RATE_LIMIT.lastRefill;

  // Refill tokens based on elapsed time
  if (elapsed > 60_000) {
    RATE_LIMIT.tokens = RATE_LIMIT.maxRequestsPerMinute;
    RATE_LIMIT.lastRefill = now;
  } else {
    const refill = Math.floor((elapsed / 60_000) * RATE_LIMIT.maxRequestsPerMinute);
    RATE_LIMIT.tokens = Math.min(RATE_LIMIT.maxRequestsPerMinute, RATE_LIMIT.tokens + refill);
    if (refill > 0) RATE_LIMIT.lastRefill = now;
  }

  if (RATE_LIMIT.tokens <= 0) {
    const waitMs = Math.ceil(60_000 / RATE_LIMIT.maxRequestsPerMinute);
    log.warn(`Rate limit self-imposed, waiting ${waitMs}ms`, { tokens: RATE_LIMIT.tokens });
    await new Promise((r) => setTimeout(r, waitMs));
    RATE_LIMIT.tokens = 1;
  }

  RATE_LIMIT.tokens--;
}

// ── Retry with Exponential Backoff + Jitter ───────────────────────

const MAX_RETRIES = 8;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

function computeBackoff(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  const jitter = Math.random() * exponential * 0.5;
  return Math.round(exponential + jitter);
}

// ── Signal combination helper ─────────────────────────────────────

function combineSignals(timeout: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return timeout;
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any([timeout, external]);
  }
  // Fallback for older Node versions
  const ac = new AbortController();
  if (timeout.aborted) { ac.abort(timeout.reason); return ac.signal; }
  if (external.aborted) { ac.abort(external.reason); return ac.signal; }
  timeout.addEventListener("abort", () => ac.abort(timeout.reason), { once: true });
  external.addEventListener("abort", () => ac.abort(external.reason), { once: true });
  return ac.signal;
}

// ── Core Fetch ────────────────────────────────────────────────────

async function callClaudeRaw(
  system: string,
  messages: Array<{ role: "user" | "assistant"; content: any }>,
  opts?: {
    model?: string;
    maxTokens?: number;
    tools?: any[];
    timeout_ms?: number;
    signal?: AbortSignal;
  },
): Promise<ClaudeApiResponse> {
  const model = opts?.model ?? MODEL_FAST;
  const maxTokens = opts?.maxTokens ?? 4096;
  const timeout = opts?.timeout_ms ?? 120_000;

  const body: Record<string, any> = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
  };

  if (opts?.tools?.length) {
    body.tools = opts.tools;
  }

  await waitForRateLimit();

  const timer = log.time(`llm_call:${model}`);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Check external abort before each attempt
    if (opts?.signal?.aborted) {
      throw new Error("Request aborted");
    }

    usage.total_requests++;

    try {
      const signal = combineSignals(AbortSignal.timeout(timeout), opts?.signal);
      const resp = await fetch(`${ANTHROPIC_BASE_URL}v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (RETRYABLE_STATUS.has(resp.status)) {
        usage.retries++;
        const respText = await resp.text().catch(() => "");

        // Try to parse retry-after hint
        const retryMatch = respText.match(/wait (\d+) second/i);
        const serverWait = retryMatch ? parseInt(retryMatch[1]) * 1000 : 0;
        const backoff = Math.max(serverWait, computeBackoff(attempt));

        if (attempt === MAX_RETRIES) {
          log.error(`LLM call failed after ${MAX_RETRIES} retries`, new Error(respText), {
            status: resp.status, model,
          });
          throw new Error(`Claude API error ${resp.status} after ${MAX_RETRIES} retries: ${respText.slice(0, 200)}`);
        }

        log.warn(`LLM retryable error ${resp.status}, backoff ${backoff}ms`, {
          attempt: attempt + 1, model, status: resp.status,
        });
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      if (!resp.ok) {
        usage.failed_requests++;
        const text = await resp.text();
        log.error(`LLM non-retryable error`, new Error(text), { status: resp.status, model });
        throw new Error(`Claude API error ${resp.status}: ${text.slice(0, 500)}`);
      }

      const data = (await resp.json()) as ClaudeApiResponse;

      // Track usage
      if (data.usage) {
        usage.total_input_tokens += data.usage.input_tokens;
        usage.total_output_tokens += data.usage.output_tokens;
      }

      const duration = timer();
      log.info(`LLM call complete`, {
        model,
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens,
        stop_reason: data.stop_reason,
        duration_ms: duration,
        attempts: attempt + 1,
      });

      return data;
    } catch (err: any) {
      // Network/timeout errors are retryable
      if (err.name === "TimeoutError" || err.name === "AbortError" || err.code === "ECONNRESET" || err.code === "ENOTFOUND") {
        usage.retries++;
        if (attempt === MAX_RETRIES) {
          usage.failed_requests++;
          log.error(`LLM call timed out after ${MAX_RETRIES} retries`, err, { model });
          throw err;
        }
        const backoff = computeBackoff(attempt);
        log.warn(`LLM network error, retrying in ${backoff}ms`, { attempt: attempt + 1, error: err.message });
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      // Non-retryable
      usage.failed_requests++;
      throw err;
    }
  }

  throw new Error("Claude API: exhausted retries (unreachable)");
}

// ── Public Functions ──────────────────────────────────────────────

export async function callClaude(
  system: string,
  userMessage: string,
  opts?: { model?: string; maxTokens?: number; history?: ClaudeMessage[]; timeout_ms?: number },
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

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    log.error("Failed to parse LLM JSON response", err, { text: text.slice(0, 200) });
    throw new Error(`LLM returned invalid JSON: ${text.slice(0, 100)}...`);
  }
}

export async function callRevision(
  system: string,
  userMessage: string,
): Promise<Record<string, any>> {
  return callClaudeJson(system, userMessage, { model: MODEL_REVISION });
}
