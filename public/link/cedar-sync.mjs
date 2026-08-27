export const LIMITS = Object.freeze({
  responseBytes: 8 * 1_024 * 1_024,
  sealedPayloadBytes: 1_064_960,
  changePayloadBytes: 1 * 1_024 * 1_024,
  snapshotEncodedBytes: 640 * 1_024,
  snapshotContentBytes: 4 * 1_024 * 1_024,
  snapshotJSONBytes: 6 * 1_024 * 1_024,
  credentialItemBytes: 64 * 1_024,
  credentialItemCount: 128,
  maximumFetch: 200,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const COMPRESSED_MAGIC = new Uint8Array([0x43, 0x53, 0x5a, 0x31]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class CedarSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CedarSyncError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new CedarSyncError(code, message);
};

const record = (value, message = "Cedar Sync returned invalid data.") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_json", message);
  return value;
};

const schemaOne = (value) => {
  if (value !== 1) fail("unsupported_schema", "This Cedar Sync version is not supported.");
};

const positiveInteger = (value, message = "Cedar Sync returned an invalid number.") => {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_number", message);
  return value;
};

const nonnegativeInteger = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_number", "The sync cursor is invalid.");
  return value;
};

export const normalizeUUID = (value) => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail("invalid_identifier", "Cedar Sync returned an invalid profile identity.");
  }
  return value.toLowerCase();
};

const boundedString = (value, maximumLength, message) => {
  if (typeof value !== "string" || value.length === 0 || [...value].length > maximumLength) {
    fail("invalid_text", message);
  }
  return value;
};

const identifier = (value, maximumLength) => {
  boundedString(value, maximumLength, "Cedar Sync returned an invalid entity identity.");
  if (![...value].every((character) => {
    const scalar = character.codePointAt(0);
    return scalar >= 0x21 && scalar <= 0x7e;
  })) {
    fail("invalid_identifier", "Cedar Sync returned an invalid entity identity.");
  }
  return value;
};

const bytesToBinary = (bytes) => {
  let value = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return value;
};

export const bytesToBase64 = (bytes) => btoa(bytesToBinary(bytes));

export const bytesToBase64URL = (bytes) => bytesToBase64(bytes)
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replaceAll("=", "");

