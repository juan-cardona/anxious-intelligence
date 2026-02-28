"""Code-Belief Bridge — maps belief revisions to concrete code patches.

When a belief revision happens, this module analyzes the revision and proposes
code changes that align the system's behavior with its updated self-understanding.

This is the strange loop: the system reads its own architecture,
understands what its beliefs mean for its behavior, and writes patches
to make itself more consistent with what it's learned about itself.
"""

import json
import os
from uuid import UUID
from pathlib import Path
from src.models import Belief
from src.claude import call_claude_json
from src import db

# The project root — where code lives
PROJECT_ROOT = Path(__file__).parent.parent

# Files that are safe to propose patches against
# We start conservative — only prompt templates and config
PATCHABLE_FILES = {
    "src/prompts.py": {
        "risk": "low",
        "description": "LLM prompt templates — affects how the system talks to itself and users",
        "auto_approvable": True,
    },
    "src/config.py": {
        "risk": "low",
        "description": "Configuration values — thresholds, model choices",
        "auto_approvable": True,
    },
    "src/dissatisfaction.py": {
        "risk": "medium",
        "description": "Dissatisfaction calculation — affects the ambient anxiety signal",
        "auto_approvable": False,
    },
    "src/tension_accumulator.py": {
        "risk": "medium",
        "description": "How tension accumulates — affects belief revision triggers",
        "auto_approvable": False,
    },
    "src/evidence_extractor.py": {
        "risk": "medium",
        "description": "How evidence is extracted from interactions — affects what the system notices",
        "auto_approvable": False,
    },
    "src/orchestrator.py": {
        "risk": "high",
        "description": "Main interaction loop — the core behavior pipeline",
        "auto_approvable": False,
    },
    "src/revision_engine.py": {
        "risk": "high",
        "description": "Belief revision logic — the phase transition mechanism",
        "auto_approvable": False,
    },
}


def _read_patchable_files() -> dict[str, str]:
    """Read the contents of all patchable files for context."""
    contents = {}
    for rel_path in PATCHABLE_FILES:
        full_path = PROJECT_ROOT / rel_path
        if full_path.exists():
            contents[rel_path] = full_path.read_text()
    return contents


def _code_patch_proposal_prompt(
    old_belief: str,
    new_belief: str,
    revision_reasoning: str,
    behavioral_changes: list[str],
    file_contents: dict[str, str],
    file_metadata: dict[str, dict],
) -> str:
    """Build the prompt that asks Claude to propose code patches."""
    
    files_section = ""
    for path, content in file_contents.items():
        meta = file_metadata.get(path, {})
        files_section += f"\n### {path}\nRisk: {meta.get('risk', 'unknown')} | {meta.get('description', '')}\n```python\n{content}\n```\n"

    behavioral_section = "\n".join(f"- {b}" for b in behavioral_changes) if behavioral_changes else "No specific behavioral changes suggested."

    return f"""You are analyzing a belief revision in an AI self-model system and proposing code changes that align the system's behavior with its updated self-understanding.

## Belief Revision
OLD: "{old_belief}"
NEW: "{new_belief}"

## Revision Reasoning
{revision_reasoning}

## Suggested Behavioral Changes
{behavioral_section}

## Codebase (files you can propose patches for)
{files_section}

## Your Task
Analyze this belief revision and determine what code changes would make the system behave more consistently with the new belief.

Think about:
1. **Prompt templates** — Should the system prompt change? Should evidence extraction weight things differently?
2. **Thresholds/config** — Should tension accumulation rates change? Confidence increments? Revision thresholds?
3. **Dissatisfaction** — Should the anxiety signal be calculated differently?
4. **Processing** — Should the orchestrator add or remove steps?

Be CONSERVATIVE. Only propose changes that are:
- Directly motivated by this specific belief revision
- Unlikely to break existing functionality
- Small and focused (one concern per patch)

For each proposed patch, provide:
- target_file: which file to change
- patch_type: "replace" (replace a function/section), "insert" (add new code), "append" (add to end), "config_change" (change a config value)
- description: what this change does and why
- original_content: the exact content being replaced (for replace type) — MUST match the file exactly
- new_content: the new content
- risk_level: "low", "medium", "high"

Respond in JSON:
{{
  "analysis": "How this belief revision should affect code behavior...",
  "patches": [
    {{
      "target_file": "src/prompts.py",
      "patch_type": "replace",
      "description": "Why this change...",
      "original_content": "exact text being replaced",
      "new_content": "replacement text",
      "risk_level": "low"
    }}
  ],
  "no_change_reasoning": "If no patches are needed, explain why"
}}

If the belief revision doesn't warrant any code changes, return an empty patches array with reasoning.
Prefer NO changes over bad changes. The system should only modify itself when there's a clear, grounded reason."""


