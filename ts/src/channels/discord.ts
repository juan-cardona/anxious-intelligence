/**
 * Discord channel — discord.js wired to the Anxious Intelligence orchestrator.
 *
 * Every message goes through the belief system. Responses carry dissatisfaction state.
 * Supports slash commands for introspection and inline revision notifications.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { processInteraction } from "../orchestrator.js";
import { computeDissatisfaction, describeState } from "../dissatisfaction.js";
import { getActiveBeliefs } from "../belief-graph.js";
import type { RevisionResult } from "../types.js";

let client: Client | null = null;

export function startDiscord(token: string) {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.on("ready", () => {
    console.log(`  🎮 Discord bot online: ${client!.user?.tag}`);
  });

  client.on("messageCreate", async (msg: Message) => {
    // Ignore own messages and other bots
    if (msg.author.bot) return;

    const text = msg.content.trim();
    if (!text) return;

    const chatId = msg.channel.id;
    const sessionId = `discord:${chatId}`;

    // ── Slash commands for introspection ──
    if (text === "!beliefs" || text === "/beliefs") {
      const beliefs = await getActiveBeliefs();
      if (!beliefs.length) {
        await msg.reply("No active beliefs.");
        return;
      }
      const lines = beliefs.map((b) => {
        const icon = b.tension > 0.5 ? "🔴" : b.tension > 0.2 ? "🟡" : "🟢";
        return `${icon} t=${b.tension.toFixed(2)} c=${b.confidence.toFixed(2)} │ ${b.content.slice(0, 50)}`;
      });
      await sendSplit(msg, `**Active Beliefs**\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
      return;
    }

    if (text === "!status" || text === "/status") {
      const d = await computeDissatisfaction();
      const beliefs = await getActiveBeliefs();
      const high = beliefs.filter((b) => b.tension > 0.3);
      const bar = "█".repeat(Math.round(d * 20)) + "░".repeat(20 - Math.round(d * 20));
      await msg.reply(
        `**Anxious Intelligence**\n` +
        `Dissatisfaction: \`[${bar}] ${d.toFixed(4)}\`\n` +
        `${describeState(d)}\n` +
        `Beliefs: ${beliefs.length} (${high.length} high tension)`,
      );
      return;
    }

    if (text === "!help" || text === "/help") {
      await msg.reply(
        "🧠 **Anxious Intelligence**\n\n" +
        "`!beliefs` — Show belief tensions\n" +
        "`!status` — Dissatisfaction level\n" +
        "`!help` — This help\n\n" +
        "Everything else goes through the belief system.",
      );
      return;
    }

    // ── Send typing indicator ──
    const channel = msg.channel;
    if ("sendTyping" in channel) {
      (channel as TextChannel).sendTyping().catch(() => {});
    }

    // ── Process through belief pipeline ──
    try {
      const revisionMessages: string[] = [];

      const result = await processInteraction(text, sessionId, (rev: RevisionResult) => {
        if (rev.status === "revised") {
          revisionMessages.push(
            `⚡ **BELIEF REVISION**\n` +
            `~~${rev.old_belief}~~\n` +
            `→ ${rev.new_belief}\n` +
            `_Discovered ${rev.discovered_connections ?? 0} new connections_`,
          );
        }
      });

      // Send revision notifications first
      for (const revMsg of revisionMessages) {
        await sendSplit(msg, revMsg);
      }

      await sendSplit(msg, result.response);
    } catch (err) {
      console.error("Discord processing error:", err);
      await msg.reply("⚠️ Processing error. The belief system may be under revision.").catch(() => {});
    }
  });

  client.on("error", (err) => {
    console.error("Discord client error:", err);
  });

  client.login(token);

  return client;
}

export function stopDiscord() {
  client?.destroy();
  client = null;
}

// ── Helpers ───────────────────────────────────────────────────────

async function sendSplit(msg: Message, text: string, maxLen = 1950) {
  const chunks = splitMessage(text, maxLen);
  for (const chunk of chunks) {
    await msg.reply(chunk);
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
