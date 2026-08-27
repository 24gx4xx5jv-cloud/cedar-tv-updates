const stateLabel = document.querySelector("#link-state-label");
const title = document.querySelector("#link-card-title");
const status = document.querySelector("#link-status");
const button = document.querySelector("#link-button");
const hasInvitationFragment = window.location.hash.length > 1;

const setState = (label, heading, message, enabled = false) => {
  stateLabel.textContent = label;
  title.textContent = heading;
  status.textContent = message;
  button.disabled = !enabled;
};

const base64URLPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeUUID = (value) => {
  if (!uuidPattern.test(value || "")) throw new Error("invalid invitation");
  return value.toLowerCase();
};

const normalizeRelay = (value) => {
  const relay = new URL(value);
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash) {
    throw new Error("invalid relay");
  }
  relay.pathname = relay.pathname.replace(/\/$/, "");
  return relay.href.replace(/\/$/, "");
};

const base64URLToBytes = (value) => {
  if (!base64URLPattern.test(value || "")) throw new Error("invalid key");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const binary = atob(padded);
  if (binary.length !== 32) throw new Error("invalid key");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToBase64 = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const bytesToBase64URL = (bytes) => bytesToBase64(bytes)
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replaceAll("=", "");

const invitationFromFragment = () => {
  if (!window.location.hash || window.location.hash.length > 2_048) return null;
  const values = new URLSearchParams(window.location.hash.slice(1));
  const allowed = new Set(["v", "relay", "space", "invitation", "enrollment", "key", "expires"]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error("unknown invitation field");
  }
  if (values.get("v") !== "1") throw new Error("unsupported invitation");
  const expiresAt = Number(values.get("expires"));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("expired invitation");
  return {
    relayBaseURL: normalizeRelay(values.get("relay")),
    spaceID: normalizeUUID(values.get("space")),
    invitationID: normalizeUUID(values.get("invitation")),
    enrollmentToken: base64URLToBytes(values.get("enrollment")),
    profileKey: base64URLToBytes(values.get("key")),
    expiresAt,
  };
};

const requestPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Browser storage is unavailable."));
});

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("cedar-link-v1", 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains("keys")) database.createObjectStore("keys");
    if (!database.objectStoreNames.contains("profiles")) database.createObjectStore("profiles");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Browser storage is unavailable."));
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error("Browser storage failed."));
  transaction.onabort = () => reject(transaction.error || new Error("Browser storage failed."));
});

const wrappingKey = async (database) => {
  const read = database.transaction("keys", "readonly");
  const existing = await requestPromise(read.objectStore("keys").get("profile-wrapping-key-v1"));
  if (existing) return existing;
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const write = database.transaction("keys", "readwrite");
  write.objectStore("keys").add(generated, "profile-wrapping-key-v1");
  try {
    await transactionDone(write);
    return generated;
  } catch {
    const retry = database.transaction("keys", "readonly");
    return requestPromise(retry.objectStore("keys").get("profile-wrapping-key-v1"));
  }
};

const readRecord = async (database, key) => {
  const transaction = database.transaction("profiles", "readonly");
  return requestPromise(transaction.objectStore("profiles").get(key));
};

const writeRecord = async (database, key, value) => {
  const transaction = database.transaction("profiles", "readwrite");
  transaction.objectStore("profiles").put(value, key);
  await transactionDone(transaction);
};

const deleteRecord = async (database, key) => {
  const transaction = database.transaction("profiles", "readwrite");
  transaction.objectStore("profiles").delete(key);
  await transactionDone(transaction);
};

const encryptSecrets = async (key, secrets) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(secrets));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, clear);
    return { iv: bytesToBase64URL(iv), ciphertext: bytesToBase64URL(new Uint8Array(ciphertext)) };
  } finally {
    clear.fill(0);
    iv.fill(0);
  }
};

const decryptSecrets = async (key, record) => {
  const ivText = record.iv;
  const ciphertextText = record.ciphertext;
  const decodeVariable = (value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid storage");
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  };
  const iv = decodeVariable(ivText);
  const ciphertext = decodeVariable(ciphertextText);
  try {
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(clear));
  } finally {
    iv.fill(0);
    ciphertext.fill(0);
  }
};

const pendingCredentials = async (database, key, invitation) => {
  const recordKey = `pending:${invitation.invitationID}`;
  const existing = await readRecord(database, recordKey);
  if (existing) return { recordKey, secrets: await decryptSecrets(key, existing) };
  const deviceToken = crypto.getRandomValues(new Uint8Array(32));
  const secrets = {
    relayBaseURL: invitation.relayBaseURL,
    spaceID: invitation.spaceID,
    invitationID: invitation.invitationID,
    deviceID: crypto.randomUUID().toLowerCase(),
    deviceToken: bytesToBase64URL(deviceToken),
    profileKey: bytesToBase64URL(invitation.profileKey),
  };
  deviceToken.fill(0);
  const encrypted = await encryptSecrets(key, secrets);
  await writeRecord(database, recordKey, {
    schemaVersion: 1,
    invitationID: invitation.invitationID,
    state: "pending",
    createdAt: Date.now(),
    ...encrypted,
  });
  return { recordKey, secrets };
};

