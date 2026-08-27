import assert from "node:assert/strict";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { deflateRawSync, deflateSync } from "node:zlib";
import test from "node:test";

import {
  CedarSyncError,
  LIMITS,
  bytesToBase64,
  bytesToBase64URL,
  createProfilePresentationPatchChange,
  decodeProfileSnapshot,
  fetchLatestProfile,
  openEnvelope,
  sealEnvelope,
} from "../public/link/cedar-sync.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const textEncoder = new TextEncoder();
const spaceID = randomUUID();
const deviceID = randomUUID();
const changeID = randomUUID();
const profileID = randomUUID();
const profileKey = randomBytes(32);
const credentials = {
  relayBaseURL: "https://relay.example",
  spaceID,
  deviceID: randomUUID(),
  deviceToken: randomBytes(32).toString("base64url"),
  profileKey: profileKey.toString("base64url"),
};

const portableProfile = {
  profile: {
    id: profileID,
    name: "Living Room",
    avatarSymbol: "https://cdn.xperience-app.com/avatars/netflix/chicken-onb.webp",
    theme: "dark",
    isKids: false,
    requiresPIN: true,
    ratingLimit: 18,
  },
  sources: [{ isEnabled: true }, { isEnabled: false }],
  homeBranches: [{ isEnabled: true }, { isEnabled: true }],
  homeShelves: [{ isEnabled: true }],
};

const makeSnapshotBytes = ({ compressed = true, wrapped = false } = {}) => {
  const snapshot = textEncoder.encode(JSON.stringify({
    schemaVersion: 1,
    profileID,
    profileName: "Living Room",
    createdAtEpochMilliseconds: 1_777_777_777_777,
    profileData: bytesToBase64(textEncoder.encode(JSON.stringify(portableProfile))),
    items: [{ reference: `cedar.profile.${profileID}.source`, data: bytesToBase64(randomBytes(32)) }],
  }));
  if (!compressed) return snapshot;
  const encoded = wrapped ? deflateSync(snapshot) : deflateRawSync(snapshot);
  return new Uint8Array(Buffer.concat([Buffer.from("CSZ1"), encoded]));
};

const makeEnvelope = async ({
  key = profileKey,
  compressed = true,
  wrapped = false,
  envelopeChangeID = changeID,
  authorSequence = 6,
  revision = 1_777_777_777_777,
} = {}) => {
  const createdAtEpochMilliseconds = 1_777_777_777_000;
  const change = {
    schemaVersion: 1,
    profileID,
    entityKind: "apple-profile-snapshot",
    entityID: profileID.toLowerCase(),
    operation: "upsert",
    revision,
    modifiedAtEpochMilliseconds: 1_777_777_777_777,
    payload: bytesToBase64(makeSnapshotBytes({ compressed, wrapped })),
  };
  const nonce = randomBytes(12);
  const aad = textEncoder.encode(
    `cedar-sync-v1:${spaceID.toLowerCase()}:${deviceID.toLowerCase()}:${envelopeChangeID.toLowerCase()}:${authorSequence}:${createdAtEpochMilliseconds}`,
  );
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    cryptoKey,
    textEncoder.encode(JSON.stringify(change)),
  );
  return {
    schemaVersion: 1,
    spaceID,
    deviceID,
    changeID: envelopeChangeID,
    authorSequence,
    createdAtEpochMilliseconds,
    sealedPayload: bytesToBase64(new Uint8Array(Buffer.concat([nonce, Buffer.from(sealed)]))),
  };
};

test("authenticates and decodes Apple's raw-DEFLATE profile snapshot", async () => {
  const opened = await openEnvelope(await makeEnvelope(), credentials);
  const profile = await decodeProfileSnapshot(opened, spaceID);
  assert.deepEqual(profile, {
    schemaVersion: 1,
    spaceID: spaceID.toLowerCase(),
    profileID: profileID.toLowerCase(),
    name: "Living Room",
    avatarSymbol: "https://cdn.xperience-app.com/avatars/netflix/chicken-onb.webp",
    avatarEditable: true,
    theme: "dark",
    isKids: false,
    requiresPIN: true,
    ratingLimit: 18,
    sourceCount: 2,
    enabledSourceCount: 1,
    branchCount: 2,
    enabledBranchCount: 2,
    shelfCount: 1,
    snapshotRevision: 1_777_777_777_777,
    syncedAt: 1_777_777_777_777,
  });
});

