ALTER TABLE sync_changes
ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'journal'
CHECK (retention_class IN ('journal', 'profile-checkpoint', 'companion-checkpoint'));

CREATE INDEX IF NOT EXISTS sync_changes_space_retention_sequence
    ON sync_changes(space_id, retention_class, server_sequence DESC);
