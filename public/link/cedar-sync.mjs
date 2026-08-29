import { inflateSync } from "./vendor/fflate-inflate.mjs?v=0.8.3";

export const LIMITS = Object.freeze({
  responseBytes: 8 * 1_024 * 1_024,
  sealedPayloadBytes: 1_064_960,
  changePayloadBytes: 1 * 1_024 * 1_024,
  snapshotEncodedBytes: 640 * 1_024,
  snapshotContentBytes: 4 * 1_024 * 1_024,
  snapshotJSONBytes: 6 * 1_024 * 1_024,
  credentialItemBytes: 64 * 1_024,
  credentialItemCount: 128,
  presentationPatchBytes: 16 * 1_024,
  companionDocumentBytes: 256 * 1_024,
  companionCommandBytes: 8 * 1_024,
  maximumFetch: 200,
  fetchPage: 5,
  maximumCatchUp: 2_000,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const COMPRESSED_MAGIC = new Uint8Array([0x43, 0x53, 0x5a, 0x31]);
const PROFILE_THEMES = new Set(["system", "light", "dark", "cedarDay", "cedarNight", "highContrast"]);
const TOP_SHELF_PRESENTATIONS = new Set(["automatic", "continue-watching", "featured"]);
const BRANCH_PRESETS = new Set([
  "continue-watching", "favorites", "watchlist", "trending", "popular", "top-rated", "coming-soon",
]);
const COMPANION_PLATFORMS = new Set(["apple", "android", "browser"]);
const REMOTE_COMMANDS = new Set([
  "status", "toggle-playback", "skip-backward", "skip-forward", "skip-intro", "next-episode", "jump-to-live",
]);
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

const normalizedProfileName = (value) => {
  boundedString(value, 128, "The Cedar profile name is invalid.");
  if (value.trim() !== value) fail("invalid_text", "The Cedar profile name is invalid.");
  return value;
};

const avatarReference = (value) => {
  boundedString(value, 2_048, "The Cedar profile avatar is invalid.");
  if (value.startsWith("data:")) fail("invalid_avatar", "Embedded profile images cannot be edited in a browser.");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      fail("invalid_avatar", "The Cedar profile avatar is invalid.");
    }
    return url.href;
  } catch (error) {
    if (error instanceof CedarSyncError) throw error;
    if (value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
      fail("invalid_avatar", "The Cedar profile avatar is invalid.");
    }
    return value;
  }
};

const badgeSelectionReference = (value) => {
  if (value === "none" || value === "builtIn") return value;
  boundedString(value, 2_048, "The Cedar badge selection is invalid.");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      fail("invalid_badges", "The Cedar badge selection is invalid.");
    }
    return url.href;
  } catch (error) {
    if (error instanceof CedarSyncError) throw error;
    fail("invalid_badges", "The Cedar badge selection is invalid.");
  }
};

export const validateProfilePresentation = (value) => {
  const presentation = record(value, "The Cedar profile presentation is invalid.");
  const theme = boundedString(presentation.theme, 32, "The Cedar profile appearance is invalid.");
  if (!PROFILE_THEMES.has(theme)) fail("invalid_theme", "The Cedar profile appearance is invalid.");
  return {
    name: normalizedProfileName(presentation.name),
    avatarSymbol: avatarReference(presentation.avatarSymbol),
    theme,
    badgeSelection: badgeSelectionReference(presentation.badgeSelection ?? "builtIn"),
  };
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

const normalizedWebRelay = (value) => {
  let relay;
  try {
    relay = new URL(value);
  } catch {
    fail("invalid_relay", "The Cedar Link relay is invalid.");
  }
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash) {
    fail("invalid_relay", "The Cedar Link relay is invalid.");
  }
  relay.pathname = relay.pathname.replace(/\/$/, "");
  return relay.href.replace(/\/$/, "");
};

