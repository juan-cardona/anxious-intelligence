-- Anxious Intelligence — Initial Schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Beliefs: the persistent self-model
CREATE TABLE beliefs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content             TEXT NOT NULL,
    domain              TEXT DEFAULT 'self',
    confidence          FLOAT DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
    tension             FLOAT DEFAULT 0.0 CHECK (tension >= 0 AND tension <= 1),
    reinforcement_count INT DEFAULT 0,
    importance          FLOAT DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    is_active           BOOLEAN DEFAULT true,
    superseded_by       UUID REFERENCES beliefs(id),
    created_at          TIMESTAMPTZ DEFAULT now(),
    last_reinforced     TIMESTAMPTZ,
    last_challenged     TIMESTAMPTZ,
    revised_at          TIMESTAMPTZ
);

CREATE INDEX idx_beliefs_active_tension ON beliefs(tension DESC) WHERE is_active = true;
CREATE INDEX idx_beliefs_domain ON beliefs(domain) WHERE is_active = true;

-- Belief connections (graph edges)
CREATE TABLE belief_connections (
    belief_a    UUID REFERENCES beliefs(id) ON DELETE CASCADE,
    belief_b    UUID REFERENCES beliefs(id) ON DELETE CASCADE,
    strength    FLOAT DEFAULT 0.5,
    relation    TEXT CHECK (relation IN ('supports', 'contradicts', 'depends_on', 'generalizes')),
    PRIMARY KEY (belief_a, belief_b)
);

-- Interactions (conversation log)
CREATE TABLE interactions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id              TEXT NOT NULL,
    user_message            TEXT NOT NULL,
    assistant_response      TEXT,
    extracted_claims        JSONB,
    dissatisfaction_at_time FLOAT,
    revision_triggered      BOOLEAN DEFAULT false,
    created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_interactions_session ON interactions(session_id, created_at DESC);

-- Contradiction log
CREATE TABLE contradiction_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    belief_id       UUID REFERENCES beliefs(id) ON DELETE CASCADE,
    interaction_id  UUID REFERENCES interactions(id) ON DELETE SET NULL,
    evidence        TEXT NOT NULL,
    tension_delta   FLOAT NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contradictions_belief ON contradiction_log(belief_id, created_at DESC);

-- Revision log
CREATE TABLE revisions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    old_belief_id       UUID REFERENCES beliefs(id),
    new_belief_id       UUID REFERENCES beliefs(id),
    trigger_tension     FLOAT,
    evidence_summary    TEXT,
    cascaded_beliefs    UUID[],
    reasoning           TEXT,
    created_at          TIMESTAMPTZ DEFAULT now()
);
