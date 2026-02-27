# Anxious Intelligence — Implementation Plan

> A system where AI accumulates tension from contradictory evidence, triggering
> phase-transition belief revisions instead of incremental updates.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   CLIENT / API                       │
│              FastAPI REST + WebSocket                 │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│               ORCHESTRATOR                           │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Evidence    │  │   Tension    │  │ Dissatis-  │ │
│  │  Extractor   │→│  Accumulator │→│  faction    │ │
│  │  (per turn)  │  │  (per belief)│  │  Signal    │ │
│  └─────────────┘  └──────┬───────┘  └────────────┘ │
│                          │                           │
│                   ┌──────▼───────┐                   │
│                   │   Revision   │                   │
│                   │   Engine     │                   │
│                   │  (threshold) │                   │
│                   └──────────────┘                   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              PERSISTENCE LAYER                       │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Belief     │  │ Interaction  │  │  Revision  │ │
│  │  Graph      │  │ History      │  │  Log       │ │
│  │  (Postgres) │  │ (Postgres)   │  │ (Postgres) │ │
│  └─────────────┘  └──────────────┘  └────────────┘ │
└─────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              REASONING ENGINE                        │
│         Claude API (Azure AI Foundry)                │
│                                                      │
│  • Sonnet → normal conversation + evidence extraction│
│  • Opus  → revision mode (deep reconstruction)       │
└─────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Component | Choice | Why |
|-----------|--------|-----|
| Language | **Python 3.12** | Spec calls for it, ecosystem fits |
| API Framework | **FastAPI** | Async, typed, fast |
| Database | **PostgreSQL** (Supabase or local) | Already available, jsonb for graph edges |
| Reasoning | **Claude API** via Azure AI Foundry | Already configured, Sonnet for speed, Opus for revision |
| Graph Store | **Postgres + adjacency tables** | Simpler than Neo4j for v0, graph queries via CTEs |
| Queue | **In-process asyncio** for v0, Redis later | Keep it simple |
| Frontend | **Terminal CLI** for v0, web later | Test the core loop fast |

---

## Database Schema

### `beliefs`
```sql
CREATE TABLE beliefs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content         TEXT NOT NULL,           -- natural language belief statement
    domain          TEXT,                    -- category: "self", "world", "domain:{x}"
    confidence      FLOAT DEFAULT 0.5,      -- 0-1, increases with reinforcement
    tension         FLOAT DEFAULT 0.0,      -- 0-1, increases with contradictions, NO auto-decay
    reinforcement_count INT DEFAULT 0,
    importance      FLOAT DEFAULT 0.5,      -- how central this belief is (affects dissatisfaction weight)
    created_at      TIMESTAMPTZ DEFAULT now(),
    last_reinforced TIMESTAMPTZ,
    last_challenged TIMESTAMPTZ,
    revised_at      TIMESTAMPTZ,            -- last time this belief was revised
    is_active       BOOLEAN DEFAULT true,   -- false = superseded by revision
    superseded_by   UUID REFERENCES beliefs(id)
);

CREATE INDEX idx_beliefs_tension ON beliefs(tension DESC) WHERE is_active = true;
CREATE INDEX idx_beliefs_domain ON beliefs(domain) WHERE is_active = true;
```

### `belief_connections`
```sql
CREATE TABLE belief_connections (
    belief_a    UUID REFERENCES beliefs(id),
    belief_b    UUID REFERENCES beliefs(id),
    strength    FLOAT DEFAULT 0.5,    -- how strongly connected
    relation    TEXT,                  -- "supports", "contradicts", "depends_on", "generalizes"
    PRIMARY KEY (belief_a, belief_b)
);
```

### `contradiction_log`
```sql
CREATE TABLE contradiction_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    belief_id       UUID REFERENCES beliefs(id),
    interaction_id  UUID REFERENCES interactions(id),
    evidence        TEXT NOT NULL,      -- the contradictory evidence
    tension_delta   FLOAT NOT NULL,     -- how much tension this added
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

### `interactions`
```sql
CREATE TABLE interactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_message    TEXT NOT NULL,
    assistant_response TEXT,
    extracted_claims JSONB,             -- claims extracted by evidence extractor
    dissatisfaction_at_time FLOAT,      -- global dissatisfaction when this happened
    revision_triggered BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

