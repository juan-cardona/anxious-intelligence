-- Add tension_shares as a valid relation type
ALTER TABLE belief_connections DROP CONSTRAINT IF EXISTS belief_connections_relation_check;
ALTER TABLE belief_connections ADD CONSTRAINT belief_connections_relation_check 
    CHECK (relation IN ('supports', 'contradicts', 'depends_on', 'generalizes', 'tension_shares'));

-- Add index for fast connection lookups during revision
CREATE INDEX IF NOT EXISTS idx_connections_belief_a ON belief_connections(belief_a);
CREATE INDEX IF NOT EXISTS idx_connections_belief_b ON belief_connections(belief_b);

-- Add discovery metadata to track how connections were found
ALTER TABLE belief_connections ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE belief_connections ADD COLUMN IF NOT EXISTS discovery_method TEXT DEFAULT 'seed' 
    CHECK (discovery_method IN ('seed', 'llm_revision', 'llm_evidence', 'manual'));
ALTER TABLE belief_connections ADD COLUMN IF NOT EXISTS discovery_reasoning TEXT;
