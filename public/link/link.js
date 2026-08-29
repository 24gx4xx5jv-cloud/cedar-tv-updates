import {
  CedarSyncError,
  base64URLToBytes,
  bytesToBase64,
  bytesToBase64URL,
  createCompanionConfigurationPatchChange,
  createDeviceRequestChange,
  createProfilePresentationPatchChange,
  createRemoteCommandChange,
  createWebInvitation,
  fetchLatestProfile,
  normalizeUUID,
  parseWebInvitationFragment,
  sealEnvelope,
  uploadEnvelope,
  validateProfilePresentation,
  validateCompanionConfiguration,
} from "./cedar-sync.mjs?v=companion-4";

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
const profileEditor = document.querySelector("#profile-editor");
const profileNameInput = document.querySelector("#profile-name-input");
const profileTheme = document.querySelector("#profile-theme");
const saveProfileButton = document.querySelector("#save-profile");
const avatarLibrary = document.querySelector("#avatar-library");
const avatarSearch = document.querySelector("#avatar-search");
const avatarGrid = document.querySelector("#avatar-grid");
const avatarMore = document.querySelector("#avatar-more");
const badgeLibrary = document.querySelector("#badge-library");
const badgeSelector = document.querySelector("#badge-selector");
const badgeStatus = document.querySelector("#badge-status");
const badgePreview = document.querySelector("#badge-preview");
const companionTabs = document.querySelector(".companion-tabs");
const settingsEditor = document.querySelector("#settings-editor");
const metadataLanguage = document.querySelector("#metadata-language");
const topShelfPresentation = document.querySelector("#top-shelf-presentation");
const automaticallyPlayBest = document.querySelector("#automatically-play-best");
const automaticallyTryNext = document.querySelector("#automatically-try-next");
const quickPlayPosters = document.querySelector("#quick-play-posters");
const hideUnreleased = document.querySelector("#hide-unreleased");
const posterRatings = document.querySelector("#poster-ratings");
const topShelfActivity = document.querySelector("#top-shelf-activity");
const cleanLiveNames = document.querySelector("#clean-live-names");
const branchesEditor = document.querySelector("#branches-editor");
const branchEditorList = document.querySelector("#branch-editor-list");
const branchPreset = document.querySelector("#branch-preset");
const addBranchButton = document.querySelector("#add-branch");
const deviceList = document.querySelector("#device-list");
const createInvitationButton = document.querySelector("#create-invitation");
const forgetBrowserButton = document.querySelector("#forget-browser");
const invitationResult = document.querySelector("#invitation-result");
const invitationURL = document.querySelector("#invitation-url");
const copyInvitationButton = document.querySelector("#copy-invitation");
const remoteDevice = document.querySelector("#remote-device");
const remoteState = document.querySelector("#remote-state");
const remoteControls = document.querySelector("#remote-controls");
const refreshBottom = document.querySelector("#refresh-bottom");
const hasInvitationFragment = window.location.hash.length > 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AVATAR_PATH_PATTERN = /^\/avatars\/[a-z0-9_-]+\/[a-z0-9_-]+\.webp$/i;
const BADGE_PATH_PATTERN = /^\/badges\/[a-z0-9_-]+\/[a-z0-9_-]+\.webp$/i;
const BADGE_PACK_PATH_PATTERN = /^\/cedar-tv-updates\/badge-packs\/[a-z0-9_-]+\.json$/i;
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
let draftSpaceID = "";
let draftPresentation = null;
let isSavingProfile = false;
let isSavingCompanion = false;
let companionDraftSpaceID = "";
let companionDraftRevision = 0;
let companionDraft = null;
let syncInFlight = null;

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

const reserveOutboundSequence = (recordKey) => new Promise((resolve, reject) => {
  const transaction = database.transaction("profiles", "readwrite");
  const store = transaction.objectStore("profiles");
  const request = store.get(recordKey);
  let sequence = 0;
  let updatedRecord = null;
  request.onsuccess = () => {
    const current = request.result;
    if (!current || current.schemaVersion !== 1 || current.state !== "active") {
      transaction.abort();
      return;
    }
    const previous = Number.isSafeInteger(current.outboundSequence) && current.outboundSequence >= 0
      ? current.outboundSequence
      : 0;
    if (previous >= Number.MAX_SAFE_INTEGER) {
      transaction.abort();
      return;
    }
    sequence = previous + 1;
    updatedRecord = { ...current, outboundSequence: sequence };
    store.put(updatedRecord, recordKey);
  };
  request.onerror = () => reject(request.error || new Error("Browser storage failed."));
  transaction.oncomplete = () => resolve({ sequence, record: updatedRecord });
  transaction.onerror = () => reject(transaction.error || new Error("Browser storage failed."));
  transaction.onabort = () => reject(transaction.error || new Error("Browser storage failed."));
});

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
    outboundSequence: 0,
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
      const companionRecord = await readRecord(`companion:${credentials.spaceID}`);
      const cachedCompanion = companionRecord ? await decryptValue(companionRecord) : null;
      const linkedCompanion = cachedCompanion?.spaceID === credentials.spaceID
        ? cachedCompanion
        : null;
      const pendingRecord = await readRecord(`presentation-pending:${credentials.spaceID}`);
      const pendingPresentation = pendingRecord ? await decryptValue(pendingRecord) : null;
      const pending = pendingPresentation?.spaceID === credentials.spaceID
        ? pendingPresentation
        : null;
      const configurationPendingRecord = await readRecord(`configuration-pending:${credentials.spaceID}`);
      const cachedConfigurationPending = configurationPendingRecord
        ? await decryptValue(configurationPendingRecord)
        : null;
      const configurationPending = cachedConfigurationPending?.spaceID === credentials.spaceID
        ? cachedConfigurationPending
        : null;
      loaded.push({
        recordKey: entry.recordKey,
        record: entry.value,
        credentials,
        profile,
        companion: linkedCompanion,
        pending,
        configurationPending,
      });
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

