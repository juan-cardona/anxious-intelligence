/**
 * Code-Belief Bridge — maps belief revisions to concrete code patches.
 *
 * When a belief revision happens, this module:
 * 1. Analyzes the revision (old belief → new belief) and behavioral implications
 * 2. Reads relevant source files to understand current behavior
 * 3. Proposes specific code patches that align behavior with new understanding
 * 4. Stores patches for review and safe application
 *
 * This is the strange loop: the system modifying its own anxiety architecture
 * based on what it has learned about itself.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { query, queryMany, queryOne } from "./db.js";
import { callClaude } from "./claude.js";

const execAsync = promisify(exec);

// The root of the project — patches can only touch files under here
const PROJECT_ROOT = join(import.meta.dirname, "..");
const SRC_DIR = join(PROJECT_ROOT, "src");

// Files the code bridge is allowed to modify
const MUTABLE_FILES = [
  "src/prompts.ts",        // System prompt templates — most common target
  "src/config.ts",         // Thresholds, weights, timing
  "src/orchestrator.ts",   // How interactions are processed
  "src/autonomous.ts",     // Background loop behavior
  "src/dissatisfaction.ts", // How anxiety is computed
  "src/evidence-extractor.ts", // How evidence is interpreted
];

// Files the code bridge must NEVER modify (safety boundary)
const IMMUTABLE_FILES = [
  "src/code-bridge.ts",    // Can't modify itself
  "src/db.ts",             // Database layer
  "src/main.ts",           // Entry point
  "src/server.ts",         // Server infrastructure (patches are added via API separately)
];

export interface CodePatch {
  id: string;
  revision_id?: string;
  belief_id: string;
  file_path: string;
  original_content: string;
  new_content: string;
  rationale: string;
  status: "proposed" | "approved" | "applied" | "rolled_back" | "rejected";
  created_at: string;
  applied_at?: string;
}

/**
 * Given a belief revision, propose code patches that align behavior with the new belief.
 */