test("seals an allowlisted browser presentation patch for Apple Cedar", async () => {
  const profile = {
    profileID,
    snapshotRevision: 12,
    name: "Living Room",
    avatarSymbol: "person.crop.circle.fill",
    theme: "system",
  };
  const replacement = {
    name: "Tyler",
    avatarSymbol:
      "https://24gx4xx5jv-cloud.github.io/cedar-tv-updates/avatars/nuvio/avatar.webp",
    theme: "dark",
  };
  const change = createProfilePresentationPatchChange(
    profile,
    replacement,
    3,
    1_800_000_002_000,
  );
  const envelope = await sealEnvelope(change, credentials, 3, {
    changeID: randomUUID(),
    createdAtEpochMilliseconds: 1_800_000_002_000,
    nonce: new Uint8Array(12).fill(0x5a),
  });

  const opened = await openEnvelope(envelope, credentials);
  const patch = JSON.parse(new TextDecoder().decode(opened.payload));

  assert.equal(opened.entityKind, "browser-profile-presentation");
  assert.equal(opened.profileID, profileID.toLowerCase());
  assert.equal(patch.baseRevision, 12);
  assert.deepEqual(patch.base, {
    name: "Living Room",
    avatarSymbol: "person.crop.circle.fill",
    theme: "system",
  });
  assert.deepEqual(patch.replacement, replacement);
  opened.payload.fill(0);
});

test("rejects unsafe or no-op browser presentation patches", () => {
  const profile = {
    profileID,
    snapshotRevision: 12,
    name: "Living Room",
    avatarSymbol: "person.crop.circle.fill",
    theme: "system",
  };
  assert.throws(
    () => createProfilePresentationPatchChange(profile, {
      name: "Living Room",
      avatarSymbol: "data:image/png;base64,AQID",
      theme: "system",
    }, 1),
    CedarSyncError,
  );
  assert.throws(
    () => createProfilePresentationPatchChange(profile, profile, 1),
    (error) => error instanceof CedarSyncError && error.code === "no_changes",
  );
});

test("keeps compatibility with zlib-wrapped profile snapshots", async () => {
  const opened = await openEnvelope(await makeEnvelope({ wrapped: true }), credentials);
  const profile = await decodeProfileSnapshot(opened, spaceID);
  assert.equal(profile.name, "Living Room");
});

test("uses the bounded software fallback when raw DecompressionStream is unavailable", async () => {
  const nativeDecompressionStream = globalThis.DecompressionStream;
  globalThis.DecompressionStream = undefined;
  try {
    const opened = await openEnvelope(await makeEnvelope(), credentials);
    const profile = await decodeProfileSnapshot(opened, spaceID);
    assert.equal(profile.name, "Living Room");
  } finally {
    globalThis.DecompressionStream = nativeDecompressionStream;
  }
});

test("keeps the software fallback inside Cedar's decompression limit", async () => {
  const nativeDecompressionStream = globalThis.DecompressionStream;
  globalThis.DecompressionStream = undefined;
  const oversized = new Uint8Array(LIMITS.snapshotJSONBytes + 2).fill(0x41);
  const payload = new Uint8Array(Buffer.concat([
    Buffer.from("CSZ1"),
    deflateRawSync(oversized),
  ]));
  try {
    await assert.rejects(
      decodeProfileSnapshot({
        schemaVersion: 1,
        profileID,
        entityKind: "apple-profile-snapshot",
        entityID: profileID.toLowerCase(),
        operation: "upsert",
        revision: 1,
        modifiedAtEpochMilliseconds: 1_777_777_777_777,
        payload,
      }, spaceID),
      (error) => error instanceof CedarSyncError && error.code === "expanded_too_large",
    );
  } finally {
    oversized.fill(0);
    globalThis.DecompressionStream = nativeDecompressionStream;
  }
});