const profileForItem = (item) => {
  if (item?.companion) {
    const presentation = item.companion.configuration.presentation;
    return {
      ...presentation,
      profileID: item.companion.profileID,
      snapshotRevision: item.companion.revision,
      syncedAt: item.companion.publishedAtEpochMilliseconds,
      avatarEditable: true,
      isKids: false,
    };
  }
  return item?.profile || null;
};

const relativeTime = (timestamp) => {
  if (!Number.isSafeInteger(timestamp)) return "Sync time unavailable";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 45) return "Synced just now";
  if (seconds < 3_600) return `Synced ${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `Synced ${Math.round(seconds / 3_600)} hr ago`;
  return `Synced ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
};

const presentationForProfile = (profile) => validateProfilePresentation({
  name: profile.name,
  avatarSymbol: profile.avatarSymbol,
  theme: profile.theme,
  badgeSelection: profile.badgeSelection,
});

const presentationsMatch = (left, right) => left?.name === right?.name
  && left?.avatarSymbol === right?.avatarSymbol
  && left?.theme === right?.theme
  && left?.badgeSelection === right?.badgeSelection;

const companionConfigurationsMatch = (left, right) => {
  if (!left || !right
    || !presentationsMatch(left.presentation, right.presentation)
    || JSON.stringify(left.settings) !== JSON.stringify(right.settings)
    || left.branches.length !== right.branches.length) return false;
  return left.branches.every((branch, index) => {
    const candidate = right.branches[index];
    return branch.id === candidate?.id
      && branch.title === candidate.title
      && branch.position === candidate.position
      && branch.isEnabled === candidate.isEnabled
      && branch.preset === candidate.preset;
  });
};

const resetDraft = (item) => {
  draftSpaceID = item?.credentials.spaceID || "";
  const profile = profileForItem(item);
  draftPresentation = profile ? presentationForProfile(profile) : null;
  profileNameInput.value = draftPresentation?.name || "";
  profileTheme.value = draftPresentation?.theme || "system";
  if (badgeCatalog) renderBadges();
};

const renderEditorState = () => {
  const item = selectedProfile();
  const profile = profileForItem(item);
  profileEditor.hidden = !profile;
  if (!profile) return;
  if (draftSpaceID !== item.credentials.spaceID || !draftPresentation) resetDraft(item);
  const unavailable = profile.avatarEditable !== true || !Number.isSafeInteger(profile.snapshotRevision);
  const pending = Boolean(item.pending || item.configurationPending);
  const normalizedName = profileNameInput.value.trim();
  const candidate = {
    ...draftPresentation,
    name: normalizedName,
    theme: profileTheme.value,
  };
  const validName = normalizedName.length > 0 && [...normalizedName].length <= 128;
  const changed = validName && !presentationsMatch(presentationForProfile(profile), candidate);
  for (const field of profileEditor.querySelectorAll("input, select, button")) {
    field.disabled = unavailable || pending || isSavingProfile || isSavingCompanion;
  }
  badgeSelector.disabled = unavailable || pending || isSavingProfile || isSavingCompanion || !badgeCatalog;
  saveProfileButton.disabled = unavailable || pending || isSavingProfile || isSavingCompanion || !changed;
  saveProfileButton.textContent = isSavingProfile || isSavingCompanion
    ? "Encrypting changes…"
    : pending
      ? "Waiting for Cedar confirmation"
      : "Send changes to Cedar";
  profileEditor.classList.toggle("is-pending", pending);
  profileEditor.classList.toggle("is-unavailable", unavailable);
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
    profileAvatar.classList.add("has-image");
  } else {
    avatarImage.removeAttribute("src");
    avatarImage.hidden = true;
    avatarFallback.hidden = false;
    profileAvatar.classList.remove("has-image");
  }
  profileAvatar.classList.toggle("is-preview", Boolean(previewPath));
  if (previewName) syncMessage.textContent = `${previewName} selected. Save the profile to send it to Cedar.`;
};

