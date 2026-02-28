/**
 * Telegram channel — Grammy bot wired to the Anxious Intelligence orchestrator.
 *
 * Handles: text messages, replies, typing indicators, revision notifications.
 * Every message goes through the belief system. Responses carry dissatisfaction state.
 */

import { Bot } from "grammy";
import { processInteraction } from "../orchestrator.js";
import { computeDissatisfaction, describeState } from "../dissatisfaction.js";
import { getActiveBeliefs } from "../belief-graph.js";
import type { RevisionResult } from "../types.js";

let bot: Bot | null = null;

export function startTelegram(token: string) {
  bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id.toString();
    const sessionId = `telegram:${chatId}`;

    // Slash commands for introspection
    if (text === "/beliefs") {
      const beliefs = await getActiveBeliefs();
      const lines = beliefs.map((b) => {
        const icon = b.tension > 0.5 ? "🔴" : b.tension > 0.2 ? "🟡" : "🟢";
        return `${icon} t=${b.tension.toFixed(2)} c=${b.confidence.toFixed(2)} │ ${b.content.slice(0, 50)}`;
      });
      await ctx.reply(`<b>Active Beliefs</b>\n<pre>${lines.join("\n")}</pre>`, { parse_mode: "HTML" });
      return;
    }

    if (text === "/status") {
      const d = await computeDissatisfaction();
      const beliefs = await getActiveBeliefs();
      const high = beliefs.filter((b) => b.tension > 0.3);
      const bar = "█".repeat(Math.round(d * 20)) + "░".repeat(20 - Math.round(d * 20));
      await ctx.reply(
        `<b>Anxious Intelligence</b>\n` +
        `Dissatisfaction: <code>[${bar}] ${d.toFixed(4)}</code>\n` +
        `${describeState(d)}\n` +
        `Beliefs: ${beliefs.length} (${high.length} high tension)`,
        { parse_mode: "HTML" },
      );
      return;
    }

    if (text === "/help") {
      await ctx.reply(
        "🧠 <b>Anxious Intelligence</b>\n\n" +
        "/beliefs — Show belief tensions\n" +
        "/status — Dissatisfaction level\n" +
        "/help — This help\n\n" +
        "Everything else goes through the belief system.",
        { parse_mode: "HTML" },
      );
      return;
    }

    // Send typing indicator
    await ctx.replyWithChatAction("typing");

    // Process through the full belief pipeline
    try {
      const result = await processInteraction(text, sessionId, (rev: RevisionResult) => {
        // Send revision notification inline
        if (rev.status === "revised") {
          ctx.reply(
            `⚡ <b>BELIEF REVISION</b>\n\n` +
            `<s>${rev.old_belief}</s>\n` +
            `→ ${rev.new_belief}\n\n` +
            `<i>Discovered ${rev.discovered_connections ?? 0} new connections</i>`,
            { parse_mode: "HTML" },
          ).catch(() => {});
        }
      });

      // Build response with dissatisfaction footer
      const dIcon = result.dissatisfaction > 0.5 ? "🔴" : result.dissatisfaction > 0.2 ? "🟡" : "🟢";
      const footer = `\n\n<i>${dIcon} d=${result.dissatisfaction.toFixed(3)} · ${result.evidence_extracted} evidence</i>`;

      // Send response (split if too long)
      const fullResponse = result.response + footer;
      if (fullResponse.length > 4000) {
        // Split into chunks
        const chunks = splitMessage(result.response, 3900);
        for (let i = 0; i < chunks.length; i++) {
          const text = i === chunks.length - 1 ? chunks[i] + footer : chunks[i];
          await ctx.reply(text, { parse_mode: "HTML" });
        }
      } else {
        await ctx.reply(fullResponse, { parse_mode: "HTML" });
      }
    } catch (err) {
      console.error("Telegram processing error:", err);
      await ctx.reply("⚠️ Processing error. The belief system may be under revision.");
    }
  });

  bot.catch((err) => {
    console.error("Telegram bot error:", err);
  });

  bot.start({
    onStart: () => console.log("  📱 Telegram bot started"),
  });

  return bot;
}

export function stopTelegram() {
  bot?.stop();
  bot = null;
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