export async function proposePatches(
  oldBelief: string,
  newBelief: string,
  beliefId: string,
  revisionId: string,
  reasoning: string,
  behavioralChanges: string[],
): Promise<CodePatch[]> {
  // 1. Read all mutable source files
  const fileContents: Record<string, string> = {};
  for (const filePath of MUTABLE_FILES) {
    try {
      const fullPath = join(PROJECT_ROOT, filePath);
      fileContents[filePath] = await readFile(fullPath, "utf-8");
    } catch {
      // File might not exist yet
    }
  }

  // 2. Build context for the LLM
  const filesSummary = Object.entries(fileContents)
    .map(([path, content]) => {
      const lines = content.split("\n");
      return `=== ${path} (${lines.length} lines) ===\n${content}`;
    })
    .join("\n\n");

  const prompt = `You are the Code-Belief Bridge for an AI self-model system called "Anxious Intelligence."

A belief revision just occurred:

OLD BELIEF: ${oldBelief}
NEW BELIEF: ${newBelief}
REASONING: ${reasoning}
BEHAVIORAL CHANGES SUGGESTED: ${behavioralChanges.join("; ") || "none specified"}

Your job: analyze the source code below and propose SPECIFIC, MINIMAL code patches that would make the system's behavior more consistent with the new belief.

Rules:
- Only modify files in this list: ${MUTABLE_FILES.join(", ")}
- Each patch must be a complete file replacement (provide the full new file content)
- Patches should be MINIMAL — change as little as possible
- Focus on the most impactful change first
- If no code change is warranted (the belief is purely self-descriptive), return an empty array
- Prefer changes to prompts.ts and config.ts over structural changes
- NEVER break the system — patches must be syntactically valid TypeScript
- Think about what concrete behavioral difference this belief revision implies

Common patch patterns:
- Adjusting system prompt language in prompts.ts to reflect new self-understanding
- Changing thresholds in config.ts (tension, confidence, dissatisfaction levels)
- Adding pre-processing steps in orchestrator.ts
- Modifying evidence interpretation in evidence-extractor.ts

SOURCE CODE:
${filesSummary}

Respond with a JSON array of patches. Each patch:
{
  "file_path": "src/prompts.ts",
  "rationale": "Why this change aligns behavior with the new belief",
  "changes_description": "Human-readable description of what changed",
  "new_content": "The complete new file content"
}

If no patches are warranted, respond with: []

IMPORTANT: The new_content must be the COMPLETE file. Not a diff, not a snippet — the entire file.
Respond with valid JSON only.`;

  let patches: Array<Record<string, any>>;
  try {
    const response = await callClaude(
      "You are a precise code modification engine. Output valid JSON only.",
      [{ role: "user", content: prompt }],
      { model: "revision" },
    );

    // Parse response — handle markdown code blocks
    let jsonStr = response.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    patches = JSON.parse(jsonStr);
  } catch (e) {
    console.error("[code-bridge] Failed to get/parse patch proposals:", e);
    return [];
  }

  if (!Array.isArray(patches) || patches.length === 0) {
    console.log("[code-bridge] No patches proposed for this revision.");
    return [];
  }

  // 3. Store proposed patches
  const stored: CodePatch[] = [];
  for (const patch of patches) {
    if (!patch.file_path || !patch.new_content) continue;
    if (!MUTABLE_FILES.includes(patch.file_path)) {
      console.warn(`[code-bridge] Rejected patch for immutable file: ${patch.file_path}`);
      continue;
    }

    const original = fileContents[patch.file_path] ?? "";

    // Don't store no-op patches
    if (original.trim() === patch.new_content.trim()) {
      console.log(`[code-bridge] Skipping no-op patch for ${patch.file_path}`);
      continue;
    }

    const result = await queryOne(
      `INSERT INTO code_patches (belief_id, file_path, original_content, new_content, rationale, status)
       VALUES ($1, $2, $3, $4, $5, 'proposed')
       RETURNING *`,
      [beliefId, patch.file_path, original, patch.new_content, patch.rationale || patch.changes_description || ""],
    );

    if (result) {
      stored.push(result as unknown as CodePatch);
    }
  }

  console.log(`[code-bridge] Proposed ${stored.length} patches for belief revision.`);
  return stored;
}

/**
 * Apply a patch — write the new content, run validation, rollback if it fails.
 */
export async function applyPatch(patchId: string): Promise<{ success: boolean; error?: string }> {
  const patch = await queryOne(
    `SELECT * FROM code_patches WHERE id = $1`,
    [patchId],
  ) as unknown as CodePatch | null;

  if (!patch) return { success: false, error: "Patch not found" };
  if (patch.status !== "proposed" && patch.status !== "approved") {
    return { success: false, error: `Patch status is '${patch.status}', expected 'proposed' or 'approved'` };
  }

  const filePath = join(PROJECT_ROOT, patch.file_path);

  // 1. Read current content (for safety — might differ from original_content if file was modified)
  let currentContent: string;
  try {
    currentContent = await readFile(filePath, "utf-8");
  } catch {
    return { success: false, error: `Cannot read ${patch.file_path}` };
  }

  // 2. Write new content
  try {
    await writeFile(filePath, patch.new_content, "utf-8");
  } catch (e) {
    return { success: false, error: `Failed to write: ${e}` };
  }

  // 3. Validate — try to compile
  const valid = await validateBuild();
  if (!valid.success) {
    // ROLLBACK — restore original
    console.error(`[code-bridge] Build failed after patch, rolling back: ${valid.error}`);
    await writeFile(filePath, currentContent, "utf-8");
    await query(
      `UPDATE code_patches SET status = 'rolled_back' WHERE id = $1`,
      [patchId],
    );
    return { success: false, error: `Build validation failed: ${valid.error}` };
  }

  // 4. Run tests if they exist
  const testResult = await runTests();
  if (!testResult.success) {
    console.error(`[code-bridge] Tests failed after patch, rolling back: ${testResult.error}`);
    await writeFile(filePath, currentContent, "utf-8");
    await query(
      `UPDATE code_patches SET status = 'rolled_back' WHERE id = $1`,
      [patchId],
    );
    return { success: false, error: `Tests failed: ${testResult.error}` };
  }

  // 5. Mark as applied
  await query(
    `UPDATE code_patches SET status = 'applied', applied_at = NOW() WHERE id = $1`,
    [patchId],
  );

  console.log(`[code-bridge] ✓ Patch ${patchId} applied to ${patch.file_path}`);
  return { success: true };
}