export const parseWebInvitationFragment = (fragment, now = Date.now()) => {
  if (typeof fragment !== "string" || fragment.length <= 1 || fragment.length > 2_048) return null;
  const values = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  const allowed = new Set(["v", "scope", "relay", "space", "owner", "invitation", "enrollment", "key", "expires"]);
  for (const field of values.keys()) {
    if (!allowed.has(field)) fail("unknown_field", "The Cedar Link invitation contains an unknown field.");
  }
  if (values.get("v") !== "1") fail("unsupported_schema", "This Cedar Link invitation is not supported.");
  if (values.has("scope") && values.get("scope") !== "companion") {
    fail("unsupported_scope", "This Cedar Link invitation has an unsupported scope.");
  }
  const expiresAt = Number(values.get("expires"));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    fail("expired_invitation", "This Cedar Link invitation has expired.");
  }
  return {
    relayBaseURL: normalizedWebRelay(values.get("relay")),
    spaceID: normalizeUUID(values.get("space")),
    ownerDeviceID: values.has("owner") ? normalizeUUID(values.get("owner")) : null,
    invitationID: normalizeUUID(values.get("invitation")),
    enrollmentToken: base64URLToBytes(values.get("enrollment"), 32),
    profileKey: base64URLToBytes(values.get("key"), 32),
    expiresAt,
  };
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

const decompressFormatBounded = async (bytes, format) => {
  let stream;
  try {
    stream = new Blob([bytes.subarray(COMPRESSED_MAGIC.length)])
      .stream()
      .pipeThrough(new DecompressionStream(format));
  } catch {
    return null;
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
    return null;
  }
  if (total === 0) return null;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const decompressBounded = async (bytes) => {
  // Apple's Compression framework names this COMPRESSION_ZLIB but emits an RFC 1951 raw
  // DEFLATE stream. Keep wrapped DEFLATE as a compatibility fallback for older test clients.
  if (typeof DecompressionStream === "function") {
    for (const format of ["deflate-raw", "deflate"]) {
      const output = await decompressFormatBounded(bytes, format);
      if (output) return output;
    }
  }
  const target = new Uint8Array(LIMITS.snapshotJSONBytes + 1);
  try {
    const output = inflateSync(bytes.subarray(COMPRESSED_MAGIC.length), { out: target });
    if (output.length > LIMITS.snapshotJSONBytes) {
      target.fill(0);
      fail("expanded_too_large", "The encrypted Cedar profile expands beyond its safe limit.");
    }
    if (output.length > 0) return output;
  } catch (error) {
    target.fill(0);
    if (error instanceof CedarSyncError) throw error;
  }
  fail("invalid_compression", "The encrypted Cedar profile could not be decompressed.");
};

const authenticatedData = (envelope) => encoder.encode(
  `cedar-sync-v1:${envelope.spaceID}:${envelope.deviceID}:${envelope.changeID}:${envelope.authorSequence}:${envelope.createdAtEpochMilliseconds}`,
);

const wireChange = (change) => ({
  schemaVersion: 1,
  profileID: change.profileID,
  entityKind: change.entityKind,
  entityID: change.entityID,
  operation: change.operation,
  revision: change.revision,
  modifiedAtEpochMilliseconds: change.modifiedAtEpochMilliseconds,
  payload: bytesToBase64(change.payload),
});

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

export const sealEnvelope = async (
  value,
  credentials,
  authorSequence,
  {
    changeID = crypto.randomUUID().toLowerCase(),
    createdAtEpochMilliseconds = Date.now(),
    nonce = crypto.getRandomValues(new Uint8Array(12)),
  } = {},
) => {
  const change = validateChange(wireChange(value));
  const envelope = {
    schemaVersion: 1,
    spaceID: normalizeUUID(credentials.spaceID),
    deviceID: normalizeUUID(credentials.deviceID),
    changeID: normalizeUUID(changeID),
    authorSequence: positiveInteger(authorSequence),
    createdAtEpochMilliseconds: positiveInteger(createdAtEpochMilliseconds),
  };
  const profileKey = base64URLToBytes(credentials.profileKey, 32);
  const initializationVector = new Uint8Array(nonce);
  if (initializationVector.length !== 12) fail("invalid_nonce", "The browser encryption nonce is invalid.");
  const clear = encoder.encode(JSON.stringify(wireChange(change)));
  let encrypted;
  try {
    const key = await crypto.subtle.importKey("raw", profileKey, "AES-GCM", false, ["encrypt"]);
    encrypted = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: initializationVector,
      additionalData: authenticatedData(envelope),
      tagLength: 128,
    }, key, clear));
    const combined = new Uint8Array(initializationVector.length + encrypted.length);
    combined.set(initializationVector);
    combined.set(encrypted, initializationVector.length);
    const sealedPayload = bytesToBase64(combined);
    combined.fill(0);
    return { ...envelope, sealedPayload };
  } finally {
    profileKey.fill(0);
    initializationVector.fill(0);
    clear.fill(0);
    encrypted?.fill(0);
    change.payload.fill(0);
    value.payload?.fill?.(0);
  }
};

