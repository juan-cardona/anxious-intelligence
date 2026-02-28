/**
 * Tension Accumulator — updates belief confidence/tension based on evidence.
 *
 * Production features:
 * - Structured logging for all tension changes
 * - Error isolation per evidence item (one failure doesn't block others)
 * - Validation of evidence data
 */

import {
  reinforceBelief,
  addTension,
  logContradiction,
} from "./belief-graph.js";
import { TENSION_INCREMENT, REVISION_THRESHOLD } from "./config.js";
import type { Belief, Evidence } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("tension");

export async function accumulate(
  evidenceList: Evidence[],
  interactionId: string | null = null,
): Promise<Belief[]> {
  const triggered: Belief[] = [];

  if (!Array.isArray(evidenceList)) {
    log.warn("accumulate called with non-array evidence", { type: typeof evidenceList });
    return triggered;
  }

  for (const ev of evidenceList) {
    try {
      if (!ev.belief_id || ev.stance === "neutral") continue;

      // Validate evidence fields
      if (!ev.claim || typeof ev.claim !== "string") {
        log.warn("Skipping evidence with invalid claim", { evidence: JSON.stringify(ev).slice(0, 100) });
        continue;
      }
      if (typeof ev.strength !== "number" || ev.strength < 0 || ev.strength > 1) {
        ev.strength = 0.5; // default
      }

      if (ev.stance === "reinforcing") {
        await reinforceBelief(ev.belief_id);
        log.debug("Evidence reinforced belief", { belief_id: ev.belief_id, claim: ev.claim.slice(0, 60) });
      } else if (ev.stance === "contradicting") {
        const delta = TENSION_INCREMENT * ev.strength;
        const updated = await addTension(ev.belief_id, delta);

        await logContradiction(ev.belief_id, interactionId, ev.claim, delta);

        log.info("Contradiction logged", {
          belief_id: ev.belief_id,
          delta,
          new_tension: updated?.tension,
          claim: ev.claim.slice(0, 60),
        });

        if (updated && updated.tension >= REVISION_THRESHOLD) {
          log.warn("Belief crossed revision threshold!", {
            belief_id: ev.belief_id,
            tension: updated.tension,
            content: updated.content.slice(0, 60),
          });
          triggered.push(updated);
        }
      }
    } catch (err) {
      log.error("Failed to process evidence item", err, {
        belief_id: ev.belief_id,
        stance: ev.stance,
        claim: ev.claim?.slice(0, 60),
      });
      // Continue processing remaining evidence
    }
  }

  return triggered;
}