/**
 * Rollback a previously applied patch.
 */
export async function rollbackPatch(patchId: string): Promise<{ success: boolean; error?: string }> {
  const patch = await queryOne(
    `SELECT * FROM code_patches WHERE id = $1`,
    [patchId],
  ) as unknown as CodePatch | null;

  if (!patch) return { success: false, error: "Patch not found" };
  if (patch.status !== "applied") {
    return { success: false, error: `Cannot rollback patch with status '${patch.status}'` };
  }

  const filePath = join(PROJECT_ROOT, patch.file_path);

  try {
    await writeFile(filePath, patch.original_content, "utf-8");
  } catch (e) {
    return { success: false, error: `Failed to restore: ${e}` };
  }

  // Validate the rollback
  const valid = await validateBuild();
  if (!valid.success) {
    // This is bad — rollback broke things. Restore the patch.
    await writeFile(filePath, patch.new_content, "utf-8");
    return { success: false, error: `Rollback broke build, re-applied patch: ${valid.error}` };
  }

  await query(
    `UPDATE code_patches SET status = 'rolled_back' WHERE id = $1`,
    [patchId],
  );

  console.log(`[code-bridge] ✓ Patch ${patchId} rolled back for ${patch.file_path}`);
  return { success: true };
}

/**
 * Get patches by status.
 */
export async function getPatchesByStatus(
  status?: string,
  limit = 20,
): Promise<CodePatch[]> {
  if (status) {
    return queryMany(
      `SELECT * FROM code_patches WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
      [status, limit],
    ) as unknown as Promise<CodePatch[]>;
  }
  return queryMany(
    `SELECT * FROM code_patches ORDER BY created_at DESC LIMIT $1`,
    [limit],
  ) as unknown as Promise<CodePatch[]>;
}

/**
 * Validate that the project builds after a change.
 */
async function validateBuild(): Promise<{ success: boolean; error?: string }> {
  try {
    const { stderr } = await execAsync("npx tsc --noEmit", {
      cwd: PROJECT_ROOT,
      timeout: 30000,
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.stderr || e.message || String(e) };
  }
}

/**
 * Run tests if they exist.
 */
async function runTests(): Promise<{ success: boolean; error?: string }> {
  try {
    const { stdout, stderr } = await execAsync("npm test 2>&1 || true", {
      cwd: PROJECT_ROOT,
      timeout: 30000,
    });
    // If there's a test script and it failed
    if (stdout.includes("FAIL") || stdout.includes("Error:")) {
      return { success: false, error: stdout.slice(0, 500) };
    }
    return { success: true };
  } catch (e: any) {
    // No test script is fine
    if (e.message?.includes("no test specified") || e.message?.includes("Missing script")) {
      return { success: true };
    }
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Format a patch for display.
 */
export function formatPatch(patch: CodePatch): string {
  const lines: string[] = [
    `📝 Patch ${patch.id.slice(0, 8)}`,
    `   File: ${patch.file_path}`,
    `   Status: ${patch.status}`,
    `   Rationale: ${patch.rationale.slice(0, 200)}`,
  ];
  if (patch.applied_at) {
    lines.push(`   Applied: ${patch.applied_at}`);
  }
  return lines.join("\n");
}
