-- Migration 002: Intelligence Metrics & Self-Improvement Tracking
-- Measures the impact of belief revisions on perceived response quality

-- Per-interaction quality scores
CREATE TABLE IF NOT EXISTS intelligence_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interaction_id UUID REFERENCES interactions(id),
    -- Quality dimensions (0-1 scale)
    depth_score FLOAT,
    accuracy_score FLOAT,
    creativity_score FLOAT,
    self_awareness_score FLOAT,
    task_completion_score FLOAT,
    coherence_score FLOAT,
    -- Composite
    composite_score FLOAT,
    -- Context at measurement time
    dissatisfaction_at_time FLOAT,
    belief_tension_sum FLOAT,
    revision_recency INT,
    active_beliefs_snapshot JSONB,
    -- Evaluation metadata
    evaluator_reasoning TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metrics_created ON intelligence_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_composite ON intelligence_metrics(composite_score);
CREATE INDEX IF NOT EXISTS idx_metrics_dissatisfaction ON intelligence_metrics(dissatisfaction_at_time);

-- Periodic belief state snapshots for time-series analysis
CREATE TABLE IF NOT EXISTS belief_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_type TEXT NOT NULL DEFAULT 'periodic',
    trigger_event TEXT,
    beliefs JSONB NOT NULL,
    connections JSONB,
    dissatisfaction FLOAT,
    total_tension FLOAT,
    total_confidence FLOAT,
    beliefs_count INT,
    revision_count INT,
    interaction_count INT,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON belief_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_type ON belief_snapshots(snapshot_type);

-- Self-generated code improvement proposals
CREATE TABLE IF NOT EXISTS improvement_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    target_file TEXT,
    proposed_diff TEXT,
    motivation TEXT,
    metric_impact_prediction JSONB,
    status TEXT DEFAULT 'proposed',
    applied_at TIMESTAMPTZ,
    metrics_before JSONB,
    metrics_after JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON improvement_proposals(status);
