PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_spaces (
    space_id TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL,
    disabled_at_ms INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS sync_devices (
    space_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    PRIMARY KEY (space_id, device_id),
    UNIQUE (space_id, token_hash),
    FOREIGN KEY (space_id) REFERENCES sync_spaces(space_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS sync_invitations (
    space_id TEXT NOT NULL,
    invitation_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_by_device_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    consumed_at_ms INTEGER,
    claimed_device_id TEXT,
    claimed_device_token_hash TEXT,
    PRIMARY KEY (space_id, invitation_id),
    UNIQUE (space_id, token_hash),
    FOREIGN KEY (space_id) REFERENCES sync_spaces(space_id) ON DELETE CASCADE,
    FOREIGN KEY (space_id, created_by_device_id)
        REFERENCES sync_devices(space_id, device_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS sync_changes (
    server_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    change_id TEXT NOT NULL,
    author_device_id TEXT NOT NULL,
    author_sequence INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    sealed_payload TEXT NOT NULL,
    stored_at_ms INTEGER NOT NULL,
    UNIQUE (space_id, change_id),
    UNIQUE (space_id, author_device_id, author_sequence),
    FOREIGN KEY (space_id) REFERENCES sync_spaces(space_id) ON DELETE CASCADE,
    FOREIGN KEY (space_id, author_device_id)
        REFERENCES sync_devices(space_id, device_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS sync_changes_space_sequence
    ON sync_changes(space_id, server_sequence);

CREATE INDEX IF NOT EXISTS sync_invitations_expiry
    ON sync_invitations(expires_at_ms);
