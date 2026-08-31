import assert from "node:assert/strict";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { deflateRawSync, deflateSync } from "node:zlib";
import test from "node:test";

import {
  CedarSyncError,
  LIMITS,
  bytesToBase64,
  bytesToBase64URL,
  createCompanionConfigurationPatchChange,
  createCompanionDeviceRequestChange,
  createCompanionRemoteRequestChange,
  createDeviceRequestChange,
  createProfilePresentationPatchChange,
  createRemoteCommandChange,
  createWebInvitation,
  decodeCompanionSnapshot,
  decodeProfileSnapshot,
  fetchLatestProfile,
  fetchLatestCompanion,
  leaveSpace,
  openEnvelope,
  parseWebInvitationFragment,
  parseCompanionInvitationFragment,
  sealEnvelope,
  validateCompanionClaimResult,
} from "../public/link/cedar-sync.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const textEncoder = new TextEncoder();
const spaceID = randomUUID();
const deviceID = randomUUID();
const changeID = randomUUID();
const profileID = randomUUID();
const installedBadgePackID = randomUUID();
const installedBadgePackURL = "https://cedartv.github.io/cedar-tv-updates/badge-packs/xp_aurora.json";
const profileKey = randomBytes(32);
const credentials = {
  relayBaseURL: "https://relay.example",
  spaceID,
  deviceID: randomUUID(),
  deviceToken: randomBytes(32).toString("base64url"),
  profileKey: profileKey.toString("base64url"),
};

const companionConfiguration = {
  presentation: {
    name: "Living Room",
    avatarSymbol: "person.crop.circle.fill",
    theme: "system",
    badgeSelection: "builtIn",
  },
  settings: {
    metadataLanguageCode: "en-CA",
    automaticallyPlayBestSource: true,
    automaticallyTryNextBestSource: true,
    quickPlayFromPosters: false,
    hideUnreleasedTitles: true,
    showsPosterCardRatings: true,
    topShelfPresentation: "automatic",
    showsTopShelfViewingActivity: true,
    cleansUpLiveChannelNames: true,
  },
  branches: [{
    id: "continue-watching",
    title: "Continue Watching",
    position: 0,
    isEnabled: true,
    preset: "continue-watching",
    sourceKind: "catalog",
    presentationKind: "row",
  }],
};

const companionSnapshot = {
  schemaVersion: 1,
  profileID,
  revision: 42,
  publishedAtEpochMilliseconds: 1_800_000_000_000,
  configuration: companionConfiguration,
  devices: [{
    id: deviceID,
    displayName: "Living Room TV",
    platform: "apple",
    linkedAtEpochMilliseconds: 1_799_000_000_000,
    lastSeenAtEpochMilliseconds: 1_800_000_000_000,
    isCurrent: true,
    supportsRemoteControl: true,
  }],
  remoteStatuses: [{
    deviceID,
    isOnline: true,
    isPlaying: false,
    isLive: false,
    supportedCommands: ["status", "toggle-playback", "skip-backward", "skip-forward"],
    updatedAtEpochMilliseconds: 1_800_000_000_000,
  }],
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
  configuration: [
    {
      key: "addons.badgePacks",
      payload: bytesToBase64(textEncoder.encode(JSON.stringify([{
        id: installedBadgePackID,
        sourceURL: installedBadgePackURL,
        pack: { name: "Aurora" },
      }]))),
    },
    {
      key: "addons.badgeSelection",
      payload: bytesToBase64(textEncoder.encode(JSON.stringify(`custom:${installedBadgePackID}`))),
    },
  ],
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
  operation = "upsert",
} = {}) => {
  const createdAtEpochMilliseconds = 1_777_777_777_000;
  const change = {
    schemaVersion: 1,
    profileID,
    entityKind: "apple-profile-snapshot",
    entityID: profileID.toLowerCase(),
    operation,
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
    badgeSelection: installedBadgePackURL,
    installedBadgePacks: [{
      id: installedBadgePackID.toLowerCase(),
      name: "Aurora",
      sourceURL: installedBadgePackURL,
    }],
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
    badgeSelection: "builtIn",
  };
  const replacement = {
    name: "Tyler",
    avatarSymbol:
      "https://cedartv.github.io/cedar-tv-updates/avatars/nuvio/avatar.webp",
    theme: "dark",
    badgeSelection: installedBadgePackURL,
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
    badgeSelection: "builtIn",
  });
  assert.deepEqual(patch.replacement, replacement);
  opened.payload.fill(0);
});

