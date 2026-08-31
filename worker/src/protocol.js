export const LIMITS = Object.freeze({
  requestBytes: 1_500_000,
  sealedPayloadBytes: 1_064_960,
  companionCheckpointBytes: 96 * 1_024,
  tokenBytes: 32,
  maximumFetch: 200,
  maximumDevices: 50,
  maximumInvitations: 64,
  maximumJournalChanges: 1_900,
  maximumJournalEncodedCharacters: 32 * 1_024 * 1_024,
  invitationLifetimeMs: 10 * 60 * 1000,
  deletionReceiptLifetimeMs: 30 * 24 * 60 * 60 * 1000,
});

export const RETENTION_CLASSES = Object.freeze({
  journal: "journal",
  profileCheckpoint: "profile-checkpoint",
  companionCheckpoint: "companion-checkpoint",
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ProtocolError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const normalizeUUID = (value) => {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ProtocolError(400, "invalid_identifier");
  }
  return value.toLowerCase();
};

export const positiveInteger = (value, code = "invalid_number") => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ProtocolError(400, code);
  return value;
};

export const nonnegativeInteger = (value, code = "invalid_number") => {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError(400, code);
  return value;
};

export const retentionClass = (value = RETENTION_CLASSES.journal) => {
  if (!Object.values(RETENTION_CLASSES).includes(value)) {
    throw new ProtocolError(400, "invalid_retention_class");
  }
  return value;
};

export const standardBase64 = (value, minimumBytes, maximumBytes) => {
  if (typeof value !== "string" || value.length === 0 || !STANDARD_BASE64_PATTERN.test(value)) {
    throw new ProtocolError(400, "invalid_base64");
  }
  const byteLength = value.endsWith("==")
    ? (value.length / 4) * 3 - 2
    : value.endsWith("=")
      ? (value.length / 4) * 3 - 1
      : (value.length / 4) * 3;
  if (!Number.isSafeInteger(byteLength) || byteLength < minimumBytes || byteLength > maximumBytes) {
    throw new ProtocolError(400, "invalid_size");
  }
  return value;
};

export const base64URLBytes = (value, expectedBytes) => {
  if (typeof value !== "string" || !BASE64_URL_PATTERN.test(value)) {
    throw new ProtocolError(401, "invalid_authorization");
  }
  const padding = "=".repeat((4 - value.length % 4) % 4);
  let binary;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  } catch {
    throw new ProtocolError(401, "invalid_authorization");
  }
  if (binary.length !== expectedBytes) throw new ProtocolError(401, "invalid_authorization");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const hashBytes = async (bytes) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64URL(new Uint8Array(digest));
};

export const bytesToBase64URL = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export const standardBase64ToBytes = (value, expectedBytes) => {
  standardBase64(value, expectedBytes, expectedBytes);
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const exactObject = (value, allowedKeys) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(400, "invalid_json");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowedKeys.includes(key))) {
    throw new ProtocolError(400, "unknown_field");
  }
  return value;
};

export const schemaOne = (value) => {
  if (value !== 1) throw new ProtocolError(400, "unsupported_schema");
};

export const parseBearer = (request) => {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header);
  if (!match) throw new ProtocolError(401, "missing_authorization");
  return base64URLBytes(match[1], LIMITS.tokenBytes);
};

export const readJSON = async (request) => {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ProtocolError(415, "content_type_required");
  }
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > LIMITS.requestBytes) throw new ProtocolError(413, "request_too_large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > LIMITS.requestBytes) {
    throw new ProtocolError(413, "request_too_large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError(400, "invalid_json");
  }
};

export const corsOrigin = (request, configuredOrigin) => {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (!configuredOrigin || origin !== configuredOrigin) {
    throw new ProtocolError(403, "origin_not_allowed");
  }
  return origin;
};
