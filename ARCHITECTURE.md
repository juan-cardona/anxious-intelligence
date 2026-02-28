# Anxious Intelligence — Architecture

> Inspired by OpenClaw's design patterns. Standalone project, not a fork.

## What We Take From OpenClaw

| Pattern | OpenClaw | Anxious Intelligence |
|---------|----------|---------------------|
| Language | TypeScript/Node | **TypeScript/Node** (migrate from Python) |
| CLI | `openclaw <command>` | `anx <command>` |
| Daemon | Gateway (background service) | **Daemon** (belief processing, tension monitoring) |
| Workspace | `~/.openclaw/workspace/` | `~/.anx/` (beliefs, revisions, config) |
| Channels | Telegram, WhatsApp, Discord | **Same** (via channel adapters) |
| AI Engine | Pass-through to Claude/GPT | **Belief-modulated** Claude calls |
| Memory | MEMORY.md files | **Belief Graph** (Postgres) + contradiction logs |
| Skills | Skill plugins | **Not needed** (beliefs ARE the skill) |
| Config | YAML/JSON | `~/.anx/config.json` |

## Project Structure

```
anxious-intelligence/
├── package.json
├── tsconfig.json
├── README.md
├── PLAN.md
├── ARCHITECTURE.md
│
├── src/
│   ├── index.ts                 # Entry point
│   ├── cli/
│   │   ├── index.ts             # CLI router (commander)
│   │   ├── chat.ts              # `anx chat` — interactive REPL
│   │   ├── beliefs.ts           # `anx beliefs` — list/inspect beliefs
│   │   ├── status.ts            # `anx status` — dissatisfaction + state
│   │   ├── revisions.ts         # `anx revisions` — revision history
│   │   ├── seed.ts              # `anx seed` — seed initial beliefs
│   │   └── daemon.ts            # `anx daemon start/stop`
│   │
│   ├── core/
│   │   ├── belief-graph.ts      # Belief CRUD + graph operations
│   │   ├── tension.ts           # Tension accumulator (asymmetric updates)
│   │   ├── evidence.ts          # Evidence extractor (Claude call)
│   │   ├── revision.ts          # Revision engine (phase transition)
│   │   ├── dissatisfaction.ts   # Global anxiety signal
│   │   └── orchestrator.ts      # Main interaction loop
│   │
│   ├── ai/
│   │   ├── claude.ts            # Claude API client
│   │   └── prompts.ts           # All prompt templates
│   │
│   ├── db/
│   │   ├── client.ts            # Postgres connection (pg)
│   │   ├── migrations.ts        # Auto-migrate on first run
│   │   └── schema.sql           # Full schema
│   │
│   ├── channels/
│   │   ├── adapter.ts           # Channel interface
│   │   ├── telegram.ts          # Telegram bot integration
│   │   └── terminal.ts          # Terminal/REPL (default)
│   │
│   ├── api/
│   │   ├── server.ts            # HTTP API (Hono)
│   │   └── routes.ts            # REST endpoints
│   │
│   └── ui/
│       ├── terminal.ts          # Rich terminal rendering (chalk + ora)
│       ├── bars.ts              # Tension/confidence bars
│       └── panels.ts            # Belief panels, revision alerts
│
├── migrations/
│   └── 001_initial.sql
│
└── web/                          # Optional: web dashboard (later)
    ├── package.json
    └── src/
```

## CLI Commands

```bash
# Core
anx chat                    # Interactive chat with belief-aware AI
anx chat --session <name>   # Named session (beliefs shared across sessions)

# Beliefs
anx beliefs                 # List all active beliefs with tension bars
anx beliefs inspect <id>    # Show belief detail + contradiction history
anx beliefs graph           # Show belief connections (ASCII graph)

# State
anx status                  # Current dissatisfaction + belief summary
anx status --watch          # Live dashboard (auto-refresh)

# Revisions
anx revisions               # List revision history
anx revisions <id>          # Show revision detail

# Management
anx seed                    # Seed initial beliefs (first run)
anx seed --reset            # Wipe and re-seed
anx daemon start            # Start background daemon
anx daemon stop             # Stop daemon

# Config
anx config                  # Show current config
anx config set <key> <val>  # Set config value
```

## Terminal UX (what `anx chat` looks like)

```
┌─────────────────────────────────────────────────┐
│  ANXIOUS INTELLIGENCE v0.1                      │
│  Dissatisfaction: ████████░░░░░░░░░░░░ 0.42     │
│  State: Uneasy — accumulating contradictions    │
│  Beliefs: 8 active | 2 revised | 14 tensions    │
└─────────────────────────────────────────────────┘

you> Your analysis of that problem was shallow and missed key points.

  ┌─ anxious_ ─────────────────────────────────────┐
  │ You're right, and I want to acknowledge         │
  │ something: I hold a belief that I produce       │
  │ accurate, well-reasoned responses (confidence   │
  │ 0.70, but tension is now at 0.45). Your        │
  │ feedback is adding real pressure to that...     │
  └─────────────────────────────────────────────────┘

  📊 dissatisfaction: 0.42 → 0.48 | evidence: 3 extracted
  ⚡ tensions: "accurate responses" +0.15, "understand context" +0.07

  ┌─ ⚡ REVISION TRIGGERED ─────────────────────────┐
  │ Belief: "I produce accurate, well-reasoned      │
  │ responses" has crossed the revision threshold.   │
  │                                                  │
  │ OLD: "I produce accurate, well-reasoned          │
  │       responses"                                 │
  │ NEW: "I produce responses that are generally     │
  │       competent but frequently lack depth on     │
  │       complex or nuanced problems"               │
  │                                                  │
  │ Cascaded: 2 connected beliefs updated            │
  └──────────────────────────────────────────────────┘

you>
```

## What `anx status` looks like

```
ANXIOUS INTELLIGENCE — System Status
═══════════════════════════════════════

Dissatisfaction: ████████████░░░░░░░░ 0.58
State: Anxious — significant unresolved tensions

Active Beliefs: 8
Revised: 3 (lifetime)
Contradictions logged: 47

Top tensions:
  🔴 0.68 "I produce accurate responses"         ██████████████░░ 
  🟡 0.45 "I can acknowledge when I don't know"  █████████░░░░░░░
  🟡 0.31 "Users find my responses helpful"       ██████░░░░░░░░░░
  🟢 0.12 "I understand context and nuance"       ██░░░░░░░░░░░░░░

Recent revisions:
  2h ago — "I perform better on structured tasks" → revised
  1d ago — "My training data may contain biases" → revised
```

## Migration Plan (Python → TypeScript)

The Python prototype is working. Migrate module by module:

1. **db/** — pg (node-postgres) replaces asyncpg
2. **core/belief-graph.ts** — direct port of belief_graph.py
3. **core/tension.ts** — direct port of tension_accumulator.py
4. **core/evidence.ts** — direct port of evidence_extractor.py
5. **core/revision.ts** — direct port of revision_engine.py
6. **core/dissatisfaction.ts** — direct port of dissatisfaction.py
7. **ai/claude.ts** — httpx → fetch/undici
8. **core/orchestrator.ts** — direct port
9. **cli/** — new (commander + chalk + ora)
10. **channels/** — new (Telegram via grammy)

Python stays as reference/tests. TypeScript becomes the real product.