test("decodes a content-free Cedar Link companion snapshot", () => {
  const payload = textEncoder.encode(JSON.stringify(companionSnapshot));
  const decoded = decodeCompanionSnapshot({
    schemaVersion: 1,
    profileID,
    entityKind: "cedar-companion-snapshot",
    entityID: profileID,
    operation: "upsert",
    revision: 42,
    modifiedAtEpochMilliseconds: 1_800_000_000_000,
    payload,
  }, spaceID);

  assert.equal(decoded.configuration.presentation.name, "Living Room");
  assert.equal(decoded.devices[0].displayName, "Living Room TV");
  assert.deepEqual(Object.keys(decoded.remoteStatuses[0]).sort(), [
    "deviceID", "isLive", "isOnline", "isPlaying", "supportedCommands", "updatedAtEpochMilliseconds",
  ]);
  assert.equal(new TextDecoder().decode(payload), "\0".repeat(payload.length));
});

test("creates bounded configuration, remote, and owner device requests", async () => {
  const companion = { profileID, revision: 42, configuration: companionConfiguration };
  const replacement = structuredClone(companionConfiguration);
  replacement.settings.metadataLanguageCode = "fr-CA";
  replacement.branches.push({
    id: "popular",
    title: "Popular",
    position: 1,
    isEnabled: true,
    preset: "popular",
    sourceKind: "catalog",
    presentationKind: "row",
  });
  const configChange = createCompanionConfigurationPatchChange(
    companion,
    replacement,
    3,
    1_800_000_001_000,
  );
  const configPatch = JSON.parse(new TextDecoder().decode(configChange.payload));
  assert.equal(configChange.entityKind, "browser-companion-configuration");
  assert.equal(configPatch.baseRevision, 42);
  assert.equal(configPatch.replacement.branches[1].preset, "popular");
  configChange.payload.fill(0);

  const remote = createRemoteCommandChange(
    companion,
    deviceID,
    "toggle-playback",
    4,
    1_800_000_002_000,
  );
  const remoteRequest = JSON.parse(new TextDecoder().decode(remote.payload));
  assert.equal(remoteRequest.command, "toggle-playback");
  assert.equal(remoteRequest.expiresAtEpochMilliseconds, 1_800_000_062_000);
  assert.equal("mediaID" in remoteRequest, false);
  remote.payload.fill(0);

  const revoke = createDeviceRequestChange(
    companion,
    deviceID,
    "revoke",
    5,
    { createdAtEpochMilliseconds: 1_800_000_003_000 },
  );
  assert.equal(JSON.parse(new TextDecoder().decode(revoke.payload)).action, "revoke");
  revoke.payload.fill(0);
});

test("does not permit branch deletion or arbitrary provider queries", () => {
  const companion = { profileID, revision: 42, configuration: companionConfiguration };
  const removed = structuredClone(companionConfiguration);
  removed.branches = [];
  assert.throws(
    () => createCompanionConfigurationPatchChange(companion, removed, 1),
    (error) => error instanceof CedarSyncError && error.code === "branch_removal",
  );
  const arbitrary = structuredClone(companionConfiguration);
  arbitrary.branches.push({
    id: "private-provider-query",
    title: "Private",
    position: 1,
    isEnabled: true,
    preset: "provider-query",
    sourceKind: "catalog",
    presentationKind: "row",
  });
  assert.throws(
    () => createCompanionConfigurationPatchChange(companion, arbitrary, 1),
    CedarSyncError,
  );
});

