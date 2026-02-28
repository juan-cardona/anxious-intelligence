/**
 * Tool definitions and execution layer.
 * 
 * Tools: bash, read_file, write_file, web_search, web_fetch, delegate
 * 
 * The `delegate` tool spawns a focused sub-agent with fresh context.
 * Progress tools are built into the orchestrator, not exposed as tools
 * (the orchestrator writes progress automatically).
 */

import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { runSubagent } from "./subagent.js";

const execAsync = promisify(exec);

// ── Tool Definitions (Claude tool_use format) ─────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "bash",
    description:
      "Run a shell command. Combine multiple commands with && or ; for efficiency. 30s timeout per call.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "Shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents. Max 100KB.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Absolute or relative path" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating directories as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Path to write to" },
        content: { type: "string" as const, description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "web_search",
    description: "Search the web via Brave Search. Returns top 5 results.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string" as const, description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch URL content as plain text (HTML stripped). Max 8KB returned.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" as const, description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "delegate",
    description:
      "Delegate a subtask to a focused sub-agent with a FRESH context window. " +
      "The sub-agent has its own tool loop (bash, read_file, write_file, web_search, web_fetch) " +
      "and returns a concise result. Use for:\n" +
      "- Reading/analyzing a large codebase (sub-agent gets full 200k context)\n" +
      "- Research tasks that require many web searches\n" +
      "- File operations across many files\n" +
      "- Any subtask that would bloat the current context\n" +
      "The sub-agent cannot delegate further (no recursion).",
    input_schema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string" as const,
          description: "Clear, specific description of what the sub-agent should do. Be explicit about expected output format.",
        },
      },
      required: ["task"],
    },
  },
];

/** Tools without delegate — used inside sub-agents to prevent recursion */
export const TOOLS_NO_DELEGATE = TOOL_DEFINITIONS.filter((t) => t.name !== "delegate");

// Shared state for delegate calls — needs system prompt from orchestrator
let _currentSystemPrompt = "";
let _currentSessionId = "default";

export function setDelegateContext(system: string, sessionId: string) {
  _currentSystemPrompt = system;
  _currentSessionId = sessionId;
}

// ── Execution ─────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, any>,
): Promise<string> {
  try {
    switch (name) {
      case "bash": {
        const { command } = input as { command: string };
        try {
          const { stdout, stderr } = await execAsync(command, {
            timeout: 30_000,
            maxBuffer: 512 * 1024,
            killSignal: "SIGKILL",
          });
          const parts = [stdout.trim(), stderr ? `[stderr] ${stderr.trim()}` : ""].filter(Boolean);
          return parts.join("\n") || "(no output)";
        } catch (err: any) {
          return `Exit ${err.code ?? "?"}: ${(err.stdout || "").trim()}\n${(err.stderr || "").trim()}`.trim();
        }
      }

      case "read_file": {
        const { path } = input as { path: string };
        const buf = await readFile(path);
        const MAX = 100 * 1024;
        if (buf.length > MAX) {
          return buf.slice(0, MAX).toString("utf8") + `\n[truncated — ${buf.length} bytes total]`;
        }
        return buf.toString("utf8");
      }

      case "write_file": {
        const { path, content } = input as { path: string; content: string };
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
        return `Written ${content.length} bytes to ${path}`;
      }

      case "web_search": {
        const { query } = input as { query: string };
        const key = process.env.BRAVE_API_KEY;
        if (!key) return "Error: BRAVE_API_KEY not configured";
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
        const resp = await fetch(url, {
          headers: { "X-Subscription-Token": key, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return `Search error: ${resp.status}`;
        const data = (await resp.json()) as any;
        const results = data.web?.results ?? [];
        if (!results.length) return "No results found.";
        return results
          .slice(0, 5)
          .map((r: any, i: number) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description || ""}`)
          .join("\n\n");
      }

      case "web_fetch": {
        const { url } = input as { url: string };
        const resp = await fetch(url, {
          headers: { "User-Agent": "AnxiousIntelligence/1.0" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) return `Fetch error: ${resp.status} ${resp.statusText}`;
        const text = await resp.text();
        const stripped = text
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
          .replace(/\s{3,}/g, "\n\n")
          .trim()
          .slice(0, 8_000);
        return stripped || "(empty response)";
      }

      case "delegate": {
        const { task } = input as { task: string };
        const result = await runSubagent(task, _currentSystemPrompt, _currentSessionId);
        const header = `[Sub-agent completed — ${result.toolsUsed} tool calls]`;
        if (result.error) {
          return `${header}\nError: ${result.error}\n\n${result.response}`;
        }
        return `${header}\n\n${result.response}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Tool error: ${err.message}`;
  }
}
