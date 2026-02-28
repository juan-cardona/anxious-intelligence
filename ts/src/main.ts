#!/usr/bin/env node
/**
 * Anxious Intelligence — Main entry point.
 *
 * Starts: gateway server + configured channels (Telegram, Discord)
 * This IS the cognitive architecture. Channels are just plumbing.
 */

import { startServer } from "./server.js";
import { startTelegram } from "./channels/telegram.js";
import { startDiscord } from "./channels/discord.js";
import { startAutonomousLoop } from "./autonomous.js";
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

  // Start channels — the plumbing
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramToken) {
    startTelegram(telegramToken);
  } else {
    console.log("  ⚠ No TELEGRAM_BOT_TOKEN — Telegram channel disabled");
  }

  const discordToken = process.env.DISCORD_TOKEN;
  if (discordToken) {
    startDiscord(discordToken);
  } else {
    console.log("  ⚠ No DISCORD_TOKEN — Discord channel disabled");
  }

  // Start autonomous belief-driven loop
  startAutonomousLoop();

  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
