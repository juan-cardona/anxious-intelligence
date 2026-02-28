-- Code Patches — proposed self-modifications triggered by belief revisions.
-- This is the bridge between the belief system and the codebase itself.

CREATE TABLE code_patches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    revision_id     UUID REFERENCES revisions(id) ON DELETE SET NULL,
    belief_id       UUID REFERENCES beliefs(id) ON DELETE SET NULL,

    -- What triggered this patch
    trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('revision', 'behavioral_change', 'manual', 'cascade')),
    trigger_reason  TEXT NOT NULL,

    -- The patch itself
    target_file     TEXT NOT NULL,           -- relative path from project root
    patch_type      TEXT NOT NULL CHECK (patch_type IN ('replace', 'insert', 'append', 'config_change', 'new_file')),
    description     TEXT NOT NULL,           -- human-readable description
    diff_preview    TEXT,                    -- unified diff or preview
    original_content TEXT,                   -- backup of original file content (for rollback)
    new_content     TEXT NOT NULL,           -- proposed new content

    -- Lifecycle
    status          TEXT DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'applied', 'tested', 'rolled_back', 'rejected')),
    applied_at      TIMESTAMPTZ,
    rolled_back_at  TIMESTAMPTZ,
    test_result     TEXT,                    -- test output after apply
    rollback_reason TEXT,

    -- Safety
    risk_level      TEXT DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    requires_restart BOOLEAN DEFAULT false,
    auto_approvable BOOLEAN DEFAULT false,   -- can be applied without human review

    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_patches_status ON code_patches(status);
CREATE INDEX idx_patches_revision ON code_patches(revision_id);
CREATE INDEX idx_patches_belief ON code_patches(belief_id);