export const createProfilePresentationPatchChange = (
  profile,
  replacementValue,
  authorSequence,
  createdAtEpochMilliseconds = Date.now(),
) => {
  const profileID = normalizeUUID(profile.profileID);
  const baseRevision = positiveInteger(profile.snapshotRevision, "The browser needs a fresh Cedar profile before editing.");
  const base = validateProfilePresentation(profile);
  const replacement = validateProfilePresentation(replacementValue);
  if (JSON.stringify(base) === JSON.stringify(replacement)) {
    fail("no_changes", "Make a profile change before saving.");
  }
  const patch = {
    schemaVersion: 1,
    profileID,
    baseRevision,
    createdAtEpochMilliseconds: positiveInteger(createdAtEpochMilliseconds),
    base,
    replacement,
  };
  const payload = encoder.encode(JSON.stringify(patch));
  if (payload.length > LIMITS.presentationPatchBytes) {
    payload.fill(0);
    fail("patch_too_large", "The browser profile edit is too large.");
  }
  const change = validateChange({
    schemaVersion: 1,
    profileID,
    entityKind: "browser-profile-presentation",
    entityID: profileID,
    operation: "upsert",
    revision: positiveInteger(authorSequence),
    modifiedAtEpochMilliseconds: patch.createdAtEpochMilliseconds,
    payload: bytesToBase64(payload),
  });
  payload.fill(0);
  return change;
};

const booleanValue = (value, message) => {
  if (typeof value !== "boolean") fail("invalid_boolean", message);
  return value;
};

export const validateCompanionSettings = (value) => {
  const settings = record(value, "The Cedar companion settings are invalid.");
  const metadataLanguageCode = boundedString(
    settings.metadataLanguageCode,
    35,
    "The metadata language is invalid.",
  );
  if (!/^[A-Za-z0-9]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(metadataLanguageCode)) {
    fail("invalid_language", "The metadata language is invalid.");
  }
  const topShelfPresentation = boundedString(
    settings.topShelfPresentation,
    32,
    "The top shelf presentation is invalid.",
  );
  if (!TOP_SHELF_PRESENTATIONS.has(topShelfPresentation)) {
    fail("invalid_top_shelf", "The top shelf presentation is invalid.");
  }
  return {
    metadataLanguageCode,
    automaticallyPlayBestSource: booleanValue(settings.automaticallyPlayBestSource, "The source preference is invalid."),
    automaticallyTryNextBestSource: booleanValue(settings.automaticallyTryNextBestSource, "The source preference is invalid."),
    quickPlayFromPosters: booleanValue(settings.quickPlayFromPosters, "The source preference is invalid."),
    hideUnreleasedTitles: booleanValue(settings.hideUnreleasedTitles, "The discovery preference is invalid."),
    showsPosterCardRatings: booleanValue(settings.showsPosterCardRatings, "The poster preference is invalid."),
    topShelfPresentation,
    showsTopShelfViewingActivity: booleanValue(settings.showsTopShelfViewingActivity, "The top shelf preference is invalid."),
    cleansUpLiveChannelNames: booleanValue(settings.cleansUpLiveChannelNames, "The Live TV preference is invalid."),
  };
};

