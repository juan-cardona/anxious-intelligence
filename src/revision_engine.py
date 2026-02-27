"""Revision Engine — phase transition when tension crosses threshold."""

import json
from uuid import UUID
from src.models import Belief
from src.belief_graph import (
    get_belief, get_contradictions, get_connected_beliefs,
    create_belief, supersede_belief, add_tension, connect_beliefs,
)
from src.claude import call_revision
from src.prompts import revision_prompt
from src.config import CASCADE_DEPTH_LIMIT, REVISION_THRESHOLD
from src import db


async def revise_belief(belief: Belief, depth: int = 0) -> dict:
    """
    Perform a belief revision — the phase transition.
    
    This HALTS normal processing. The system cannot proceed until
    revision completes. This is not optional.
    """
    if depth >= CASCADE_DEPTH_LIMIT:
        return {"status": "cascade_limit", "belief_id": str(belief.id)}

    # Load full contradiction history
    contradictions = await get_contradictions(belief.id, limit=50)
    contradiction_texts = [c["evidence"] for c in contradictions]

    # Load connected beliefs
    connected = await get_connected_beliefs(belief.id, hops=2)
    connected_texts = [f"{b.content} (confidence={b.confidence:.2f}, tension={b.tension:.2f})" for b in connected]

    # Call Claude Opus for deep reconstruction
    prompt = revision_prompt(
        belief=belief.content,
        confidence=belief.confidence,
        tension=belief.tension,
        contradictions=contradiction_texts,
        connected_beliefs=connected_texts,
    )

    try:
        result = await call_revision(
            "You are performing a deep belief revision. Respond in valid JSON only.",
            prompt,
        )
    except Exception as e:
        return {"status": "error", "error": str(e), "belief_id": str(belief.id)}

    # Create the new belief
    new_belief = await create_belief(
        content=result.get("revised_belief", belief.content),
        domain=belief.domain,
        confidence=min(1.0, max(0.0, float(result.get("confidence", 0.5)))),
        importance=belief.importance,
    )

    # Supersede the old belief
    await supersede_belief(belief.id, new_belief.id)

    # Re-establish connections from old belief to new belief
    for conn_belief in connected:
        await connect_beliefs(new_belief.id, conn_belief.id, "supports", 0.5)

    # Log the revision
    cascaded_ids = []
    await db.execute(
        """
        INSERT INTO revisions (old_belief_id, new_belief_id, trigger_tension, evidence_summary, cascaded_beliefs, reasoning)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        belief.id,
        new_belief.id,
        belief.tension,
        "\n".join(contradiction_texts[:10]),
        cascaded_ids,
        result.get("reasoning", ""),
    )

    # Cascade: check connected beliefs for their own tension
    cascade_results = []
    for conn_belief in connected:
        if conn_belief.tension >= REVISION_THRESHOLD * 0.8:  # Lower threshold for cascade
            cascade_result = await revise_belief(conn_belief, depth=depth + 1)
            cascade_results.append(cascade_result)
            cascaded_ids.append(conn_belief.id)

    return {
        "status": "revised",
        "old_belief": belief.content,
        "new_belief": result.get("revised_belief"),
        "analysis": result.get("analysis"),
        "reasoning": result.get("reasoning"),
        "behavioral_changes": result.get("behavioral_changes", []),
        "cascades": cascade_results,
    }


async def revise_all_triggered(beliefs: list[Belief]) -> list[dict]:
    """Revise all beliefs that have crossed the threshold."""
    results = []
    for belief in beliefs:
        # Re-check in case a cascade already revised it
        current = await get_belief(belief.id)
        if current and current.is_active and current.tension >= REVISION_THRESHOLD:
            result = await revise_belief(current)
            results.append(result)
    return results


async def get_recent_revisions(limit: int = 5) -> list[dict]:
    rows = await db.fetch(
        """
        SELECT r.*, 
               old.content as old_content, 
               new.content as new_content
        FROM revisions r
        JOIN beliefs old ON r.old_belief_id = old.id
        JOIN beliefs new ON r.new_belief_id = new.id
        ORDER BY r.created_at DESC
        LIMIT $1
        """,
        limit,
    )
    return [dict(r) for r in rows]
