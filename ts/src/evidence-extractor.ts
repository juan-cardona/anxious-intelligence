/**
 * Evidence Extractor — analyzes interactions to find reinforcing/contradicting evidence.
 */

import { callClaudeJson } from "./claude.js";
import { evidenceExtractionPrompt, formatBeliefsForPrompt } from "./prompts.js";
import type { Belief, Evidence } from "./types.js";

export async function extractEvidence(
  userMessage: string,
  assistantResponse: string,
  activeBeliefs: Belief[],
): Promise<Evidence[]> {
  if (!activeBeliefs.length) return [];

  const summary = formatBeliefsForPrompt(activeBeliefs);
  const prompt = evidenceExtractionPrompt(userMessage, assistantResponse, summary);

  let raw: any[];
  try {
    raw = await callClaudeJson<any[]>(
      "You are a precise evidence extraction system. Respond only in valid JSON.",
      prompt,
    );
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) return [];

  const result: Evidence[] = [];

  for (const item of raw) {
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

    result.push({
      claim: item.claim ?? "",
      evidence_type: item.type ?? "factual",
      relevance: item.relevance ?? "",
      stance: stance as Evidence["stance"],
      belief_id: beliefId,
      strength: Math.min(1, Math.max(0, parseFloat(item.strength ?? "0.5"))),
    });
  }

  return result;
}
