/**
 * Evidence Extractor — analyzes interactions to find reinforcing/contradicting evidence.
 *
 * Production features:
 * - Structured logging
 * - Robust error handling (returns empty list on failure, never throws)
 * - Input validation and sanitization
 * - Size limits on extracted evidence
 */

import { callClaudeJson } from "./claude.js";
import { evidenceExtractionPrompt, formatBeliefsForPrompt } from "./prompts.js";
import type { Belief, Evidence } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("evidence");

const MAX_EVIDENCE_ITEMS = 20;
const MAX_CLAIM_LENGTH = 500;

export async function extractEvidence(
  userMessage: string,
  assistantResponse: string,
  activeBeliefs: Belief[],
): Promise<Evidence[]> {
  if (!activeBeliefs.length) {
    log.debug("No active beliefs — skipping evidence extraction");
    return [];
  }

  if (!userMessage || !assistantResponse) {
    log.warn("Missing user message or response — skipping extraction");
    return [];
  }

  const timer = log.time("evidence_extraction");
  const summary = formatBeliefsForPrompt(activeBeliefs);
  const prompt = evidenceExtractionPrompt(userMessage, assistantResponse, summary);

  let raw: any[];
  try {
    raw = await callClaudeJson<any[]>(
      "You are a precise evidence extraction system. Respond only in valid JSON.",
      prompt,
    );
  } catch (err) {
    log.error("Evidence extraction LLM call failed", err);
    return [];
  }

  if (!Array.isArray(raw)) {
    log.warn("Evidence extraction returned non-array", { type: typeof raw });
    return [];
  }

  const result: Evidence[] = [];

  for (const item of raw.slice(0, MAX_EVIDENCE_ITEMS)) {
    if (typeof item !== "object" || !item) continue;

    const beliefIndex = item.belief_index;
    let beliefId: string | null = null;

    if (
      typeof beliefIndex === "number" &&
      beliefIndex >= 0 &&
      beliefIndex < activeBeliefs.length
    ) {
      beliefId = activeBeliefs[beliefIndex].id;
    }

    let stance = item.stance as string;
    if (!["reinforcing", "contradicting", "neutral"].includes(stance)) {
      stance = "neutral";
    }

    const claim = String(item.claim ?? "").slice(0, MAX_CLAIM_LENGTH);
    if (!claim) continue; // Skip empty claims

    let evidenceType = item.type ?? "factual";
    if (!["factual", "feedback", "outcome"].includes(evidenceType)) {
      evidenceType = "factual";
    }

    result.push({
      claim,
      evidence_type: evidenceType as Evidence["evidence_type"],
      relevance: String(item.relevance ?? ""),
      stance: stance as Evidence["stance"],
      belief_id: beliefId,
      strength: Math.min(1, Math.max(0, parseFloat(item.strength ?? "0.5"))),
    });
  }

  timer();
  log.info("Evidence extracted", {
    total: result.length,
    reinforcing: result.filter((e) => e.stance === "reinforcing").length,
    contradicting: result.filter((e) => e.stance === "contradicting").length,
    neutral: result.filter((e) => e.stance === "neutral").length,
  });

  return result;
}