const validateCompanionBranch = (value, expectedPosition) => {
  const branch = record(value, "A Cedar Home branch is invalid.");
  const title = boundedString(branch.title, 80, "A Cedar Home branch title is invalid.");
  if (title.trim() !== title) fail("invalid_branch", "A Cedar Home branch title is invalid.");
  if (branch.position !== expectedPosition) fail("invalid_branch_order", "The Cedar Home branch order is invalid.");
  const preset = branch.preset == null
    ? null
    : boundedString(branch.preset, 32, "The Cedar Home branch preset is invalid.");
  if (preset !== null && !BRANCH_PRESETS.has(preset)) {
    fail("invalid_branch_preset", "The Cedar Home branch preset is invalid.");
  }
  return {
    id: identifier(branch.id, 128),
    title,
    position: expectedPosition,
    isEnabled: booleanValue(branch.isEnabled, "The Cedar Home branch state is invalid."),
    preset,
    sourceKind: identifier(branch.sourceKind ?? "catalog", 64),
    presentationKind: identifier(branch.presentationKind ?? "row", 64),
  };
};

export const validateCompanionConfiguration = (value) => {
  const configuration = record(value, "The Cedar companion configuration is invalid.");
  const rawBranches = Array.isArray(configuration.branches)
    ? configuration.branches
    : fail("invalid_branches", "The Cedar Home branch list is invalid.");
  if (rawBranches.length > 50) fail("too_many_branches", "The Cedar profile has too many Home branches.");
  const branches = rawBranches.map(validateCompanionBranch);
  if (new Set(branches.map((branch) => branch.id)).size !== branches.length) {
    fail("duplicate_branches", "The Cedar profile contains duplicate Home branches.");
  }
  return {
    presentation: validateProfilePresentation(configuration.presentation),
    settings: validateCompanionSettings(configuration.settings),
    branches,
  };
};

const validateCompanionDevice = (value) => {
  const device = record(value, "A linked Cedar device is invalid.");
  const platform = boundedString(device.platform, 16, "A linked Cedar platform is invalid.");
  if (!COMPANION_PLATFORMS.has(platform)) fail("invalid_platform", "A linked Cedar platform is invalid.");
  const linkedAtEpochMilliseconds = positiveInteger(device.linkedAtEpochMilliseconds);
  const lastSeenAtEpochMilliseconds = positiveInteger(device.lastSeenAtEpochMilliseconds);
  if (lastSeenAtEpochMilliseconds < linkedAtEpochMilliseconds) {
    fail("invalid_device_time", "A linked Cedar device timestamp is invalid.");
  }
  const displayName = boundedString(device.displayName, 80, "A linked Cedar device name is invalid.");
  if (displayName.trim() !== displayName) fail("invalid_device_name", "A linked Cedar device name is invalid.");
  return {
    id: normalizeUUID(device.id),
    displayName,
    platform,
    linkedAtEpochMilliseconds,
    lastSeenAtEpochMilliseconds,
    isCurrent: booleanValue(device.isCurrent, "A linked Cedar device state is invalid."),
    supportsRemoteControl: booleanValue(device.supportsRemoteControl, "A linked Cedar device state is invalid."),
  };
};

const validateRemoteStatus = (value) => {
  const status = record(value, "A Cedar remote status is invalid.");
  if (!Array.isArray(status.supportedCommands) || status.supportedCommands.length === 0) {
    fail("invalid_remote_commands", "A Cedar remote status is invalid.");
  }
  const supportedCommands = status.supportedCommands.map((command) => {
    if (!REMOTE_COMMANDS.has(command)) fail("invalid_remote_command", "A Cedar remote command is invalid.");
    return command;
  });
  if (new Set(supportedCommands).size !== supportedCommands.length) {
    fail("duplicate_remote_commands", "A Cedar remote status is invalid.");
  }
  return {
    deviceID: normalizeUUID(status.deviceID),
    isOnline: booleanValue(status.isOnline, "A Cedar remote status is invalid."),
    isPlaying: booleanValue(status.isPlaying, "A Cedar remote status is invalid."),
    isLive: booleanValue(status.isLive, "A Cedar remote status is invalid."),
    supportedCommands,
    updatedAtEpochMilliseconds: positiveInteger(status.updatedAtEpochMilliseconds),
  };
};

