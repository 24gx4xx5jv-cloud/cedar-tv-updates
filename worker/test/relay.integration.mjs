import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const baseURL = process.env.CEDAR_SYNC_TEST_URL || "http://127.0.0.1:8791";
const standardBase64 = (value) => value.toString("base64");
const base64URL = (value) => value.toString("base64url");
const tokenHash = (value) => createHash("sha256").update(value).digest();

const request = async (path, { method = "GET", token, body } = {}) => {
  const response = await fetch(`${baseURL}${path}`, {
    method,
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${base64URL(token)}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  return { status: response.status, value };
};

const spaceID = randomUUID();
const firstDeviceID = randomUUID();
const firstDeviceToken = randomBytes(32);
const invitationID = randomUUID();
const enrollmentToken = randomBytes(32);
const secondDeviceID = randomUUID();
const secondDeviceToken = randomBytes(32);
const changeID = randomUUID();

const created = await request("/v1/spaces", {
  method: "POST",
  body: {
    schemaVersion: 1,
    spaceID,
    deviceID: firstDeviceID,
    deviceToken: standardBase64(firstDeviceToken),
  },
});
assert.equal(created.status, 200);

const invitation = await request(`/v1/spaces/${spaceID}/invitations`, {
  method: "POST",
  token: firstDeviceToken,
  body: {
    schemaVersion: 1,
    invitationID,
    enrollmentTokenHash: standardBase64(tokenHash(enrollmentToken)),
    expiresAtEpochMilliseconds: Date.now() + 5 * 60 * 1000,
  },
});
assert.equal(invitation.status, 200);
assert.equal(invitation.value.ownerDeviceID, firstDeviceID);

const claimed = await request(`/v1/spaces/${spaceID}/invitations/${invitationID}/claim`, {
  method: "POST",
  token: enrollmentToken,
  body: {
    schemaVersion: 1,
    deviceID: secondDeviceID,
    deviceToken: standardBase64(secondDeviceToken),
  },
});
assert.equal(claimed.status, 200);
assert.equal(claimed.value.ownerDeviceID, firstDeviceID);
assert.equal(claimed.value.highWaterCursor, 0);
assert.deepEqual(claimed.value.checkpoints, []);

const identity = await request(`/v1/spaces/${spaceID}/identity`, {
  token: secondDeviceToken,
});
assert.equal(identity.status, 200);
assert.equal(identity.value.ownerDeviceID, firstDeviceID);

// The relay never receives encryption keys or an invitation scope. Therefore the same owner-only
// authorization gate protects both native full-profile and browser-companion enrollment records.
const linkedDeviceCannotCreateCompanionInvitation = await request(`/v1/spaces/${spaceID}/invitations`, {
  method: "POST",
  token: secondDeviceToken,
  body: {
    schemaVersion: 1,
    invitationID: randomUUID(),
    enrollmentTokenHash: standardBase64(tokenHash(randomBytes(32))),
    expiresAtEpochMilliseconds: Date.now() + 5 * 60 * 1000,
  },
});
assert.equal(linkedDeviceCannotCreateCompanionInvitation.status, 403);
const linkedDeviceCannotCreateFullProfileInvitation = await request(`/v1/spaces/${spaceID}/invitations`, {
  method: "POST",
  token: secondDeviceToken,
  body: {
    schemaVersion: 1,
    invitationID: randomUUID(),
    enrollmentTokenHash: standardBase64(tokenHash(randomBytes(32))),
    expiresAtEpochMilliseconds: Date.now() + 5 * 60 * 1000,
  },
});
assert.equal(linkedDeviceCannotCreateFullProfileInvitation.status, 403);

const replayedClaim = await request(`/v1/spaces/${spaceID}/invitations/${invitationID}/claim`, {
  method: "POST",
  token: enrollmentToken,
  body: {
    schemaVersion: 1,
    deviceID: randomUUID(),
    deviceToken: standardBase64(randomBytes(32)),
  },
});
assert.equal(replayedClaim.status, 401);

const envelope = {
  schemaVersion: 1,
  spaceID,
  deviceID: secondDeviceID,
  changeID,
  authorSequence: 1,
  createdAtEpochMilliseconds: Date.now(),
  sealedPayload: standardBase64(randomBytes(64)),
};
const uploaded = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: secondDeviceToken,
  body: envelope,
});
assert.equal(uploaded.status, 200);
assert.ok(uploaded.value.serverSequence > 0);