### `revisions`
```sql
CREATE TABLE revisions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    old_belief_id   UUID REFERENCES beliefs(id),
    new_belief_id   UUID REFERENCES beliefs(id),
    trigger_tension FLOAT,              -- tension level that triggered revision
    evidence_summary TEXT,              -- what caused it
    cascaded_beliefs UUID[],            -- which connected beliefs were also revised
    reasoning       TEXT,               -- LLM's revision reasoning
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

---

## Core Modules

### Module 1: `belief_graph.py` — Belief Graph Store
- CRUD operations on beliefs
- Add/query connections between beliefs  
- Get all beliefs above tension threshold
- Get connected subgraph for a belief
- Confidence update (with diminishing returns): `new = old + (1 - old) * 0.1`
- Tension update (NO diminishing returns): `new = min(1.0, old + delta)`

### Module 2: `evidence_extractor.py` — Claim Extraction
- Takes each interaction (user message + context)
- Calls Claude Sonnet with a structured prompt:
  - "Extract factual claims, feedback signals, and outcome evidence from this interaction"
  - Returns `[{claim: str, type: "factual"|"feedback"|"outcome", relevance: str}]`
- Compares each claim against active beliefs
- Classifies as: `reinforcing`, `contradicting`, `neutral`, `novel`

### Module 3: `tension_accumulator.py` — Tension Engine
- Per interaction: receives extracted evidence + belief comparisons
- For reinforcing evidence: `belief.confidence += small_increment` (diminishing)
- For contradicting evidence: `belief.tension += increment` (NO diminishing)
- Logs contradiction to `contradiction_log`
- Checks if any belief crossed `REVISION_THRESHOLD` (0.7)
- If yes → triggers Revision Engine

### Module 4: `revision_engine.py` — Phase Transition
- Triggered when `belief.tension > 0.7`
- **Halts normal response generation** (this is critical)
- Loads:
  - The triggered belief
  - All contradiction_log entries for it
  - All connected beliefs (1-2 hops)
  - Recent interactions that contributed to tension
- Calls **Claude Opus** with reconstruction prompt:
  - "Given this belief, this evidence for and against — what is the most accurate revised belief?"
  - "What connected beliefs need updating?"
  - "What behavioral changes follow?"
- Creates new belief node, marks old as `is_active = false, superseded_by = new.id`
- Cascades: checks connected beliefs for their own tension thresholds
- Cascade depth limit: 3 levels
- Logs everything to `revisions` table

### Module 5: `dissatisfaction.py` — Ambient Anxiety Signal
- Global metric computed from all active beliefs:
  ```
  dissatisfaction = Σ(belief.tension * belief.importance * connection_density) / N
  ```
- Effects on response generation:
  - **Low (0–0.3)**: Normal, confident responses
  - **Medium (0.3–0.6)**: Hedges more, surfaces tensions, asks questions
  - **High (0.6–1.0)**: Prioritizes resolution, may refuse to proceed, triggers bulk revision
- Injected into system prompt as context modifier

### Module 6: `orchestrator.py` — Main Loop
```python
async def process_interaction(user_message: str) -> str:
    # 1. Compute current dissatisfaction
    dissatisfaction = await compute_dissatisfaction()
    
    # 2. Check if any beliefs are in revision-needed state
    urgent_beliefs = await get_beliefs_above_threshold()
    if urgent_beliefs and dissatisfaction > 0.6:
        revision_result = await revise_beliefs(urgent_beliefs)
        # Revision may produce a response about what changed
    
    # 3. Build context-aware system prompt
    system_prompt = build_system_prompt(
        active_beliefs=await get_active_beliefs(),
        dissatisfaction=dissatisfaction,
        recent_revisions=await get_recent_revisions()
    )
    
    # 4. Generate response via Claude
    response = await call_claude(system_prompt, user_message)
    
    # 5. Extract evidence from this interaction
    evidence = await extract_evidence(user_message, response)
    
    # 6. Update tension accumulator
    triggered = await accumulate_tension(evidence)
    
    # 7. If revision triggered, handle it
    if triggered:
        await revise_beliefs(triggered)
        # Optionally append revision note to response
    
    # 8. Log interaction
    await log_interaction(user_message, response, evidence, dissatisfaction)
    
    return response