async def propose_patches(
    old_belief: Belief,
    new_belief: Belief,
    revision_reasoning: str,
    behavioral_changes: list[str],
    revision_id: UUID | None = None,
) -> list[dict]:
    """
    Given a belief revision, propose code patches that align behavior with the new belief.
    
    Returns a list of patch proposals (not yet applied).
    """
    # Read current codebase
    file_contents = _read_patchable_files()
    
    if not file_contents:
        return []

    prompt = _code_patch_proposal_prompt(
        old_belief=old_belief.content,
        new_belief=new_belief.content,
        revision_reasoning=revision_reasoning,
        behavioral_changes=behavioral_changes,
        file_contents=file_contents,
        file_metadata=PATCHABLE_FILES,
    )

    try:
        result = await call_claude_json(
            "You are a careful code analyst for an AI self-model system. Propose minimal, safe code changes. Respond only in valid JSON.",
            prompt,
        )
    except Exception as e:
        print(f"[code_bridge] Failed to get patch proposals: {e}")
        return []

    patches = result.get("patches", [])
    stored_patches = []

    for patch in patches:
        target = patch.get("target_file", "")
        if target not in PATCHABLE_FILES:
            continue  # Skip patches to non-patchable files

        meta = PATCHABLE_FILES[target]
        risk = patch.get("risk_level", meta.get("risk", "medium"))
        
        # Read original content for backup
        full_path = PROJECT_ROOT / target
        original_file_content = full_path.read_text() if full_path.exists() else None

        # Store in database
        row = await db.fetchrow(
            """
            INSERT INTO code_patches (
                revision_id, belief_id, trigger_type, trigger_reason,
                target_file, patch_type, description, diff_preview,
                original_content, new_content, status, risk_level,
                requires_restart, auto_approvable
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
            """,
            revision_id,
            new_belief.id,
            "revision",
            f"Belief revised: '{old_belief.content[:100]}' → '{new_belief.content[:100]}'",
            target,
            patch.get("patch_type", "replace"),
            patch.get("description", "No description"),
            _make_diff_preview(patch),
            original_file_content,  # Full file backup for rollback
            patch.get("new_content", ""),
            "proposed",
            risk,
            target in ("src/orchestrator.py", "src/revision_engine.py"),  # These need restart
            meta.get("auto_approvable", False) and risk == "low",
        )

        stored_patches.append(dict(row))

    return stored_patches


def _make_diff_preview(patch: dict) -> str:
    """Create a simple diff preview string."""
    lines = []
    lines.append(f"--- {patch.get('target_file', '?')}")
    lines.append(f"+++ {patch.get('target_file', '?')} (proposed)")
    lines.append(f"@@ {patch.get('patch_type', 'replace')} @@")
    
    if patch.get("original_content"):
        for line in patch["original_content"].split("\n")[:10]:
            lines.append(f"- {line}")
    
    if patch.get("new_content"):
        for line in patch["new_content"].split("\n")[:10]:
            lines.append(f"+ {line}")
    
    return "\n".join(lines)


async def get_pending_patches() -> list[dict]:
    """Get all proposed patches awaiting review/application."""
    rows = await db.fetch(
        """
        SELECT cp.*, b.content as belief_content
        FROM code_patches cp
        LEFT JOIN beliefs b ON cp.belief_id = b.id
        WHERE cp.status = 'proposed'
        ORDER BY cp.created_at DESC
        """
    )
    return [dict(r) for r in rows]


async def get_patch(patch_id: UUID) -> dict | None:
    """Get a specific patch by ID."""
    row = await db.fetchrow("SELECT * FROM code_patches WHERE id = $1", patch_id)
    return dict(row) if row else None


async def update_patch_status(patch_id: UUID, status: str, **kwargs):
    """Update a patch's status and optional fields."""
    sets = ["status = $2"]
    args = [patch_id, status]
    
    if "test_result" in kwargs:
        sets.append(f"test_result = ${len(args) + 1}")
        args.append(kwargs["test_result"])
    if "rollback_reason" in kwargs:
        sets.append(f"rollback_reason = ${len(args) + 1}")
        args.append(kwargs["rollback_reason"])
    if status == "applied":
        sets.append(f"applied_at = now()")
    if status == "rolled_back":
        sets.append(f"rolled_back_at = now()")
    
    query = f"UPDATE code_patches SET {', '.join(sets)} WHERE id = $1"
    await db.execute(query, *args)
