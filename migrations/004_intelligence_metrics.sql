-- Migration 004: Intelligence Metrics, Belief Snapshots, Improvement Proposals
-- Created for the Anxious Intelligence self-evaluation system
--
-- NOTE: Originally requested as 002_intelligence_metrics.sql, but numbered 004 
-- to follow existing migrations (001, 002, 003 already exist).

BEGIN;

-- ============================================================================
-- 1. intelligence_metrics — per-interaction quality scores
-- ============================================================================
CREATE TABLE IF NOT EXISTS intelligence_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interaction_id UUID REFERENCES interactions(id),
    -- Quality dimensions (0-1 scale)
    depth_score FLOAT,           -- How deeply did it analyze vs surface-level
    accuracy_score FLOAT,        -- Self-assessed correctness likelihood  
    creativity_score FLOAT,      -- Novel connections, unexpected insights
    self_awareness_score FLOAT,  -- Did it appropriately hedge/express uncertainty
    task_completion_score FLOAT, -- Did it actually do what was asked
    coherence_score FLOAT,       -- Logical consistency
    -- Composite
    composite_score FLOAT,       -- Weighted average of all dimensions
    -- Context
    dissatisfaction_at_time FLOAT,
    belief_tension_sum FLOAT,    -- Sum of all belief tensions at measurement time
    revision_recency INT,        -- How many interactions since last revision (NULL = never)
    active_beliefs_snapshot JSONB, -- Snapshot of belief states at measurement time
    -- Evaluation metadata
    evaluator_reasoning TEXT,    -- The evaluator's reasoning
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metrics_created ON intelligence_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_composite ON intelligence_metrics(composite_score);
CREATE INDEX IF NOT EXISTS idx_metrics_dissatisfaction ON intelligence_metrics(dissatisfaction_at_time);

-- ============================================================================
-- 2. belief_snapshots — periodic snapshots of the entire belief state
-- ============================================================================
CREATE TABLE IF NOT EXISTS belief_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_type TEXT NOT NULL DEFAULT 'periodic',  -- 'periodic', 'pre_revision', 'post_revision', 'manual'
    trigger_event TEXT,          -- What caused this snapshot
    beliefs JSONB NOT NULL,      -- Full belief array
    connections JSONB,           -- Full connection array
    dissatisfaction FLOAT,
    total_tension FLOAT,
    total_confidence FLOAT,
    beliefs_count INT,
    revision_count INT,          -- Cumulative revisions at this point
    interaction_count INT,       -- Cumulative interactions at this point
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created ON belief_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_type ON belief_snapshots(snapshot_type);

-- ============================================================================
-- 3. improvement_proposals — self-generated code improvement suggestions
-- ============================================================================
CREATE TABLE IF NOT EXISTS improvement_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    target_file TEXT,             -- Which source file to modify
    proposed_diff TEXT,           -- The actual code change
    motivation TEXT,              -- Why this change should help
    metric_impact_prediction JSONB, -- Predicted effect on metrics
    status TEXT DEFAULT 'proposed', -- 'proposed', 'applied', 'rejected', 'reverted'
    applied_at TIMESTAMPTZ,
    metrics_before JSONB,        -- Metrics snapshot before applying
    metrics_after JSONB,         -- Metrics snapshot after applying
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON improvement_proposals(status);

COMMIT;
