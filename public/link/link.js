import {
  CedarSyncError,
  base64URLToBytes,
  bytesToBase64,
  bytesToBase64URL,
  fetchLatestProfile,
  normalizeUUID,
} from "./cedar-sync.mjs?v=raw-deflate-2";

const pairing = document.querySelector("#link-pairing");
const card = document.querySelector("#link-card");
const stateLabel = document.querySelector("#link-state-label");
const title = document.querySelector("#link-card-title");
const status = document.querySelector("#link-status");
const button = document.querySelector("#link-button");
const companion = document.querySelector("#link-companion");
const companionState = document.querySelector("#companion-state");
const profileSelector = document.querySelector("#profile-selector");
const profileName = document.querySelector("#profile-name");
const profileKicker = document.querySelector("#profile-kicker");
const profileMeta = document.querySelector("#profile-meta");
const profileAvatar = document.querySelector("#profile-avatar");
const avatarImage = document.querySelector("#profile-avatar-image");
const avatarFallback = document.querySelector("#profile-avatar-fallback");
const sourceCount = document.querySelector("#source-count");
const branchCount = document.querySelector("#branch-count");
const shelfCount = document.querySelector("#shelf-count");
const syncMessage = document.querySelector("#sync-message");
const refreshButton = document.querySelector("#refresh-profile");
const avatarLibrary = document.querySelector("#avatar-library");
const avatarSearch = document.querySelector("#avatar-search");
const avatarGrid = document.querySelector("#avatar-grid");
const avatarMore = document.querySelector("#avatar-more");
const badgeLibrary = document.querySelector("#badge-library");
const badgeSelector = document.querySelector("#badge-selector");
const badgePreview = document.querySelector("#badge-preview");
const hasInvitationFragment = window.location.hash.length > 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AVATAR_PATH_PATTERN = /^\/avatars\/[a-z0-9_-]+\/[a-z0-9_-]+\.webp$/i;
const BADGE_PATH_PATTERN = /^\/badges\/[a-z0-9_-]+\/[a-z0-9_-]+\.webp$/i;
const databaseName = "cedar-link-v1";
const wrappingKeyName = "profile-wrapping-key-v1";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let invitation = null;
let relayBaseURL = "";
let database = null;
let key = null;
let activeProfiles = [];
let selectedSpaceID = "";
let avatarCatalog = null;
let avatarMatches = [];
let visibleAvatarCount = 24;
let badgeCatalog = null;

const setState = (label, heading, message, enabled = false) => {
  stateLabel.textContent = label;
  title.textContent = heading;
  status.textContent = message;
  button.disabled = !enabled;
};

const normalizeRelay = (value) => {
  const relay = new URL(value);
  if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash) {
    throw new Error("invalid relay");
  }
  relay.pathname = relay.pathname.replace(/\/$/, "");
  return relay.href.replace(/\/$/, "");
};

const invitationKey = (value) => {
  if (!KEY_PATTERN.test(value || "")) throw new Error("invalid key");
  return base64URLToBytes(value, 32);
};

const invitationFromFragment = () => {
  if (!window.location.hash || window.location.hash.length > 2_048) return null;
  const values = new URLSearchParams(window.location.hash.slice(1));
  const allowed = new Set(["v", "relay", "space", "invitation", "enrollment", "key", "expires"]);
  for (const field of values.keys()) {
    if (!allowed.has(field)) throw new Error("unknown invitation field");
  }
  if (values.get("v") !== "1") throw new Error("unsupported invitation");
  const expiresAt = Number(values.get("expires"));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("expired invitation");
  return {
    relayBaseURL: normalizeRelay(values.get("relay")),
    spaceID: normalizeUUID(values.get("space")),
    invitationID: normalizeUUID(values.get("invitation")),
    enrollmentToken: invitationKey(values.get("enrollment")),
    profileKey: invitationKey(values.get("key")),
    expiresAt,
  };
};

const requestPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Browser storage is unavailable."));
});

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(databaseName, 1);
  request.onupgradeneeded = () => {
    const result = request.result;
    if (!result.objectStoreNames.contains("keys")) result.createObjectStore("keys");
    if (!result.objectStoreNames.contains("profiles")) result.createObjectStore("profiles");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error("Browser storage is unavailable."));
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error("Browser storage failed."));
  transaction.onabort = () => reject(transaction.error || new Error("Browser storage failed."));
});