export const base64URLToBytes = (value, expectedBytes = 32) => {
  if (typeof value !== "string" || !BASE64_URL_PATTERN.test(value)) {
    fail("invalid_key", "The protected browser key is invalid.");
  }
  const padding = "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    fail("invalid_key", "The protected browser key is invalid.");
  }
  if (expectedBytes !== null && binary.length !== expectedBytes) {
    fail("invalid_key", "The protected browser key has an invalid size.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const standardBase64ToBytes = (value, minimumBytes, maximumBytes) => {
  if (typeof value !== "string" || !STANDARD_BASE64_PATTERN.test(value)) {
    fail("invalid_base64", "Cedar Sync returned malformed encrypted data.");
  }
  const byteLength = value.endsWith("==")
    ? (value.length / 4) * 3 - 2
    : value.endsWith("=")
      ? (value.length / 4) * 3 - 1
      : (value.length / 4) * 3;
  if (!Number.isSafeInteger(byteLength) || byteLength < minimumBytes || byteLength > maximumBytes) {
    fail("invalid_size", "Cedar Sync returned data outside its safe size limit.");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    fail("invalid_base64", "Cedar Sync returned malformed encrypted data.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const parseJSONBytes = (bytes, message) => {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    fail("invalid_json", message);
  }
};

const parseJSONText = (text, message) => {
  try {
    return JSON.parse(text);
  } catch {
    fail("invalid_json", message);
  }
};

const hasCompressedMagic = (bytes) => bytes.length >= COMPRESSED_MAGIC.length
  && COMPRESSED_MAGIC.every((byte, index) => bytes[index] === byte);

const decompressBounded = async (bytes) => {
  if (typeof DecompressionStream !== "function") {
    fail("compression_unavailable", "This browser cannot open Cedar's compressed profile yet. Update iOS and try again.");
  }
  let stream;
  try {
    stream = new Blob([bytes.subarray(COMPRESSED_MAGIC.length)])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
  } catch {
    fail("invalid_compression", "The encrypted Cedar profile could not be decompressed.");
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.snapshotJSONBytes) {
        await reader.cancel();
        fail("expanded_too_large", "The encrypted Cedar profile expands beyond its safe limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CedarSyncError) throw error;
    fail("invalid_compression", "The encrypted Cedar profile could not be decompressed.");
  }
  if (total === 0) fail("invalid_compression", "The encrypted Cedar profile is empty.");
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const authenticatedData = (envelope) => encoder.encode(
  `cedar-sync-v1:${envelope.spaceID}:${envelope.deviceID}:${envelope.changeID}:${envelope.authorSequence}:${envelope.createdAtEpochMilliseconds}`,
);

const validateEnvelope = (value, expectedSpaceID) => {
  const envelope = record(value);
  schemaOne(envelope.schemaVersion);
  const normalized = {
    schemaVersion: 1,
    spaceID: normalizeUUID(envelope.spaceID),
    deviceID: normalizeUUID(envelope.deviceID),
    changeID: normalizeUUID(envelope.changeID),
    authorSequence: positiveInteger(envelope.authorSequence),
    createdAtEpochMilliseconds: positiveInteger(envelope.createdAtEpochMilliseconds),
    sealedPayload: standardBase64ToBytes(envelope.sealedPayload, 28, LIMITS.sealedPayloadBytes),
  };
  if (normalized.spaceID !== normalizeUUID(expectedSpaceID)) {
    normalized.sealedPayload.fill(0);
    fail("space_mismatch", "The encrypted profile belongs to another Cedar space.");
  }
  return normalized;
};

const validateChange = (value) => {
  const raw = record(value);
  schemaOne(raw.schemaVersion);
  const operation = boundedString(raw.operation, 16, "Cedar Sync returned an invalid operation.");
  if (operation !== "upsert" && operation !== "tombstone") {
    fail("invalid_operation", "Cedar Sync returned an invalid operation.");
  }
  const profileID = normalizeUUID(raw.profileID);
  const entityKind = identifier(raw.entityKind, 64);
  const entityID = identifier(raw.entityID, 512);
  const revision = positiveInteger(raw.revision);
  const modifiedAtEpochMilliseconds = positiveInteger(raw.modifiedAtEpochMilliseconds);
  const payload = standardBase64ToBytes(raw.payload, 0, LIMITS.changePayloadBytes);
  if (operation === "tombstone" && payload.length !== 0) {
    payload.fill(0);
    fail("invalid_tombstone", "Cedar Sync returned an invalid removal record.");
  }
  return {
    schemaVersion: 1,
    profileID,
    entityKind,
    entityID,
    operation,
    revision,
    modifiedAtEpochMilliseconds,
    payload,
  };
};

export const openEnvelope = async (value, credentials) => {
  const envelope = validateEnvelope(value, credentials.spaceID);
  const profileKey = base64URLToBytes(credentials.profileKey, 32);
  const nonce = envelope.sealedPayload.slice(0, 12);
  const ciphertext = envelope.sealedPayload.slice(12);
  let clear;
  try {
    const key = await crypto.subtle.importKey("raw", profileKey, "AES-GCM", false, ["decrypt"]);
    clear = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: nonce,
      additionalData: authenticatedData(envelope),
      tagLength: 128,
    }, key, ciphertext));
    return validateChange(parseJSONBytes(clear, "The encrypted Cedar change is invalid."));
  } catch (error) {
    if (error instanceof CedarSyncError) throw error;
    fail("authentication_failed", "The encrypted Cedar profile could not be authenticated.");
  } finally {
    profileKey.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    envelope.sealedPayload.fill(0);
    clear?.fill(0);
  }
};

const safeArray = (value) => Array.isArray(value) ? value : [];

const safeProfileSummary = (portable, snapshot) => {
  const root = record(portable, "The Cedar profile document is invalid.");
  const profile = record(root.profile, "The Cedar profile document is missing its profile.");
  const profileID = normalizeUUID(profile.id);
  if (profileID !== snapshot.profileID) {
    fail("profile_mismatch", "The encrypted Cedar profile identity changed.");
  }
  const name = boundedString(profile.name, 128, "The Cedar profile name is invalid.");
  let avatarSymbol = "person.crop.circle.fill";
  if (typeof profile.avatarSymbol === "string") {
    const trimmedAvatar = profile.avatarSymbol.trim();
    if (trimmedAvatar.length <= 128 && !trimmedAvatar.startsWith("data:")) {
      avatarSymbol = trimmedAvatar;
    } else if (trimmedAvatar.length <= 2_048) {
      try {
        const avatarURL = new URL(trimmedAvatar);
        if (avatarURL.protocol === "https:") avatarSymbol = avatarURL.href;
      } catch {
        // Unsupported avatar references use Cedar's local fallback.
      }
    }
  }
  const theme = ["system", "light", "dark", "cedarDay", "cedarNight", "highContrast"]
    .includes(profile.theme) ? profile.theme : "system";
  const sources = safeArray(root.sources);
  const homeBranches = safeArray(root.homeBranches);
  const homeShelves = safeArray(root.homeShelves);
  return {
    schemaVersion: 1,
    spaceID: snapshot.spaceID,
    profileID,
    name,
    avatarSymbol,
    theme,
    isKids: profile.isKids === true,
    requiresPIN: profile.requiresPIN === true,
    ratingLimit: Number.isSafeInteger(profile.ratingLimit) ? profile.ratingLimit : null,
    sourceCount: sources.length,
    enabledSourceCount: sources.filter((source) => source?.isEnabled === true).length,
    branchCount: homeBranches.length,
    enabledBranchCount: homeBranches.filter((branch) => branch?.isEnabled === true).length,
    shelfCount: homeShelves.length,
    syncedAt: snapshot.createdAtEpochMilliseconds,
  };
};

export const decodeProfileSnapshot = async (change, expectedSpaceID) => {
  if (change.entityKind !== "apple-profile-snapshot") return null;
  if (change.entityID.toLowerCase() !== change.profileID) {
    fail("profile_mismatch", "The encrypted Cedar profile identity changed.");
  }
  if (change.operation === "tombstone") return { removed: true, profileID: change.profileID };
  if (change.payload.length < 1 || change.payload.length > LIMITS.snapshotEncodedBytes) {
    fail("snapshot_too_large", "The encrypted Cedar profile is outside its safe size limit.");
  }
  const jsonBytes = hasCompressedMagic(change.payload)
    ? await decompressBounded(change.payload)
    : change.payload.slice();
  let profileData;
  try {
    const raw = record(parseJSONBytes(jsonBytes, "The encrypted Cedar profile is invalid."));
    schemaOne(raw.schemaVersion);
    const profileID = normalizeUUID(raw.profileID);
    if (profileID !== change.profileID) {
      fail("profile_mismatch", "The encrypted Cedar profile identity changed.");
    }
    const profileName = boundedString(raw.profileName, 128, "The Cedar profile name is invalid.");
    const createdAtEpochMilliseconds = positiveInteger(raw.createdAtEpochMilliseconds);
    profileData = standardBase64ToBytes(raw.profileData, 1, LIMITS.snapshotContentBytes);
    const items = Array.isArray(raw.items) ? raw.items : fail(
      "missing_credentials",
      "The encrypted Cedar profile is missing its credential bundle.",
    );
    if (items.length > LIMITS.credentialItemCount) {
      fail("too_many_credentials", "The encrypted Cedar profile has too many credential items.");
    }
    let totalBytes = profileData.length;
    const references = new Set();
    for (const itemValue of items) {
      const item = record(itemValue, "The encrypted Cedar credential bundle is invalid.");
      const reference = boundedString(item.reference, 512, "The encrypted Cedar credential reference is invalid.");
      if (references.has(reference)) {
        fail("duplicate_credentials", "The encrypted Cedar profile has duplicate credential items.");
      }
      references.add(reference);
      const secret = standardBase64ToBytes(item.data, 0, LIMITS.credentialItemBytes);
      totalBytes += secret.length;
      secret.fill(0);
      if (totalBytes > LIMITS.snapshotContentBytes) {
        fail("snapshot_too_large", "The encrypted Cedar profile is outside its safe size limit.");
      }
    }
    const snapshot = {
      spaceID: normalizeUUID(expectedSpaceID),
      profileID,
      profileName,
      createdAtEpochMilliseconds,
    };
    return safeProfileSummary(
      parseJSONBytes(profileData, "The Cedar profile document is invalid."),
      snapshot,
    );
  } finally {
    profileData?.fill(0);
    jsonBytes.fill(0);
    change.payload.fill(0);
  }
};

const readBoundedText = async (response, maximumBytes) => {
  const declared = Number(response.headers.get("Content-Length") || 0);
  if (declared > maximumBytes) fail("response_too_large", "The Cedar Sync response is too large.");
  if (!response.body) {
    const text = await response.text();
    if (encoder.encode(text).length > maximumBytes) {
      fail("response_too_large", "The Cedar Sync response is too large.");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      fail("response_too_large", "The Cedar Sync response is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return decoder.decode(bytes);
  } finally {
    bytes.fill(0);
  }
};

const fetchPage = async (credentials, after) => {
  nonnegativeInteger(after);
  const relay = new URL(credentials.relayBaseURL);
  relay.pathname = `${relay.pathname.replace(/\/$/, "")}/v1/spaces/${normalizeUUID(credentials.spaceID)}/changes`;
  relay.search = new URLSearchParams({ after: String(after), limit: String(LIMITS.maximumFetch) }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(relay, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.deviceToken}`,
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") fail("timeout", "Cedar Sync took too long to respond.");
    fail("network", "Cedar Sync could not reach the encrypted relay.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      fail("authorization", "This browser's Cedar Link access is no longer valid. Create a new link on iPhone.");
    }
    fail("relay_rejected", `Cedar Sync could not load this profile (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    fail("invalid_content_type", "Cedar Sync returned an unexpected response.");
  }
  const root = record(parseJSONText(
    await readBoundedText(response, LIMITS.responseBytes),
    "Cedar Sync returned an invalid response.",
  ));
  schemaOne(root.schemaVersion);
  if (!Array.isArray(root.changes) || root.changes.length > LIMITS.maximumFetch) {
    fail("invalid_changes", "Cedar Sync returned an invalid change list.");
  }
  return root.changes;
};

export const fetchLatestProfile = async (credentials, startingCursor = 0) => {
  let cursor = nonnegativeInteger(startingCursor);
  let profile = null;
  let sawChanges = false;
  for (let page = 0; page < 10; page += 1) {
    const values = await fetchPage(credentials, cursor);
    for (const value of values) {
      const item = record(value);
      const serverSequence = positiveInteger(item.serverSequence, "Cedar Sync returned an invalid cursor.");
      if (serverSequence <= cursor) fail("cursor_backwards", "The Cedar Sync cursor moved backwards.");
      const change = await openEnvelope(item.envelope, credentials);
      const decoded = await decodeProfileSnapshot(change, credentials.spaceID);
      if (decoded?.removed) profile = null;
      else if (decoded) profile = decoded;
      else change.payload.fill(0);
      cursor = serverSequence;
      sawChanges = true;
    }
    if (values.length < LIMITS.maximumFetch) return { cursor, profile, sawChanges };
  }
  fail("too_many_changes", "Cedar Sync has too many pending changes. Refresh and try again.");
};
