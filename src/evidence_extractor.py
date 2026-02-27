"""Evidence Extractor — analyzes interactions to find reinforcing/contradicting evidence."""

import json
from uuid import UUID
from src.models import Evidence, Belief
from src.claude import call_claude_json
from src.prompts import evidence_extraction_prompt


def format_beliefs_for_prompt(beliefs: list[Belief]) -> str:
    lines = []
    for i, b in enumerate(beliefs):
        lines.append(
            f"[{i}] \"{b.content}\" "
            f"(confidence={b.confidence:.2f}, tension={b.tension:.2f}, domain={b.domain})"
        )
    return "\n".join(lines)


async def extract_evidence(
    user_message: str,
    assistant_response: str,
    active_beliefs: list[Belief],
) -> list[Evidence]:
    """Extract evidence from an interaction and match it against beliefs."""
    if not active_beliefs:
        return []

    beliefs_summary = format_beliefs_for_prompt(active_beliefs)
    prompt = evidence_extraction_prompt(user_message, assistant_response, beliefs_summary)

    try:
        raw = await call_claude_json("You are a precise evidence extraction system. Respond only in valid JSON.", prompt)
    except (json.JSONDecodeError, Exception):
        return []

    if not isinstance(raw, list):
        return []

    evidence_list = []
    for item in raw:
        if not isinstance(item, dict):
            continue

        belief_index = item.get("belief_index")
        belief_id = None
        if isinstance(belief_index, int) and 0 <= belief_index < len(active_beliefs):
            belief_id = active_beliefs[belief_index].id

        stance = item.get("stance", "neutral")
        if stance not in ("reinforcing", "contradicting", "neutral"):
            stance = "neutral"

        evidence_list.append(Evidence(
            claim=item.get("claim", ""),
            evidence_type=item.get("type", "factual"),
            relevance=item.get("relevance", ""),
            stance=stance,
            belief_id=belief_id,
            strength=min(1.0, max(0.0, float(item.get("strength", 0.5)))),
        ))

    return evidence_list