const wrappingKey = async (currentDatabase) => {
  const read = currentDatabase.transaction("keys", "readonly");
  const existing = await requestPromise(read.objectStore("keys").get(wrappingKeyName));
  if (existing) return existing;
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const write = currentDatabase.transaction("keys", "readwrite");
  write.objectStore("keys").add(generated, wrappingKeyName);
  try {
    await transactionDone(write);
    return generated;
  } catch {
    const retry = currentDatabase.transaction("keys", "readonly");
    return requestPromise(retry.objectStore("keys").get(wrappingKeyName));
  }
};

const readRecord = async (recordKey) => {
  const transaction = database.transaction("profiles", "readonly");
  return requestPromise(transaction.objectStore("profiles").get(recordKey));
};

const readAllRecords = async () => {
  const transaction = database.transaction("profiles", "readonly");
  const store = transaction.objectStore("profiles");
  const [keys, values] = await Promise.all([
    requestPromise(store.getAllKeys()),
    requestPromise(store.getAll()),
  ]);
  return keys.map((recordKey, index) => ({ recordKey, value: values[index] }));
};

const writeRecord = async (recordKey, value) => {
  const transaction = database.transaction("profiles", "readwrite");
  transaction.objectStore("profiles").put(value, recordKey);
  await transactionDone(transaction);
};

const writeRecords = async (entries) => {
  const transaction = database.transaction("profiles", "readwrite");
  const store = transaction.objectStore("profiles");
  for (const [recordKey, value] of entries) store.put(value, recordKey);
  await transactionDone(transaction);
};

const deleteRecord = async (recordKey) => {
  const transaction = database.transaction("profiles", "readwrite");
  transaction.objectStore("profiles").delete(recordKey);
  await transactionDone(transaction);
};

const encryptValue = async (value) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const clear = new TextEncoder().encode(JSON.stringify(value));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, clear);
    return { iv: bytesToBase64URL(iv), ciphertext: bytesToBase64URL(new Uint8Array(ciphertext)) };
  } finally {
    clear.fill(0);
    iv.fill(0);
  }
};

const decryptValue = async (stored) => {
  const iv = base64URLToBytes(stored.iv, 12);
  const ciphertext = base64URLToBytes(stored.ciphertext, null);
  if (ciphertext.length < 16) throw new Error("Protected browser data is invalid.");
  let clear;
  try {
    clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
  } finally {
    iv.fill(0);
    ciphertext.fill(0);
    clear?.fill(0);
  }
};

const pendingCredentials = async (currentInvitation) => {
  const recordKey = `pending:${currentInvitation.invitationID}`;
  const existing = await readRecord(recordKey);
  if (existing) return { recordKey, secrets: await decryptValue(existing) };
  const deviceToken = crypto.getRandomValues(new Uint8Array(32));
  const secrets = {
    relayBaseURL: currentInvitation.relayBaseURL,
    spaceID: currentInvitation.spaceID,
    invitationID: currentInvitation.invitationID,
    deviceID: crypto.randomUUID().toLowerCase(),
    deviceToken: bytesToBase64URL(deviceToken),
    profileKey: bytesToBase64URL(currentInvitation.profileKey),
  };
  deviceToken.fill(0);
  const encrypted = await encryptValue(secrets);
  await writeRecord(recordKey, {
    schemaVersion: 1,
    invitationID: currentInvitation.invitationID,
    state: "pending",
    createdAt: Date.now(),
    ...encrypted,
  });
  return { recordKey, secrets };
};

const claim = async (currentInvitation, secrets) => {
  const enrollment = bytesToBase64URL(currentInvitation.enrollmentToken);
  const deviceToken = base64URLToBytes(secrets.deviceToken, 32);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(
      `${currentInvitation.relayBaseURL}/v1/spaces/${currentInvitation.spaceID}/invitations/${currentInvitation.invitationID}/claim`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
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
    clearTimeout(timeout);
    deviceToken.fill(0);
  }
};

const activate = async (pendingKey, secrets) => {
  const encrypted = await encryptValue(secrets);
  await writeRecord(`space:${secrets.spaceID}`, {
    schemaVersion: 1,
    spaceID: secrets.spaceID,
    deviceID: secrets.deviceID,
    relayBaseURL: secrets.relayBaseURL,
    state: "active",
    linkedAt: Date.now(),
    cursor: 0,
    ...encrypted,
  });
  await deleteRecord(pendingKey);
};