const renderProfileSelector = () => {
  profileSelector.replaceChildren();
  for (const item of activeProfiles) {
    const option = document.createElement("option");
    option.value = item.credentials.spaceID;
    option.textContent = profileForItem(item)?.name || "Waiting for profile";
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
  const currentProfile = profileForItem(item);
  if (!currentProfile) {
    profileName.textContent = "Waiting for your profile";
    profileKicker.textContent = "Browser linked";
    profileMeta.textContent = "Keep the owning Cedar app open for a moment";
    sourceCount.textContent = "—";
    branchCount.textContent = "—";
    shelfCount.textContent = "—";
    setAvatar({ name: "Cedar" });
    profileEditor.hidden = true;
    renderCompanionPanels(item);
    return;
  }
  const profile = currentProfile;
  profileName.textContent = profile.name;
  profileKicker.textContent = profile.isKids ? "Kids profile" : "Profile received";
  profileMeta.textContent = `${relativeTime(profile.syncedAt)} · ${profile.theme === "system" ? "System appearance" : `${profile.theme} appearance`}`;
  sourceCount.textContent = String(item.companion?.devices.length ?? 0);
  branchCount.textContent = String(
    item.companion?.configuration.branches.filter((branch) => branch.isEnabled).length
      ?? profile.enabledBranchCount
      ?? profile.branchCount
      ?? 0,
  );
  shelfCount.textContent = String(
    item.companion?.devices.filter((device) => device.supportsRemoteControl).length ?? 0,
  );
  const avatarPreview = draftSpaceID === item.credentials.spaceID
    && draftPresentation?.avatarSymbol !== profile.avatarSymbol
    ? localAvatarPath(draftPresentation.avatarSymbol)
    : null;
  setAvatar(profile, avatarPreview);
  renderEditorState();
  renderCompanionPanels(item);
};

const resetCompanionDraft = (item) => {
  companionDraftSpaceID = item?.credentials.spaceID || "";
  companionDraftRevision = item?.companion?.revision || 0;
  companionDraft = item?.companion
    ? structuredClone(item.companion.configuration)
    : null;
};

const ensureCompanionDraft = (item) => {
  if (!item?.companion) {
    resetCompanionDraft(item);
    return;
  }
  if (companionDraftSpaceID !== item.credentials.spaceID
    || companionDraftRevision !== item.companion.revision
    || !companionDraft) {
    resetCompanionDraft(item);
  }
};

const renderSettings = (item) => {
  ensureCompanionDraft(item);
  const settings = companionDraft?.settings;
  const unavailable = !settings || Boolean(item?.configurationPending) || isSavingCompanion;
  for (const field of settingsEditor.elements) field.disabled = unavailable;
  if (!settings) return;
  metadataLanguage.value = settings.metadataLanguageCode;
  topShelfPresentation.value = settings.topShelfPresentation;
  automaticallyPlayBest.checked = settings.automaticallyPlayBestSource;
  automaticallyTryNext.checked = settings.automaticallyTryNextBestSource;
  quickPlayPosters.checked = settings.quickPlayFromPosters;
  hideUnreleased.checked = settings.hideUnreleasedTitles;
  posterRatings.checked = settings.showsPosterCardRatings;
  topShelfActivity.checked = settings.showsTopShelfViewingActivity;
  cleanLiveNames.checked = settings.cleansUpLiveChannelNames;
};

const renderBranches = (item) => {
  ensureCompanionDraft(item);
  branchEditorList.replaceChildren();
  const unavailable = !companionDraft || Boolean(item?.configurationPending) || isSavingCompanion;
  addBranchButton.disabled = unavailable || (companionDraft?.branches.length ?? 50) >= 50;
  branchPreset.disabled = unavailable;
  branchesEditor.querySelector('button[type="submit"]').disabled = unavailable;
  if (!companionDraft) {
    const empty = document.createElement("li");
    empty.className = "library-loading";
    empty.textContent = "Waiting for a content-free companion snapshot from Cedar.";
    branchEditorList.append(empty);
    return;
  }
  companionDraft.branches.forEach((branch, index) => {
    const row = document.createElement("li");
    row.className = "branch-row";
    row.dataset.index = String(index);
    const grab = document.createElement("span");
    grab.className = "branch-grab";
    grab.textContent = "⋮⋮";
    grab.setAttribute("aria-hidden", "true");
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "library-search";
    titleInput.maxLength = 80;
    titleInput.value = branch.title;
    titleInput.disabled = unavailable;
    titleInput.setAttribute("aria-label", `Name for Home row ${index + 1}`);
    const buttons = document.createElement("span");
    buttons.className = "branch-buttons";
    for (const [action, label] of [["up", "Move up"], ["down", "Move down"]]) {
      const move = document.createElement("button");
      move.type = "button";
      move.dataset.action = action;
      move.textContent = action === "up" ? "↑" : "↓";
      move.setAttribute("aria-label", `${label}: ${branch.title}`);
      move.disabled = unavailable || (action === "up" ? index === 0 : index === companionDraft.branches.length - 1);
      buttons.append(move);
    }
    const enabled = document.createElement("label");
    enabled.className = "branch-enabled";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = branch.isEnabled;
    checkbox.disabled = unavailable;
    checkbox.dataset.action = "enabled";
    enabled.append(checkbox, document.createTextNode("Show this row on Cedar devices"));
    row.append(grab, titleInput, buttons, enabled);
    branchEditorList.append(row);
  });
};

const devicePlatformLabel = (platform) => ({ apple: "Apple", android: "Android", browser: "Browser" })[platform] || "Cedar";

const renderDevices = (item) => {
  deviceList.replaceChildren();
  const devices = item?.companion?.devices || [];
  if (devices.length === 0) {
    const empty = document.createElement("li");
    empty.className = "library-loading";
    empty.textContent = "Waiting for the owning Cedar app to publish linked devices.";
    deviceList.append(empty);
    return;
  }
  for (const device of devices) {
    const row = document.createElement("li");
    row.className = "device-row";
    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = device.displayName;
    const meta = document.createElement("small");
    meta.textContent = `${devicePlatformLabel(device.platform)} · ${device.isCurrent ? "Owner device" : relativeTime(device.lastSeenAtEpochMilliseconds).replace("Synced", "Seen")}`;
    details.append(name, meta);
    const actions = document.createElement("span");
    actions.className = "device-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.dataset.action = "rename";
    rename.dataset.deviceID = device.id;
    rename.textContent = "Rename";
    rename.disabled = Boolean(item.configurationPending || isSavingCompanion);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "danger-button";
    revoke.dataset.action = "revoke";
    revoke.dataset.deviceID = device.id;
    revoke.textContent = "Revoke";
    revoke.disabled = device.id === item.credentials.deviceID || device.isCurrent || Boolean(item.configurationPending || isSavingCompanion);
    actions.append(rename, revoke);
    row.append(details, actions);
    deviceList.append(row);
  }
};

const renderRemote = (item) => {
  const previous = remoteDevice.value;
  remoteDevice.replaceChildren();
  const devices = (item?.companion?.devices || []).filter((device) => device.supportsRemoteControl);
  for (const device of devices) {
    const option = document.createElement("option");
    option.value = device.id;
    option.textContent = device.displayName;
    remoteDevice.append(option);
  }
  if (devices.some((device) => device.id === previous)) remoteDevice.value = previous;
  const statusValue = item?.companion?.remoteStatuses.find((status) => status.deviceID === remoteDevice.value);
  remoteDevice.disabled = devices.length === 0 || isSavingCompanion;
  if (!statusValue) remoteState.textContent = devices.length ? "Waiting for transport status from this Cedar device." : "No remote-capable Cedar device is linked yet.";
  else if (!statusValue.isOnline) remoteState.textContent = "Offline · Open Cedar on this device to receive commands.";
  else remoteState.textContent = `${statusValue.isPlaying ? "Playing" : "Paused"}${statusValue.isLive ? " · Live mode" : ""} · No content details shared`;
  for (const control of remoteControls.querySelectorAll("button")) {
    control.disabled = !statusValue?.isOnline
      || !statusValue.supportedCommands.includes(control.dataset.command)
      || isSavingCompanion;
  }
};

const renderCompanionPanels = (item) => {
  renderSettings(item);
  renderBranches(item);
  renderDevices(item);
  renderRemote(item);
};

const persistSyncResult = async (item, result) => {
  const updatedRecord = { ...item.record, cursor: result.cursor, lastCheckedAt: Date.now() };
  const entries = [[item.recordKey, updatedRecord]];
  let reconciliation = null;
  let companionReconciliation = null;
  if (result.profile) {
    entries.push([`snapshot:${item.credentials.spaceID}`, {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      ...await encryptValue(result.profile),
    }]);
    if (item.pending && result.profile.snapshotRevision > item.pending.baseRevision) {
      reconciliation = presentationsMatch(
        presentationForProfile(result.profile),
        item.pending.replacement,
      ) ? "applied" : "rejected";
    }
  }
  if (result.companion) {
    entries.push([`companion:${item.credentials.spaceID}`, {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      ...await encryptValue(result.companion),
    }]);
    if (item.configurationPending && result.companion.revision > item.configurationPending.baseRevision) {
      companionReconciliation = companionConfigurationsMatch(
        result.companion.configuration,
        item.configurationPending.replacement,
      )
        ? "applied"
        : "rejected";
    }
  }
  await writeRecords(entries);
  item.record = updatedRecord;
  if (result.profile) item.profile = result.profile;
  if (result.companion) item.companion = result.companion;
  if (reconciliation) {
    await deleteRecord(`presentation-pending:${item.credentials.spaceID}`);
    item.pending = null;
    resetDraft(item);
  } else if (result.profile && !item.pending) {
    // A newer canonical native snapshot invalidates any unsaved stale browser draft.
    resetDraft(item);
  }
  if (companionReconciliation) {
    await deleteRecord(`configuration-pending:${item.credentials.spaceID}`);
    item.configurationPending = null;
    resetCompanionDraft(item);
    resetDraft(item);
  } else if (result.companion && !item.configurationPending) {
    resetCompanionDraft(item);
    resetDraft(item);
  }
  return companionReconciliation || reconciliation;
};

const performSelectedProfileSync = async ({ poll = false } = {}) => {
  const item = selectedProfile();
  if (!item) return;
  refreshButton.disabled = true;
  refreshButton.classList.add("is-refreshing");
  companionState.textContent = "Checking Cedar Sync";
  syncMessage.classList.remove("is-error", "is-success");
  syncMessage.textContent = profileForItem(item)
    ? "Checking for newer encrypted companion state…"
    : "Waiting for the first encrypted upload from a Cedar device…";
  const delays = poll ? [0, 1_800, 3_000, 5_000, 8_000, 12_000] : [0];
  try {
    for (const delay of delays) {
      if (delay) await sleep(delay);
      // Profiles cached by the first read-only companion did not include a snapshot revision.
      // Replay the encrypted log once so those existing linked browsers become safely editable.
      const startingCursor = Number.isSafeInteger(item.companion?.revision ?? item.profile?.snapshotRevision)
        ? item.record.cursor || 0
        : 0;
      const result = await fetchLatestProfile(item.credentials, startingCursor);
      const reconciliation = await persistSyncResult(item, result);
      renderCompanion();
      if (reconciliation === "applied") {
        companionState.textContent = "Cedar Link connected";
        syncMessage.textContent = "Profile edit confirmed by the owning Cedar app.";
        syncMessage.classList.add("is-success");
        return;
      }
      if (reconciliation === "rejected") {
        companionState.textContent = "Cedar kept the newer profile";
        syncMessage.textContent = "This edit was based on an older profile. Cedar kept the newer native version.";
        syncMessage.classList.add("is-error");
        return;
      }
      if (item.pending || item.configurationPending) {
        companionState.textContent = "Waiting for Cedar confirmation";
        syncMessage.textContent = "The encrypted edit is at the relay. Open the owning Cedar app; it will validate, apply, and publish the result.";
        return;
      }
      if (profileForItem(item)) {
        companionState.textContent = "Cedar Link connected";
        syncMessage.textContent = item.companion
          ? "Encrypted companion state authenticated. Cedar Link remains configuration and control only."
          : "Encrypted profile authenticated. Waiting for Cedar's companion update.";
        syncMessage.classList.add("is-success");
        return;
      }
    }
    companionState.textContent = "Browser linked";
    syncMessage.textContent = "No companion upload has arrived yet. Keep the owning Cedar app open, then tap refresh.";
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

const syncSelectedProfile = (options = {}) => {
  if (syncInFlight) return syncInFlight;
  syncInFlight = performSelectedProfileSync(options).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
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
  const item = selectedProfile();
  const avatarEditingUnavailable = profileForItem(item)?.avatarEditable !== true;
  for (const avatar of avatarMatches.slice(0, visibleAvatarCount)) {
    const choice = document.createElement("button");
    choice.className = "avatar-choice";
    choice.type = "button";
    choice.title = avatar.name;
    choice.dataset.path = `..${avatar.url}`;
    choice.dataset.name = avatar.name;
    choice.dataset.value = new URL(`..${avatar.url}`, location.href).href;
    choice.classList.toggle("is-selected", choice.dataset.value === draftPresentation?.avatarSymbol);
    choice.disabled = Boolean(item?.pending || item?.configurationPending || isSavingProfile || isSavingCompanion || avatarEditingUnavailable);
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
  const response = await fetch("../catalogs/badges.json?v=selectable-1", {
    cache: "force-cache",
    credentials: "omit",
  });
  if (!response.ok) throw new Error("badge catalog unavailable");
  const value = await response.json();
  if (!Array.isArray(value.sets)) throw new Error("badge catalog invalid");
  badgeCatalog = value.sets.filter((set) => {
    if (!Array.isArray(set?.badges) || typeof set?.label !== "string" || typeof set?.sourceURL !== "string") return false;
    try {
      const source = new URL(set.sourceURL);
      return source.protocol === "https:"
        && source.origin === "https://24gx4xx5jv-cloud.github.io"
        && BADGE_PACK_PATH_PATTERN.test(source.pathname);
    } catch {
      return false;
    }
  });
  renderBadges();
};

const addBadgeOption = (parent, value, label, { current = false, installed = false } = {}) => {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = `${label}${current ? " · Current" : installed ? " · Installed" : ""}`;
  parent.append(option);
};

const renderBadges = () => {
  const item = selectedProfile();
  const profile = profileForItem(item);
  const installed = Array.isArray(profile?.installedBadgePacks) ? profile.installedBadgePacks : [];
  const currentSelection = profile?.badgeSelection || "builtIn";
  const selected = draftPresentation?.badgeSelection || currentSelection;

  badgeSelector.replaceChildren();
  const cedarOptions = document.createElement("optgroup");
  cedarOptions.label = "Cedar";
  addBadgeOption(cedarOptions, "builtIn", "Cedar built-in badges", {
    current: currentSelection === "builtIn",
  });
  addBadgeOption(cedarOptions, "none", "Badges off", { current: currentSelection === "none" });
  badgeSelector.append(cedarOptions);

  const catalogSources = new Set(badgeCatalog?.map((set) => set.sourceURL) || []);
  const otherInstalled = installed.filter((pack) => !catalogSources.has(pack.sourceURL));
  if (otherInstalled.length > 0) {
    const installedOptions = document.createElement("optgroup");
    installedOptions.label = "Installed in Cedar";
    for (const pack of otherInstalled) {
      addBadgeOption(installedOptions, pack.sourceURL, pack.name, {
        current: currentSelection === pack.sourceURL,
        installed: true,
      });
    }
    badgeSelector.append(installedOptions);
  }

  const libraryOptions = document.createElement("optgroup");
  libraryOptions.label = "Cedar badge library";
  for (const set of badgeCatalog || []) {
    addBadgeOption(libraryOptions, set.sourceURL, `${set.label} · ${set.creator || "Community"}`, {
      current: currentSelection === set.sourceURL,
      installed: installed.some((pack) => pack.sourceURL === set.sourceURL),
    });
  }
  badgeSelector.append(libraryOptions);
  badgeSelector.value = selected;
  if (badgeSelector.value !== selected) badgeSelector.value = currentSelection;
  badgeSelector.disabled = !profile
    || profile.avatarEditable !== true
    || Boolean(item?.pending || item?.configurationPending || isSavingProfile || isSavingCompanion);

  const currentSet = badgeCatalog?.find((set) => set.sourceURL === currentSelection);
  const currentInstalled = installed.find((pack) => pack.sourceURL === currentSelection);
  const currentLabel = currentSelection === "none"
    ? "Badges off"
    : currentSelection === "builtIn"
      ? "Cedar built-in badges"
      : currentSet?.label || currentInstalled?.name || "Custom badge set";
  badgeStatus.textContent = installed.length > 0
    ? `Current in Cedar: ${currentLabel} · ${installed.length} custom ${installed.length === 1 ? "set" : "sets"} installed`
    : `Current in Cedar: ${currentLabel} · No custom sets installed`;

  const set = badgeCatalog?.find((value) => value.sourceURL === badgeSelector.value);
  badgePreview.replaceChildren();
  if (!set) {
    const note = document.createElement("p");
    note.className = "library-loading";
    note.textContent = badgeSelector.value === "none"
      ? "Technical badges will be hidden."
      : badgeSelector.value === "builtIn"
        ? "Cedar's built-in technical badges will be used."
        : "This installed badge pack is available in Cedar.";
    badgePreview.append(note);
    return;
  }
  for (const badge of set.badges.filter((item) => item?.enabled !== false).slice(0, 8)) {
    if (typeof badge.imageURL !== "string" || !BADGE_PATH_PATTERN.test(badge.imageURL)) continue;
    const image = document.createElement("img");
    image.src = `..${badge.imageURL}`;
    image.alt = badge.name || "Badge";
    image.loading = "lazy";
    badgePreview.append(image);
  }
};

const uploadCompanionChange = async (item, makeChange) => {
  const reservation = await reserveOutboundSequence(item.recordKey);
  item.record = reservation.record;
  const submittedAt = Date.now();
  const change = makeChange(reservation.sequence, submittedAt);
  const envelope = await sealEnvelope(change, item.credentials, reservation.sequence, {
    createdAtEpochMilliseconds: submittedAt,
  });
  await uploadEnvelope(item.credentials, envelope);
  return submittedAt;
};

const saveCompanionConfiguration = async (replacementValue, successMessage) => {
  const item = selectedProfile();
  if (!item?.companion || item.configurationPending || isSavingCompanion) return;
  const replacement = validateCompanionConfiguration(replacementValue);
  isSavingCompanion = true;
  syncMessage.classList.remove("is-error", "is-success");
  syncMessage.textContent = "Encrypting this configuration update for Cedar…";
  renderCompanion();
  try {
    const submittedAt = await uploadCompanionChange(item, (sequence, createdAt) => (
      createCompanionConfigurationPatchChange(item.companion, replacement, sequence, createdAt)
    ));
    const pending = {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      profileID: item.companion.profileID,
      baseRevision: item.companion.revision,
      submittedAt,
      replacement,
    };
    await writeRecord(`configuration-pending:${item.credentials.spaceID}`, {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      ...await encryptValue(pending),
    });
    item.configurationPending = pending;
    companionDraft = structuredClone(replacement);
    companionState.textContent = "Waiting for Cedar confirmation";
    syncMessage.textContent = successMessage;
    syncMessage.classList.add("is-success");
  } catch (error) {
    companionState.textContent = "Sync needs attention";
    syncMessage.textContent = error instanceof CedarSyncError
      ? error.message
      : "The encrypted companion update could not be sent. Try again.";
    syncMessage.classList.add("is-error");
  } finally {
    isSavingCompanion = false;
    renderCompanion();
  }
};

const sendDeviceAction = async (targetDeviceID, action, displayName = null) => {
  const item = selectedProfile();
  if (!item?.companion || isSavingCompanion) return;
  isSavingCompanion = true;
  renderCompanionPanels(item);
  try {
    await uploadCompanionChange(item, (sequence, createdAtEpochMilliseconds) => (
      createDeviceRequestChange(item.companion, targetDeviceID, action, sequence, {
        displayName,
        createdAtEpochMilliseconds,
      })
    ));
    companionState.textContent = "Owner action requested";
    syncMessage.textContent = action === "revoke"
      ? "Encrypted revoke request sent. The owning Cedar app will validate and complete it."
      : "Encrypted rename request sent. The owning Cedar app will validate and publish it.";
    syncMessage.classList.add("is-success");
    await syncSelectedProfile({ poll: true });
  } catch (error) {
    syncMessage.textContent = error instanceof CedarSyncError ? error.message : "The device request could not be sent.";
    syncMessage.classList.add("is-error");
  } finally {
    isSavingCompanion = false;
    renderCompanionPanels(item);
  }
};

const sendRemoteCommand = async (command) => {
  const item = selectedProfile();
  if (!item?.companion || !remoteDevice.value || isSavingCompanion) return;
  isSavingCompanion = true;
  renderRemote(item);
  try {
    await uploadCompanionChange(item, (sequence, createdAtEpochMilliseconds) => (
      createRemoteCommandChange(
        item.companion,
        remoteDevice.value,
        command,
        sequence,
        createdAtEpochMilliseconds,
      )
    ));
    companionState.textContent = "Remote command sent";
    syncMessage.textContent = "The encrypted transport command was sent to Cedar. No media was sent to this browser.";
    syncMessage.classList.add("is-success");
    await syncSelectedProfile({ poll: true });
  } catch (error) {
    syncMessage.textContent = error instanceof CedarSyncError ? error.message : "The remote command could not be sent.";
    syncMessage.classList.add("is-error");
  } finally {
    isSavingCompanion = false;
    renderRemote(item);
  }
};

const saveProfilePresentation = async () => {
  const item = selectedProfile();
  const profile = profileForItem(item);
  if (!profile || item.pending || item.configurationPending || isSavingProfile || !draftPresentation) return;
  const replacement = validateProfilePresentation({
    ...draftPresentation,
    name: profileNameInput.value.trim(),
    theme: profileTheme.value,
  });
  if (presentationsMatch(presentationForProfile(profile), replacement)) return;

  if (item.companion) {
    await saveCompanionConfiguration({
      ...item.companion.configuration,
      presentation: replacement,
    }, "Profile update sent securely. Open the owning Cedar app to validate and publish it.");
    return;
  }

  isSavingProfile = true;
  syncMessage.classList.remove("is-error", "is-success");
  syncMessage.textContent = "Encrypting this profile edit for the owning Cedar app…";
  renderEditorState();
  try {
    const reservation = await reserveOutboundSequence(item.recordKey);
    item.record = reservation.record;
    const submittedAt = Date.now();
    const change = createProfilePresentationPatchChange(
      profile,
      replacement,
      reservation.sequence,
      submittedAt,
    );
    const envelope = await sealEnvelope(change, item.credentials, reservation.sequence, {
      createdAtEpochMilliseconds: submittedAt,
    });
    await uploadEnvelope(item.credentials, envelope);
    const pending = {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      profileID: profile.profileID,
      baseRevision: profile.snapshotRevision,
      submittedAt,
      replacement,
    };
    await writeRecord(`presentation-pending:${item.credentials.spaceID}`, {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      ...await encryptValue(pending),
    });
    item.pending = pending;
    draftPresentation = replacement;
    companionState.textContent = "Waiting for Cedar confirmation";
    syncMessage.textContent = "Edit sent securely. Open the owning Cedar app; it will apply the edit and publish confirmation.";
    syncMessage.classList.add("is-success");
  } catch (error) {
    companionState.textContent = "Sync needs attention";
    syncMessage.textContent = error instanceof CedarSyncError
      ? error.message
      : "The encrypted profile edit could not be sent. Try again.";
    syncMessage.classList.add("is-error");
  } finally {
    isSavingProfile = false;
    renderEditorState();
    if (avatarCatalog) renderAvatars();
    if (badgeCatalog) renderBadges();
  }
};

const initialize = async () => {
  const configResponse = await fetch("../sync-config.json", { cache: "no-store", credentials: "omit" });
  if (!configResponse.ok) throw new Error("configuration unavailable");
  const config = await configResponse.json();
  if (config.schemaVersion !== 1) throw new Error("configuration unavailable");
  relayBaseURL = config.relayBaseURL ? normalizeRelay(config.relayBaseURL) : "";
  invitation = parseWebInvitationFragment(window.location.hash);
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
refreshBottom.addEventListener("click", () => syncSelectedProfile());

companionTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("button[data-panel]");
  if (!tab) return;
  for (const buttonValue of companionTabs.querySelectorAll("button[data-panel]")) {
    buttonValue.setAttribute("aria-selected", String(buttonValue === tab));
  }
  for (const panel of companion.querySelectorAll("[data-companion-panel]")) {
    panel.hidden = panel.dataset.companionPanel !== tab.dataset.panel;
  }
});

profileEditor.addEventListener("submit", (event) => {
  event.preventDefault();
  saveProfilePresentation();
});

profileNameInput.addEventListener("input", renderEditorState);
profileTheme.addEventListener("change", renderEditorState);

profileSelector.addEventListener("change", async () => {
  selectedSpaceID = profileSelector.value;
  draftSpaceID = "";
  draftPresentation = null;
  companionDraftSpaceID = "";
  companionDraftRevision = 0;
  companionDraft = null;
  renderCompanion();
  await syncSelectedProfile();
});

settingsEditor.addEventListener("submit", (event) => {
  event.preventDefault();
  const item = selectedProfile();
  if (!item?.companion) return;
  const replacement = structuredClone(item.companion.configuration);
  replacement.settings = {
    metadataLanguageCode: metadataLanguage.value.trim(),
    automaticallyPlayBestSource: automaticallyPlayBest.checked,
    automaticallyTryNextBestSource: automaticallyTryNext.checked,
    quickPlayFromPosters: quickPlayPosters.checked,
    hideUnreleasedTitles: hideUnreleased.checked,
    showsPosterCardRatings: posterRatings.checked,
    topShelfPresentation: topShelfPresentation.value,
    showsTopShelfViewingActivity: topShelfActivity.checked,
    cleansUpLiveChannelNames: cleanLiveNames.checked,
  };
  saveCompanionConfiguration(
    replacement,
    "Settings sent securely. Open the owning Cedar app to validate and publish them.",
  );
});

branchEditorList.addEventListener("input", (event) => {
  const row = event.target.closest(".branch-row");
  if (!row || !companionDraft) return;
  const index = Number(row.dataset.index);
  if (!Number.isInteger(index) || !companionDraft.branches[index]) return;
  if (event.target.matches('input[type="text"]')) companionDraft.branches[index].title = event.target.value;
  if (event.target.matches('input[data-action="enabled"]')) companionDraft.branches[index].isEnabled = event.target.checked;
});

branchEditorList.addEventListener("click", (event) => {
  const buttonValue = event.target.closest("button[data-action]");
  const row = event.target.closest(".branch-row");
  if (!buttonValue || !row || !companionDraft) return;
  const index = Number(row.dataset.index);
  const destination = buttonValue.dataset.action === "up" ? index - 1 : index + 1;
  if (destination < 0 || destination >= companionDraft.branches.length) return;
  [companionDraft.branches[index], companionDraft.branches[destination]] = [
    companionDraft.branches[destination],
    companionDraft.branches[index],
  ];
  companionDraft.branches.forEach((branch, branchIndex) => { branch.position = branchIndex; });
  renderBranches(selectedProfile());
});

addBranchButton.addEventListener("click", () => {
  const item = selectedProfile();
  ensureCompanionDraft(item);
  if (!companionDraft || companionDraft.branches.length >= 50) return;
  const preset = branchPreset.value;
  const labels = {
    "continue-watching": "Continue Watching",
    favorites: "Favorites",
    watchlist: "Watchlist",
    trending: "Trending",
    popular: "Popular",
    "top-rated": "Top Rated",
    "coming-soon": "Coming Soon",
  };
  companionDraft.branches.push({
    id: crypto.randomUUID().toLowerCase(),
    title: labels[preset] || "Cedar Row",
    position: companionDraft.branches.length,
    isEnabled: true,
    preset,
    sourceKind: "catalog",
    presentationKind: "row",
  });
  renderBranches(item);
});

branchesEditor.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!companionDraft) return;
  saveCompanionConfiguration(
    companionDraft,
    "Home changes sent securely. Cedar will configure the rows without sending their content here.",
  );
});

