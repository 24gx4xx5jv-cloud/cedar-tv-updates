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
assert.equal(fetched.value.changes.length, 1);
assert.equal(fetched.value.changes[0].envelope.changeID, changeID);
assert.equal(fetched.value.changes[0].envelope.sealedPayload, envelope.sealedPayload);

const unauthorized = await request(`/v1/spaces/${spaceID}/changes?after=0`, {
  token: randomBytes(32),
});
assert.equal(unauthorized.status, 401);

const revoked = await request(`/v1/spaces/${spaceID}/devices/${secondDeviceID}`, {
  method: "DELETE",
  token: firstDeviceToken,
});
assert.equal(revoked.status, 200);

const afterRevocation = await request(`/v1/spaces/${spaceID}/changes?after=0`, {
  token: secondDeviceToken,
});
assert.equal(afterRevocation.status, 401);

firstDeviceToken.fill(0);
enrollmentToken.fill(0);
secondDeviceToken.fill(0);
process.stdout.write("Cedar Sync relay integration flow passed.\n");
