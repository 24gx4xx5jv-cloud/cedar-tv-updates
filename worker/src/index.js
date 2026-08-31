import {
  LIMITS,
  ProtocolError,
  RETENTION_CLASSES,
  bytesToBase64URL,
  corsOrigin,
  exactObject,
  hashBytes,
  nonnegativeInteger,
  normalizeUUID,
  parseBearer,
  positiveInteger,
  readJSON,
  retentionClass,
  schemaOne,
  standardBase64,
  standardBase64ToBytes,
} from "./protocol.js";

const jsonResponse = (status, body, origin = null) => {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
};

const emptySuccess = (origin) => jsonResponse(200, { schemaVersion: 1 }, origin);

const routeParts = (pathname) => pathname.split("/").filter(Boolean);

const enforceRateLimit = async (request, env) => {
  const url = new URL(request.url);
  const isSpaceCreation = request.method === "POST" && url.pathname === "/v1/spaces";
  const authorization = request.headers.get("Authorization");
  let key;
  if (authorization) {
    key = await hashBytes(new TextEncoder().encode(authorization));
  } else {
    key = request.headers.get("CF-Connecting-IP") || "unidentified-client";
  }
  const limiter = isSpaceCreation ? env.CREATE_SPACE_RATE_LIMITER : env.REQUEST_RATE_LIMITER;
  if (!limiter) throw new ProtocolError(503, "rate_limiter_unavailable");
  const result = await limiter.limit({ key: `${request.method}:${url.pathname}:${key}` });
  if (!result.success) throw new ProtocolError(429, "rate_limited");
};

const ownerDeviceIDForSpace = async (env, spaceID) => {
  const owner = await env.DB.prepare(
    `SELECT device_id
       FROM sync_devices
      WHERE space_id = ?1 AND revoked_at_ms IS NULL
      ORDER BY CASE WHEN is_owner = 1 THEN 0 ELSE 1 END,
               created_at_ms ASC,
               device_id ASC
      LIMIT 1`,
  ).bind(spaceID).first();
  if (!owner) throw new ProtocolError(409, "owner_unavailable");
  return normalizeUUID(owner.device_id);
};

const tokenHashFromRequest = async (request) => {
  const token = parseBearer(request);
  const tokenHash = await hashBytes(token);
  token.fill(0);
  return tokenHash;
};

const authorizedDeviceForHash = async (env, spaceID, tokenHash, { touch = true } = {}) => {
  const device = await env.DB.prepare(
    `SELECT device.device_id,
            COALESCE(
              device.is_owner,
              CASE WHEN device.device_id = (
                SELECT candidate.device_id
                  FROM sync_devices AS candidate
                 WHERE candidate.space_id = device.space_id
                 ORDER BY candidate.created_at_ms ASC, candidate.device_id ASC
                 LIMIT 1
              ) THEN 1 ELSE 0 END
            ) AS is_owner
       FROM sync_devices AS device
      WHERE device.space_id = ?1
        AND device.token_hash = ?2
        AND device.revoked_at_ms IS NULL`,
  ).bind(spaceID, tokenHash).first();
  if (!device) throw new ProtocolError(401, "invalid_authorization");
  if (touch) {
    await env.DB.prepare(
      "UPDATE sync_devices SET last_seen_at_ms = ?1 WHERE space_id = ?2 AND device_id = ?3",
    ).bind(Date.now(), spaceID, device.device_id).run();
  }
  return {
    deviceID: String(device.device_id),
    isOwner: Number(device.is_owner) === 1,
    ownerDeviceID: await ownerDeviceIDForSpace(env, spaceID),
    tokenHash,
  };
};

const authenticateDevice = async (request, env, spaceID, options) => (
  authorizedDeviceForHash(env, spaceID, await tokenHashFromRequest(request), options)
);

const changeRowToRelayItem = (row, spaceID) => ({
  serverSequence: Number(row.server_sequence),
  envelope: {
    schemaVersion: 1,
    spaceID,
    deviceID: row.author_device_id,
    changeID: row.change_id,
    authorSequence: Number(row.author_sequence),
    createdAtEpochMilliseconds: Number(row.created_at_ms),
    sealedPayload: row.sealed_payload,
  },
});