const duplicate = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: secondDeviceToken,
  body: envelope,
});
assert.equal(duplicate.status, 200);
assert.equal(duplicate.value.serverSequence, uploaded.value.serverSequence);

const fetched = await request(`/v1/spaces/${spaceID}/changes?after=0&limit=20`, {
  token: firstDeviceToken,
});
assert.equal(fetched.status, 200);
assert.equal(fetched.value.ownerDeviceID, firstDeviceID);
assert.equal(fetched.value.changes.length, 1);
assert.equal(fetched.value.changes[0].envelope.changeID, changeID);
assert.equal(fetched.value.changes[0].envelope.sealedPayload, envelope.sealedPayload);

const nonOwnerProfileCheckpoint = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: secondDeviceToken,
  body: {
    ...envelope,
    changeID: randomUUID(),
    authorSequence: 2,
    retentionClass: "profile-checkpoint",
  },
});
assert.equal(nonOwnerProfileCheckpoint.status, 403);

const firstProfileCheckpointID = randomUUID();
const companionCheckpointID = randomUUID();
const currentProfileCheckpointID = randomUUID();
const ownerCheckpointEnvelope = (changeIDValue, authorSequence, retentionClass) => ({
  schemaVersion: 1,
  spaceID,
  deviceID: firstDeviceID,
  changeID: changeIDValue,
  authorSequence,
  createdAtEpochMilliseconds: Date.now() + authorSequence,
  sealedPayload: standardBase64(randomBytes(64)),
  retentionClass,
});
const firstProfileCheckpoint = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: firstDeviceToken,
  body: ownerCheckpointEnvelope(firstProfileCheckpointID, 1, "profile-checkpoint"),
});
assert.equal(firstProfileCheckpoint.status, 200);
const companionCheckpoint = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: firstDeviceToken,
  body: ownerCheckpointEnvelope(companionCheckpointID, 2, "companion-checkpoint"),
});
assert.equal(companionCheckpoint.status, 200);

const betweenCheckpointJournalID = randomUUID();
const betweenCheckpointJournal = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: secondDeviceToken,
  body: {
    ...envelope,
    changeID: betweenCheckpointJournalID,
    authorSequence: 2,
    createdAtEpochMilliseconds: Date.now() + 4,
  },
});
assert.equal(betweenCheckpointJournal.status, 200);

const currentProfileCheckpoint = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: firstDeviceToken,
  body: ownerCheckpointEnvelope(currentProfileCheckpointID, 3, "profile-checkpoint"),
});
assert.equal(currentProfileCheckpoint.status, 200);
assert.ok(currentProfileCheckpoint.value.serverSequence > firstProfileCheckpoint.value.serverSequence);

const followingCheckpointJournalID = randomUUID();
const followingCheckpointJournal = await request(`/v1/spaces/${spaceID}/changes`, {
  method: "POST",
  token: secondDeviceToken,
  body: {
    ...envelope,
    changeID: followingCheckpointJournalID,
    authorSequence: 3,
    createdAtEpochMilliseconds: Date.now() + 6,
  },
});
assert.equal(followingCheckpointJournal.status, 200);