const loadActiveProfiles = async () => {
  const records = await readAllRecords();
  const loaded = [];
  for (const entry of records) {
    if (typeof entry.recordKey !== "string" || !entry.recordKey.startsWith("space:")) continue;
    if (entry.value?.schemaVersion !== 1 || entry.value?.state !== "active") continue;
    try {
      const credentials = await decryptValue(entry.value);
      if (credentials.relayBaseURL !== relayBaseURL || !UUID_PATTERN.test(credentials.spaceID || "")) continue;
      if (entry.recordKey !== `space:${credentials.spaceID}` || entry.value.spaceID !== credentials.spaceID) continue;
      const cachedRecord = await readRecord(`snapshot:${credentials.spaceID}`);
      const cachedProfile = cachedRecord ? await decryptValue(cachedRecord) : null;
      const profile = cachedProfile?.spaceID === credentials.spaceID ? cachedProfile : null;
      loaded.push({ recordKey: entry.recordKey, record: entry.value, credentials, profile });
    } catch {
      // One damaged local record must not prevent another linked profile from opening.
    }
  }
  activeProfiles = loaded.sort((left, right) => (right.record.linkedAt || 0) - (left.record.linkedAt || 0));
  if (!selectedSpaceID || !activeProfiles.some((item) => item.credentials.spaceID === selectedSpaceID)) {
    selectedSpaceID = activeProfiles[0]?.credentials.spaceID || "";
  }
};

const selectedProfile = () => activeProfiles.find((item) => item.credentials.spaceID === selectedSpaceID);

const relativeTime = (timestamp) => {
  if (!Number.isSafeInteger(timestamp)) return "Sync time unavailable";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 45) return "Synced just now";
  if (seconds < 3_600) return `Synced ${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `Synced ${Math.round(seconds / 3_600)} hr ago`;
  return `Synced ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
};

const localAvatarPath = (storedValue) => {
  if (typeof storedValue !== "string") return null;
  try {
    const url = new URL(storedValue);
    const marker = url.pathname.indexOf("/avatars/");
    if (marker < 0) return null;
    const path = url.pathname.slice(marker);
    return AVATAR_PATH_PATTERN.test(path) ? `..${path}` : null;
  } catch {
    if (AVATAR_PATH_PATTERN.test(storedValue)) return `..${storedValue}`;
    return null;
  }
};

const setAvatar = (profile, previewPath = null, previewName = null) => {
  const path = previewPath || localAvatarPath(profile?.avatarSymbol);
  avatarFallback.textContent = (profile?.name || "C").trim().slice(0, 1).toUpperCase() || "C";
  if (path) {
    avatarImage.src = path;
    avatarImage.hidden = false;
    avatarFallback.hidden = true;
  } else {
    avatarImage.removeAttribute("src");
    avatarImage.hidden = true;
    avatarFallback.hidden = false;
  }
  profileAvatar.classList.toggle("is-preview", Boolean(previewPath));
  if (previewName) syncMessage.textContent = `Previewing ${previewName}. This preview is not sent back to Cedar.`;
};

const renderProfileSelector = () => {
  profileSelector.replaceChildren();
  for (const item of activeProfiles) {
    const option = document.createElement("option");
    option.value = item.credentials.spaceID;
    option.textContent = item.profile?.name || "Waiting for profile";
    option.selected = option.value === selectedSpaceID;
    profileSelector.append(option);
  }
  profileSelector.hidden = activeProfiles.length < 2;
  document.querySelector(".profile-picker-label").hidden = activeProfiles.length < 2;
};

const renderCompanion = () => {
  const item = selectedProfile();
  if (!item) return;
  pairing.hidden = true;
  companion.hidden = false;
  card.classList.add("has-companion");
  card.setAttribute("aria-labelledby", "profile-name");
  renderProfileSelector();
  if (!item.profile) {
    profileName.textContent = "Waiting for your profile";
    profileKicker.textContent = "Browser linked";
    profileMeta.textContent = "Keep Cedar open on iPhone for a moment";
    sourceCount.textContent = "—";
    branchCount.textContent = "—";
    shelfCount.textContent = "—";
    setAvatar({ name: "Cedar" });
    return;
  }
  const profile = item.profile;
  profileName.textContent = profile.name;
  profileKicker.textContent = profile.isKids ? "Kids profile" : "Profile received";
  profileMeta.textContent = `${relativeTime(profile.syncedAt)} · ${profile.theme === "system" ? "System appearance" : `${profile.theme} appearance`}`;
  sourceCount.textContent = String(profile.enabledSourceCount ?? profile.sourceCount ?? 0);
  branchCount.textContent = String(profile.enabledBranchCount ?? profile.branchCount ?? 0);
  shelfCount.textContent = String(profile.shelfCount ?? 0);
  setAvatar(profile);
};

const persistSyncResult = async (item, result) => {
  const updatedRecord = { ...item.record, cursor: result.cursor, lastCheckedAt: Date.now() };
  const entries = [[item.recordKey, updatedRecord]];
  if (result.profile) {
    entries.push([`snapshot:${item.credentials.spaceID}`, {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      ...await encryptValue(result.profile),
    }]);
  }
  await writeRecords(entries);
  item.record = updatedRecord;
  if (result.profile) item.profile = result.profile;
};

