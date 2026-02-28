#!/usr/bin/env node
/**
 * Anxious Intelligence — Main entry point.
 *
 * Starts: gateway server + configured channels (Telegram, etc.)
 */

import { startServer } from "./server.js";
import { startTelegram } from "./channels/telegram.js";
import { seedBeliefs } from "./belief-graph.js";
import { getPool } from "./db.js";

async function main() {
  console.log("\n  🧠 Anxious Intelligence — starting...\n");

  // Init DB
  getPool();

  // Auto-seed on first run
  const seeded = await seedBeliefs();
  if (seeded) console.log("  ✓ First run — seeded initial beliefs.");

  // Start gateway server (HTTP + WS + dashboard)
  startServer();

  // Start channels
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    startTelegram(telegramToken);
  } else {
    console.log("  ⚠ No TELEGRAM_BOT_TOKEN — Telegram channel disabled");
  }

  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
