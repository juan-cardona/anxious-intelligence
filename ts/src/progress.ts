/**
 * Progress persistence — task state on disk for cross-session continuity.
 * 
 * Two layers:
 * 1. Progress JSONL — append-only log of tool events (for the orchestrator)
 * 2. Progress file — markdown summary written by the model (human-readable)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const PROGRESS_DIR = join(import.meta.dirname, "..", "..", "progress");

export interface ProgressEntry {
  timestamp: string;
  type: "task_start" | "tool_call" | "tool_result" | "thinking" | "response" | "error" | "compaction";
  summary: string;
}

export async function ensureDir() {
  await mkdir(PROGRESS_DIR, { recursive: true });
}

function logPath(sessionId: string): string {
  return join(PROGRESS_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

function filePath(sessionId: string): string {
  return join(PROGRESS_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`);
}

// ── JSONL log (orchestrator writes automatically) ─────────────────

export async function appendProgress(sessionId: string, entry: ProgressEntry): Promise<void> {
  await ensureDir();
  await writeFile(logPath(sessionId), JSON.stringify(entry) + "\n", { flag: "a" });
}

export async function readProgressLog(sessionId: string): Promise<ProgressEntry[]> {
  try {
    const text = await readFile(logPath(sessionId), "utf8");
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function getProgressSummary(sessionId: string): Promise<string> {
  const entries = await readProgressLog(sessionId);
  if (!entries.length) return "";
  return entries.slice(-30).map((e) => `[${e.timestamp}] ${e.type}: ${e.summary}`).join("\n");
}

// ── Markdown file (model writes via write_progress tool) ──────────

export async function readProgressFile(sessionId: string): Promise<string | null> {
  try {
    return await readFile(filePath(sessionId), "utf8");
  } catch {
    return null;
  }
}

export async function writeProgressFile(sessionId: string, content: string): Promise<void> {
  await ensureDir();
  await writeFile(filePath(sessionId), content, "utf8");
}

export async function appendProgressNote(sessionId: string, note: string): Promise<void> {
  await appendProgress(sessionId, {
    timestamp: new Date().toISOString(),
    type: "response",
    summary: note,
  });
}