deviceList.addEventListener("click", (event) => {
  const actionButton = event.target.closest("button[data-action][data-device-id]");
  if (!actionButton) return;
  const item = selectedProfile();
  const device = item?.companion?.devices.find((value) => value.id === actionButton.dataset.deviceId);
  if (!device) return;
  if (actionButton.dataset.action === "rename") {
    const displayName = window.prompt("Name this linked Cedar device", device.displayName)?.trim();
    if (displayName && displayName !== device.displayName) sendDeviceAction(device.id, "rename", displayName);
    return;
  }
  if (window.confirm(`Revoke Cedar Link access for “${device.displayName}”? The owning Cedar app must complete this request.`)) {
    sendDeviceAction(device.id, "revoke");
  }
});

createInvitationButton.addEventListener("click", async () => {
  const item = selectedProfile();
  if (!item || createInvitationButton.disabled) return;
  createInvitationButton.disabled = true;
  createInvitationButton.textContent = "Creating encrypted link…";
  try {
    const result = await createWebInvitation(item.credentials, window.location.href);
    invitationURL.value = result.url;
    invitationResult.hidden = false;
    syncMessage.textContent = "One-use invitation created. It expires in 10 minutes; share it only with a device you trust.";
    syncMessage.classList.add("is-success");
  } catch (error) {
    syncMessage.textContent = error instanceof CedarSyncError ? error.message : "The one-use invitation could not be created.";
    syncMessage.classList.add("is-error");
  } finally {
    createInvitationButton.disabled = false;
    createInvitationButton.textContent = "Create one-use link";
  }
});

