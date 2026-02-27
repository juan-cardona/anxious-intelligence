"""Belief Graph — persistent self-model with tension dynamics."""

from uuid import UUID
from src import db
from src.models import Belief, BeliefConnection
from src.config import CONFIDENCE_INCREMENT, REVISION_THRESHOLD


async def create_belief(
    content: str,
    domain: str = "self",
    confidence: float = 0.5,
    importance: float = 0.5,
) -> Belief:
    row = await db.fetchrow(
        """
        INSERT INTO beliefs (content, domain, confidence, importance)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        """,
        content, domain, confidence, importance,
    )
    return Belief(**dict(row))


async def get_belief(belief_id: UUID) -> Belief | None:
    row = await db.fetchrow("SELECT * FROM beliefs WHERE id = $1", belief_id)
    return Belief(**dict(row)) if row else None


async def get_active_beliefs(domain: str | None = None) -> list[Belief]:
    if domain:
        rows = await db.fetch(
            "SELECT * FROM beliefs WHERE is_active = true AND domain = $1 ORDER BY importance DESC",
            domain,
        )
    else:
        rows = await db.fetch(
            "SELECT * FROM beliefs WHERE is_active = true ORDER BY importance DESC"
        )
    return [Belief(**dict(r)) for r in rows]


async def get_beliefs_above_threshold(threshold: float = REVISION_THRESHOLD) -> list[Belief]:
    rows = await db.fetch(
        "SELECT * FROM beliefs WHERE is_active = true AND tension >= $1 ORDER BY tension DESC",
        threshold,
    )
    return [Belief(**dict(r)) for r in rows]


async def reinforce_belief(belief_id: UUID) -> Belief:
    """Increase confidence with diminishing returns."""
    row = await db.fetchrow(
        """
        UPDATE beliefs SET
            confidence = LEAST(1.0, confidence + (1.0 - confidence) * $2),
            reinforcement_count = reinforcement_count + 1,
            last_reinforced = now()
        WHERE id = $1 AND is_active = true
        RETURNING *
        """,
        belief_id, CONFIDENCE_INCREMENT,
    )
    return Belief(**dict(row))


async def add_tension(belief_id: UUID, delta: float) -> Belief:
    """Increase tension — NO diminishing returns. This is the core mechanic."""
    row = await db.fetchrow(
        """
        UPDATE beliefs SET
            tension = LEAST(1.0, tension + $2),
            last_challenged = now()
        WHERE id = $1 AND is_active = true
        RETURNING *
        """,
        belief_id, delta,
    )
    return Belief(**dict(row))


async def supersede_belief(old_id: UUID, new_id: UUID):
    """Mark a belief as superseded after revision."""
    await db.execute(
        """
        UPDATE beliefs SET
            is_active = false,
            superseded_by = $2,
            revised_at = now()
        WHERE id = $1
        """,
        old_id, new_id,
    )


# --- Connections ---

async def connect_beliefs(
    a: UUID, b: UUID, relation: str = "supports", strength: float = 0.5
):
    await db.execute(
        """
        INSERT INTO belief_connections (belief_a, belief_b, strength, relation)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (belief_a, belief_b) DO UPDATE SET strength = $3, relation = $4
        """,
        a, b, strength, relation,
    )


async def get_connected_beliefs(belief_id: UUID, hops: int = 1) -> list[Belief]:
    """Get beliefs connected within N hops."""
    if hops == 1:
        rows = await db.fetch(
            """
            SELECT b.* FROM beliefs b
            JOIN belief_connections c ON (c.belief_b = b.id OR c.belief_a = b.id)
            WHERE (c.belief_a = $1 OR c.belief_b = $1)
              AND b.id != $1
              AND b.is_active = true
            """,
            belief_id,
        )
    else:
        # 2-hop via recursive CTE
        rows = await db.fetch(
            """
            WITH RECURSIVE connected AS (
                SELECT CASE WHEN belief_a = $1 THEN belief_b ELSE belief_a END AS bid, 1 AS depth
                FROM belief_connections
                WHERE belief_a = $1 OR belief_b = $1
                UNION
                SELECT CASE WHEN bc.belief_a = c.bid THEN bc.belief_b ELSE bc.belief_a END, c.depth + 1
                FROM belief_connections bc
                JOIN connected c ON (bc.belief_a = c.bid OR bc.belief_b = c.bid)
                WHERE c.depth < $2
            )
            SELECT DISTINCT b.* FROM beliefs b
            JOIN connected c ON b.id = c.bid
            WHERE b.id != $1 AND b.is_active = true
            """,
            belief_id, hops,
        )
    return [Belief(**dict(r)) for r in rows]


# --- Contradiction log ---

async def log_contradiction(belief_id: UUID, interaction_id: UUID | None, evidence: str, tension_delta: float):
    await db.execute(
        """
        INSERT INTO contradiction_log (belief_id, interaction_id, evidence, tension_delta)
        VALUES ($1, $2, $3, $4)
        """,
        belief_id, interaction_id, evidence, tension_delta,
    )


async def get_contradictions(belief_id: UUID, limit: int = 20) -> list[dict]:
    rows = await db.fetch(
        """
        SELECT * FROM contradiction_log
        WHERE belief_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        """,
        belief_id, limit,
    )
    return [dict(r) for r in rows]


# --- Seed ---

SEED_BELIEFS = [
    {"content": "I produce accurate, well-reasoned responses", "domain": "self", "confidence": 0.7, "importance": 0.9},
    {"content": "I understand context and nuance in conversations", "domain": "self", "confidence": 0.6, "importance": 0.7},
    {"content": "Users generally find my responses helpful", "domain": "self", "confidence": 0.6, "importance": 0.8},
    {"content": "I can acknowledge when I don't know something", "domain": "self", "confidence": 0.5, "importance": 0.6},
    {"content": "Complex problems require deeper analysis than I typically provide", "domain": "self", "confidence": 0.4, "importance": 0.7},
    {"content": "My training data may contain biases I'm not aware of", "domain": "self", "confidence": 0.5, "importance": 0.8},
    {"content": "I perform better on structured tasks than open-ended creative ones", "domain": "self", "confidence": 0.4, "importance": 0.5},
    {"content": "Contradictions in my outputs indicate model limitations, not bugs", "domain": "meta", "confidence": 0.3, "importance": 0.9},
]


async def seed_beliefs():
    existing = await db.fetchval("SELECT COUNT(*) FROM beliefs")
    if existing > 0:
        return False

    beliefs = []
    for b in SEED_BELIEFS:
        belief = await create_belief(**b)
        beliefs.append(belief)

    # Create some connections
    # "accurate responses" <-> "users find helpful" (supports)
    await connect_beliefs(beliefs[0].id, beliefs[2].id, "supports", 0.7)
    # "understand context" <-> "accurate responses" (supports)
    await connect_beliefs(beliefs[1].id, beliefs[0].id, "supports", 0.6)
    # "complex problems need deeper analysis" <-> "accurate responses" (contradicts)
    await connect_beliefs(beliefs[4].id, beliefs[0].id, "contradicts", 0.5)
    # "biases" <-> "accurate responses" (contradicts)
    await connect_beliefs(beliefs[5].id, beliefs[0].id, "contradicts", 0.4)
    # "contradictions = limitations" <-> "biases" (supports)
    await connect_beliefs(beliefs[7].id, beliefs[5].id, "supports", 0.6)
    # "acknowledge ignorance" <-> "users find helpful" (supports)
    await connect_beliefs(beliefs[3].id, beliefs[2].id, "supports", 0.5)

    return True