const syncSelectedProfile = async ({ poll = false } = {}) => {
  const item = selectedProfile();
  if (!item) return;
  refreshButton.disabled = true;
  refreshButton.classList.add("is-refreshing");
  companionState.textContent = "Checking Cedar Sync";
  syncMessage.classList.remove("is-error", "is-success");
  syncMessage.textContent = item.profile
    ? "Checking for a newer encrypted profile…"
    : "Waiting for the first encrypted upload from Cedar on iPhone…";
  const delays = poll ? [0, 1_800, 3_000, 5_000, 8_000, 12_000] : [0];
  try {
    for (const delay of delays) {
      if (delay) await sleep(delay);
      const result = await fetchLatestProfile(item.credentials, item.record.cursor || 0);
      await persistSyncResult(item, result);
      renderCompanion();
      if (item.profile) {
        companionState.textContent = "Cedar Link connected";
        syncMessage.textContent = "Encrypted profile authenticated and ready in this browser.";
        syncMessage.classList.add("is-success");
        return;
      }
    }
    companionState.textContent = "Browser linked";
    syncMessage.textContent = "No profile upload has arrived yet. Keep Cedar open on iPhone, then tap refresh.";
  } catch (error) {
    companionState.textContent = "Sync needs attention";
    syncMessage.textContent = error instanceof CedarSyncError
      ? error.message
      : "This browser could not open the encrypted Cedar profile. Try refreshing.";
    syncMessage.classList.add("is-error");
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove("is-refreshing");
  }
};

const verifyRelay = async (baseURL) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseURL}/v1/health`, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("relay unavailable");
    const result = await response.json();
    if (result.schemaVersion !== 1 || result.status !== "ok") throw new Error("relay unavailable");
  } finally {
    clearTimeout(timeout);
  }
};

const loadAvatars = async () => {
  if (avatarCatalog) return;
  avatarGrid.innerHTML = '<p class="library-loading">Loading recovered avatars…</p>';
  const response = await fetch("../catalogs/avatars.json", { cache: "force-cache", credentials: "omit" });
  if (!response.ok) throw new Error("avatar catalog unavailable");
  const value = await response.json();
  if (!Array.isArray(value.avatars)) throw new Error("avatar catalog invalid");
  avatarCatalog = value.avatars.filter((avatar) => (
    typeof avatar?.name === "string"
    && typeof avatar?.url === "string"
    && AVATAR_PATH_PATTERN.test(avatar.url)
  ));
  avatarMatches = avatarCatalog;
  renderAvatars();
};

const renderAvatars = () => {
  avatarGrid.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const avatar of avatarMatches.slice(0, visibleAvatarCount)) {
    const choice = document.createElement("button");
    choice.className = "avatar-choice";
    choice.type = "button";
    choice.title = `${avatar.name} — preview only`;
    choice.dataset.path = `..${avatar.url}`;
    choice.dataset.name = avatar.name;
    const image = document.createElement("img");
    image.src = `..${avatar.url}`;
    image.alt = avatar.name;
    image.loading = "lazy";
    image.decoding = "async";
    choice.append(image);
    fragment.append(choice);
  }
  avatarGrid.append(fragment);
  if (avatarMatches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "library-loading";
    empty.textContent = "No avatars match that search.";
    avatarGrid.append(empty);
  }
  avatarMore.hidden = avatarMatches.length <= visibleAvatarCount;
};

const loadBadges = async () => {
  if (badgeCatalog) return;
  const response = await fetch("../catalogs/badges.json", { cache: "force-cache", credentials: "omit" });
  if (!response.ok) throw new Error("badge catalog unavailable");
  const value = await response.json();
  if (!Array.isArray(value.sets)) throw new Error("badge catalog invalid");
  badgeCatalog = value.sets.filter((set) => Array.isArray(set?.badges) && typeof set?.label === "string");
  badgeSelector.replaceChildren();
  for (const [index, set] of badgeCatalog.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${set.label} · ${set.creator || "Community"}`;
    badgeSelector.append(option);
  }
  renderBadges();
};

const renderBadges = () => {
  const set = badgeCatalog?.[Number(badgeSelector.value) || 0];
  badgePreview.replaceChildren();
  if (!set) return;
  for (const badge of set.badges.filter((item) => item?.enabled !== false).slice(0, 8)) {
    if (typeof badge.imageURL !== "string" || !BADGE_PATH_PATTERN.test(badge.imageURL)) continue;
    const image = document.createElement("img");
    image.src = `..${badge.imageURL}`;
    image.alt = badge.name || "Badge";
    image.loading = "lazy";
    badgePreview.append(image);
  }
};

