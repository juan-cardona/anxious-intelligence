/**
 * Tool system — gives the Anxious Intelligence agent hands.
 *
 * Tools are passed to Claude as tool definitions. The orchestrator
 * executes them and feeds results back. Belief state modulates
 * tool usage (high tension → verify before acting).
 */

import { execSync, exec as execCb } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ── Tool Definitions (Claude format) ──────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Execute a shell command and return stdout/stderr. Use for: running code, installing packages, checking system state, git operations, API calls with curl. Working directory is the project root.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 30)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the full text content.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path" },
        limit: { type: "number", description: "Max lines to read (default: all)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files and directories at a path.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: .)" },
      },
      required: [],
    },
  },
  {
    name: "web_search",
    description: "Search the web using Brave Search API. Returns titles, URLs, and snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results (default 5, max 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and extract readable text content (HTML → markdown).",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        max_chars: { type: "number", description: "Max characters to return (default 10000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "query_beliefs",
    description: "Query your own belief system. Returns current beliefs, tensions, dissatisfaction. Use this for metacognition — understanding your own state before making decisions.",
    input_schema: {
      type: "object",
      properties: {
        what: {
          type: "string",
          enum: ["beliefs", "dissatisfaction", "graph", "revisions"],
          description: "What to query",
        },
      },
      required: ["what"],
    },
  },
];

// ── Tool Execution ────────────────────────────────────────────────

const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY ?? "";

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "bash":
        return executeBash(call);
      case "read_file":
        return executeReadFile(call);
      case "write_file":
        return executeWriteFile(call);
      case "list_files":
        return executeListFiles(call);
      case "web_search":
        return await executeWebSearch(call);
      case "web_fetch":
        return await executeWebFetch(call);
      case "query_beliefs":
        return await executeQueryBeliefs(call);
      default:
        return { tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
    }
  } catch (err) {
    return { tool_use_id: call.id, content: `Error: ${err}`, is_error: true };
  }
}

function executeBash(call: ToolCall): ToolResult {
  const cmd = call.input.command as string;
  const timeout = ((call.input.timeout as number) ?? 30) * 1000;

  // Safety: block destructive commands without confirmation
  const dangerous = /\brm\s+-rf\s+[\/~]|\bdd\s+if=|mkfs|fdisk/i;
  if (dangerous.test(cmd)) {
    return { tool_use_id: call.id, content: "Blocked: potentially destructive command. Use trash instead of rm.", is_error: true };
  }

  try {
    const output = execSync(cmd, {
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      cwd: resolve(process.env.HOME ?? "/tmp"),
    });
    return { tool_use_id: call.id, content: output.slice(0, 50000) || "(no output)" };
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    return {
      tool_use_id: call.id,
      content: `Exit code ${err.status ?? "unknown"}\nstdout: ${stdout.slice(0, 10000)}\nstderr: ${stderr.slice(0, 10000)}`,
      is_error: true,
    };
  }
}

function executeReadFile(call: ToolCall): ToolResult {
  const path = resolve(call.input.path as string);
  if (!existsSync(path)) {
    return { tool_use_id: call.id, content: `File not found: ${path}`, is_error: true };
  }
  let content = readFileSync(path, "utf-8");
  const limit = call.input.limit as number | undefined;
  if (limit) {
    content = content.split("\n").slice(0, limit).join("\n");
  }
  return { tool_use_id: call.id, content: content.slice(0, 100000) };
}

function executeWriteFile(call: ToolCall): ToolResult {
  const path = resolve(call.input.path as string);
  const content = call.input.content as string;
  const dir = resolve(path, "..");
  execSync(`mkdir -p "${dir}"`);
  writeFileSync(path, content, "utf-8");
  return { tool_use_id: call.id, content: `Written ${content.length} bytes to ${path}` };
}

function executeListFiles(call: ToolCall): ToolResult {
  const dirPath = resolve(call.input.path as string ?? ".");
  if (!existsSync(dirPath)) {
    return { tool_use_id: call.id, content: `Directory not found: ${dirPath}`, is_error: true };
  }
  const entries = readdirSync(dirPath).map((name) => {
    try {
      const stat = statSync(resolve(dirPath, name));
      return `${stat.isDirectory() ? "📁" : "📄"} ${name}${stat.isDirectory() ? "/" : ""} (${stat.size}b)`;
    } catch {
      return `❓ ${name}`;
    }
  });
  return { tool_use_id: call.id, content: entries.join("\n") || "(empty directory)" };
}

async function executeWebSearch(call: ToolCall): Promise<ToolResult> {
  if (!BRAVE_API_KEY) {
    return { tool_use_id: call.id, content: "No BRAVE_SEARCH_API_KEY configured", is_error: true };
  }
  const q = call.input.query as string;
  const count = Math.min(10, (call.input.count as number) ?? 5);
  const resp = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`,
    { headers: { "X-Subscription-Token": BRAVE_API_KEY, Accept: "application/json" } },
  );
  if (!resp.ok) return { tool_use_id: call.id, content: `Search error: ${resp.status}`, is_error: true };
  const data = await resp.json() as any;
  const results = (data.web?.results ?? []).map((r: any) =>
    `**${r.title}**\n${r.url}\n${r.description ?? ""}\n`,
  );
  return { tool_use_id: call.id, content: results.join("\n") || "No results" };
}

async function executeWebFetch(call: ToolCall): Promise<ToolResult> {
  const url = call.input.url as string;
  const maxChars = (call.input.max_chars as number) ?? 10000;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "AnxiousIntelligence/0.1" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    // Simple HTML to text
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { tool_use_id: call.id, content: cleaned.slice(0, maxChars) };
  } catch (err) {
    return { tool_use_id: call.id, content: `Fetch error: ${err}`, is_error: true };
  }
}

async function executeQueryBeliefs(call: ToolCall): Promise<ToolResult> {
  // Query our own API
  const what = call.input.what as string;
  const endpoint = {
    beliefs: "/api/beliefs",
    dissatisfaction: "/api/dissatisfaction",
    graph: "/api/graph",
    revisions: "/api/revisions?limit=5",
  }[what] ?? "/api/overview";

  try {
    const port = process.env.PORT ?? "8080";
    const resp = await fetch(`http://127.0.0.1:${port}${endpoint}`);
    const data = await resp.json();
    return { tool_use_id: call.id, content: JSON.stringify(data, null, 2).slice(0, 20000) };
  } catch (err) {
    return { tool_use_id: call.id, content: `Self-query error: ${err}`, is_error: true };
  }
}
