from pydantic import BaseModel
from datetime import datetime
from uuid import UUID


class Belief(BaseModel):
    id: UUID
    content: str
    domain: str
    confidence: float
    tension: float
    reinforcement_count: int
    importance: float
    is_active: bool
    superseded_by: UUID | None = None
    created_at: datetime
    last_reinforced: datetime | None = None
    last_challenged: datetime | None = None
    revised_at: datetime | None = None


class BeliefConnection(BaseModel):
    belief_a: UUID
    belief_b: UUID
    strength: float
    relation: str  # supports, contradicts, depends_on, generalizes


class Evidence(BaseModel):
    claim: str
    evidence_type: str  # factual, feedback, outcome
    relevance: str  # which belief domain this relates to
    stance: str  # reinforcing, contradicting, neutral, novel
    belief_id: UUID | None = None  # matched belief, if any
    strength: float = 0.5  # how strong this evidence is


class Interaction(BaseModel):
    id: UUID
    session_id: str
    user_message: str
    assistant_response: str | None
    extracted_claims: list[Evidence] | None
    dissatisfaction_at_time: float | None
    revision_triggered: bool
    created_at: datetime


class Revision(BaseModel):
    id: UUID
    old_belief_id: UUID
    new_belief_id: UUID
    trigger_tension: float
    evidence_summary: str
    cascaded_beliefs: list[UUID]
    reasoning: str
    created_at: datetime