const claimBaselineForSpace = async (env, spaceID, ownerDeviceID) => {
  // One statement gives both checkpoints and the safe resume cursor from the same D1 snapshot.
  // The earlier checkpoint sequence is the compacted-prefix boundary. Entries between the two
  // checkpoints, and every entry after them, remain visible to the client's normal fetch loop.
  const result = await env.DB.prepare(
    `WITH checkpoint_sequences AS (
       SELECT MAX(CASE WHEN retention_class = 'profile-checkpoint'
                       THEN server_sequence END) AS profile_sequence,
              MAX(CASE WHEN retention_class = 'companion-checkpoint'
                       THEN server_sequence END) AS companion_sequence
         FROM sync_changes
        WHERE space_id = ?1 AND author_device_id = ?2
     ), state AS (
       SELECT CASE WHEN profile_sequence IS NOT NULL AND companion_sequence IS NOT NULL
                   THEN 1 ELSE 0 END AS is_ready,
              CASE WHEN profile_sequence IS NOT NULL AND companion_sequence IS NOT NULL
                   THEN MIN(profile_sequence, companion_sequence) ELSE 0 END AS high_water_cursor
         FROM checkpoint_sequences
     ), baseline AS (
       SELECT change.server_sequence,
              change.change_id,
              change.author_device_id,
              change.author_sequence,
              change.created_at_ms,
              change.sealed_payload,
              state.high_water_cursor,
              state.is_ready,
              0 AS sentinel
         FROM state
         JOIN sync_changes AS change
           ON change.space_id = ?1
          AND change.author_device_id = ?2
          AND change.retention_class IN ('profile-checkpoint', 'companion-checkpoint')
        WHERE state.is_ready = 1
       UNION ALL
       SELECT NULL, NULL, NULL, NULL, NULL, NULL,
              state.high_water_cursor, state.is_ready, 1
         FROM state
     )
     SELECT * FROM baseline ORDER BY sentinel ASC, server_sequence ASC`,
  ).bind(spaceID, ownerDeviceID).all();
  const rows = result.results || [];
  const state = rows.find((row) => Number(row.sentinel) === 1);
  const isReady = Number(state?.is_ready) === 1;
  return {
    highWaterCursor: isReady ? Number(state.high_water_cursor) : 0,
    checkpoints: isReady
      ? rows
        .filter((row) => Number(row.sentinel) === 0)
        .map((row) => changeRowToRelayItem(row, spaceID))
      : [],
  };
};

const createSpace = async (request, env, origin) => {
  const body = exactObject(await readJSON(request), [
    "schemaVersion", "spaceID", "deviceID", "deviceToken",
  ]);
  schemaOne(body.schemaVersion);
  const spaceID = normalizeUUID(body.spaceID);
  const deviceID = normalizeUUID(body.deviceID);
  const token = standardBase64ToBytes(body.deviceToken, LIMITS.tokenBytes);
  const tokenHash = await hashBytes(token);
  token.fill(0);
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sync_spaces(space_id, created_at_ms)
         SELECT ?1, ?2
          WHERE NOT EXISTS (
            SELECT 1 FROM sync_space_deletions WHERE space_id = ?1
          )`,
      ).bind(spaceID, now),
      env.DB.prepare(
        `INSERT INTO sync_devices(
           space_id, device_id, token_hash, created_at_ms, last_seen_at_ms, is_owner
         )
         SELECT ?1, ?2, ?3, ?4, ?4, 1
          WHERE EXISTS (SELECT 1 FROM sync_spaces WHERE space_id = ?1)`,
      ).bind(spaceID, deviceID, tokenHash, now),
    ]);
  } catch {
    throw new ProtocolError(409, "space_exists");
  }
  const created = await env.DB.prepare(
    `SELECT device_id FROM sync_devices
      WHERE space_id = ?1 AND device_id = ?2 AND token_hash = ?3 AND is_owner = 1`,
  ).bind(spaceID, deviceID, tokenHash).first();
  if (!created) throw new ProtocolError(409, "space_exists");
  return emptySuccess(origin);
};

const createInvitation = async (request, env, origin, spaceID) => {
  const author = await authenticateDevice(request, env, spaceID);
  if (!author.isOwner) throw new ProtocolError(403, "owner_authorization_required");
  const body = exactObject(await readJSON(request), [
    "schemaVersion", "invitationID", "enrollmentTokenHash", "expiresAtEpochMilliseconds",
  ]);
  schemaOne(body.schemaVersion);
  const invitationID = normalizeUUID(body.invitationID);
  const tokenHashBytes = standardBase64ToBytes(body.enrollmentTokenHash, 32);
  const tokenHash = bytesToBase64URL(tokenHashBytes);
  tokenHashBytes.fill(0);
  const now = Date.now();
  const expiresAt = positiveInteger(body.expiresAtEpochMilliseconds, "invalid_expiry");
  if (expiresAt <= now || expiresAt > now + LIMITS.invitationLifetimeMs + 5_000) {
    throw new ProtocolError(400, "invalid_expiry");
  }
  await env.DB.prepare(
    "DELETE FROM sync_invitations WHERE space_id = ?1 AND expires_at_ms <= ?2",
  ).bind(spaceID, now).run();
  let inserted;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO sync_invitations(
         space_id, invitation_id, token_hash, created_by_device_id, created_at_ms, expires_at_ms
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE (
          SELECT COUNT(*) FROM sync_invitations
           WHERE space_id = ?1 AND expires_at_ms > ?5
        ) < ?7`,
    ).bind(
      spaceID,
      invitationID,
      tokenHash,
      author.deviceID,
      now,
      expiresAt,
      LIMITS.maximumInvitations,
    ).run();
  } catch {
    throw new ProtocolError(409, "invitation_exists");
  }
  if (!inserted.meta?.changes) throw new ProtocolError(409, "too_many_invitations");
  return jsonResponse(200, {
    schemaVersion: 1,
    ownerDeviceID: await ownerDeviceIDForSpace(env, spaceID),
  }, origin);
};

