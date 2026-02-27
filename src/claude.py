"""Claude API client via Azure AI Foundry."""

import json
import httpx
from src.config import ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, MODEL_FAST, MODEL_REVISION


async def call_claude(
    system: str,
    user_message: str,
    model: str | None = None,
    max_tokens: int = 4096,
) -> str:
    """Call Claude API and return the text response."""
    model = model or MODEL_FAST

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            f"{ANTHROPIC_BASE_URL}v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user_message}],
            },
        )
        resp.raise_for_status()
        data = resp.json()

    # Extract text from response
    content = data.get("content", [])
    return "".join(block["text"] for block in content if block.get("type") == "text")


async def call_claude_json(
    system: str,
    user_message: str,
    model: str | None = None,
) -> dict | list:
    """Call Claude and parse the response as JSON."""
    text = await call_claude(system, user_message, model=model)

    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

    return json.loads(text)


async def call_revision(system: str, user_message: str) -> dict:
    """Call Claude with the revision model (Opus) for deep reconstruction."""
    return await call_claude_json(system, user_message, model=MODEL_REVISION)
