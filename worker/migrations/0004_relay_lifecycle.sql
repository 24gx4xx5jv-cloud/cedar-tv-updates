-- Existing schema-3 clients append a new row for every checkpoint. Keep only the newest opaque
-- checkpoint in each publisher slot before enforcing the bounded schema-4 representation.
DELETE FROM sync_changes
 WHERE retention_class != 'journal'
   AND server_sequence NOT IN (
     SELECT MAX(server_sequence)
       FROM sync_changes
      WHERE retention_class != 'journal'
      GROUP BY space_id, author_device_id, retention_class
   );

CREATE UNIQUE INDEX IF NOT EXISTS sync_changes_checkpoint_slot
    ON sync_changes(space_id, author_device_id, retention_class)
    WHERE retention_class != 'journal';

-- One bounded receipt per active author prevents a pruned journal entry from being replayed as a
-- new server sequence. The payload hash is nullable only for rows backfilled from schema 3; their
-- still-retained sync_changes row remains the idempotency source until that author uploads again.
CREATE TABLE IF NOT EXISTS sync_author_heads (
    space_id TEXT NOT NULL,
    author_device_id TEXT NOT NULL,
    highest_author_sequence INTEGER NOT NULL,
    change_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    retention_class TEXT NOT NULL
        CHECK (retention_class IN ('journal', 'profile-checkpoint', 'companion-checkpoint')),
    sealed_payload_hash TEXT,
    server_sequence INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (space_id, author_device_id),
    FOREIGN KEY (space_id, author_device_id)
        REFERENCES sync_devices(space_id, device_id) ON DELETE CASCADE
) STRICT;

INSERT OR IGNORE INTO sync_author_heads(
    space_id, author_device_id, highest_author_sequence, change_id, created_at_ms,
    retention_class, sealed_payload_hash, server_sequence, updated_at_ms
)
SELECT change.space_id,
       change.author_device_id,
       change.author_sequence,
       change.change_id,
       change.created_at_ms,
       change.retention_class,
       NULL,
       change.server_sequence,
       change.stored_at_ms
  FROM sync_changes AS change
 WHERE change.server_sequence = (
    SELECT candidate.server_sequence
      FROM sync_changes AS candidate
     WHERE candidate.space_id = change.space_id
       AND candidate.author_device_id = change.author_device_id
     ORDER BY candidate.author_sequence DESC, candidate.server_sequence DESC
     LIMIT 1
 );

-- A departed-device receipt makes self-removal safely retryable after its live authorization row
-- has been erased. It intentionally retains only an authorization hash, never the bearer token.
CREATE TABLE IF NOT EXISTS sync_device_departures (
    space_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    departed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (space_id, device_id),
    UNIQUE (space_id, token_hash),
    FOREIGN KEY (space_id) REFERENCES sync_spaces(space_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS sync_device_departures_cleanup
    ON sync_device_departures(departed_at_ms);

-- Space deletion must remain retryable after all live authorization rows and the space itself are
-- gone, so these tombstones deliberately have no foreign key back to sync_spaces.
CREATE TABLE IF NOT EXISTS sync_space_deletions (
    space_id TEXT PRIMARY KEY,
    owner_token_hash TEXT NOT NULL,
    deleted_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS sync_space_deletions_cleanup
    ON sync_space_deletions(deleted_at_ms);
