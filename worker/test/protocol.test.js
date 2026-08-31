import assert from "node:assert/strict";
import test from "node:test";
import {
  LIMITS,
  ProtocolError,
  RETENTION_CLASSES,
  corsOrigin,
  exactObject,
  normalizeUUID,
  retentionClass,
  standardBase64,
} from "../src/protocol.js";

test("UUIDs normalize without accepting loose identifiers", () => {
  assert.equal(
    normalizeUUID("ED4DA86C-9708-4C4F-AD10-91F34726997A"),
    "ed4da86c-9708-4c4f-ad10-91f34726997a",
  );
  assert.throws(() => normalizeUUID("../../space"), ProtocolError);
  assert.throws(() => normalizeUUID("00000000-0000-0000-0000-000000000000"), ProtocolError);
});

test("opaque payloads use strict bounded standard Base64", () => {
  assert.equal(standardBase64("AQIDBA==", 4, 4), "AQIDBA==");
  assert.throws(() => standardBase64("AQIDBA", 4, 4), ProtocolError);
  assert.throws(() => standardBase64("AQIDBA==", 5, 10), ProtocolError);
  assert.throws(
    () => standardBase64("A".repeat(LIMITS.sealedPayloadBytes * 2), 1, 100),
    ProtocolError,
  );
});

test("unknown request fields are rejected", () => {
  assert.deepEqual(exactObject({ schemaVersion: 1 }, ["schemaVersion"]), { schemaVersion: 1 });
  assert.throws(
    () => exactObject({ schemaVersion: 1, plaintext: "secret" }, ["schemaVersion"]),
    ProtocolError,
  );
});

test("retention hints are strict and legacy uploads default to journal", () => {
  assert.equal(retentionClass(), RETENTION_CLASSES.journal);
  assert.equal(
    retentionClass("profile-checkpoint"),
    RETENTION_CLASSES.profileCheckpoint,
  );
  assert.equal(
    retentionClass("companion-checkpoint"),
    RETENTION_CLASSES.companionCheckpoint,
  );
  assert.throws(() => retentionClass("profile"), ProtocolError);
  assert.ok(LIMITS.maximumJournalChanges + LIMITS.maximumDevices + 1 <= 2_000);
});

test("browser access is restricted to the configured Cedar site", () => {
  const allowed = new Request("https://sync.example/v1/health", {
    headers: { Origin: "https://24gx4xx5jv-cloud.github.io" },
  });
  const denied = new Request("https://sync.example/v1/health", {
    headers: { Origin: "https://attacker.example" },
  });
  const native = new Request("https://sync.example/v1/health");
  assert.equal(
    corsOrigin(allowed, "https://24gx4xx5jv-cloud.github.io"),
    "https://24gx4xx5jv-cloud.github.io",
  );
  assert.equal(corsOrigin(native, "https://24gx4xx5jv-cloud.github.io"), null);
  assert.throws(
    () => corsOrigin(denied, "https://24gx4xx5jv-cloud.github.io"),
    ProtocolError,
  );
});