export const decodeCompanionSnapshot = (change, expectedSpaceID) => {
  if (change.entityKind !== "cedar-companion-snapshot") return null;
  if (change.entityID.toLowerCase() !== change.profileID) {
    fail("profile_mismatch", "The encrypted Cedar companion identity changed.");
  }
  if (change.operation === "tombstone") return { removed: true, profileID: change.profileID };
  if (change.payload.length < 1 || change.payload.length > LIMITS.companionDocumentBytes) {
    fail("companion_too_large", "The encrypted Cedar companion document is outside its safe size limit.");
  }
  try {
    const raw = record(parseJSONBytes(change.payload, "The encrypted Cedar companion document is invalid."));
    schemaOne(raw.schemaVersion);
    const profileID = normalizeUUID(raw.profileID);
    if (profileID !== change.profileID) fail("profile_mismatch", "The encrypted Cedar companion identity changed.");
    const revision = positiveInteger(raw.revision);
    if (revision !== change.revision) fail("revision_mismatch", "The encrypted Cedar companion revision changed.");
    const devices = Array.isArray(raw.devices) ? raw.devices.map(validateCompanionDevice) : fail(
      "invalid_devices",
      "The linked Cedar device list is invalid.",
    );
    if (devices.length > 50 || new Set(devices.map((device) => device.id)).size !== devices.length) {
      fail("invalid_devices", "The linked Cedar device list is invalid.");
    }
    const remoteStatuses = Array.isArray(raw.remoteStatuses)
      ? raw.remoteStatuses.map(validateRemoteStatus)
      : fail("invalid_remote_statuses", "The Cedar remote state is invalid.");
    const deviceIDs = new Set(devices.map((device) => device.id));
    if (new Set(remoteStatuses.map((status) => status.deviceID)).size !== remoteStatuses.length
      || remoteStatuses.some((status) => !deviceIDs.has(status.deviceID))) {
      fail("invalid_remote_statuses", "The Cedar remote state is invalid.");
    }
    return {
      schemaVersion: 1,
      spaceID: normalizeUUID(expectedSpaceID),
      profileID,
      revision,
      publishedAtEpochMilliseconds: positiveInteger(raw.publishedAtEpochMilliseconds),
      configuration: validateCompanionConfiguration(raw.configuration),
      devices,
      remoteStatuses,
    };
  } finally {
    change.payload.fill(0);
  }
};

const createCompanionChange = (profileIDValue, entityKind, entityID, document, authorSequence, maximumBytes) => {
  const profileID = normalizeUUID(profileIDValue);
  const createdAtEpochMilliseconds = positiveInteger(document.createdAtEpochMilliseconds);
  const payload = encoder.encode(JSON.stringify(document));
  if (payload.length > maximumBytes) {
    payload.fill(0);
    fail("command_too_large", "The Cedar Link request is too large.");
  }
  const change = validateChange({
    schemaVersion: 1,
    profileID,
    entityKind,
    entityID,
    operation: "upsert",
    revision: positiveInteger(authorSequence),
    modifiedAtEpochMilliseconds: createdAtEpochMilliseconds,
    payload: bytesToBase64(payload),
  });
  payload.fill(0);
  return change;
};