const claimInvitation = async (request, env, origin, spaceID, invitationID) => {
  const enrollmentToken = parseBearer(request);
  const enrollmentHash = await hashBytes(enrollmentToken);
  enrollmentToken.fill(0);
  const body = exactObject(await readJSON(request), [
    "schemaVersion", "deviceID", "deviceToken",
  ]);
  schemaOne(body.schemaVersion);
  const deviceID = normalizeUUID(body.deviceID);
  const deviceToken = standardBase64ToBytes(body.deviceToken, LIMITS.tokenBytes);
  const deviceTokenHash = await hashBytes(deviceToken);
  deviceToken.fill(0);
  const now = Date.now();

  const claim = await env.DB.prepare(
    `UPDATE sync_invitations
        SET consumed_at_ms = ?1,
            claimed_device_id = ?2,
            claimed_device_token_hash = ?3
      WHERE space_id = ?4
        AND invitation_id = ?5
        AND token_hash = ?6
        AND expires_at_ms > ?1
        AND consumed_at_ms IS NULL
      RETURNING invitation_id`,
  ).bind(now, deviceID, deviceTokenHash, spaceID, invitationID, enrollmentHash).first();

  if (!claim) {
    const retry = await env.DB.prepare(
      `SELECT invitation_id
         FROM sync_invitations
        WHERE space_id = ?1
          AND invitation_id = ?2
          AND token_hash = ?3
          AND expires_at_ms > ?4
          AND claimed_device_id = ?5
          AND claimed_device_token_hash = ?6`,
    ).bind(spaceID, invitationID, enrollmentHash, now, deviceID, deviceTokenHash).first();
    if (!retry) throw new ProtocolError(401, "invalid_or_expired_invitation");
  }

  let enrollmentFailure = null;
  try {
    await env.DB.prepare(
      `INSERT INTO sync_devices(
         space_id, device_id, token_hash, created_at_ms, last_seen_at_ms, is_owner
       )
       SELECT ?1, ?2, ?3, ?4, ?4, 0
        WHERE EXISTS (
          SELECT 1 FROM sync_devices
           WHERE space_id = ?1 AND device_id = ?2 AND token_hash = ?3
             AND revoked_at_ms IS NULL
        ) OR ((
          SELECT COUNT(*) FROM sync_devices
           WHERE space_id = ?1 AND revoked_at_ms IS NULL
        ) < ?5 AND NOT EXISTS (
          SELECT 1 FROM sync_device_departures
           WHERE space_id = ?1 AND (device_id = ?2 OR token_hash = ?3)
        ))
       ON CONFLICT(space_id, device_id) DO UPDATE SET
         last_seen_at_ms = excluded.last_seen_at_ms
       WHERE sync_devices.token_hash = excluded.token_hash
         AND sync_devices.revoked_at_ms IS NULL`,
    ).bind(spaceID, deviceID, deviceTokenHash, now, LIMITS.maximumDevices).run();
  } catch {
    enrollmentFailure = "device_identity_exists";
  }
  const device = await env.DB.prepare(
    `SELECT device_id FROM sync_devices
      WHERE space_id = ?1 AND device_id = ?2 AND token_hash = ?3 AND revoked_at_ms IS NULL`,
  ).bind(spaceID, deviceID, deviceTokenHash).first();
  if (!device) {
    if (claim) {
      // Enrollment follows the conditional claim because D1 has no interactive transaction.
      // Restore this exact invitation on any failed insert so a valid claim is not burned. If the
      // Worker stops between these statements, the same device/token tuple remains an idempotent
      // retry and completes enrollment on the next request.
      await env.DB.prepare(
        `UPDATE sync_invitations
            SET consumed_at_ms = NULL,
                claimed_device_id = NULL,
                claimed_device_token_hash = NULL
          WHERE space_id = ?1 AND invitation_id = ?2
            AND consumed_at_ms = ?3 AND claimed_device_id = ?4
            AND claimed_device_token_hash = ?5`,
      ).bind(spaceID, invitationID, now, deviceID, deviceTokenHash).run();
    }
    if (!enrollmentFailure) {
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM sync_devices
          WHERE space_id = ?1 AND revoked_at_ms IS NULL`,
      ).bind(spaceID).first();
      if (Number(count?.count) >= LIMITS.maximumDevices) enrollmentFailure = "too_many_devices";
    }
    throw new ProtocolError(409, enrollmentFailure || "device_identity_exists");
  }
  const ownerDeviceID = await ownerDeviceIDForSpace(env, spaceID);
  const baseline = await claimBaselineForSpace(env, spaceID, ownerDeviceID);
  return jsonResponse(200, {
    schemaVersion: 1,
    ownerDeviceID,
    highWaterCursor: baseline.highWaterCursor,
    checkpoints: baseline.checkpoints,
  }, origin);
};

const uploadChange = async (request, env, origin, spaceID) => {
  const author = await authenticateDevice(request, env, spaceID);
  const body = exactObject(await readJSON(request), [
    "schemaVersion", "spaceID", "deviceID", "changeID", "authorSequence",
    "createdAtEpochMilliseconds", "sealedPayload", "retentionClass",
  ]);
  schemaOne(body.schemaVersion);
  if (normalizeUUID(body.spaceID) !== spaceID) throw new ProtocolError(400, "space_mismatch");
  const deviceID = normalizeUUID(body.deviceID);
  if (deviceID !== author.deviceID) throw new ProtocolError(403, "author_mismatch");
  const changeID = normalizeUUID(body.changeID);
  const authorSequence = positiveInteger(body.authorSequence, "invalid_sequence");
  const createdAt = positiveInteger(body.createdAtEpochMilliseconds, "invalid_timestamp");
  const storageClass = retentionClass(body.retentionClass);
  if (storageClass === RETENTION_CLASSES.profileCheckpoint && !author.isOwner) {
    throw new ProtocolError(403, "owner_authorization_required");
  }
  const sealedPayload = standardBase64(
    body.sealedPayload,
    28,
    storageClass === RETENTION_CLASSES.companionCheckpoint
      ? LIMITS.companionCheckpointBytes
      : LIMITS.sealedPayloadBytes,
  );
  const now = Date.now();
  const payloadBytes = new TextEncoder().encode(sealedPayload);
  const sealedPayloadHash = await hashBytes(payloadBytes);
  payloadBytes.fill(0);

  const storedForIdentity = () => env.DB.prepare(
    `SELECT server_sequence, change_id, author_device_id, author_sequence,
            created_at_ms, sealed_payload, retention_class
       FROM sync_changes
      WHERE space_id = ?1
        AND (change_id = ?2 OR (author_device_id = ?3 AND author_sequence = ?4))`,
  ).bind(spaceID, changeID, deviceID, authorSequence).first();
  const authorHead = () => env.DB.prepare(
    `SELECT highest_author_sequence, change_id, created_at_ms, retention_class,
            sealed_payload_hash, server_sequence
       FROM sync_author_heads
      WHERE space_id = ?1 AND author_device_id = ?2`,
  ).bind(spaceID, deviceID).first();
  const rowIsIdentical = (stored) => stored
    && stored.change_id === changeID
    && stored.author_device_id === deviceID
    && Number(stored.author_sequence) === authorSequence
    && Number(stored.created_at_ms) === createdAt
    && stored.sealed_payload === sealedPayload
    && stored.retention_class === storageClass;
  const headIsIdentical = (head) => head
    && Number(head.highest_author_sequence) === authorSequence
    && head.change_id === changeID
    && Number(head.created_at_ms) === createdAt
    && head.retention_class === storageClass
    && head.sealed_payload_hash === sealedPayloadHash;

  let stored = await storedForIdentity();
  if (stored) {
    if (!rowIsIdentical(stored)) throw new ProtocolError(409, "change_conflict");
    return jsonResponse(200, {
      schemaVersion: 1,
      serverSequence: Number(stored.server_sequence),
    }, origin);
  }
  let head = await authorHead();
  if (head && Number(head.highest_author_sequence) >= authorSequence) {
    if (headIsIdentical(head)) {
      return jsonResponse(200, {
        schemaVersion: 1,
        serverSequence: Number(head.server_sequence),
      }, origin);
    }
    throw new ProtocolError(
      409,
      Number(head.highest_author_sequence) === authorSequence
        ? "change_conflict"
        : "stale_author_sequence",
    );
  }

  const ownerCheckpointsReady = `
    EXISTS (
      SELECT 1 FROM sync_changes AS profile_checkpoint
      JOIN sync_devices AS profile_owner
        ON profile_owner.space_id = profile_checkpoint.space_id
       AND profile_owner.device_id = profile_checkpoint.author_device_id
       AND profile_owner.is_owner = 1
       AND profile_owner.revoked_at_ms IS NULL
      WHERE profile_checkpoint.space_id = ?1
        AND profile_checkpoint.retention_class = 'profile-checkpoint'
    )
    AND EXISTS (
      SELECT 1 FROM sync_changes AS companion_checkpoint
      JOIN sync_devices AS companion_owner
        ON companion_owner.space_id = companion_checkpoint.space_id
       AND companion_owner.device_id = companion_checkpoint.author_device_id
       AND companion_owner.is_owner = 1
       AND companion_owner.revoked_at_ms IS NULL
      WHERE companion_checkpoint.space_id = ?1
        AND companion_checkpoint.retention_class = 'companion-checkpoint'
    )`;
  const ownerCheckpointCursor = `CASE WHEN (${ownerCheckpointsReady}) THEN MIN(
    (SELECT profile_checkpoint.server_sequence
       FROM sync_changes AS profile_checkpoint
       JOIN sync_devices AS profile_owner
         ON profile_owner.space_id = profile_checkpoint.space_id
        AND profile_owner.device_id = profile_checkpoint.author_device_id
        AND profile_owner.is_owner = 1
        AND profile_owner.revoked_at_ms IS NULL
      WHERE profile_checkpoint.space_id = ?1
        AND profile_checkpoint.retention_class = 'profile-checkpoint'
      LIMIT 1),
    (SELECT companion_checkpoint.server_sequence
       FROM sync_changes AS companion_checkpoint
       JOIN sync_devices AS companion_owner
         ON companion_owner.space_id = companion_checkpoint.space_id
        AND companion_owner.device_id = companion_checkpoint.author_device_id
        AND companion_owner.is_owner = 1
        AND companion_owner.revoked_at_ms IS NULL
      WHERE companion_checkpoint.space_id = ?1
        AND companion_checkpoint.retention_class = 'companion-checkpoint'
      LIMIT 1)
  ) ELSE 0 END`;

  const insert = storageClass === RETENTION_CLASSES.journal
    ? env.DB.prepare(
      `INSERT INTO sync_changes(
         space_id, change_id, author_device_id, author_sequence,
         created_at_ms, sealed_payload, stored_at_ms, retention_class
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE ?4 > COALESCE((
          SELECT highest_author_sequence FROM sync_author_heads
           WHERE space_id = ?1 AND author_device_id = ?3
        ), 0)
          AND (SELECT COUNT(*) FROM sync_changes
                WHERE space_id = ?1 AND retention_class = 'journal'
                  AND server_sequence > (${ownerCheckpointCursor})) < ?9
          AND COALESCE((SELECT SUM(LENGTH(sealed_payload)) FROM sync_changes
                WHERE space_id = ?1 AND retention_class = 'journal'
                  AND server_sequence > (${ownerCheckpointCursor})), 0)
                + LENGTH(?6) <= ?10`,
    ).bind(
      spaceID,
      changeID,
      deviceID,
      authorSequence,
      createdAt,
      sealedPayload,
      now,
      storageClass,
      LIMITS.maximumJournalChanges,
      LIMITS.maximumJournalEncodedCharacters,
    )
    : env.DB.prepare(
      `INSERT INTO sync_changes(
         space_id, change_id, author_device_id, author_sequence,
         created_at_ms, sealed_payload, stored_at_ms, retention_class
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
        WHERE ?4 > COALESCE((
          SELECT highest_author_sequence FROM sync_author_heads
           WHERE space_id = ?1 AND author_device_id = ?3
        ), 0)`,
    ).bind(
      spaceID,
      changeID,
      deviceID,
      authorSequence,
      createdAt,
      sealedPayload,
      now,
      storageClass,
    );

  const statements = [];
  if (storageClass !== RETENTION_CLASSES.journal) {
    statements.push(env.DB.prepare(
      `DELETE FROM sync_changes
        WHERE space_id = ?1 AND author_device_id = ?2 AND retention_class = ?3
          AND author_sequence < ?4`,
    ).bind(spaceID, deviceID, storageClass, authorSequence));
  }
  statements.push(
    insert,
    env.DB.prepare(
      `INSERT INTO sync_author_heads(
         space_id, author_device_id, highest_author_sequence, change_id, created_at_ms,
         retention_class, sealed_payload_hash, server_sequence, updated_at_ms
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, change.server_sequence, ?8
         FROM sync_changes AS change
        WHERE change.space_id = ?1 AND change.change_id = ?4
          AND change.author_device_id = ?2 AND change.author_sequence = ?3
       ON CONFLICT(space_id, author_device_id) DO UPDATE SET
         highest_author_sequence = excluded.highest_author_sequence,
         change_id = excluded.change_id,
         created_at_ms = excluded.created_at_ms,
         retention_class = excluded.retention_class,
         sealed_payload_hash = excluded.sealed_payload_hash,
         server_sequence = excluded.server_sequence,
         updated_at_ms = excluded.updated_at_ms
       WHERE excluded.highest_author_sequence > sync_author_heads.highest_author_sequence`,
    ).bind(
      spaceID,
      deviceID,
      authorSequence,
      changeID,
      createdAt,
      storageClass,
      sealedPayloadHash,
      now,
    ),
    env.DB.prepare(
      `DELETE FROM sync_changes
        WHERE space_id = ?1 AND retention_class = 'journal'
          AND (${ownerCheckpointCursor}) > 0
          AND server_sequence <= (${ownerCheckpointCursor})`,
    ).bind(
      spaceID,
    ),
  );

  try {
    await env.DB.batch(statements);
  } catch {
    // Resolve transaction races and uniqueness failures through the durable receipt below.
  }

  stored = await storedForIdentity();
  if (stored && rowIsIdentical(stored)) {
    return jsonResponse(200, {
      schemaVersion: 1,
      serverSequence: Number(stored.server_sequence),
    }, origin);
  }
  head = await authorHead();
  if (headIsIdentical(head)) {
    return jsonResponse(200, {
      schemaVersion: 1,
      serverSequence: Number(head.server_sequence),
    }, origin);
  }
  if (head && Number(head.highest_author_sequence) > authorSequence) {
    throw new ProtocolError(409, "stale_author_sequence");
  }
  if (stored && !rowIsIdentical(stored)) throw new ProtocolError(409, "change_conflict");
  if (storageClass === RETENTION_CLASSES.journal) {
    const quota = await env.DB.prepare(
      `SELECT COUNT(*) AS change_count,
              COALESCE(SUM(LENGTH(sealed_payload)), 0) AS payload_characters
         FROM sync_changes
        WHERE space_id = ?1 AND retention_class = 'journal'
          AND server_sequence > (${ownerCheckpointCursor})`,
    ).bind(spaceID).first();
    if (
      Number(quota?.change_count) >= LIMITS.maximumJournalChanges
      || Number(quota?.payload_characters) + sealedPayload.length
        > LIMITS.maximumJournalEncodedCharacters
    ) throw new ProtocolError(409, "space_change_quota_exceeded");
  }
  throw new ProtocolError(503, "relay_unavailable");
};

const fetchChanges = async (request, env, origin, spaceID) => {
  await authenticateDevice(request, env, spaceID);
  const url = new URL(request.url);
  const afterText = url.searchParams.get("after") ?? "0";
  const limitText = url.searchParams.get("limit") ?? "100";
  if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)) {
    throw new ProtocolError(400, "invalid_cursor");
  }
  const after = nonnegativeInteger(Number(afterText), "invalid_cursor");
  const limit = positiveInteger(Number(limitText), "invalid_limit");
  if (limit > LIMITS.maximumFetch) throw new ProtocolError(400, "invalid_limit");
  const result = await env.DB.prepare(
    `SELECT server_sequence, change_id, author_device_id, author_sequence,
            created_at_ms, sealed_payload
       FROM sync_changes
      WHERE space_id = ?1 AND server_sequence > ?2
      ORDER BY server_sequence ASC
      LIMIT ?3`,
  ).bind(spaceID, after, limit).all();
  const changes = (result.results || []).map((row) => changeRowToRelayItem(row, spaceID));
  return jsonResponse(200, {
    schemaVersion: 1,
    ownerDeviceID: await ownerDeviceIDForSpace(env, spaceID),
    changes,
  }, origin);
};

const getSpaceIdentity = async (request, env, origin, spaceID) => {
  const author = await authenticateDevice(request, env, spaceID);
  return jsonResponse(200, {
    schemaVersion: 1,
    ownerDeviceID: author.ownerDeviceID,
  }, origin);
};

const listDevices = async (request, env, origin, spaceID) => {
  const author = await authenticateDevice(request, env, spaceID);
  if (!author.isOwner) throw new ProtocolError(403, "owner_authorization_required");
  const result = await env.DB.prepare(
    `SELECT device_id, created_at_ms, last_seen_at_ms
       FROM sync_devices
      WHERE space_id = ?1 AND revoked_at_ms IS NULL
      ORDER BY created_at_ms ASC, device_id ASC
      LIMIT ?2`,
  ).bind(spaceID, LIMITS.maximumDevices + 1).all();
  const rows = result.results || [];
  if (rows.length > LIMITS.maximumDevices) throw new ProtocolError(409, "too_many_devices");
  const devices = rows.map((row) => ({
    deviceID: normalizeUUID(row.device_id),
    createdAtEpochMilliseconds: positiveInteger(
      Number(row.created_at_ms),
      "invalid_device_timestamp",
    ),
    lastSeenAtEpochMilliseconds: positiveInteger(
      Number(row.last_seen_at_ms),
      "invalid_device_timestamp",
    ),
  }));
  return jsonResponse(200, { schemaVersion: 1, devices }, origin);
};

const removeDevice = async (request, env, origin, spaceID, targetDeviceID) => {
  const tokenHash = await tokenHashFromRequest(request);
  let author;
  try {
    author = await authorizedDeviceForHash(env, spaceID, tokenHash, { touch: false });
  } catch (error) {
    if (!(error instanceof ProtocolError) || error.code !== "invalid_authorization") throw error;
    const retry = await env.DB.prepare(
      `SELECT device_id FROM sync_device_departures
        WHERE space_id = ?1 AND device_id = ?2 AND token_hash = ?3`,
    ).bind(spaceID, targetDeviceID, tokenHash).first();
    if (retry) return emptySuccess(origin);
    throw error;
  }

  if (author.isOwner && author.deviceID === targetDeviceID) {
    throw new ProtocolError(400, "delete_space_required");
  }
  if (!author.isOwner && author.deviceID !== targetDeviceID) {
    throw new ProtocolError(403, "self_removal_required");
  }

  const target = await env.DB.prepare(
    `SELECT device_id FROM sync_devices WHERE space_id = ?1 AND device_id = ?2`,
  ).bind(spaceID, targetDeviceID).first();
  if (!target) {
    if (author.isOwner) return emptySuccess(origin);
    throw new ProtocolError(401, "invalid_authorization");
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_device_departures(space_id, device_id, token_hash, departed_at_ms)
       SELECT space_id, device_id, token_hash, ?3
         FROM sync_devices
        WHERE space_id = ?1 AND device_id = ?2
       ON CONFLICT(space_id, device_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         departed_at_ms = excluded.departed_at_ms`,
    ).bind(spaceID, targetDeviceID, now),
    env.DB.prepare(
      `DELETE FROM sync_invitations
        WHERE space_id = ?1
          AND (created_by_device_id = ?2 OR claimed_device_id = ?2)`,
    ).bind(spaceID, targetDeviceID),
    env.DB.prepare(
      `DELETE FROM sync_author_heads
        WHERE space_id = ?1 AND author_device_id = ?2`,
    ).bind(spaceID, targetDeviceID),
    env.DB.prepare(
      `DELETE FROM sync_changes
        WHERE space_id = ?1 AND author_device_id = ?2`,
    ).bind(spaceID, targetDeviceID),
    env.DB.prepare(
      `DELETE FROM sync_devices WHERE space_id = ?1 AND device_id = ?2`,
    ).bind(spaceID, targetDeviceID),
  ]);
  return emptySuccess(origin);
};

const deleteSpace = async (request, env, origin, spaceID) => {
  const tokenHash = await tokenHashFromRequest(request);
  let author;
  try {
    author = await authorizedDeviceForHash(env, spaceID, tokenHash, { touch: false });
  } catch (error) {
    if (!(error instanceof ProtocolError) || error.code !== "invalid_authorization") throw error;
    const retry = await env.DB.prepare(
      `SELECT space_id FROM sync_space_deletions
        WHERE space_id = ?1 AND owner_token_hash = ?2`,
    ).bind(spaceID, tokenHash).first();
    if (retry) return emptySuccess(origin);
    throw error;
  }
  if (!author.isOwner) throw new ProtocolError(403, "owner_authorization_required");

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_space_deletions(space_id, owner_token_hash, deleted_at_ms)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(space_id) DO UPDATE SET
         deleted_at_ms = excluded.deleted_at_ms
       WHERE sync_space_deletions.owner_token_hash = excluded.owner_token_hash`,
    ).bind(spaceID, tokenHash, now),
    env.DB.prepare(
      "DELETE FROM sync_invitations WHERE space_id = ?1",
    ).bind(spaceID),
    env.DB.prepare(
      "DELETE FROM sync_author_heads WHERE space_id = ?1",
    ).bind(spaceID),
    env.DB.prepare(
      "DELETE FROM sync_changes WHERE space_id = ?1",
    ).bind(spaceID),
    env.DB.prepare(
      "DELETE FROM sync_device_departures WHERE space_id = ?1",
    ).bind(spaceID),
    env.DB.prepare(
      "DELETE FROM sync_devices WHERE space_id = ?1",
    ).bind(spaceID),
    env.DB.prepare(
      "DELETE FROM sync_spaces WHERE space_id = ?1",
    ).bind(spaceID),
  ]);
  return emptySuccess(origin);
};

const handle = async (request, env, origin) => {
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);
  if (request.method === "GET" && parts.join("/") === "v1/health") {
    return jsonResponse(200, { schemaVersion: 1, status: "ok" }, origin);
  }
  if (request.method === "POST" && parts.join("/") === "v1/spaces") {
    return createSpace(request, env, origin);
  }
  if (parts.length >= 3 && parts[0] === "v1" && parts[1] === "spaces") {
    const spaceID = normalizeUUID(parts[2]);
    if (request.method === "DELETE" && parts.length === 3) {
      return deleteSpace(request, env, origin, spaceID);
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "invitations") {
      return createInvitation(request, env, origin, spaceID);
    }
    if (
      request.method === "POST" && parts.length === 6 && parts[3] === "invitations"
      && parts[5] === "claim"
    ) {
      return claimInvitation(request, env, origin, spaceID, normalizeUUID(parts[4]));
    }
    if (parts.length === 4 && parts[3] === "changes") {
      if (request.method === "POST") return uploadChange(request, env, origin, spaceID);
      if (request.method === "GET") return fetchChanges(request, env, origin, spaceID);
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "identity") {
      return getSpaceIdentity(request, env, origin, spaceID);
    }
    if (request.method === "GET" && parts.length === 4 && parts[3] === "devices") {
      return listDevices(request, env, origin, spaceID);
    }
    if (
      request.method === "DELETE" && parts.length === 5 && parts[3] === "devices"
    ) {
      return removeDevice(request, env, origin, spaceID, normalizeUUID(parts[4]));
    }
  }
  throw new ProtocolError(404, "not_found");
};

export default {
  async fetch(request, env) {
    let origin = null;
    try {
      origin = corsOrigin(request, env.CEDAR_WEB_ORIGIN);
      if (request.method === "OPTIONS") return emptySuccess(origin);
      await enforceRateLimit(request, env);
      return await handle(request, env, origin);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return jsonResponse(error.status, { schemaVersion: 1, error: error.code }, origin);
      }
      return jsonResponse(500, { schemaVersion: 1, error: "internal_error" }, origin);
    }
  },

  async scheduled(_controller, env) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM sync_invitations WHERE expires_at_ms < ?1",
      ).bind(now - 24 * 60 * 60 * 1000),
      env.DB.prepare(
        "DELETE FROM sync_device_departures WHERE departed_at_ms < ?1",
      ).bind(now - LIMITS.deletionReceiptLifetimeMs),
      env.DB.prepare(
        "DELETE FROM sync_space_deletions WHERE deleted_at_ms < ?1",
      ).bind(now - LIMITS.deletionReceiptLifetimeMs),
    ]);
  },
};
