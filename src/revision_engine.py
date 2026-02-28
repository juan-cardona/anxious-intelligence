"""Revision Engine — phase transition when tension crosses threshold.

Hybrid connection discovery: stored edges for fast lookups +
LLM-driven discovery at revision time for emergent connections.
Discovered connections are written back to the edges table,
so the graph grows organically through revision events.
"""

import json
from uuid import UUID
from src.models import Belief
from src.belief_graph import (
    get_belief, get_active_beliefs, get_contradictions,
    get_connected_beliefs, create_belief, supersede_belief,
    add_tension, connect_beliefs,
)
from src.claude import call_claude_json, call_revision
from src.prompts import connection_discovery_prompt, revision_prompt
from src.config import CASCADE_DEPTH_LIMIT, REVISION_THRESHOLD
from src import db


async def discover_connections(triggered: Belief, all_beliefs: list[Belief]) -> list[dict]:
    """
    LLM-driven connection discovery. Feed the triggered belief + full belief set
    to Claude and let it find connections that stored edges might have missed.
    
    This is the key hybrid mechanism: connections emerge under pressure,
    not just from pre-defined storage.
    """
    # Exclude the triggered belief itself
    other_beliefs = [
        {"content": b.content, "confidence": b.confidence, "tension": b.tension, "domain": b.domain, "id": str(b.id)}
        for b in all_beliefs if b.id != triggered.id
    ]

    if not other_beliefs:
        return []

    prompt = connection_discovery_prompt(triggered.content, other_beliefs)

    try:
        raw = await call_claude_json(
            "You are a belief connection analysis system. Respond only in valid JSON array.",
            prompt,
        )
    except Exception:
        return []

    if not isinstance(raw, list):
        return []

    discovered = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        idx = item.get("belief_index")
        if not isinstance(idx, int) or idx < 0 or idx >= len(other_beliefs):
            continue

        relation = item.get("relation", "supports")
        valid_relations = ("supports", "contradicts", "depends_on", "generalizes", "tension_shares")
        if relation not in valid_relations:
            relation = "supports"

        discovered.append({
            "belief_id": other_beliefs[idx]["id"],
            "belief_content": other_beliefs[idx]["content"],
            "relation": relation,
            "strength": min(1.0, max(0.0, float(item.get("strength", 0.5)))),
            "reasoning": item.get("reasoning", ""),
        })

    return discovered


