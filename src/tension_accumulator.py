"""Tension Accumulator — updates belief confidence/tension based on evidence."""

from uuid import UUID
from src.models import Evidence, Belief
from src.belief_graph import reinforce_belief, add_tension, log_contradiction, get_beliefs_above_threshold
from src.config import TENSION_INCREMENT, REVISION_THRESHOLD


async def accumulate(
    evidence_list: list[Evidence],
    interaction_id: UUID | None = None,
) -> list[Belief]:
    """Process evidence and update beliefs. Returns beliefs that crossed revision threshold."""
    triggered = []

    for ev in evidence_list:
        if not ev.belief_id or ev.stance == "neutral":
            continue

        if ev.stance == "reinforcing":
            await reinforce_belief(ev.belief_id)

        elif ev.stance == "contradicting":
            # Tension increment scaled by evidence strength — NO diminishing returns
            delta = TENSION_INCREMENT * ev.strength
            updated = await add_tension(ev.belief_id, delta)

            # Log the contradiction
            await log_contradiction(
                belief_id=ev.belief_id,
                interaction_id=interaction_id,
                evidence=ev.claim,
                tension_delta=delta,
            )

            # Check if this pushed the belief over the threshold
            if updated.tension >= REVISION_THRESHOLD:
                triggered.append(updated)

    return triggered
