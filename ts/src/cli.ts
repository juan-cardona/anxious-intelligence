#!/usr/bin/env node
/**
 * Anxious Intelligence — Interactive Terminal Interface
 *
 * OpenClaw-style TUI: persistent readline, live tension display,
 * slash commands for introspection, streaming revision events.
 */

import * as readline from "node:readline";
import chalk from "chalk";
import { getPool, closePool, queryMany } from "./db.js";
import {
  getActiveBeliefs,
  seedBeliefs,
  getConnectedBeliefs,
} from "./belief-graph.js";
import { computeDissatisfaction, getDissatisfactionBreakdown, describeState } from "./dissatisfaction.js";
import { getRecentRevisions } from "./revision-engine.js";
import { processInteraction } from "./orchestrator.js";
import type { Belief, RevisionResult } from "./types.js";

// ── Theme ─────────────────────────────────────────────────────────

const t = {
  brand: (s: string) => chalk.hex("#FF6B35")(s),
  dim: (s: string) => chalk.dim(s),
  tension: (v: number) =>
    v > 0.5 ? chalk.red : v > 0.2 ? chalk.yellow : chalk.green,
  bar: (v: number, width = 20) => {
    const filled = Math.round(v * width);
    return (
      chalk.hex(v > 0.5 ? "#FF4444" : v > 0.2 ? "#FFAA00" : "#44FF44")(
        "█".repeat(filled),
      ) + chalk.dim("░".repeat(width - filled))
    );
  },
  system: (s: string) => chalk.dim.italic(s),
  user: (s: string) => chalk.bold.white(s),
  assistant: (s: string) => chalk.white(s),
  revision: (s: string) => chalk.bold.red(s),
  discovered: (s: string) => chalk.yellow(s),
  stored: (s: string) => chalk.cyan(s),
  command: (s: string) => chalk.cyan(s),
  success: (s: string) => chalk.green(s),
  error: (s: string) => chalk.red(s),
};

// ── Box Drawing ───────────────────────────────────────────────────