const checkpointedJournal = await request(`/v1/spaces/${spaceID}/changes?after=0&limit=20`, {
  token: firstDeviceToken,
});
assert.equal(checkpointedJournal.status, 200);
const retainedChangeIDs = checkpointedJournal.value.changes.map((item) => item.envelope.changeID);
assert.equal(retainedChangeIDs.includes(firstProfileCheckpointID), false);
assert.equal(retainedChangeIDs.includes(companionCheckpointID), true);
assert.equal(retainedChangeIDs.includes(betweenCheckpointJournalID), true);
assert.equal(retainedChangeIDs.includes(currentProfileCheckpointID), true);
assert.equal(retainedChangeIDs.includes(followingCheckpointJournalID), true);

const baselineInvitationID = randomUUID();
const baselineEnrollmentToken = randomBytes(32);
const baselineDeviceID = randomUUID();
const baselineDeviceToken = randomBytes(32);
const baselineInvitation = await request(`/v1/spaces/${spaceID}/invitations`, {
  method: "POST",
  token: firstDeviceToken,
  body: {
    schemaVersion: 1,
    invitationID: baselineInvitationID,
    enrollmentTokenHash: standardBase64(tokenHash(baselineEnrollmentToken)),
    expiresAtEpochMilliseconds: Date.now() + 5 * 60 * 1000,
  },
});
assert.equal(baselineInvitation.status, 200);
const baselineClaim = await request(
  `/v1/spaces/${spaceID}/invitations/${baselineInvitationID}/claim`,
  {
    method: "POST",
    token: baselineEnrollmentToken,
    body: {
      schemaVersion: 1,
      deviceID: baselineDeviceID,
      deviceToken: standardBase64(baselineDeviceToken),
    },
  },
);
assert.equal(baselineClaim.status, 200);
assert.equal(baselineClaim.value.ownerDeviceID, firstDeviceID);
assert.equal(
  baselineClaim.value.highWaterCursor,
  companionCheckpoint.value.serverSequence,
);
assert.deepEqual(
  baselineClaim.value.checkpoints.map((item) => item.envelope.changeID),
  [companionCheckpointID, currentProfileCheckpointID],
);

const baselineCatchUp = await request(
  `/v1/spaces/${spaceID}/changes?after=${baselineClaim.value.highWaterCursor}&limit=20`,
  { token: baselineDeviceToken },
);
assert.equal(baselineCatchUp.status, 200);
assert.deepEqual(
  baselineCatchUp.value.changes.map((item) => item.envelope.changeID),
  [betweenCheckpointJournalID, currentProfileCheckpointID, followingCheckpointJournalID],
);

// A bounded encoded-byte suffix prevents one space from monopolizing D1 even when every envelope
// is individually valid. The checkpoints remain outside this quota and define the safe prefix.
const quotaPayload = standardBase64(randomBytes(1_064_960));
let journalQuotaFailure = null;
let journalQuotaAccepted = 0;
for (let index = 0; index < 30; index += 1) {
  const candidate = await request(`/v1/spaces/${spaceID}/changes`, {
    method: "POST",
    token: firstDeviceToken,
    body: {
      schemaVersion: 1,
      spaceID,
      deviceID: firstDeviceID,
      changeID: randomUUID(),
      authorSequence: 4 + index,
      createdAtEpochMilliseconds: Date.now() + 10 + index,
      sealedPayload: quotaPayload,
    },
  });
  if (candidate.status === 409) {
    journalQuotaFailure = candidate;
    break;
  }
  assert.equal(candidate.status, 200);
  journalQuotaAccepted += 1;
}
assert.ok(journalQuotaAccepted > 0);
assert.equal(journalQuotaFailure?.status, 409);
assert.equal(journalQuotaFailure.value.error, "space_change_quota_exceeded");

const baselineLeave = await request(
  `/v1/spaces/${spaceID}/devices/${baselineDeviceID}`,
  { method: "DELETE", token: baselineDeviceToken },
);
assert.equal(baselineLeave.status, 200);
const baselineLeaveRetry = await request(
  `/v1/spaces/${spaceID}/devices/${baselineDeviceID}`,
  { method: "DELETE", token: baselineDeviceToken },
);
assert.equal(baselineLeaveRetry.status, 200);

