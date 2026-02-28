/**
 * Tension Accumulator — updates belief confidence/tension based on evidence.
 */

import {
  reinforceBelief,
  addTension,
  logContradiction,
} from "./belief-graph.js";
import { TENSION_INCREMENT, REVISION_THRESHOLD } from "./config.js";
import type { Belief, Evidence } from "./types.js";

export async function accumulate(
  evidenceList: Evidence[],
  interactionId: string | null = null,
): Promise<Belief[]> {
  const triggered: Belief[] = [];

  for (const ev of evidenceList) {
    if (!ev.belief_id || ev.stance === "neutral") continue;

    if (ev.stance === "reinforcing") {
      await reinforceBelief(ev.belief_id);
    } else if (ev.stance === "contradicting") {
      const delta = TENSION_INCREMENT * ev.strength;
      const updated = await addTension(ev.belief_id, delta);

      await logContradiction(ev.belief_id, interactionId, ev.claim, delta);

      if (updated && updated.tension >= REVISION_THRESHOLD) {
        triggered.push(updated);
      }
    }
  }

  return triggered;
}