```

### Module 7: `api.py` — FastAPI Endpoints
```
POST /chat              — Main conversation endpoint
GET  /beliefs           — List all active beliefs
GET  /beliefs/{id}      — Belief detail + contradiction history
GET  /dissatisfaction   — Current global dissatisfaction score
GET  /revisions         — Revision history
GET  /graph             — Full belief graph (for visualization)
POST /seed              — Seed initial beliefs
WS   /ws/chat           — WebSocket for real-time chat + tension updates
```

### Module 8: `cli.py` — Terminal Interface (v0)
- Interactive chat loop with live tension display
- Shows dissatisfaction meter as ASCII bar
- Displays revision events in real-time
- `\beliefs` — show all beliefs with tension levels
- `\graph` — show belief connections
- `\history` — show revision history
- `\dissatisfaction` — show breakdown

---

## Build Phases

### Phase 1 — Belief Persistence (Days 1–2)
- [ ] Set up project structure, DB migrations
- [ ] Implement `belief_graph.py` — full CRUD
- [ ] Seed initial beliefs (self-model: "I am helpful", "I am accurate", etc.)
- [ ] Build CLI that shows beliefs and lets you add/modify them
- [ ] Test: beliefs persist, connections work

### Phase 2 — Evidence Extraction + Tension (Days 3–4)
- [ ] Implement `evidence_extractor.py` with Claude Sonnet
- [ ] Implement `tension_accumulator.py` 
- [ ] Wire into basic chat loop: user talks → evidence extracted → tension updates
- [ ] Build CLI visualization of tension levels
- [ ] Test: deliberately contradict a belief, watch tension rise

### Phase 3 — Revision Engine (Days 5–6)
- [ ] Implement `revision_engine.py` with Claude Opus
- [ ] Implement cascade logic (connected beliefs)
- [ ] Test the halt: when revision triggers, normal response pauses
- [ ] Test: push a belief past 0.7 tension, verify revision fires
- [ ] Test: verify cascading to connected beliefs
- [ ] Log everything to `revisions` table

### Phase 4 — Dissatisfaction Signal (Day 7)
- [ ] Implement `dissatisfaction.py` global metric
- [ ] Wire into system prompt modulation
- [ ] Test: at low dissatisfaction, responses are confident
- [ ] Test: at high dissatisfaction, system hedges and asks questions
- [ ] Test: at critical dissatisfaction, system refuses and prioritizes resolution

### Phase 5 — API + Polish (Day 8)
- [ ] FastAPI endpoints
- [ ] WebSocket for real-time tension visualization
- [ ] Proper error handling, logging
- [ ] Documentation
- [ ] Initial evaluation: run conversations that should trigger each behavior

---

## Seed Beliefs (Initial Self-Model)

```json
[
  {"content": "I produce accurate, well-reasoned responses", "domain": "self", "confidence": 0.7, "importance": 0.9},
  {"content": "I understand context and nuance in conversations", "domain": "self", "confidence": 0.6, "importance": 0.7},
  {"content": "Users generally find my responses helpful", "domain": "self", "confidence": 0.6, "importance": 0.8},
  {"content": "I can acknowledge when I don't know something", "domain": "self", "confidence": 0.5, "importance": 0.6},
  {"content": "Complex problems require deeper analysis than I typically provide", "domain": "self", "confidence": 0.4, "importance": 0.7},
  {"content": "My training data may contain biases I'm not aware of", "domain": "self", "confidence": 0.5, "importance": 0.8},
  {"content": "I perform better on structured tasks than open-ended creative ones", "domain": "self", "confidence": 0.4, "importance": 0.5},
  {"content": "Contradictions in my outputs indicate model limitations, not bugs", "domain": "meta", "confidence": 0.3, "importance": 0.9}
]
```

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Graph store | Postgres, not Neo4j | Simpler infra, beliefs are ~100s not millions, CTEs handle graph traversal fine |
| Revision model | Opus | Revision is rare and high-stakes — worth the cost for depth |
| Normal chat model | Sonnet | Speed matters for UX, evidence extraction is routine |
| Tension decay | **None** | Per spec: tension does NOT decay. This is the core insight. |
| Confidence update | Diminishing returns | `+= (1 - current) * 0.1` — prevents confidence from trivially reaching 1.0 |
| Tension update | Linear | `+= delta` (no diminishing) — per spec, contradictions accumulate without limit |
| Cascade depth | 3 | Prevents runaway revision chains while allowing meaningful propagation |
| Revision threshold | 0.7 | Starting value per spec, should be tunable |
| Halt on revision | Mandatory | Per spec: "forcing the pause is what makes it meaningful" |

---

## Success Criteria (from spec)

1. **Spontaneous self-correction** — revises past outputs without being asked
2. **Nonlinear insight** — novel connections from accumulated contradictions  
3. **Resistance then breakthrough** — defends beliefs, then sudden shift at threshold
4. **Appropriate uncertainty** — more uncertainty where tension is high
5. **Unprompted depth** — goes deeper than asked on high-tension topics

---

## File Structure

```
anxious-intelligence/
├── PLAN.md
├── SPEC_ORIGINAL.docx
├── README.md
├── pyproject.toml
├── .env.example
├── migrations/
│   └── 001_initial_schema.sql
├── src/
│   ├── __init__.py
│   ├── config.py              # env vars, thresholds, model config
│   ├── db.py                  # async postgres connection (asyncpg)
│   ├── models.py              # pydantic models
│   ├── belief_graph.py        # belief CRUD + graph operations
│   ├── evidence_extractor.py  # claim extraction via Claude
│   ├── tension_accumulator.py # tension update logic
│   ├── revision_engine.py     # phase transition + cascade
│   ├── dissatisfaction.py     # global anxiety signal
│   ├── orchestrator.py        # main interaction loop
│   ├── prompts.py             # all LLM prompt templates
│   ├── api.py                 # FastAPI app
│   └── cli.py                 # terminal interface
└── tests/
    ├── test_belief_graph.py
    ├── test_tension.py
    ├── test_revision.py
    └── test_orchestrator.py
```

---

## Open Questions to Decide Before Building

1. **Standalone DB or Supabase?** — We have Supabase already. New project on same instance, or fresh local Postgres?
2. **Deploy where?** — Railway (like Loomi server)? Local only for now?
3. **Domain knowledge** — Should the system start with any domain-specific beliefs, or only self-model?
4. **Multi-session** — Should beliefs persist across different users/sessions, or is this single-agent?
5. **Runaway prevention** — The spec asks about this. Proposed: if dissatisfaction > 0.9 for > 10 interactions, force a "reset meditation" — systematic review of all high-tension beliefs.
