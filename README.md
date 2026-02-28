# Anxious Intelligence

**A system architecture for persistent dissonance-driven AI.**

Beliefs accumulate tension from contradictory evidence. When tension crosses a threshold, the system undergoes a phase-transition revision — not an incremental update, but a structural reorganization of understanding. Connections between beliefs are discovered organically under pressure, not pre-defined.

> "Breakthroughs in understanding don't come from new data. They come from the accumulated cost of maintaining a wrong model becoming higher than the cost of revising it."

## Architecture

```
User ──→ Orchestrator ──→ Claude (belief-aware response)
              │
              ├──→ Evidence Extractor (per interaction)
              │         │
              │         ▼
              ├──→ Tension Accumulator (updates belief graph)
              │         │
              │         ▼  [threshold crossed?]
              ├──→ Connection Discovery (LLM finds emergent links)
              │         │
              │         ▼
              └──→ Revision Engine (phase transition via Claude Opus)
                        │
                        ▼
                  Belief Graph (Postgres) ←── grows organically
```

### The Four Layers

1. **Belief Graph** — Persistent self-model. Beliefs have confidence (reinforced by evidence, diminishing returns) and tension (accumulated from contradictions, NO diminishing returns). This asymmetry is the core mechanic.

2. **Tension Accumulator** — Every interaction produces evidence. Reinforcing evidence nudges confidence up slowly. Contradicting evidence adds tension that never decays. The system cannot forget what challenged it.

3. **Revision Engine** — When tension crosses the threshold (0.7), normal processing HALTS. The system loads the full contradiction history, discovers connections via LLM, and reconstructs the belief through Claude Opus. Old belief is superseded, new one takes its place. Cascades propagate through connected beliefs.

4. **Dissatisfaction Signal** — Global ambient anxiety. Weighted average of tension across all beliefs. At low levels, the system responds confidently. At medium levels, it hedges and asks questions. At high levels, it prioritizes resolution over task completion.

### Hybrid Connection Discovery

Connections between beliefs use a hybrid approach:

- **Stored edges** (fast path): Previously discovered connections persisted in Postgres. Used for quick lookups during evidence accumulation.
- **LLM discovery** (slow path): At revision time, Claude analyzes the full belief set and discovers connections that stored edges missed. These emergent connections are written back to the edges table.

The graph grows organically through revision events. Connections that weren't obvious on the surface become apparent under pressure — just like human insight.

## Stack

| Component | Choice |
|-----------|--------|
| Language | Python 3.12 |
| Database | PostgreSQL 16 (Docker) |
| AI Engine | Claude via Azure AI Foundry |
| Fast model | Claude Opus (conversation + evidence extraction) |
| Revision model | Claude Opus (deep reconstruction) |
| CLI | Rich (terminal UI) |
| API | FastAPI (planned) |

## Setup

```bash
# 1. Start Postgres
docker run -d --name anxious-pg --network host \
  -e POSTGRES_USER=anxious \
  -e POSTGRES_PASSWORD=anxious123 \
  -e POSTGRES_DB=anxious_intelligence \
  postgres:16-alpine -p 5433

# 2. Run migrations
docker exec -i anxious-pg psql -U anxious -d anxious_intelligence -p 5433 < migrations/001_initial_schema.sql
docker exec -i anxious-pg psql -U anxious -d anxious_intelligence -p 5433 < migrations/002_add_tension_shares_relation.sql

# 3. Create venv and install deps
python3.12 -m venv .venv
.venv/bin/pip install asyncpg httpx python-dotenv pydantic rich

# 4. Configure
cp .env.example .env
# Edit .env with your Claude API credentials

# 5. Run
.venv/bin/python3 -m src.cli
```

## CLI Commands

```
\beliefs        — Show all active beliefs with tension levels
\graph          — Show belief graph with all connections
\dissatisfaction — Show global dissatisfaction breakdown
\revisions      — Show revision history
\seed           — Re-seed initial beliefs
\help           — Show this help
\quit           — Exit
```

Anything else is sent as a chat message through the full pipeline.

## How It Works

1. You chat with the system. It responds using Claude, with its belief state injected into the system prompt.
2. After each response, the Evidence Extractor analyzes the interaction for claims that reinforce or contradict existing beliefs.
3. The Tension Accumulator updates belief confidence/tension scores. Confidence uses diminishing returns. Tension does not.
4. If any belief's tension crosses 0.7, the Revision Engine fires:
   - Normal processing halts
   - Full contradiction history is loaded
   - LLM discovers connections across the entire belief set
   - Claude Opus reconstructs the belief
   - Discovered connections are persisted
   - Cascades propagate to connected beliefs
5. The Dissatisfaction Signal (global anxiety) modulates future responses.

## Success Criteria

From the [original spec](SPEC_ORIGINAL.docx):

- **Spontaneous self-correction** — Revises past outputs without being asked
- **Nonlinear insight** — Novel connections from accumulated contradictions
- **Resistance then breakthrough** — Defends beliefs, then sudden shift at threshold
- **Appropriate uncertainty** — More uncertainty where tension is high
- **Unprompted depth** — Goes deeper than asked on high-tension topics

## Project Structure

```
src/
├── belief_graph.py        # Belief CRUD, connections, graph traversal
├── claude.py              # Claude API client (Azure AI Foundry)
├── cli.py                 # Rich terminal interface
├── config.py              # Environment + thresholds
├── db.py                  # Async Postgres (asyncpg)
├── dissatisfaction.py     # Global anxiety signal
├── evidence_extractor.py  # Per-interaction claim extraction
├── models.py              # Pydantic models
├── orchestrator.py        # Main interaction loop
├── prompts.py             # All LLM prompt templates
├── revision_engine.py     # Phase transition + hybrid discovery
└── tension_accumulator.py # Tension/confidence update logic
```

## License

MIT

## Author

Juan Cardona — Vikingo AI
