import {
  LIMITS,
  ProtocolError,
  bytesToBase64URL,
  corsOrigin,
  exactObject,
  hashBytes,
  nonnegativeInteger,
  normalizeUUID,
  parseBearer,
  positiveInteger,
  readJSON,
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

const envelopeFromRow = (spaceID, row) => ({
  schemaVersion: 1,
  spaceID,
  deviceID: row.author_device_id,
  changeID: row.change_id,
  authorSequence: Number(row.author_sequence),
  createdAtEpochMilliseconds: Number(row.created_at_ms),
  sealedPayload: row.sealed_payload,
});

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

const authenticateDevice = async (request, env, spaceID) => {
  const token = parseBearer(request);
  const tokenHash = await hashBytes(token);
  token.fill(0);
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
  await env.DB.prepare(
    "UPDATE sync_devices SET last_seen_at_ms = ?1 WHERE space_id = ?2 AND device_id = ?3",
  ).bind(Date.now(), spaceID, device.device_id).run();
  return {
    deviceID: String(device.device_id),
    isOwner: Number(device.is_owner) === 1,
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
        "INSERT INTO sync_spaces(space_id, created_at_ms) VALUES (?1, ?2)",
      ).bind(spaceID, now),
      env.DB.prepare(
        `INSERT INTO sync_devices(
           space_id, device_id, token_hash, created_at_ms, last_seen_at_ms, is_owner
         ) VALUES (?1, ?2, ?3, ?4, ?4, 1)`,
      ).bind(spaceID, deviceID, tokenHash, now),
    ]);
  } catch {
    throw new ProtocolError(409, "space_exists");
  }
  return emptySuccess(origin);
};

