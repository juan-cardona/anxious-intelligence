"""Dissatisfaction Signal — the ambient anxiety metric."""

from src import db


async def compute_dissatisfaction() -> float:
    """
    Global dissatisfaction = weighted average of tension across all active beliefs.
    
    Weight = importance * connection_density
    
    A system that is always satisfied has no reason to improve.
    A system that carries ambient dissatisfaction will spontaneously
    seek better models and produce genuine uncertainty.
    """
    row = await db.fetchrow(
        """
        WITH belief_density AS (
            SELECT b.id, b.tension, b.importance,
                   COALESCE(COUNT(c.belief_a), 0) + 1 AS connections
            FROM beliefs b
            LEFT JOIN belief_connections c ON (c.belief_a = b.id OR c.belief_b = b.id)
            WHERE b.is_active = true
            GROUP BY b.id
        )
        SELECT 
            CASE WHEN COUNT(*) = 0 THEN 0
                 ELSE SUM(tension * importance * connections) / SUM(importance * connections)
            END AS dissatisfaction
        FROM belief_density
        """
    )
    return float(row["dissatisfaction"]) if row else 0.0


async def get_dissatisfaction_breakdown() -> list[dict]:
    """Get per-belief contribution to dissatisfaction."""
    rows = await db.fetch(
        """
        WITH belief_density AS (
            SELECT b.id, b.content, b.tension, b.confidence, b.importance, b.domain,
                   COALESCE(COUNT(c.belief_a), 0) + 1 AS connections
            FROM beliefs b
            LEFT JOIN belief_connections c ON (c.belief_a = b.id OR c.belief_b = b.id)
            WHERE b.is_active = true
            GROUP BY b.id
        )
        SELECT *, 
               tension * importance * connections AS contribution
        FROM belief_density
        ORDER BY contribution DESC
        """
    )
    return [dict(r) for r in rows]


def describe_state(dissatisfaction: float) -> str:
    """Human-readable description of the dissatisfaction level."""
    if dissatisfaction < 0.1:
        return "Calm — beliefs are stable and well-supported"
    elif dissatisfaction < 0.3:
        return "Settled — minor tensions, nothing urgent"
    elif dissatisfaction < 0.5:
        return "Uneasy — accumulating contradictions, seeking clarity"
    elif dissatisfaction < 0.7:
        return "Anxious — significant unresolved tensions affecting processing"
    elif dissatisfaction < 0.9:
        return "Critical — belief system under pressure, revisions needed"
    else:
        return "Crisis — fundamental beliefs being challenged, processing impaired"
