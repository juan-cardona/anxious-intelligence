/**
 * Agentic tool definitions and execution layer.
 * Provides bash, read_file, write_file, web_search, web_fetch.
 */

import { exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── Tool Definitions (Claude tool_use format) ─────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "bash",
    description:
      "Run a shell command. Use for executing scripts, checking system state, reading directory listings, running programs, etc.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file from the filesystem.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web using Brave Search. Returns top results with titles, URLs, and descriptions.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch the text content of a URL. Strips HTML tags to plain text.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
];

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
          const parts = [stdout.trim(), stderr ? `[stderr]\n${stderr.trim()}` : ""].filter(Boolean);
          return parts.join("\n") || "(no output)";
        } catch (err: any) {
          const msg = `Exit ${err.code ?? "?"}: ${err.message}`;
          const errOut = err.stderr ? `\n[stderr]\n${err.stderr.trim()}` : "";
          return `${msg}${errOut}`;
        }
      }

      case "read_file": {
        const { path } = input as { path: string };
        const MAX_BYTES = 100 * 1024;
        const buf = await readFile(path);
        if (buf.length > MAX_BYTES) {
          return (
            buf.slice(0, MAX_BYTES).toString("utf8") +
            `\n\n[truncated — file is ${buf.length} bytes, showing first ${MAX_BYTES}]`
          );
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
        if (!key) return "Error: Brave Search API not configured (set BRAVE_API_KEY)";
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
        const resp = await fetch(url, {
          headers: {
            "X-Subscription-Token": key,
            Accept: "application/json",
          },
        });
        if (!resp.ok) {
          return `Search API error: ${resp.status} ${await resp.text()}`;
        }
        const data = (await resp.json()) as any;
        const results = data.web?.results ?? [];
        if (!results.length) return "No results found.";
        return results
          .slice(0, 5)
          .map(
            (r: any, i: number) =>
              `[${i + 1}] ${r.title}\n${r.url}\n${r.description || "(no description)"}`,
          )
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
        // Strip HTML to readable text
        const stripped = text
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/\s{3,}/g, "\n\n")
          .trim()
          .slice(0, 8_000);
        return stripped || "(empty response)";
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: any) {
    return `Tool execution error: ${err.message}`;
  }
}