const createInvitation = async (request, env, origin, spaceID) => {
  const author = await authenticateDevice(request, env, spaceID);
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
  try {
    await env.DB.prepare(
      `INSERT INTO sync_invitations(
         space_id, invitation_id, token_hash, created_by_device_id, created_at_ms, expires_at_ms
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(spaceID, invitationID, tokenHash, author.deviceID, now, expiresAt).run();
  } catch {
    throw new ProtocolError(409, "invitation_exists");
  }
  return emptySuccess(origin);
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

  try {
    await env.DB.prepare(
      `INSERT INTO sync_devices(
         space_id, device_id, token_hash, created_at_ms, last_seen_at_ms, is_owner
       ) VALUES (?1, ?2, ?3, ?4, ?4, 0)
       ON CONFLICT(space_id, device_id) DO UPDATE SET
         last_seen_at_ms = excluded.last_seen_at_ms
       WHERE sync_devices.token_hash = excluded.token_hash
         AND sync_devices.revoked_at_ms IS NULL`,
    ).bind(spaceID, deviceID, deviceTokenHash, now).run();
  } catch {
    throw new ProtocolError(409, "device_identity_exists");
  }
  const device = await env.DB.prepare(
    `SELECT device_id FROM sync_devices
      WHERE space_id = ?1 AND device_id = ?2 AND token_hash = ?3 AND revoked_at_ms IS NULL`,
  ).bind(spaceID, deviceID, deviceTokenHash).first();
  if (!device) throw new ProtocolError(409, "device_identity_exists");
  const owner = await env.DB.prepare(
    `SELECT device_id
       FROM sync_devices
      WHERE space_id = ?1 AND is_owner = 1 AND revoked_at_ms IS NULL
      ORDER BY created_at_ms ASC, device_id ASC
      LIMIT 1`,
  ).bind(spaceID).first();
  if (!owner) throw new ProtocolError(409, "owner_unavailable");
  const ownerDeviceID = normalizeUUID(owner.device_id);
  const checkpointRows = await env.DB.prepare(
    `SELECT server_sequence, change_id, author_device_id, author_sequence,
            created_at_ms, sealed_payload, retention_class
       FROM sync_changes AS candidate
      WHERE candidate.space_id = ?1
        AND candidate.author_device_id = ?2
        AND candidate.retention_class IN ('profile-checkpoint', 'companion-checkpoint')
        AND candidate.server_sequence = (
          SELECT MAX(latest.server_sequence)
            FROM sync_changes AS latest
           WHERE latest.space_id = candidate.space_id
             AND latest.author_device_id = candidate.author_device_id
             AND latest.retention_class = candidate.retention_class
        )
      ORDER BY server_sequence ASC`,
  ).bind(spaceID, ownerDeviceID).all();
  const rows = checkpointRows.results || [];
  const hasCompleteBaseline = rows.length === 2
    && new Set(rows.map((row) => row.retention_class)).size === 2;
  let highWaterCursor = 0;
  let checkpoints = [];
  if (hasCompleteBaseline) {
    const highWater = await env.DB.prepare(
      "SELECT COALESCE(MAX(server_sequence), 0) AS value FROM sync_changes WHERE space_id = ?1",
    ).bind(spaceID).first();
    highWaterCursor = nonnegativeInteger(Number(highWater?.value || 0), "invalid_cursor");
    checkpoints = rows.map((row) => ({
      serverSequence: positiveInteger(Number(row.server_sequence), "invalid_cursor"),
      envelope: envelopeFromRow(spaceID, row),
    }));
  }
  return jsonResponse(200, {
    schemaVersion: 1,
    ownerDeviceID,
    highWaterCursor,
    checkpoints,
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
  const sealedPayload = standardBase64(
    body.sealedPayload,
    28,
    LIMITS.sealedPayloadBytes,
  );
  const retentionClass = body.retentionClass ?? "journal";
  if (!["journal", "profile-checkpoint", "companion-checkpoint"].includes(retentionClass)) {
    throw new ProtocolError(400, "invalid_retention_class");
  }
  if (retentionClass === "profile-checkpoint" && !author.isOwner) {
    throw new ProtocolError(403, "owner_authorization_required");
  }
  const now = Date.now();
  const insert = await env.DB.prepare(
    `INSERT OR IGNORE INTO sync_changes(
       space_id, change_id, author_device_id, author_sequence,
       created_at_ms, sealed_payload, stored_at_ms, retention_class
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    spaceID, changeID, deviceID, authorSequence, createdAt, sealedPayload, now, retentionClass,
  ).run();

  const stored = await env.DB.prepare(
    `SELECT server_sequence, change_id, author_device_id, author_sequence,
            created_at_ms, sealed_payload, retention_class
       FROM sync_changes
      WHERE space_id = ?1
        AND (change_id = ?2 OR (author_device_id = ?3 AND author_sequence = ?4))`,
  ).bind(spaceID, changeID, deviceID, authorSequence).first();
  const identical = stored
    && stored.change_id === changeID
    && stored.author_device_id === deviceID
    && Number(stored.author_sequence) === authorSequence
    && Number(stored.created_at_ms) === createdAt
    && stored.sealed_payload === sealedPayload
    && stored.retention_class === retentionClass;
  if (!identical) throw new ProtocolError(409, "change_conflict");
  if (!insert.success && !stored) throw new ProtocolError(503, "relay_unavailable");
  return jsonResponse(200, {
    schemaVersion: 1,
    serverSequence: Number(stored.server_sequence),
  }, origin);
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
  const changes = (result.results || []).map((row) => ({
    serverSequence: Number(row.server_sequence),
    envelope: envelopeFromRow(spaceID, row),
  }));
  return jsonResponse(200, { schemaVersion: 1, changes }, origin);
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

const revokeDevice = async (request, env, origin, spaceID, targetDeviceID) => {
  const author = await authenticateDevice(request, env, spaceID);
  if (!author.isOwner) throw new ProtocolError(403, "owner_authorization_required");
  if (author.deviceID === targetDeviceID) {
    throw new ProtocolError(400, "cannot_revoke_current_device");
  }
  const result = await env.DB.prepare(
    `UPDATE sync_devices SET revoked_at_ms = ?1
      WHERE space_id = ?2 AND device_id = ?3 AND revoked_at_ms IS NULL`,
  ).bind(Date.now(), spaceID, targetDeviceID).run();
  if (!result.meta?.changes) throw new ProtocolError(404, "device_not_found");
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
    if (request.method === "GET" && parts.length === 4 && parts[3] === "devices") {
      return listDevices(request, env, origin, spaceID);
    }
    if (
      request.method === "DELETE" && parts.length === 5 && parts[3] === "devices"
    ) {
      return revokeDevice(request, env, origin, spaceID, normalizeUUID(parts[4]));
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
    await env.DB.prepare(
      "DELETE FROM sync_invitations WHERE expires_at_ms < ?1",
    ).bind(Date.now() - 24 * 60 * 60 * 1000).run();
  },
};
