/**
 * Autonomous Agent Loop — belief-driven background tasks.
 * 
 * Periodically checks belief state and triggers autonomous tool use
 * when tension is high. YIELDS to user requests.
 */

import { getActiveBeliefs } from "./belief-graph.js";
import { computeDissatisfaction } from "./dissatisfaction.js";
import { processInteraction, isUserRequestActive } from "./orchestrator.js";
import type { RevisionResult } from "./types.js";

let running = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

const AUTONOMOUS_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DISSATISFACTION_THRESHOLD = 0.5;

export function startAutonomousLoop() {
  if (running) return;
  running = true;

  console.log("  🤖 Autonomous belief loop started (every 15min, yields to user)");

  intervalHandle = setInterval(async () => {
    try {
      await checkAndAct();
    } catch (err: any) {
      console.error("[autonomous] Error:", err.message);
    }
  }, AUTONOMOUS_INTERVAL_MS);
}

export function stopAutonomousLoop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  running = false;
}

async function checkAndAct() {
  // Don't run if a user request is in flight
  if (isUserRequestActive()) {
    console.log("[autonomous] Skipping — user request in progress");
    return;
  }

  const dissatisfaction = await computeDissatisfaction();
  const beliefs = await getActiveBeliefs();
  const highTension = beliefs.filter((b) => b.tension > 0.3);

  if (dissatisfaction < DISSATISFACTION_THRESHOLD && highTension.length === 0) {
    return;
  }

  // Double-check user isn't active
  if (isUserRequestActive()) return;

  console.log(
    `[autonomous] d=${dissatisfaction.toFixed(3)}, high-tension=${highTension.length}. Investigating.`,
  );

  const tensionSummary = highTension
    .map((b) => `- "${b.content}" (tension=${b.tension.toFixed(2)})`)
    .join("\n");

  const prompt = `[AUTONOMOUS MODE — Self-directed investigation]

Your dissatisfaction is ${dissatisfaction.toFixed(3)}. High-tension beliefs:

${tensionSummary}

Investigate these tensions using tools. Search the web, read files, gather evidence. Be focused — max 10 tool calls. Write findings to /home/clawd/projects/anxious-intelligence/notes/.`;

  try {
    const result = await processInteraction(
      prompt,
      "autonomous",
      (rev: RevisionResult) => {
        console.log(`[autonomous] Revision: "${rev.old_belief?.slice(0, 40)}" → "${rev.new_belief?.slice(0, 40)}"`);
      },
    );

    console.log(
      `[autonomous] Done. evidence=${result.evidence_extracted} tools=${result.tools_used?.length ?? 0}`,
    );
  } catch (err: any) {
    console.error("[autonomous] Error:", err.message);
  }
}