copyInvitationButton.addEventListener("click", async () => {
  if (!invitationURL.value) return;
  try {
    await navigator.clipboard.writeText(invitationURL.value);
    copyInvitationButton.textContent = "Copied";
    setTimeout(() => { copyInvitationButton.textContent = "Copy link"; }, 2_000);
  } catch {
    invitationURL.select();
    syncMessage.textContent = "Copy is unavailable in this browser. The invitation link is selected.";
  }
});

forgetBrowserButton.addEventListener("click", async () => {
  const item = selectedProfile();
  if (!item || !window.confirm("Forget this Cedar Link profile in this browser? This removes its protected local key and cannot be undone here.")) return;
  for (const recordKey of [
    item.recordKey,
    `snapshot:${item.credentials.spaceID}`,
    `companion:${item.credentials.spaceID}`,
    `presentation-pending:${item.credentials.spaceID}`,
    `configuration-pending:${item.credentials.spaceID}`,
  ]) await deleteRecord(recordKey);
  activeProfiles = activeProfiles.filter((value) => value !== item);
  selectedSpaceID = activeProfiles[0]?.credentials.spaceID || "";
  if (activeProfiles.length) {
    renderCompanion();
    await syncSelectedProfile();
  } else {
    window.location.reload();
  }
});

remoteDevice.addEventListener("change", () => renderRemote(selectedProfile()));
remoteControls.addEventListener("click", (event) => {
  const commandButton = event.target.closest("button[data-command]");
  if (commandButton && !commandButton.disabled) sendRemoteCommand(commandButton.dataset.command);
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
  const item = selectedProfile();
  const currentProfile = profileForItem(item);
  if (
    !choice
    || !currentProfile
    || currentProfile.avatarEditable !== true
    || item.pending
    || item.configurationPending
    || isSavingProfile
    || !draftPresentation
  ) return;
  draftPresentation = { ...draftPresentation, avatarSymbol: choice.dataset.value };
  setAvatar(currentProfile, choice.dataset.path, choice.dataset.name);
  for (const current of avatarGrid.querySelectorAll(".avatar-choice")) {
    current.classList.toggle("is-selected", current === choice);
  }
  renderEditorState();
});

badgeLibrary.addEventListener("toggle", () => {
  if (badgeLibrary.open) loadBadges().catch(() => {
    badgePreview.innerHTML = '<p class="library-loading">The badge library could not be loaded.</p>';
  });
});

badgeSelector.addEventListener("change", () => {
  const item = selectedProfile();
  if (!profileForItem(item) || item.pending || item.configurationPending || isSavingProfile || !draftPresentation) return;
  draftPresentation = { ...draftPresentation, badgeSelection: badgeSelector.value };
  renderBadges();
  renderEditorState();
  const set = badgeCatalog?.find((value) => value.sourceURL === badgeSelector.value);
  const label = badgeSelector.value === "none"
    ? "Badges off"
    : badgeSelector.value === "builtIn"
      ? "Cedar built-in badges"
      : set?.label || "Installed badge set";
  syncMessage.classList.remove("is-error", "is-success");
  syncMessage.textContent = `${label} selected. Save the profile to send it to Cedar.`;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && selectedProfile()) syncSelectedProfile();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted && selectedProfile()) syncSelectedProfile();
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
