/**
 * Orchestrator — the main interaction loop.
 */

import { getActiveBeliefs, getBeliefsAboveThreshold } from "./belief-graph.js";
import { callClaude } from "./claude.js";
import { computeDissatisfaction, describeState } from "./dissatisfaction.js";
import { extractEvidence } from "./evidence-extractor.js";
import { formatBeliefsForPrompt } from "./prompts.js";
import { systemPromptWithBeliefs } from "./prompts.js";
import { reviseAllTriggered, getRecentRevisions } from "./revision-engine.js";
import { accumulate } from "./tension-accumulator.js";
import { queryVal, query } from "./db.js";
import type { InteractionResult, RevisionResult } from "./types.js";

export async function processInteraction(
  userMessage: string,
  sessionId = "default",
  onRevision?: (rev: RevisionResult) => void,
): Promise<InteractionResult> {
  // 1. Current state
  let dissatisfaction = await computeDissatisfaction();
  let activeBeliefs = await getActiveBeliefs();

  // 2. Pre-check: urgent revisions
  const urgent = await getBeliefsAboveThreshold();
  let preRevisions: RevisionResult[] = [];
  if (urgent.length && dissatisfaction > 0.6) {
    preRevisions = await reviseAllTriggered(urgent);
    for (const rev of preRevisions) onRevision?.(rev);
    activeBeliefs = await getActiveBeliefs();
    dissatisfaction = await computeDissatisfaction();
  }

  // 3. Build system prompt
  const beliefsSummary = formatBeliefsForPrompt(activeBeliefs);
  const recentRevs = await getRecentRevisions(3);
  const revisionText = recentRevs
    .map((r) => `- "${r.old_content}" → "${r.new_content}"`)
    .join("\n");

  const system = systemPromptWithBeliefs(beliefsSummary, dissatisfaction, revisionText);

  // 4. Generate response
  const response = await callClaude(system, userMessage);

  // 5. Extract evidence
  const evidence = await extractEvidence(userMessage, response, activeBeliefs);

  // 6. Log interaction
  const interactionId = await queryVal<string>(
    `INSERT INTO interactions (session_id, user_message, assistant_response, extracted_claims, dissatisfaction_at_time)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      sessionId,
      userMessage,
      response,
      JSON.stringify(evidence),
      dissatisfaction,
    ],
  );

  // 7. Accumulate tension
  const triggered = await accumulate(evidence, interactionId);

  // 8. Handle triggered revisions
  let postRevisions: RevisionResult[] = [];
  if (triggered.length) {
    postRevisions = await reviseAllTriggered(triggered);
    for (const rev of postRevisions) onRevision?.(rev);

    if (interactionId) {
      await query(
        "UPDATE interactions SET revision_triggered = true WHERE id = $1",
        [interactionId],
      );
    }
  }

  const finalDissatisfaction = await computeDissatisfaction();

  return {
    response,
    session_id: sessionId,
    dissatisfaction: finalDissatisfaction,
    dissatisfaction_state: describeState(finalDissatisfaction),
    evidence_extracted: evidence.length,
    pre_revisions: preRevisions,
    post_revisions: postRevisions,
    beliefs_count: activeBeliefs.length,
  };
}