test("opens the shared Apple and Android AES-GCM wire vector", async () => {
  const sharedCredentials = {
    relayBaseURL: "https://sync.cedar.example",
    spaceID: "ed4da86c-9708-4c4f-ad10-91f34726997a",
    deviceID: randomUUID(),
    deviceToken: bytesToBase64URL(new Uint8Array(32).fill(0x11)),
    profileKey: bytesToBase64URL(new Uint8Array(32).fill(0x22)),
  };
  const envelope = {
    schemaVersion: 1,
    spaceID: sharedCredentials.spaceID,
    deviceID: "ad72a672-d5ad-4549-a41c-dd1be6331167",
    changeID: "ae85e32e-72a6-43c9-ab1e-e50e77ee280d",
    authorSequence: 9,
    createdAtEpochMilliseconds: 1_800_000_001_000,
    sealedPayload: "AAECAwQFBgcICQoLPeLycc9E/L1xcjezZjHGDhUtoCMgjxTxgFQc1vNtn+xZUU38fNB7hhPOxjHwt73ymEqEBD+zaOzyv0sGLM5XDoLc9h/8t2pXfxFwzvgdeYU0ehEUbUlAh/8rO5ZbTV8Ppu7LEknei0dFk/U5fAIwVCg6Pzjl8F/Bv3Jb0tS5mKm20hzsRMlj7I3rh5XSW+CU3RJKZ++v6XnbVxK01HPnlIPKQJ1/k2HldLgpsfDqX+8+HL7gtVraKsPy3ET58tVGZ8ED3stQVHR9KXNR39ygccUkBy/TlbYrJrPkFzqGAYWl8nHQC/kAP8LE0ErLLsXA49eoNhk4k+wKsQdMgx8AUhxM148pAw==",
  };

  const opened = await openEnvelope(envelope, sharedCredentials);

  assert.equal(opened.profileID, "13880d2e-2a44-48fe-a0e6-67e03d47de57");
  assert.equal(opened.entityKind, "preference");
  assert.equal(opened.entityID, "metadata.provider");
  assert.equal(new TextDecoder().decode(opened.payload), '{"provider":"tvdb"}');
  opened.payload.fill(0);
});

test("decodes the uncompressed snapshot form", async () => {
  const opened = await openEnvelope(await makeEnvelope({ compressed: false }), credentials);
  const profile = await decodeProfileSnapshot(opened, spaceID);
  assert.equal(profile.name, "Living Room");
  assert.equal(profile.sourceCount, 2);
});

test("rejects a wrong profile key", async () => {
  const wrongCredentials = { ...credentials, profileKey: bytesToBase64URL(randomBytes(32)) };
  await assert.rejects(
    openEnvelope(await makeEnvelope(), wrongCredentials),
    (error) => error instanceof CedarSyncError && error.code === "authentication_failed",
  );
});

test("authenticates relay-visible envelope metadata", async () => {
  const envelope = await makeEnvelope();
  envelope.authorSequence += 1;
  await assert.rejects(
    openEnvelope(envelope, credentials),
    (error) => error instanceof CedarSyncError && error.code === "authentication_failed",
  );
});

test("rejects a profile identity mismatch", async () => {
  const opened = await openEnvelope(await makeEnvelope(), credentials);
  opened.entityID = randomUUID();
  await assert.rejects(
    decodeProfileSnapshot(opened, spaceID),
    (error) => error instanceof CedarSyncError && error.code === "profile_mismatch",
  );
});

test("paginates encrypted history below the response-size ceiling", async () => {
  const nativeFetch = globalThis.fetch;
  const entries = await Promise.all(Array.from({ length: 7 }, async (_, index) => ({
    serverSequence: index + 1,
    envelope: await makeEnvelope({
      envelopeChangeID: randomUUID(),
      authorSequence: index + 1,
      revision: 20 + index,
    }),
  })));
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    const after = Number(url.searchParams.get("after"));
    const limit = Number(url.searchParams.get("limit"));
    requests.push({ after, limit });
    const changes = entries.filter((entry) => entry.serverSequence > after).slice(0, limit);
    return new Response(JSON.stringify({ schemaVersion: 1, changes }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await fetchLatestProfile(credentials);
    assert.equal(result.cursor, 7);
    assert.equal(result.profile.snapshotRevision, 26);
    assert.deepEqual(requests, [
      { after: 0, limit: LIMITS.fetchPage },
      { after: 5, limit: LIMITS.fetchPage },
    ]);
    const maximumEnvelopeJSONBytes = 4 * Math.ceil(LIMITS.sealedPayloadBytes / 3) + 2_048;
    assert.ok(
      LIMITS.fetchPage * maximumEnvelopeJSONBytes + 64 * 1_024 <= LIMITS.responseBytes,
      "the worst-case relay page must stay inside the bounded reader",
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