const claim = async (invitation, secrets) => {
  const enrollment = bytesToBase64URL(invitation.enrollmentToken);
  const deviceToken = base64URLToBytes(secrets.deviceToken);
  try {
    const response = await fetch(
      `${invitation.relayBaseURL}/v1/spaces/${invitation.spaceID}/invitations/${invitation.invitationID}/claim`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${enrollment}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          deviceID: secrets.deviceID,
          deviceToken: bytesToBase64(deviceToken),
        }),
      },
    );
    if (!response.ok) throw new Error(`relay rejected link (${response.status})`);
    const result = await response.json();
    if (result.schemaVersion !== 1) throw new Error("invalid relay response");
  } finally {
    deviceToken.fill(0);
  }
};

const activate = async (database, key, pendingKey, secrets) => {
  const encrypted = await encryptSecrets(key, secrets);
  await writeRecord(database, `space:${secrets.spaceID}`, {
    schemaVersion: 1,
    spaceID: secrets.spaceID,
    deviceID: secrets.deviceID,
    relayBaseURL: secrets.relayBaseURL,
    state: "active",
    linkedAt: Date.now(),
    ...encrypted,
  });
  await deleteRecord(database, pendingKey);
};

let invitation = null;
let relayBaseURL = "";

const verifyRelay = async (baseURL) => {
  const response = await fetch(`${baseURL}/v1/health`, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("relay unavailable");
  const result = await response.json();
  if (result.schemaVersion !== 1 || result.status !== "ok") {
    throw new Error("relay unavailable");
  }
};

const initialize = async () => {
  const configResponse = await fetch("../sync-config.json", {
    cache: "no-store",
    credentials: "omit",
  });
  if (!configResponse.ok) throw new Error("configuration unavailable");
  const config = await configResponse.json();
  if (config.schemaVersion !== 1) throw new Error("configuration unavailable");
  relayBaseURL = config.relayBaseURL ? normalizeRelay(config.relayBaseURL) : "";
  invitation = invitationFromFragment();
  if (!relayBaseURL) {
    setState(
      "Not yet enabled",
      "Cedar Link is being prepared.",
      "This site has not been connected to the encrypted Cedar Sync relay yet.",
    );
    return;
  }
  await verifyRelay(relayBaseURL);
  if (!invitation) {
    setState(
      "Service online",
      "Ready for a Cedar invitation.",
      "In Cedar on iPhone or iPad, open Settings → Cedar Link and create a browser link.",
    );
    return;
  }
  if (invitation.relayBaseURL !== relayBaseURL) throw new Error("invitation relay mismatch");
  setState(
    "Invitation ready",
    "Link this browser to Cedar?",
    "Only this browser receives the profile key. The relay stores ciphertext and cannot read the profile.",
    true,
  );
};

button.addEventListener("click", async () => {
  if (!invitation || !relayBaseURL || button.disabled) return;
  button.disabled = true;
  setState("Linking securely", "Protecting this device…", "This normally takes only a moment.");
  try {
    if (invitation.expiresAt <= Date.now()) throw new Error("expired invitation");
    const database = await openDatabase();
    const key = await wrappingKey(database);
    if (!key) throw new Error("browser key unavailable");
    const pending = await pendingCredentials(database, key, invitation);
    await claim(invitation, pending.secrets);
    await activate(database, key, pending.recordKey, pending.secrets);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    invitation.enrollmentToken.fill(0);
    invitation.profileKey.fill(0);
    invitation = null;
    button.textContent = "Device linked";
    button.dataset.complete = "true";
    setState(
      "Linked",
      "This device is ready.",
      "This browser now holds protected access to the Cedar Sync space. Profile editing will appear here only after sync is activated.",
    );
  } catch {
    const canRetry = Boolean(invitation && invitation.expiresAt > Date.now());
    button.textContent = canRetry ? "Try Again" : "Link this device";
    setState(
      "Could not link",
      "The invitation was not completed.",
      canRetry
        ? "Check this device's connection and try again. No profile data was sent in plaintext."
        : "Return to Cedar, create a new browser link, and try again.",
      canRetry,
    );
  }
});

initialize().catch(() => {
  setState(
    hasInvitationFragment ? "Link unavailable" : "Service unavailable",
    hasInvitationFragment
      ? "This invitation could not be verified."
      : "Cedar Link is temporarily unavailable.",
    hasInvitationFragment
      ? "Return to Cedar and create a new browser link, then try again."
      : "Your Cedar profile and local device data are unaffected. Try again in a moment.",
  );
});
