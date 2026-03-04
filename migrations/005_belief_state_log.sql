-- Migration 005: Belief State Log
-- Records the full belief state at every interaction for impact analysis.
-- Enables tracking how belief revisions affect perceived intelligence over time.

BEGIN;

CREATE TABLE IF NOT EXISTS belief_state_log (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interaction_id        UUID REFERENCES interactions(id) ON DELETE SET NULL,
    beliefs_snapshot      JSONB NOT NULL,       -- All active beliefs with tension/confidence
    dissatisfaction       FLOAT NOT NULL DEFAULT 0,
    total_tension         FLOAT NOT NULL DEFAULT 0,
    avg_confidence        FLOAT NOT NULL DEFAULT 0,
    revision_count_total  INT NOT NULL DEFAULT 0,
    revisions_since_last  INT NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_belief_state_log_created ON belief_state_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_belief_state_log_interaction ON belief_state_log(interaction_id);
CREATE INDEX IF NOT EXISTS idx_belief_state_log_dissatisfaction ON belief_state_log(dissatisfaction);

COMMIT;