export const createCompanionConfigurationPatchChange = (
  companion,
  replacementValue,
  authorSequence,
  createdAtEpochMilliseconds = Date.now(),
) => {
  const profileID = normalizeUUID(companion.profileID);
  const baseRevision = positiveInteger(companion.revision, "Refresh Cedar Link before editing this profile.");
  const base = validateCompanionConfiguration(companion.configuration);
  const replacement = validateCompanionConfiguration(replacementValue);
  if (JSON.stringify(base) === JSON.stringify(replacement)) {
    fail("no_changes", "Make a configuration change before saving.");
  }
  // Removing branches remotely is intentionally not supported. Disable a row instead.
  const replacementIDs = new Set(replacement.branches.map((branch) => branch.id));
  if (base.branches.some((branch) => !replacementIDs.has(branch.id))) {
    fail("branch_removal", "Cedar Link can hide a Home branch but cannot delete it.");
  }
  const baseIDs = new Set(base.branches.map((branch) => branch.id));
  for (const branch of replacement.branches) {
    if (!baseIDs.has(branch.id) && !BRANCH_PRESETS.has(branch.preset)) {
      fail("invalid_branch_preset", "New Home branches must use a Cedar preset.");
    }
  }
  return createCompanionChange(profileID, "browser-companion-configuration", profileID, {
    schemaVersion: 1,
    profileID,
    baseRevision,
    createdAtEpochMilliseconds: positiveInteger(createdAtEpochMilliseconds),
    base,
    replacement,
  }, authorSequence, LIMITS.companionDocumentBytes);
};

export const createRemoteCommandChange = (
  companion,
  targetDeviceID,
  command,
  authorSequence,
  createdAtEpochMilliseconds = Date.now(),
) => {
  if (!REMOTE_COMMANDS.has(command)) fail("invalid_remote_command", "That Cedar remote command is not supported.");
  const requestID = crypto.randomUUID().toLowerCase();
  return createCompanionChange(companion.profileID, "browser-remote-command", requestID, {
    schemaVersion: 1,
    requestID,
    profileID: normalizeUUID(companion.profileID),
    targetDeviceID: normalizeUUID(targetDeviceID),
    command,
    createdAtEpochMilliseconds: positiveInteger(createdAtEpochMilliseconds),
    expiresAtEpochMilliseconds: createdAtEpochMilliseconds + 60_000,
  }, authorSequence, LIMITS.companionCommandBytes);
};

export const createDeviceRequestChange = (
  companion,
  targetDeviceID,
  action,
  authorSequence,
  { displayName = null, createdAtEpochMilliseconds = Date.now() } = {},
) => {
  if (action !== "rename" && action !== "revoke") fail("invalid_device_action", "That device action is not supported.");
  if ((action === "rename") !== (displayName !== null)) fail("invalid_device_name", "A new device name is required.");
  if (displayName !== null && (displayName.trim() !== displayName || !displayName || [...displayName].length > 80)) {
    fail("invalid_device_name", "The linked Cedar device name is invalid.");
  }
  const requestID = crypto.randomUUID().toLowerCase();
  return createCompanionChange(companion.profileID, "browser-device-action", requestID, {
    schemaVersion: 1,
    requestID,
    profileID: normalizeUUID(companion.profileID),
    targetDeviceID: normalizeUUID(targetDeviceID),
    action,
    displayName,
    createdAtEpochMilliseconds: positiveInteger(createdAtEpochMilliseconds),
    expiresAtEpochMilliseconds: createdAtEpochMilliseconds + 10 * 60_000,
  }, authorSequence, LIMITS.companionCommandBytes);
};

const safeArray = (value) => Array.isArray(value) ? value : [];

const decodedConfigurationPayload = (configuration, key) => {
  const entry = safeArray(configuration).find((value) => value?.key === key);
  if (typeof entry?.payload !== "string") return null;
  let bytes;
  try {
    bytes = standardBase64ToBytes(entry.payload, 1, 2 * 1_024 * 1_024);
    return parseJSONBytes(bytes, "The Cedar profile configuration is invalid.");
  } catch {
    return null;
  } finally {
    bytes?.fill(0);
  }
};