test("creates a one-use browser invitation with secrets only in the fragment", async () => {
  const nativeFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const invitation = await createWebInvitation(
      credentials,
      "https://cedar.example/link/?discarded=yes#discarded",
      1_800_000_000_000,
    );
    const url = new URL(invitation.url);
    const body = JSON.parse(request.init.body);
    assert.equal(url.search, "");
    assert.equal(new URLSearchParams(url.hash.slice(1)).get("scope"), "companion");
    assert.match(url.hash, /enrollment=/);
    assert.match(url.hash, /key=/);
    assert.doesNotMatch(request.url, /enrollment|key=/);
    assert.equal(body.enrollmentTokenHash.length, 44);
    assert.doesNotMatch(request.init.body, /profileKey|deviceToken/);
    const parsed = parseWebInvitationFragment(url.hash, 1_800_000_000_000);
    assert.equal(parsed.relayBaseURL, credentials.relayBaseURL);
    assert.equal(parsed.spaceID, credentials.spaceID);
    assert.equal(parsed.ownerDeviceID, credentials.deviceID);
    assert.equal(parsed.profileKey.length, 32);
    assert.equal(parsed.enrollmentToken.length, 32);

    assert.throws(
      () => parseCompanionInvitationFragment(`${url.hash}&key=${bytesToBase64URL(randomBytes(32))}`, 1_800_000_000_000),
      (error) => error instanceof CedarSyncError && error.code === "invalid_invitation",
    );

    const unsupported = new URL(url);
    const unsupportedValues = new URLSearchParams(unsupported.hash.slice(1));
    unsupportedValues.set("scope", "profile");
    unsupported.hash = unsupportedValues.toString();
    assert.throws(
      () => parseWebInvitationFragment(unsupported.hash, 1_800_000_000_000),
      CedarSyncError,
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
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
      badgeSelection: "builtIn",
    }, 1),
    CedarSyncError,
  );
  assert.throws(
    () => createProfilePresentationPatchChange(profile, {
      ...profile,
      badgeSelection: "http://example.com/unsafe-badges.json",
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

test("skips owner-only checkpoints and opens the companion checkpoint", async () => {
  const nativeFetch = globalThis.fetch;
  const ownerOnlyEnvelope = await makeEnvelope({
    key: randomBytes(32),
    envelopeChangeID: randomUUID(),
    authorSequence: 1,
  });
  const companionPayload = textEncoder.encode(JSON.stringify(companionSnapshot));
  const companionEnvelope = await sealEnvelope({
    schemaVersion: 1,
    profileID,
    entityKind: "cedar-companion-snapshot",
    entityID: profileID,
    operation: "upsert",
    revision: companionSnapshot.revision,
    modifiedAtEpochMilliseconds: 1_800_000_000_000,
    payload: companionPayload,
  }, credentials, 2, {
    changeID: randomUUID(),
    createdAtEpochMilliseconds: 1_800_000_000_000,
    nonce: new Uint8Array(12).fill(0x2a),
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    schemaVersion: 1,
    changes: [
      { serverSequence: 1, envelope: ownerOnlyEnvelope },
      { serverSequence: 2, envelope: companionEnvelope },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const result = await fetchLatestProfile(credentials);
    assert.equal(result.cursor, 2);
    assert.equal(result.profile, null);
    assert.equal(result.companion.revision, companionSnapshot.revision);
    assert.equal(result.companion.configuration.presentation.name, "Living Room");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("does not skip authenticated malformed changes", async () => {
  const nativeFetch = globalThis.fetch;
  const malformedEnvelope = await makeEnvelope({
    operation: "delete",
    envelopeChangeID: randomUUID(),
    authorSequence: 1,
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    schemaVersion: 1,
    changes: [{ serverSequence: 1, envelope: malformedEnvelope }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    await assert.rejects(
      fetchLatestProfile(credentials),
      (error) => error instanceof CedarSyncError && error.code === "invalid_operation",
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

const companionCredentials = {
  ...credentials,
  ownerDeviceID: deviceID,
};
const ownerCompanionCredentials = {
  ...companionCredentials,
  deviceID,
};

const makeCompanionEnvelope = ({
  authorCredentials = ownerCompanionCredentials,
  authorSequence = 1,
  revision = companionSnapshot.revision,
  name = companionSnapshot.configuration.presentation.name,
  envelopeChangeID = randomUUID(),
  operation = "upsert",
} = {}) => {
  const snapshot = structuredClone(companionSnapshot);
  snapshot.revision = revision;
  snapshot.publishedAtEpochMilliseconds += revision;
  snapshot.configuration.presentation.name = name;
  return sealEnvelope({
    schemaVersion: 1,
    profileID,
    entityKind: "cedar-companion-snapshot",
    entityID: profileID,
    operation,
    revision,
    modifiedAtEpochMilliseconds: snapshot.publishedAtEpochMilliseconds,
    payload: operation === "tombstone"
      ? new Uint8Array()
      : textEncoder.encode(JSON.stringify(snapshot)),
  }, authorCredentials, authorSequence, {
    changeID: envelopeChangeID,
    createdAtEpochMilliseconds: snapshot.publishedAtEpochMilliseconds,
    nonce: new Uint8Array(12).fill(authorSequence),
  });
};

test("surfaces an authenticated profile tombstone for cache removal", async () => {
  const nativeFetch = globalThis.fetch;
  const tombstone = await sealEnvelope({
    schemaVersion: 1,
    profileID,
    entityKind: "apple-profile-snapshot",
    entityID: profileID,
    operation: "tombstone",
    revision: 44,
    modifiedAtEpochMilliseconds: 1_800_000_000_044,
    payload: new Uint8Array(),
  }, credentials, 1, {
    changeID: randomUUID(),
    createdAtEpochMilliseconds: 1_800_000_000_044,
    nonce: new Uint8Array(12).fill(0x44),
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    schemaVersion: 1,
    changes: [{ serverSequence: 1, envelope: tombstone }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const result = await fetchLatestProfile(credentials);
    assert.equal(result.cursor, 1);
    assert.equal(result.profile, null);
    assert.equal(result.profileRemoved, true);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("surfaces an owner companion tombstone and clears the starting snapshot", async () => {
  const nativeFetch = globalThis.fetch;
  const tombstone = await makeCompanionEnvelope({
    authorSequence: 2,
    operation: "tombstone",
    revision: companionSnapshot.revision + 1,
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    schemaVersion: 1,
    changes: [{ serverSequence: 2, envelope: tombstone }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const result = await fetchLatestCompanion(companionCredentials, 0, companionSnapshot);
    assert.equal(result.cursor, 2);
    assert.equal(result.companion, null);
    assert.equal(result.companionRemoved, true);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("keeps companion configuration bound to the invitation owner across a mixed-key journal", async () => {
  const nativeFetch = globalThis.fetch;
  const participantCredentials = {
    ...companionCredentials,
    deviceID: randomUUID(),
  };
  const entries = [{
    serverSequence: 1,
    envelope: await makeEnvelope({
      key: randomBytes(32),
      envelopeChangeID: randomUUID(),
      authorSequence: 1,
    }),
  }, {
    serverSequence: 2,
    envelope: await makeCompanionEnvelope({ authorSequence: 2 }),
  }, {
    serverSequence: 3,
    envelope: await makeCompanionEnvelope({
      authorCredentials: participantCredentials,
      authorSequence: 3,
      revision: 43,
      name: "Participant must not replace owner",
    }),
  }];
  globalThis.fetch = async (input) => {
    const after = Number(new URL(input).searchParams.get("after"));
    return new Response(JSON.stringify({
      schemaVersion: 1,
      changes: entries.filter((entry) => entry.serverSequence > after),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const result = await fetchLatestCompanion(companionCredentials);
    assert.equal(result.cursor, 3);
    assert.equal(result.unreadableChanges, 1);
    assert.equal(result.companion.revision, 42);
    assert.equal(result.companion.configuration.presentation.name, "Living Room");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("validates the owner and both encryption domains in a claim baseline", async () => {
  const result = await validateCompanionClaimResult({
    schemaVersion: 1,
    ownerDeviceID: deviceID,
    highWaterCursor: 9,
    checkpoints: [{
      serverSequence: 7,
      envelope: await makeEnvelope({
        key: randomBytes(32),
        envelopeChangeID: randomUUID(),
        authorSequence: 7,
      }),
    }, {
      serverSequence: 9,
      envelope: await makeCompanionEnvelope({ authorSequence: 9 }),
    }],
  }, companionCredentials, deviceID);

  assert.equal(result.ownerDeviceID, deviceID.toLowerCase());
  assert.equal(result.highWaterCursor, 9);
  assert.equal(result.unreadableChanges, 1);
  assert.equal(result.companion.configuration.presentation.name, "Living Room");
});

test("keeps the explicit current companion request aliases on the shared wire contract", () => {
  const companion = { profileID, revision: 42, configuration: companionConfiguration };
  const rename = createCompanionDeviceRequestChange(
    companion,
    deviceID,
    "rename",
    10,
    { displayName: "Living Room", createdAtEpochMilliseconds: 1_800_000_010_000 },
  );
  const remote = createCompanionRemoteRequestChange(
    companion,
    deviceID,
    "toggle-playback",
    11,
    1_800_000_011_000,
  );
  assert.equal(rename.entityKind, "browser-device-action");
  assert.equal(remote.entityKind, "browser-remote-command");
  rename.payload.fill(0);
  remote.payload.fill(0);
});


test("keeps native personal rows readable but prevents the browser from adding them", () => {
  const companion = { profileID, revision: 10, configuration: companionConfiguration };
  for (const preset of ["continue-watching", "favorites", "watchlist"]) {
    const replacement = structuredClone(companion.configuration);
    replacement.branches.push({
      id: `${preset}-browser-row`,
      title: "Unsupported browser row",
      position: 1,
      isEnabled: true,
      preset,
      sourceKind: "catalog",
      presentationKind: "row",
    });
    assert.throws(
      () => createCompanionConfigurationPatchChange(companion, replacement, 1),
      (error) => error instanceof CedarSyncError && error.code === "invalid_branch_preset",
    );
  }

  const replacement = structuredClone(companion.configuration);
  replacement.branches.push({
    id: "trending-browser-row",
    title: "Trending",
    position: 1,
    isEnabled: true,
    preset: "trending",
    sourceKind: "catalog",
    presentationKind: "row",
  });
  assert.equal(
    createCompanionConfigurationPatchChange(companion, replacement, 1).entityKind,
    "browser-companion-configuration",
  );
});

test("leaves the relay before local browser credentials are forgotten", async () => {
  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), options });
    return new Response(JSON.stringify({ schemaVersion: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await leaveSpace(credentials);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, "DELETE");
    assert.equal(
      new URL(requests[0].url).pathname,
      `/v1/spaces/${spaceID}/devices/${credentials.deviceID}`,
    );
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${credentials.deviceToken}`);

    globalThis.fetch = async () => new Response(JSON.stringify({
      schemaVersion: 1,
      error: "invalid_authorization",
    }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    await leaveSpace(credentials);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