async def revise_belief(belief: Belief, depth: int = 0) -> dict:
    """
    Perform a belief revision — the phase transition.
    
    1. Load contradiction history
    2. Get stored connections (fast path)
    3. Discover NEW connections via LLM (slow path — the emergent part)
    4. Write discovered connections back to edges table
    5. Call Claude Opus for deep reconstruction
    6. Create new belief, supersede old
    7. Cascade to connected beliefs
    
    This HALTS normal processing. The system cannot proceed until
    revision completes. This is not optional.
    """
    if depth >= CASCADE_DEPTH_LIMIT:
        return {"status": "cascade_limit", "belief_id": str(belief.id)}

    # 1. Load full contradiction history
    contradictions = await get_contradictions(belief.id, limit=50)
    contradiction_texts = [c["evidence"] for c in contradictions]

    # 2. Get STORED connections (fast path — previously discovered edges)
    stored_connected = await get_connected_beliefs(belief.id, hops=1)
    stored_texts = [
        f"[stored] {b.content} (conf={b.confidence:.2f}, tension={b.tension:.2f}, relation=stored)"
        for b in stored_connected
    ]

    # 3. DISCOVER new connections via LLM (the emergent part)
    all_beliefs = await get_active_beliefs()
    discovered = await discover_connections(belief, all_beliefs)

    # 4. Write discovered connections back to edges table
    #    The graph grows organically through revision events
    discovered_texts = []
    newly_connected_beliefs = []
    for disc in discovered:
        disc_id = UUID(disc["belief_id"])

        # Write edge (upsert — might upgrade an existing weak connection)
        await connect_beliefs(
            belief.id, disc_id, disc["relation"], disc["strength"],
            method="llm_revision", reasoning=disc["reasoning"][:500],
        )

        discovered_texts.append(
            f"[discovered] {disc['belief_content']} "
            f"(relation={disc['relation']}, strength={disc['strength']:.2f}) "
            f"— {disc['reasoning']}"
        )

        # Track for cascading
        disc_belief = await get_belief(disc_id)
        if disc_belief and disc_belief.is_active:
            newly_connected_beliefs.append(disc_belief)

    # 5. Call Claude Opus for deep reconstruction
    prompt = revision_prompt(
        belief=belief.content,
        confidence=belief.confidence,
        tension=belief.tension,
        contradictions=contradiction_texts,
        stored_connections=stored_texts,
        discovered_connections=discovered_texts,
    )

    try:
        result = await call_revision(
            "You are performing a deep belief revision. Respond in valid JSON only.",
            prompt,
        )
    except Exception as e:
        return {"status": "error", "error": str(e), "belief_id": str(belief.id)}

    # 6. Create the new belief, supersede the old
    new_belief = await create_belief(
        content=result.get("revised_belief", belief.content),
        domain=belief.domain,
        confidence=min(1.0, max(0.0, float(result.get("confidence", 0.5)))),
        importance=belief.importance,
    )
    await supersede_belief(belief.id, new_belief.id)

    # Transfer connections to new belief (both stored and discovered)
    all_connected = {b.id: b for b in stored_connected}
    for b in newly_connected_beliefs:
        all_connected[b.id] = b

    for conn_belief in all_connected.values():
        await connect_beliefs(new_belief.id, conn_belief.id, "supports", 0.5)

    # Write any NEW connections the revision itself suggested
    for new_conn in result.get("new_connections", []):
        # Find the belief by content match
        for b in all_beliefs:
            if b.content in new_conn.get("to_belief", "") or new_conn.get("to_belief", "") in b.content:
                rel = new_conn.get("relation", "supports")
                if rel in ("supports", "contradicts", "depends_on", "generalizes", "tension_shares"):
                    await connect_beliefs(new_belief.id, b.id, rel, 0.5)
                break

    # 7. Log the revision
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

    # 8. Cascade: apply tension deltas from revision to connected beliefs
    cascade_results = []
    for cascade_item in result.get("cascade_updates", []):
        tension_delta = max(0.0, float(cascade_item.get("new_tension_delta", 0.1)))
        if tension_delta <= 0:
            continue
        # Find the matching belief
        for conn_belief in all_connected.values():
            if conn_belief.content in cascade_item.get("belief", ""):
                updated = await add_tension(conn_belief.id, tension_delta)
                if updated and updated.tension >= REVISION_THRESHOLD:
                    cascade_result = await revise_belief(updated, depth=depth + 1)
                    cascade_results.append(cascade_result)
                    cascaded_ids.append(conn_belief.id)
                break

    # Also cascade any connected beliefs already above threshold
    for conn_belief in all_connected.values():
        if conn_belief.id not in cascaded_ids and conn_belief.tension >= REVISION_THRESHOLD * 0.8:
            current = await get_belief(conn_belief.id)
            if current and current.is_active and current.tension >= REVISION_THRESHOLD:
                cascade_result = await revise_belief(current, depth=depth + 1)
                cascade_results.append(cascade_result)
                cascaded_ids.append(conn_belief.id)

    return {
        "status": "revised",
        "old_belief": belief.content,
        "new_belief": result.get("revised_belief"),
        "analysis": result.get("analysis"),
        "reasoning": result.get("reasoning"),
        "behavioral_changes": result.get("behavioral_changes", []),
        "stored_connections": len(stored_connected),
        "discovered_connections": len(discovered),
        "discovered_details": [
            {"content": d["belief_content"][:60], "relation": d["relation"], "reasoning": d["reasoning"][:100]}
            for d in discovered
        ],
        "cascades": cascade_results,
    }


async def revise_all_triggered(beliefs: list[Belief]) -> list[dict]:
    """Revise all beliefs that have crossed the threshold."""
    results = []
    for belief in beliefs:
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