const ownerDevices = await request(`/v1/spaces/${spaceID}/devices`, {
  token: firstDeviceToken,
});
assert.equal(ownerDevices.status, 200);
assert.deepEqual(
  ownerDevices.value.devices.map((device) => device.deviceID),
  [firstDeviceID, secondDeviceID],
);
assert.ok(ownerDevices.value.devices.every((device) => (
  Number.isSafeInteger(device.createdAtEpochMilliseconds)
  && Number.isSafeInteger(device.lastSeenAtEpochMilliseconds)
)));

const linkedDeviceCannotList = await request(`/v1/spaces/${spaceID}/devices`, {
  token: secondDeviceToken,
});
assert.equal(linkedDeviceCannotList.status, 403);

const linkedDeviceCannotRevokeOwner = await request(
  `/v1/spaces/${spaceID}/devices/${firstDeviceID}`,
  { method: "DELETE", token: secondDeviceToken },
);
assert.equal(linkedDeviceCannotRevokeOwner.status, 403);

const ownerCannotRevokeItself = await request(
  `/v1/spaces/${spaceID}/devices/${firstDeviceID}`,
  { method: "DELETE", token: firstDeviceToken },
);
assert.equal(ownerCannotRevokeItself.status, 400);

const unauthorized = await request(`/v1/spaces/${spaceID}/changes?after=0`, {
  token: randomBytes(32),
});
assert.equal(unauthorized.status, 401);

// Fill the active-device bound, then prove a rejected enrollment does not burn its invitation.
const capacityDevices = [];
for (let index = 0; index < 48; index += 1) {
  const extraInvitationID = randomUUID();
  const extraEnrollmentToken = randomBytes(32);
  const extraDeviceID = randomUUID();
  const extraDeviceToken = randomBytes(32);
  const createdInvitation = await request(`/v1/spaces/${spaceID}/invitations`, {
    method: "POST",
    token: firstDeviceToken,
    body: {
      schemaVersion: 1,
      invitationID: extraInvitationID,
      enrollmentTokenHash: standardBase64(tokenHash(extraEnrollmentToken)),
      expiresAtEpochMilliseconds: Date.now() + 5 * 60 * 1000,
    },
  });
  assert.equal(createdInvitation.status, 200);
  const extraClaim = await request(
    `/v1/spaces/${spaceID}/invitations/${extraInvitationID}/claim`,
    {
      method: "POST",
      token: extraEnrollmentToken,
      body: {
        schemaVersion: 1,
        deviceID: extraDeviceID,
        deviceToken: standardBase64(extraDeviceToken),
      },
    },
  );
  assert.equal(extraClaim.status, 200);
  capacityDevices.push({ deviceID: extraDeviceID, token: extraDeviceToken });
  extraEnrollmentToken.fill(0);
}

const boundedInvitationID = randomUUID();
const boundedEnrollmentToken = randomBytes(32);
const boundedDeviceID = randomUUID();
const boundedDeviceToken = randomBytes(32);
const boundedInvitation = await request(`/v1/spaces/${spaceID}/invitations`, {
  method: "POST",
  token: firstDeviceToken,
  body: {
    schemaVersion: 1,
    invitationID: boundedInvitationID,
    enrollmentTokenHash: standardBase64(tokenHash(boundedEnrollmentToken)),
    expiresAtEpochMilliseconds: Date.now() + 5 * 60 * 1000,
  },
});
assert.equal(boundedInvitation.status, 200);
const boundedClaim = async () => request(
  `/v1/spaces/${spaceID}/invitations/${boundedInvitationID}/claim`,
  {
    method: "POST",
    token: boundedEnrollmentToken,
    body: {
      schemaVersion: 1,
      deviceID: boundedDeviceID,
      deviceToken: standardBase64(boundedDeviceToken),
    },
  },
);
const rejectedAtCapacity = await boundedClaim();
assert.equal(rejectedAtCapacity.status, 409);
assert.equal(rejectedAtCapacity.value.error, "too_many_devices");
const freedCapacity = await request(
  `/v1/spaces/${spaceID}/devices/${capacityDevices[0].deviceID}`,
  { method: "DELETE", token: firstDeviceToken },
);
assert.equal(freedCapacity.status, 200);
const retriedAfterCapacity = await boundedClaim();
assert.equal(retriedAfterCapacity.status, 200);
assert.equal(retriedAfterCapacity.value.ownerDeviceID, firstDeviceID);