const safeBadgeState = (configuration) => {
  const rawPacks = decodedConfigurationPayload(configuration, "addons.badgePacks");
  const installedBadgePacks = [];
  for (const value of safeArray(rawPacks).slice(0, 10)) {
    try {
      const id = normalizeUUID(value?.id);
      const sourceURL = badgeSelectionReference(value?.sourceURL);
      if (sourceURL === "none" || sourceURL === "builtIn") continue;
      const packName = typeof value?.pack?.name === "string"
        && value.pack.name.trim()
        && [...value.pack.name.trim()].length <= 128
        ? value.pack.name.trim()
        : new URL(sourceURL).hostname;
      installedBadgePacks.push({ id, name: packName, sourceURL });
    } catch {
      // One invalid installed pack must not hide the rest of the linked profile.
    }
  }

  const storedSelection = decodedConfigurationPayload(configuration, "addons.badgeSelection");
  let badgeSelection = "builtIn";
  if (storedSelection === "none" || storedSelection === "builtIn") {
    badgeSelection = storedSelection;
  } else if (typeof storedSelection === "string" && storedSelection.startsWith("custom:")) {
    try {
      const selectedID = normalizeUUID(storedSelection.slice("custom:".length));
      badgeSelection = installedBadgePacks.find((pack) => pack.id === selectedID)?.sourceURL
        ?? "builtIn";
    } catch {
      // Cedar itself falls back to the built-in pack when the stored custom pack is missing.
    }
  }
  return { badgeSelection, installedBadgePacks };
};