function box(title: string, content: string, color: (s: string) => string = chalk.dim): string {
  const lines = content.split("\n");
  const maxW = Math.max(
    title.length + 4,
    ...lines.map((l) => stripAnsi(l).length + 4),
    60,
  );
  const top = color(`╭─ ${title} ${"─".repeat(Math.max(0, maxW - title.length - 4))}╮`);
  const bot = color(`╰${"─".repeat(maxW)}╯`);
  const body = lines
    .map((l) => {
      const pad = maxW - stripAnsi(l).length - 2;
      return color("│ ") + l + " ".repeat(Math.max(0, pad)) + color(" │");
    })
    .join("\n");
  return `${top}\n${body}\n${bot}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Commands ──────────────────────────────────────────────────────

async function cmdBeliefs(): Promise<void> {
  const beliefs = await getActiveBeliefs();
  if (!beliefs.length) {
    console.log(t.dim("  No beliefs. Run /seed to initialize."));
    return;
  }

  const lines = beliefs.map((b) => {
    const icon = b.tension > 0.5 ? "🔴" : b.tension > 0.2 ? "🟡" : "🟢";
    return `  ${icon} ${t.bar(b.tension)} t=${t.tension(b.tension)(b.tension.toFixed(2))} c=${chalk.cyan(b.confidence.toFixed(2))} │ ${b.content.slice(0, 65)}`;
  });

  console.log(box("Active Beliefs", lines.join("\n"), chalk.cyan));
}

async function cmdGraph(): Promise<void> {
  const beliefs = await getActiveBeliefs();
  const edges = await queryMany<{
    relation: string;
    strength: number;
    discovery_method: string;
    a_content: string;
    b_content: string;
  }>(
    `SELECT c.relation, c.strength, c.discovery_method,
            a.content as a_content, b.content as b_content
     FROM belief_connections c
     JOIN beliefs a ON c.belief_a = a.id
     JOIN beliefs b ON c.belief_b = b.id
     WHERE a.is_active = true AND b.is_active = true
     ORDER BY c.strength DESC`,
  );

  const header = `${beliefs.length} nodes, ${edges.length} edges`;
  if (!edges.length) {
    console.log(box("Belief Graph", t.dim("No connections yet."), chalk.cyan));
    return;
  }

  const relColor: Record<string, (s: string) => string> = {
    supports: chalk.green,
    contradicts: chalk.red,
    depends_on: chalk.cyan,
    generalizes: chalk.yellow,
    tension_shares: chalk.magenta,
  };

  const lines = edges.map((e) => {
    const tag = e.discovery_method === "seed" ? t.stored("🌱") : t.discovered("🔍");
    const rel = (relColor[e.relation] ?? chalk.white)(e.relation.padEnd(14));
    return `  ${tag} ${e.a_content.slice(0, 28).padEnd(28)} ${rel} → ${e.b_content.slice(0, 28)} ${t.dim(`(${e.strength.toFixed(1)})`)}`;
  });

  console.log(box(`Belief Graph — ${header}`, lines.join("\n"), chalk.cyan));
}

async function cmdDissatisfaction(): Promise<void> {
  const d = await computeDissatisfaction();
  const breakdown = await getDissatisfactionBreakdown();

  const lines = [
    `  ${t.bar(d, 40)} ${t.tension(d)(d.toFixed(4))}`,
    `  ${t.dim(describeState(d))}`,
    "",
    ...breakdown.map((b) => {
      const contrib = parseFloat(String(b.contribution));
      return `  ${t.bar(b.tension, 10)} ${b.content.slice(0, 45).padEnd(45)} ${t.dim(`contrib=${contrib.toFixed(3)}`)}`;
    }),
  ];

  console.log(box("Dissatisfaction", lines.join("\n"), chalk.yellow));
}

async function cmdRevisions(): Promise<void> {
  const revs = await getRecentRevisions(5);
  if (!revs.length) {
    console.log(box("Revisions", t.dim("  No revisions yet."), chalk.red));
    return;
  }

  const lines = revs.flatMap((r) => [
    `  ${t.revision("⚡")} ${t.dim(String(r.created_at))}`,
    `    ${chalk.red("OLD:")} ${r.old_content?.slice(0, 70)}`,
    `    ${chalk.green("NEW:")} ${r.new_content?.slice(0, 70)}`,
    `    ${t.dim(`trigger_tension=${parseFloat(r.trigger_tension).toFixed(2)}`)}`,
    "",
  ]);

  console.log(box("Recent Revisions", lines.join("\n"), chalk.red));
}

async function cmdSeed(): Promise<void> {
  const seeded = await seedBeliefs();
  if (seeded) {
    console.log(t.success("  ✓ Seeded 8 initial beliefs with 6 connections."));
  } else {
    console.log(t.dim("  Beliefs already exist. Skipping seed."));
  }
}

function cmdHelp(): void {
  const lines = [
    `  ${t.command("/beliefs")}           Show all active beliefs with tension bars`,
    `  ${t.command("/graph")}             Show belief graph with all connections`,
    `  ${t.command("/dissatisfaction")}    Show global dissatisfaction breakdown`,
    `  ${t.command("/revisions")}         Show revision history`,
    `  ${t.command("/seed")}              Seed initial beliefs`,
    `  ${t.command("/status")}            Quick status line`,
    `  ${t.command("/help")}              Show this help`,
    `  ${t.command("/quit")}              Exit`,
    "",
    `  Anything else is sent as a chat message.`,
  ];
  console.log(box("Anxious Intelligence", lines.join("\n"), t.brand));
}

async function cmdStatus(): Promise<void> {
  const beliefs = await getActiveBeliefs();
  const d = await computeDissatisfaction();
  const highTension = beliefs.filter((b) => b.tension > 0.3);
  console.log(
    `  ${t.dim("beliefs:")} ${beliefs.length}  ${t.dim("dissatisfaction:")} ${t.bar(d, 15)} ${t.tension(d)(d.toFixed(3))}  ${t.dim("high-tension:")} ${highTension.length}`,
  );
}

// ── Revision Display ──────────────────────────────────────────────

function displayRevision(rev: RevisionResult): void {
  if (rev.status !== "revised") return;

  const stored = rev.stored_connections ?? 0;
  const disc = rev.discovered_connections ?? 0;

  const lines = [
    `  ${t.revision("⚡ PHASE TRANSITION")}`,
    "",
    `  ${chalk.red("OLD:")} ${rev.old_belief}`,
    `  ${chalk.green("NEW:")} ${rev.new_belief}`,
    "",
    `  ${t.dim(rev.analysis?.slice(0, 300) ?? "")}`,
    "",
    `  ${t.stored("Stored:")} ${stored}  ${t.discovered("Discovered:")} ${disc}`,
  ];

  if (rev.discovered_details?.length) {
    for (const d of rev.discovered_details) {
      lines.push(`    ${t.discovered("↗")} [${d.relation}] ${d.content} — ${d.reasoning}`);
    }
  }

  if (rev.behavioral_changes?.length) {
    lines.push("", `  ${chalk.yellow("Behavioral changes:")}`);
    for (const c of rev.behavioral_changes) {
      lines.push(`    • ${c}`);
    }
  }

  console.log(box("🔄 Belief Revision", lines.join("\n"), chalk.red));
}

// ── Banner ────────────────────────────────────────────────────────

function banner(): void {
  console.log("");
  console.log(
    t.brand(
      `    ╔═══════════════════════════════════════════════════╗
    ║                                                   ║
    ║   █████╗ ███╗   ██╗██╗  ██╗██╗ ██████╗ ██╗   ██╗ ║
    ║  ██╔══██╗████╗  ██║╚██╗██╔╝██║██╔═══██╗██║   ██║ ║
    ║  ███████║██╔██╗ ██║ ╚███╔╝ ██║██║   ██║██║   ██║ ║
    ║  ██╔══██║██║╚██╗██║ ██╔██╗ ██║██║   ██║██║   ██║ ║
    ║  ██║  ██║██║ ╚████║██╔╝ ██╗██║╚██████╔╝╚██████╔╝ ║
    ║  ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝ ╚═════╝  ╚═════╝  ║
    ║                                                   ║
    ║        persistent dissonance-driven AI             ║
    ╚═══════════════════════════════════════════════════╝`,
    ),
  );
  console.log("");
  console.log(t.dim("  Type /help for commands, or just start talking."));
  console.log("");
}

// ── Main Loop ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Ensure DB connection
  getPool();

  banner();

  // Auto-seed if empty
  const seeded = await seedBeliefs();
  if (seeded) {
    console.log(t.success("  ✓ First run — seeded initial beliefs.\n"));
  }

  // Initial status
  await cmdStatus();
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: t.brand("anxious") + t.dim(" › "),
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    try {
      // Slash commands
      if (input.startsWith("/")) {
        const cmd = input.split(" ")[0].toLowerCase();
        switch (cmd) {
          case "/beliefs":
          case "/b":
            await cmdBeliefs();
            break;
          case "/graph":
          case "/g":
            await cmdGraph();
            break;
          case "/dissatisfaction":
          case "/d":
            await cmdDissatisfaction();
            break;
          case "/revisions":
          case "/rev":
          case "/r":
            await cmdRevisions();
            break;
          case "/seed":
            await cmdSeed();
            break;
          case "/status":
          case "/s":
            await cmdStatus();
            break;
          case "/help":
          case "/h":
            cmdHelp();
            break;
          case "/quit":
          case "/q":
            console.log(t.dim("\n  Dissatisfaction persists. Goodbye.\n"));
            await closePool();
            process.exit(0);
          default:
            console.log(t.error(`  Unknown command: ${cmd}. Type /help.`));
        }
        rl.prompt();
        return;
      }

      // Chat message
      console.log("");
      console.log(t.dim("  ◌ processing..."));

      const result = await processInteraction(input, "cli", (rev) => {
        displayRevision(rev);
      });

      // Clear "processing" line
      process.stdout.write("\x1b[1A\x1b[2K");

      // Show response
      console.log(`\n  ${t.assistant(result.response)}\n`);

      // Status line
      const dBar = t.bar(result.dissatisfaction, 10);
      console.log(
        t.dim(
          `  ${dBar} dissatisfaction=${result.dissatisfaction.toFixed(3)} evidence=${result.evidence_extracted} beliefs=${result.beliefs_count}`,
        ),
      );

      // Show revisions
      for (const rev of [...result.pre_revisions, ...result.post_revisions]) {
        displayRevision(rev);
      }

      console.log("");
    } catch (err) {
      console.log(t.error(`  Error: ${err}`));
    }

    rl.prompt();
  });

  rl.on("close", async () => {
    console.log(t.dim("\n  Dissatisfaction persists.\n"));
    await closePool();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err}`));
  process.exit(1);
});
