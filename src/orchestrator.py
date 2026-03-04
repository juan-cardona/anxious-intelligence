"""Orchestrator — the main interaction loop."""

from uuid import UUID
from src.models import Belief, Evidence
from src.belief_graph import get_active_beliefs, get_beliefs_above_threshold
from src.evidence_extractor import extract_evidence, format_beliefs_for_prompt
from src.tension_accumulator import accumulate
from src.revision_engine import revise_all_triggered, get_recent_revisions
from src.dissatisfaction import compute_dissatisfaction, describe_state
from src.claude import call_claude
from src.prompts import system_prompt_with_beliefs
from src.config import REVISION_THRESHOLD
from src import db


# Beliefs at max tension for this many consecutive interactions trigger
# forced revision regardless of global dissatisfaction level.
STUCK_BELIEF_MAX_TENSION = 0.95
STUCK_BELIEF_DISSATISFACTION_FLOOR = 0.25  # minimal dissatisfaction required


async def process_interaction(
    user_message: str,
    session_id: str = "default",
    on_revision: callable = None,  # callback for revision events
) -> dict:
    """
    Main interaction loop:
    1. Compute dissatisfaction
    2. Check for urgent revisions (with stuck-belief recovery)
    3. Generate response with belief-aware system prompt
    4. Extract evidence
    5. Update tensions
    6. Handle any triggered revisions
    """

    # 1. Current state
    dissatisfaction = await compute_dissatisfaction()
    active_beliefs = await get_active_beliefs()

    # 2. Pre-check: any beliefs already past threshold?
    urgent = await get_beliefs_above_threshold()
    pre_revisions = []

    if urgent:
        if dissatisfaction > 0.6:
            # Original path: high global dissatisfaction triggers revision
            pre_revisions = await revise_all_triggered(urgent)
        elif dissatisfaction > STUCK_BELIEF_DISSATISFACTION_FLOOR:
            # STUCK BELIEF RECOVERY: beliefs at near-max tension that can't
            # trigger via the normal post-accumulation path (because they're
            # already past the threshold and new evidence can't "cross" it
            # again). These beliefs have accumulated overwhelming evidence
            # but are trapped by the dissatisfaction gate.
            #
            # The architectural insight: the dissatisfaction > 0.6 gate
            # exists to prevent premature revision. But beliefs at tension
            # >= 0.95 have, by definition, accumulated far more than enough
            # evidence. The gate is protecting nothing — it's creating a
            # dead zone.
            stuck = [b for b in urgent if b.tension >= STUCK_BELIEF_MAX_TENSION]
            if stuck:
                pre_revisions = await revise_all_triggered(stuck)

        if pre_revisions and on_revision:
            for rev in pre_revisions:
                await on_revision(rev) if callable(on_revision) else None
        if pre_revisions:
            # Refresh beliefs after revision
            active_beliefs = await get_active_beliefs()
            dissatisfaction = await compute_dissatisfaction()

    # 3. Build system prompt
    beliefs_summary = format_beliefs_for_prompt(active_beliefs)
    recent_revs = await get_recent_revisions(limit=3)
    revision_text = ""
    if recent_revs:
        revision_text = "\n".join(
            f"- \"{r['old_content']}\" → \"{r['new_content']}\""
            for r in recent_revs
        )

    system = system_prompt_with_beliefs(beliefs_summary, dissatisfaction, revision_text)

    # 4. Generate response
    response = await call_claude(system, user_message)

    # 5. Extract evidence
    evidence = await extract_evidence(user_message, response, active_beliefs)

    # 6. Log interaction
    interaction_id = await db.fetchval(
        """
        INSERT INTO interactions (session_id, user_message, assistant_response, extracted_claims, dissatisfaction_at_time)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        """,
        session_id,
        user_message,
        response,
        __import__('json').dumps([e.model_dump(mode="json") for e in evidence]),
        dissatisfaction,
    )

    # 7. Accumulate tension
    triggered = await accumulate(evidence, interaction_id)

    # 8. Handle triggered revisions
    post_revisions = []
    if triggered:
        post_revisions = await revise_all_triggered(triggered)
        if on_revision:
            for rev in post_revisions:
                await on_revision(rev) if callable(on_revision) else None

        # Mark interaction as revision-triggering
        await db.execute(
            "UPDATE interactions SET revision_triggered = true WHERE id = $1",
            interaction_id,
        )

    # Final dissatisfaction after all updates
    final_dissatisfaction = await compute_dissatisfaction()

    return {
        "response": response,
        "session_id": session_id,
        "dissatisfaction": final_dissatisfaction,
        "dissatisfaction_state": describe_state(final_dissatisfaction),
        "evidence_extracted": len(evidence),
        "pre_revisions": pre_revisions,
        "post_revisions": post_revisions,
        "beliefs_count": len(active_beliefs),
    }