const initialize = async () => {
  const configResponse = await fetch("../sync-config.json", { cache: "no-store", credentials: "omit" });
  if (!configResponse.ok) throw new Error("configuration unavailable");
  const config = await configResponse.json();
  if (config.schemaVersion !== 1) throw new Error("configuration unavailable");
  relayBaseURL = config.relayBaseURL ? normalizeRelay(config.relayBaseURL) : "";
  invitation = invitationFromFragment();
  if (!relayBaseURL) {
    setState("Not yet enabled", "Cedar Link is being prepared.", "This site has not been connected to the encrypted Cedar Sync relay yet.");
    return;
  }
  await verifyRelay(relayBaseURL);
  database = await openDatabase();
  key = await wrappingKey(database);
  await loadActiveProfiles();

  if (invitation) {
    if (invitation.relayBaseURL !== relayBaseURL) throw new Error("invitation relay mismatch");
    setState(
      "Invitation ready",
      "Link this browser to Cedar?",
      "Only this browser receives the profile key. The relay stores ciphertext and cannot read the profile.",
      true,
    );
    return;
  }
  if (activeProfiles.length > 0) {
    renderCompanion();
    await syncSelectedProfile();
    return;
  }
  setState(
    "Service online",
    "Ready for a Cedar invitation.",
    "In Cedar on iPhone or iPad, open Settings → Cedar Link and create a browser link.",
  );
};

button.addEventListener("click", async () => {
  if (!invitation || !relayBaseURL || button.disabled) return;
  button.disabled = true;
  setState("Linking securely", "Protecting this browser…", "Claiming the invitation and waiting for Cedar's encrypted upload.");
  try {
    if (invitation.expiresAt <= Date.now()) throw new Error("expired invitation");
    const pending = await pendingCredentials(invitation);
    await claim(invitation, pending.secrets);
    await activate(pending.recordKey, pending.secrets);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    invitation.enrollmentToken.fill(0);
    invitation.profileKey.fill(0);
    selectedSpaceID = invitation.spaceID;
    invitation = null;
    await loadActiveProfiles();
    renderCompanion();
    await syncSelectedProfile({ poll: true });
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

refreshButton.addEventListener("click", () => syncSelectedProfile());

profileSelector.addEventListener("change", async () => {
  selectedSpaceID = profileSelector.value;
  renderCompanion();
  await syncSelectedProfile();
});

avatarLibrary.addEventListener("toggle", () => {
  if (avatarLibrary.open) loadAvatars().catch(() => {
    avatarGrid.innerHTML = '<p class="library-loading">The avatar library could not be loaded.</p>';
  });
});

avatarSearch.addEventListener("input", () => {
  const query = avatarSearch.value.trim().toLocaleLowerCase();
  avatarMatches = query
    ? avatarCatalog.filter((avatar) => `${avatar.name} ${avatar.category || ""} ${avatar.source || ""}`.toLocaleLowerCase().includes(query))
    : avatarCatalog;
  visibleAvatarCount = 24;
  renderAvatars();
});

avatarMore.addEventListener("click", () => {
  visibleAvatarCount += 24;
  renderAvatars();
});

avatarGrid.addEventListener("click", (event) => {
  const choice = event.target.closest(".avatar-choice");
  if (!choice) return;
  setAvatar(selectedProfile()?.profile, choice.dataset.path, choice.dataset.name);
  for (const current of avatarGrid.querySelectorAll(".avatar-choice")) {
    current.classList.toggle("is-selected", current === choice);
  }
});

badgeLibrary.addEventListener("toggle", () => {
  if (badgeLibrary.open) loadBadges().catch(() => {
    badgePreview.innerHTML = '<p class="library-loading">The badge library could not be loaded.</p>';
  });
});

badgeSelector.addEventListener("change", () => {
  renderBadges();
  const set = badgeCatalog?.[Number(badgeSelector.value) || 0];
  if (set) syncMessage.textContent = `Previewing the ${set.label} badge set. This preview is not sent back to Cedar.`;
});

initialize().catch(() => {
  setState(
    hasInvitationFragment ? "Link unavailable" : "Service unavailable",
    hasInvitationFragment ? "This invitation could not be verified." : "Cedar Link is temporarily unavailable.",
    hasInvitationFragment
      ? "Return to Cedar and create a new browser link, then try again."
      : "Your Cedar profile and local device data are unaffected. Try again in a moment.",
  );
});