const revoked = await request(`/v1/spaces/${spaceID}/devices/${secondDeviceID}`, {
  method: "DELETE",
  token: firstDeviceToken,
});
assert.equal(revoked.status, 200);
const revokedDeviceRetry = await request(`/v1/spaces/${spaceID}/devices/${secondDeviceID}`, {
  method: "DELETE",
  token: secondDeviceToken,
});
assert.equal(revokedDeviceRetry.status, 200);

const afterRevocation = await request(`/v1/spaces/${spaceID}/changes?after=0`, {
  token: secondDeviceToken,
});
assert.equal(afterRevocation.status, 401);

// The per-space invitation bound counts every still-live claim receipt, not just pending links.
let invitationOverQuota = null;
let quotaInvitationsCreated = 0;
for (let index = 0; index < 65; index += 1) {
  const candidate = await request(`/v1/spaces/${spaceID}/invitations`, {
    method: "POST",
    token: firstDeviceToken,
    body: {
      schemaVersion: 1,
      invitationID: randomUUID(),
      enrollmentTokenHash: standardBase64(tokenHash(randomBytes(32))),
      expiresAtEpochMilliseconds: Date.now() + 5 * 60 * 1000,
    },
  });
  if (candidate.status === 409) {
    invitationOverQuota = candidate;
    break;
  }
  assert.equal(candidate.status, 200);
  quotaInvitationsCreated += 1;
}
assert.ok(quotaInvitationsCreated > 0);
assert.equal(invitationOverQuota?.status, 409);
assert.equal(invitationOverQuota.value.error, "too_many_invitations");

const participantCannotDeleteSpace = await request(`/v1/spaces/${spaceID}`, {
  method: "DELETE",
  token: boundedDeviceToken,
});
assert.equal(participantCannotDeleteSpace.status, 403);
assert.equal(participantCannotDeleteSpace.value.error, "owner_authorization_required");
const deletedSpace = await request(`/v1/spaces/${spaceID}`, {
  method: "DELETE",
  token: firstDeviceToken,
});
assert.equal(deletedSpace.status, 200);
const retriedSpaceDelete = await request(`/v1/spaces/${spaceID}`, {
  method: "DELETE",
  token: firstDeviceToken,
});
assert.equal(retriedSpaceDelete.status, 200);
const formerParticipantCannotReplayOwnerDelete = await request(`/v1/spaces/${spaceID}`, {
  method: "DELETE",
  token: boundedDeviceToken,
});
assert.equal(formerParticipantCannotReplayOwnerDelete.status, 401);
const deletedSpaceCannotBeRecreatedDuringRetryWindow = await request("/v1/spaces", {
  method: "POST",
  body: {
    schemaVersion: 1,
    spaceID,
    deviceID: randomUUID(),
    deviceToken: standardBase64(randomBytes(32)),
  },
});
assert.equal(deletedSpaceCannotBeRecreatedDuringRetryWindow.status, 409);

firstDeviceToken.fill(0);
enrollmentToken.fill(0);
secondDeviceToken.fill(0);
baselineEnrollmentToken.fill(0);
baselineDeviceToken.fill(0);
for (const value of capacityDevices) value.token.fill(0);
boundedEnrollmentToken.fill(0);
boundedDeviceToken.fill(0);
process.stdout.write("Cedar Sync relay integration flow passed.\n");