const safeProfileSummary = (portable, snapshot) => {
  const root = record(portable, "The Cedar profile document is invalid.");
  const profile = record(root.profile, "The Cedar profile document is missing its profile.");
  const profileID = normalizeUUID(profile.id);
  if (profileID !== snapshot.profileID) {
    fail("profile_mismatch", "The encrypted Cedar profile identity changed.");
  }
  const name = boundedString(profile.name, 128, "The Cedar profile name is invalid.");
  let avatarSymbol = "person.crop.circle.fill";
  let avatarEditable = false;
  if (typeof profile.avatarSymbol === "string") {
    const trimmedAvatar = profile.avatarSymbol.trim();
    if (trimmedAvatar.length <= 128 && !trimmedAvatar.startsWith("data:")) {
      avatarSymbol = trimmedAvatar;
      avatarEditable = true;
    } else if (trimmedAvatar.length <= 2_048) {
      try {
        const avatarURL = new URL(trimmedAvatar);
        if (avatarURL.protocol === "https:") {
          avatarSymbol = avatarURL.href;
          avatarEditable = true;
        }
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
  const badgeState = safeBadgeState(root.configuration);
  return {
    schemaVersion: 1,
    spaceID: snapshot.spaceID,
    profileID,
    name,
    avatarSymbol,
    avatarEditable,
    theme,
    ...badgeState,
    isKids: profile.isKids === true,
    requiresPIN: profile.requiresPIN === true,
    ratingLimit: Number.isSafeInteger(profile.ratingLimit) ? profile.ratingLimit : null,
    sourceCount: sources.length,
    enabledSourceCount: sources.filter((source) => source?.isEnabled === true).length,
    branchCount: homeBranches.length,
    enabledBranchCount: homeBranches.filter((branch) => branch?.isEnabled === true).length,
    shelfCount: homeShelves.length,
    snapshotRevision: snapshot.snapshotRevision,
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
      snapshotRevision: change.revision,
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
  relay.search = new URLSearchParams({ after: String(after), limit: String(LIMITS.fetchPage) }).toString();
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
  if (!Array.isArray(root.changes) || root.changes.length > LIMITS.fetchPage) {
    fail("invalid_changes", "Cedar Sync returned an invalid change list.");
  }
  return root.changes;
};

export const uploadEnvelope = async (credentials, envelope) => {
  const relay = new URL(credentials.relayBaseURL);
  relay.pathname = `${relay.pathname.replace(/\/$/, "")}/v1/spaces/${normalizeUUID(credentials.spaceID)}/changes`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(relay, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
  } catch (error) {
    if (error?.name === "AbortError") fail("timeout", "Cedar Sync took too long to save the edit.");
    fail("network", "Cedar Sync could not reach the encrypted relay.");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      fail("authorization", "This browser's Cedar Link access is no longer valid. Create a new link on iPhone.");
    }
    fail("relay_rejected", `Cedar Sync could not save this edit (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    fail("invalid_content_type", "Cedar Sync returned an unexpected save response.");
  }
  const root = record(parseJSONText(
    await readBoundedText(response, 64 * 1_024),
    "Cedar Sync returned an invalid save response.",
  ));
  schemaOne(root.schemaVersion);
  return positiveInteger(root.serverSequence, "Cedar Sync returned an invalid save cursor.");
};

export const createWebInvitation = async (
  credentials,
  linkPageURL = window.location.href,
  createdAtEpochMilliseconds = Date.now(),
) => {
  const invitationID = crypto.randomUUID().toLowerCase();
  const enrollmentToken = crypto.getRandomValues(new Uint8Array(32));
  const profileKey = base64URLToBytes(credentials.profileKey, 32);
  const expiresAtEpochMilliseconds = positiveInteger(createdAtEpochMilliseconds) + 10 * 60_000;
  const relay = new URL(credentials.relayBaseURL);
  relay.pathname = `${relay.pathname.replace(/\/$/, "")}/v1/spaces/${normalizeUUID(credentials.spaceID)}/invitations`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const enrollmentTokenHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enrollmentToken));
    const response = await fetch(relay, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        invitationID,
        enrollmentTokenHash: bytesToBase64(enrollmentTokenHash),
        expiresAtEpochMilliseconds,
      }),
    });
    enrollmentTokenHash.fill(0);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        fail("authorization", "This browser can no longer create Cedar Link invitations.");
      }
      fail("relay_rejected", `Cedar Sync could not create the invitation (HTTP ${response.status}).`);
    }
    const target = new URL(linkPageURL);
    target.search = "";
    target.hash = new URLSearchParams({
      v: "1",
      scope: "companion",
      relay: credentials.relayBaseURL,
      space: normalizeUUID(credentials.spaceID),
      invitation: invitationID,
      enrollment: bytesToBase64URL(enrollmentToken),
      key: bytesToBase64URL(profileKey),
      expires: String(expiresAtEpochMilliseconds),
    }).toString();
    return { url: target.href, expiresAtEpochMilliseconds };
  } catch (error) {
    if (error instanceof CedarSyncError) throw error;
    if (error?.name === "AbortError") fail("timeout", "Cedar Sync took too long to create the invitation.");
    fail("network", "Cedar Sync could not create the invitation.");
  } finally {
    clearTimeout(timeout);
    enrollmentToken.fill(0);
    profileKey.fill(0);
  }
};

export const fetchLatestProfile = async (credentials, startingCursor = 0) => {
  let cursor = nonnegativeInteger(startingCursor);
  let profile = null;
  let companion = null;
  let sawChanges = false;
  const maximumPages = Math.ceil(LIMITS.maximumCatchUp / LIMITS.fetchPage);
  for (let page = 0; page < maximumPages; page += 1) {
    const values = await fetchPage(credentials, cursor);
    for (const value of values) {
      const item = record(value);
      const serverSequence = positiveInteger(item.serverSequence, "Cedar Sync returned an invalid cursor.");
      if (serverSequence <= cursor) fail("cursor_backwards", "The Cedar Sync cursor moved backwards.");
      let change;
      try {
        change = await openEnvelope(item.envelope, credentials);
      } catch (error) {
        if (!(error instanceof CedarSyncError) || error.code !== "authentication_failed") throw error;
        // The relay journal intentionally mixes owner-only profile checkpoints with companion-key
        // changes. A browser cannot authenticate the former and must advance past them, while any
        // authenticated but malformed envelope continues to fail closed below.
        cursor = serverSequence;
        sawChanges = true;
        continue;
      }
      const decodedCompanion = decodeCompanionSnapshot(change, credentials.spaceID);
      if (decodedCompanion?.removed) companion = null;
      else if (decodedCompanion) companion = decodedCompanion;
      else {
        const decoded = await decodeProfileSnapshot(change, credentials.spaceID);
        if (decoded?.removed) profile = null;
        else if (decoded) profile = decoded;
        else change.payload.fill(0);
      }
      cursor = serverSequence;
      sawChanges = true;
    }
    if (values.length < LIMITS.fetchPage) return { cursor, profile, companion, sawChanges };
  }
  fail("too_many_changes", "Cedar Sync has too many pending changes. Refresh and try again.");
};
