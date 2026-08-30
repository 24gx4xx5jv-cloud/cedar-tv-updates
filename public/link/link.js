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
  fetchLatestCompanion,
  normalizeUUID,
  parseWebInvitationFragment,
  sealEnvelope,
  uploadEnvelope,
  validateCompanionClaimResult,
  validateProfilePresentation,
  validateCompanionConfiguration,
} from "./cedar-sync.mjs?v=companion-5";
import {
  companionConfigurationsMatch,
  companionDraftDirtySections,
  companionDraftIsDirty,
  companionDraftValidationIssues,
  createCompanionDraftForState,
  describeDirtySections,
  discardCompanionDraftChanges,
  filterAvatarCatalog,
  reconcileCompanionDraft,
  updateCompanionDraftSection,
} from "./companion-draft.mjs?v=workspace-1";
import {
  renderDeviceList,
  renderHomeBranches,
  renderRemoteControls,
} from "./companion-ui.mjs?v=workspace-1";

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
const invitationExpiry = document.querySelector("#invitation-expiry");
const revealInvitationButton = document.querySelector("#reveal-invitation");
const copyInvitationButton = document.querySelector("#copy-invitation");
const remoteDevice = document.querySelector("#remote-device");
const remoteState = document.querySelector("#remote-state");
const remoteControls = document.querySelector("#remote-controls");
const refreshBottom = document.querySelector("#refresh-bottom");
const companionSavebar = document.querySelector("#companion-savebar");
const companionDirtySummary = document.querySelector("#companion-dirty-summary");
const discardCompanionChangesButton = document.querySelector("#discard-companion-changes");
const saveCompanionChangesButton = document.querySelector("#save-companion-changes");
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
let avatarCatalogPromise = null;
let avatarMatches = [];
let visibleAvatarCount = 24;
let badgeCatalog = null;
let draftSpaceID = "";
let draftPresentation = null;
let isSavingProfile = false;
let isSavingCompanion = false;
let isForgettingProfile = false;
let isCreatingInvitation = false;
const companionDrafts = new Map();
const syncInFlightBySpace = new Map();
const profileOperationGenerations = new Map();
let currentInvitationURL = "";
let currentInvitationSpaceID = "";
let currentInvitationExpiresAt = 0;
let invitationCountdownTimer = null;
let invitationRevealTimer = null;

const profileOperationGeneration = (spaceID) => profileOperationGenerations.get(spaceID) || 0;

const profileOperationIsCurrent = (item, generation) => Boolean(
  item
  && activeProfiles.includes(item)
  && profileOperationGeneration(item.credentials.spaceID) === generation
);

const invalidateProfileOperations = (spaceID) => {
  const nextGeneration = profileOperationGeneration(spaceID) + 1;
  profileOperationGenerations.set(spaceID, nextGeneration);
  return nextGeneration;
};

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

const invitationFromFragment = () => {
  if (!window.location.hash) return null;
  const fragment = window.location.hash;
  // Remove secret material before the first network request, user interaction, or async yield.
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return parseWebInvitationFragment(fragment);
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

const deleteRecords = async (recordKeys) => {
  const transaction = database.transaction("profiles", "readwrite");
  const store = transaction.objectStore("profiles");
  for (const recordKey of recordKeys) store.delete(recordKey);
  await transactionDone(transaction);
};

const deleteRecord = (recordKey) => deleteRecords([recordKey]);

const writeSyncRecords = (item, cursor, entries, deletedRecordKeys = []) => new Promise((resolve, reject) => {
  const transaction = database.transaction("profiles", "readwrite");
  const store = transaction.objectStore("profiles");
  const request = store.get(item.recordKey);
  let updatedRecord = null;
  request.onsuccess = () => {
    const current = request.result;
    if (!current || current.schemaVersion !== 1 || current.state !== "active") {
      transaction.abort();
      return;
    }
    // Merge the cursor into the record inside the same transaction so a concurrent
    // outbound sequence reservation can never be rolled back by a refresh.
    updatedRecord = { ...current, cursor, lastCheckedAt: Date.now() };
    store.put(updatedRecord, item.recordKey);
    for (const [recordKey, value] of entries) store.put(value, recordKey);
    for (const recordKey of deletedRecordKeys) store.delete(recordKey);
  };
  request.onerror = () => reject(request.error || new Error("Browser storage failed."));
  transaction.oncomplete = () => resolve(updatedRecord);
  transaction.onerror = () => reject(transaction.error || new Error("Browser storage failed."));
  transaction.onabort = () => reject(transaction.error || new Error("Browser storage failed."));
});

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
    scope: "companion",
    relayBaseURL: currentInvitation.relayBaseURL,
    spaceID: currentInvitation.spaceID,
    ownerDeviceID: currentInvitation.ownerDeviceID,
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
    return validateCompanionClaimResult(result, secrets, currentInvitation.ownerDeviceID);
  } finally {
    clearTimeout(timeout);
    deviceToken.fill(0);
  }
};

const activate = async (pendingKey, secrets, baseline) => {
  const encrypted = await encryptValue(secrets);
  const entries = [[`space:${secrets.spaceID}`, {
    schemaVersion: 1,
    spaceID: secrets.spaceID,
    deviceID: secrets.deviceID,
    relayBaseURL: secrets.relayBaseURL,
    state: "active",
    linkedAt: Date.now(),
    cursor: baseline.highWaterCursor,
    outboundSequence: 0,
    ...encrypted,
  }]];
  if (baseline.companion) {
    entries.push([`companion:${secrets.spaceID}`, {
      schemaVersion: 1,
      spaceID: secrets.spaceID,
      ...await encryptValue(baseline.companion),
    }]);
  }
  await writeRecords(entries);
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
      if (credentials.scope !== "companion" || !UUID_PATTERN.test(credentials.ownerDeviceID || "")) continue;
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

const resetCompanionDraft = (item) => {
  if (!item?.companion) {
    if (item?.credentials?.spaceID) companionDrafts.delete(item.credentials.spaceID);
    return null;
  }
  const draft = createCompanionDraftForState(
    item.credentials.spaceID,
    item.companion.revision,
    item.companion.configuration,
    item.configurationPending?.replacement,
  );
  companionDrafts.set(item.credentials.spaceID, draft);
  return draft;
};

const ensureCompanionDraft = (item) => {
  if (!item?.companion) return resetCompanionDraft(item);
  const spaceID = item.credentials.spaceID;
  const current = companionDrafts.get(spaceID);
  const reconciled = reconcileCompanionDraft(
    current,
    spaceID,
    item.companion.revision,
    item.companion.configuration,
  );
  if (reconciled !== current) companionDrafts.set(spaceID, reconciled);
  return reconciled;
};

const setCompanionDraftSection = (item, section, value) => {
  const current = ensureCompanionDraft(item);
  if (!current) return null;
  const updated = updateCompanionDraftSection(current, section, value);
  companionDrafts.set(item.credentials.spaceID, updated);
  return updated;
};

const pendingComparison = (item) => item?.configurationPending?.replacement
  || item?.companion?.configuration
  || null;

const dirtyCompanionSections = (item) => {
  const draft = ensureCompanionDraft(item);
  return draft ? companionDraftDirtySections(draft, pendingComparison(item)) : [];
};

const hasDirtyCompanionChanges = (item) => dirtyCompanionSections(item).length > 0;

const hasDirtyLegacyPresentation = (item) => {
  const profile = profileForItem(item);
  return !item?.companion
    && draftSpaceID === item?.credentials.spaceID
    && Boolean(draftPresentation && profile)
    && !presentationsMatch(draftPresentation, presentationForProfile(profile));
};

const hasUnsavedEditorChanges = (item) => (
  hasDirtyCompanionChanges(item) || hasDirtyLegacyPresentation(item)
);

const renderCompanionSaveState = (item) => {
  const draft = ensureCompanionDraft(item);
  const dirtySections = dirtyCompanionSections(item);
  const pending = Boolean(item?.configurationPending);
  const saving = isSavingCompanion || isSavingProfile;
  const busy = saving || isForgettingProfile;
  const visible = Boolean(draft && (dirtySections.length > 0 || pending || busy));
  if (companionSavebar) {
    companionSavebar.hidden = !visible;
    companionSavebar.setAttribute(
      "aria-label",
      isForgettingProfile
        ? "Protected browser link being removed"
        : pending
        ? "Companion changes awaiting confirmation"
        : saving
          ? "Companion changes being encrypted"
          : "Unsaved companion changes",
    );
  }
  if (companionDirtySummary) {
    companionDirtySummary.textContent = isForgettingProfile
      ? "Removing this protected browser link…"
      : saving
      ? "Encrypting changes for Cedar…"
      : pending
        ? "Changes sent. Waiting for Cedar to confirm them."
        : describeDirtySections(dirtySections);
  }
  if (discardCompanionChangesButton) {
    discardCompanionChangesButton.disabled = !draft || pending || busy || dirtySections.length === 0;
  }
  if (saveCompanionChangesButton) {
    saveCompanionChangesButton.disabled = !draft || pending || busy || dirtySections.length === 0;
    saveCompanionChangesButton.textContent = isForgettingProfile
      ? "Removing link…"
      : saving
      ? "Encrypting…"
      : pending
        ? "Waiting for Cedar"
        : "Send changes to Cedar";
  }
  if (draft) {
    const unavailable = pending || busy || dirtySections.length === 0;
    for (const form of [profileEditor, settingsEditor, branchesEditor]) {
      const submit = form?.querySelector('button[type="submit"]');
      if (submit) submit.disabled = unavailable;
    }
  }
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
  if (!item.companion && (draftSpaceID !== item.credentials.spaceID || !draftPresentation)) resetDraft(item);
  const companionConfigurationDraft = ensureCompanionDraft(item)?.configuration;
  const presentationDraft = companionConfigurationDraft?.presentation || draftPresentation;
  if (!presentationDraft) return;
  profileNameInput.value = presentationDraft.name;
  profileTheme.value = presentationDraft.theme;
  const unavailable = profile.avatarEditable !== true || !Number.isSafeInteger(profile.snapshotRevision);
  const pending = Boolean(item.pending || item.configurationPending);
  const validName = presentationDraft.name.length > 0 && [...presentationDraft.name].length <= 128;
  const changed = item.companion
    ? hasDirtyCompanionChanges(item)
    : validName && !presentationsMatch(presentationForProfile(profile), presentationDraft);
  for (const field of profileEditor.querySelectorAll("input, select, button")) {
    field.disabled = unavailable || pending || isSavingProfile || isSavingCompanion || isForgettingProfile;
  }
  badgeSelector.disabled = unavailable || pending || isSavingProfile || isSavingCompanion || isForgettingProfile || !badgeCatalog;
  saveProfileButton.disabled = unavailable || pending || isSavingProfile || isSavingCompanion || isForgettingProfile || !changed;
  saveProfileButton.textContent = isSavingProfile || isSavingCompanion
    ? "Encrypting changes…"
    : pending
      ? "Waiting for Cedar confirmation"
      : "Send changes to Cedar";
  profileEditor.classList.toggle("is-pending", pending);
  profileEditor.classList.toggle("is-unavailable", unavailable);
  renderCompanionSaveState(item);
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
  if (previewName) {
    syncMessage.classList.remove("is-error", "is-success", "is-pending");
    syncMessage.textContent = `${previewName} selected. Send changes when you are ready.`;
  }
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
  profileSelector.disabled = isSavingProfile || isSavingCompanion || isForgettingProfile;
  document.querySelector(".profile-picker-label").hidden = activeProfiles.length < 2;
};

const captureCompanionFocus = () => {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || !companion.contains(element)) return null;
  const branch = element.closest("[data-branch-id]");
  return {
    id: element.id || "",
    tagName: element.tagName,
    type: element.getAttribute("type") || "",
    action: element.dataset.action || "",
    command: element.dataset.command || "",
    deviceID: element.dataset.deviceId || "",
    value: element.dataset.value || "",
    branchID: branch?.dataset.branchId || "",
    selectionStart: typeof element.selectionStart === "number" ? element.selectionStart : null,
    selectionEnd: typeof element.selectionEnd === "number" ? element.selectionEnd : null,
  };
};

const restoreCompanionFocus = (token) => {
  if (!token) return false;
  let target = token.id ? document.getElementById(token.id) : null;
  const hasDynamicIdentity = token.action
    || token.command
    || token.deviceID
    || token.value
    || token.branchID;
  if (!target && hasDynamicIdentity) {
    target = [...companion.querySelectorAll("button, input, select, summary")].find((candidate) => {
      const branch = candidate.closest("[data-branch-id]");
      return candidate.tagName === token.tagName
        && (candidate.getAttribute("type") || "") === token.type
        && (candidate.dataset.action || "") === token.action
        && (candidate.dataset.command || "") === token.command
        && (candidate.dataset.deviceId || "") === token.deviceID
        && (candidate.dataset.value || "") === token.value
        && (branch?.dataset.branchId || "") === token.branchID;
    }) || null;
  }
  if (!target || target.disabled || target.hidden) return false;
  target.focus({ preventScroll: true });
  if (token.selectionStart != null && typeof target.setSelectionRange === "function") {
    target.setSelectionRange(token.selectionStart, token.selectionEnd ?? token.selectionStart);
  }
  return document.activeElement === target;
};

const focusCompanionStatus = () => {
  syncMessage.tabIndex = -1;
  syncMessage.focus();
};

const restoreOperationFocus = (token) => {
  if (!document.hasFocus()) return;
  const active = document.activeElement;
  const hasMeaningfulFocus = active instanceof HTMLElement
    && active !== document.body
    && active.isConnected
    && !active.hidden
    && !active.disabled
    && !active.closest("[hidden]");
  if (hasMeaningfulFocus) return;
  if (!restoreCompanionFocus(token)) focusCompanionStatus();
};

const refreshLoadedArtworkControls = () => {
  if (avatarCatalog) {
    avatarMatches = filterAvatarCatalog(avatarCatalog, avatarSearch.value);
    renderAvatars();
  }
  if (badgeCatalog) renderBadges();
};

const renderCompanion = ({ preserveFocus = true } = {}) => {
  const focusToken = preserveFocus ? captureCompanionFocus() : null;
  const item = selectedProfile();
  if (!item) return;
  document.body.classList.add("is-companion-workspace");
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
    renderCompanionPanels(item, { preserveFocus: false });
    refreshLoadedArtworkControls();
    restoreCompanionFocus(focusToken);
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
  const presentationDraft = ensureCompanionDraft(item)?.configuration.presentation || draftPresentation;
  const avatarPreview = presentationDraft?.avatarSymbol !== profile.avatarSymbol
    ? localAvatarPath(presentationDraft?.avatarSymbol)
    : null;
  setAvatar(profile, avatarPreview);
  renderEditorState();
  renderCompanionPanels(item, { preserveFocus: false });
  refreshLoadedArtworkControls();
  restoreCompanionFocus(focusToken);
};

const renderSettings = (item) => {
  const settings = ensureCompanionDraft(item)?.configuration.settings;
  const unavailable = !settings || Boolean(item?.configurationPending) || isSavingCompanion || isForgettingProfile;
  for (const field of settingsEditor.elements) field.disabled = unavailable;
  const submit = settingsEditor.querySelector('button[type="submit"]');
  if (submit) submit.disabled = unavailable || !hasDirtyCompanionChanges(item);
  if (!settings) {
    settingsEditor.reset();
    metadataLanguage.value = "";
    topShelfPresentation.value = "";
    for (const field of settingsEditor.querySelectorAll('input[type="checkbox"]')) field.checked = false;
    return;
  }
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

const applyBranchDraftChange = (item, change) => {
  const current = ensureCompanionDraft(item)?.configuration;
  if (!current) return;
  const index = current.branches.findIndex((branch) => branch.id === change.id);
  if (index < 0) return;
  const branches = structuredClone(current.branches);
  if (change.type === "title") {
    branches[index].title = change.value;
  } else if (change.type === "enabled") {
    branches[index].isEnabled = change.value;
  } else if (change.type === "move") {
    const destination = change.direction === "up" ? index - 1 : index + 1;
    if (destination < 0 || destination >= branches.length) return;
    [branches[index], branches[destination]] = [branches[destination], branches[index]];
    branches.forEach((branch, branchIndex) => { branch.position = branchIndex; });
    setCompanionDraftSection(item, "branches", branches);
    renderBranches(item, { focusTarget: { id: change.id, direction: change.direction } });
    renderCompanionSaveState(item);
    syncMessage.classList.remove("is-error", "is-success", "is-pending");
    syncMessage.textContent = `Moved “${branches[destination].title}” to position ${destination + 1}.`;
    return;
  } else {
    return;
  }
  setCompanionDraftSection(item, "branches", branches);
  renderCompanionSaveState(item);
};

const renderBranches = (item, { focusTarget = null } = {}) => {
  const configurationDraft = ensureCompanionDraft(item)?.configuration;
  const unavailable = !configurationDraft || Boolean(item?.configurationPending) || isSavingCompanion || isForgettingProfile;
  addBranchButton.disabled = unavailable || (configurationDraft?.branches.length ?? 50) >= 50;
  branchPreset.disabled = unavailable;
  branchesEditor.querySelector('button[type="submit"]').disabled = unavailable || !hasDirtyCompanionChanges(item);
  if (!configurationDraft) {
    branchEditorList.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "library-loading";
    empty.textContent = "Waiting for a content-free companion snapshot from Cedar.";
    branchEditorList.append(empty);
    return;
  }
  renderHomeBranches(document, branchEditorList, configurationDraft.branches, {
    disabled: unavailable,
    focusTarget,
    onChange: (change) => applyBranchDraftChange(item, change),
  });
};

const renderDevices = (item) => {
  renderDeviceList(document, deviceList, item?.companion, {
    ownerDeviceID: item?.credentials.ownerDeviceID,
    currentDeviceID: item?.credentials.deviceID,
    disabled: Boolean(item?.configurationPending || isSavingCompanion || isForgettingProfile),
    emptyMessage: "Waiting for the owning Cedar app to publish linked devices.",
    onRename: (device) => {
      const displayName = window.prompt("Name this linked Cedar device", device.displayName)?.trim();
      if (displayName && displayName !== device.displayName) {
        sendDeviceAction(device.id, "rename", displayName);
      }
    },
    onRevoke: (device) => {
      if (window.confirm(`Revoke Cedar Link access for “${device.displayName}”? The owning Cedar app must complete this request.`)) {
        sendDeviceAction(device.id, "revoke");
      }
    },
  });
};

const renderRemote = (item) => {
  const previous = remoteDevice.value;
  renderRemoteControls(document, remoteDevice, remoteState, remoteControls, item?.companion, {
    selectedDeviceID: previous,
    disabled: isSavingCompanion || isForgettingProfile,
    onSelect: () => renderRemote(item),
    onCommand: (_deviceID, command) => sendRemoteCommand(command),
  });
};

const renderCompanionPanels = (item, { preserveFocus = true } = {}) => {
  const focusToken = preserveFocus ? captureCompanionFocus() : null;
  renderSettings(item);
  renderBranches(item);
  renderDevices(item);
  renderRemote(item);
  renderCompanionSaveState(item);
  createInvitationButton.disabled = isSavingProfile
    || isSavingCompanion
    || isForgettingProfile
    || isCreatingInvitation;
  forgetBrowserButton.disabled = isSavingProfile || isSavingCompanion || isForgettingProfile;
  restoreCompanionFocus(focusToken);
};

const persistSyncResult = async (item, result, generation) => {
  if (!profileOperationIsCurrent(item, generation)) return "cancelled";
  const entries = [];
  const deletedRecordKeys = [];
  const companionRemoved = result.companionRemoved === true;
  const profileRemoved = result.profileRemoved === true;
  let reconciliation = null;
  let companionReconciliation = null;
  let draftRebasedWithNativeChanges = false;
  if (companionRemoved) {
    deletedRecordKeys.push(
      `companion:${item.credentials.spaceID}`,
      `snapshot:${item.credentials.spaceID}`,
      `presentation-pending:${item.credentials.spaceID}`,
      `configuration-pending:${item.credentials.spaceID}`,
    );
  } else if (profileRemoved) {
    deletedRecordKeys.push(
      `snapshot:${item.credentials.spaceID}`,
      `presentation-pending:${item.credentials.spaceID}`,
    );
  }
  if (result.profile && !profileRemoved && !companionRemoved) {
    if (result.profile !== item.profile) {
      entries.push([`snapshot:${item.credentials.spaceID}`, {
        schemaVersion: 1,
        spaceID: item.credentials.spaceID,
        ...await encryptValue(result.profile),
      }]);
    }
    if (item.pending && result.profile.snapshotRevision > item.pending.baseRevision) {
      reconciliation = presentationsMatch(
        presentationForProfile(result.profile),
        item.pending.replacement,
      ) ? "applied" : "rejected";
    }
  }
  if (result.companion && !companionRemoved) {
    if (result.companion !== item.companion) {
      entries.push([`companion:${item.credentials.spaceID}`, {
        schemaVersion: 1,
        spaceID: item.credentials.spaceID,
        ...await encryptValue(result.companion),
      }]);
    }
    // Early companion links may still have a profile-presentation request in flight.
    // A newer companion snapshot is its authoritative confirmation path.
    if (item.pending && result.companion.revision > item.pending.baseRevision) {
      reconciliation = presentationsMatch(
        result.companion.configuration.presentation,
        item.pending.replacement,
      ) ? "applied" : "rejected";
    }
    if (item.configurationPending && result.companion.revision > item.configurationPending.baseRevision) {
      companionReconciliation = companionConfigurationsMatch(
        result.companion.configuration,
        item.configurationPending.replacement,
      )
        ? "applied"
        : "rejected";
    }
  }
  if (reconciliation && !deletedRecordKeys.includes(`presentation-pending:${item.credentials.spaceID}`)) {
    deletedRecordKeys.push(`presentation-pending:${item.credentials.spaceID}`);
  }
  if (companionReconciliation && !deletedRecordKeys.includes(`configuration-pending:${item.credentials.spaceID}`)) {
    deletedRecordKeys.push(`configuration-pending:${item.credentials.spaceID}`);
  }
  if (!profileOperationIsCurrent(item, generation)) return "cancelled";
  const updatedRecord = await writeSyncRecords(item, result.cursor, entries, deletedRecordKeys);
  if (!profileOperationIsCurrent(item, generation)) return "cancelled";
  item.record = updatedRecord;
  if (companionRemoved) {
    item.companion = null;
    item.profile = null;
    item.pending = null;
    item.configurationPending = null;
    companionDrafts.delete(item.credentials.spaceID);
    if (currentInvitationSpaceID === item.credentials.spaceID) clearInvitationDisplay();
    resetDraft(item);
    return "companion-removed";
  }
  if (profileRemoved) {
    item.profile = null;
    item.pending = null;
    if (currentInvitationSpaceID === item.credentials.spaceID) clearInvitationDisplay();
    if (!item.companion) resetDraft(item);
  } else if (result.profile) {
    item.profile = result.profile;
  }
  if (result.companion) item.companion = result.companion;
  if (reconciliation) {
    item.pending = null;
    if (!item.companion) resetDraft(item);
  } else if (result.profile && !item.pending) {
    // A newer canonical native snapshot invalidates any unsaved stale browser draft.
    if (!item.companion) resetDraft(item);
  }
  if (companionReconciliation) {
    item.configurationPending = null;
    resetCompanionDraft(item);
  } else if (result.companion && !item.configurationPending) {
    // Merge unrelated native fields into the draft. Direct conflicts keep Cedar's newer value.
    const rebasedDraft = ensureCompanionDraft(item);
    if (rebasedDraft?.nativeUpdatedSections?.length) {
      draftRebasedWithNativeChanges = true;
      rebasedDraft.nativeUpdatedSections = [];
    }
  }
  if (companionReconciliation) return `configuration-${companionReconciliation}`;
  if (reconciliation) return `presentation-${reconciliation}`;
  if (profileRemoved) return "profile-removed";
  if (draftRebasedWithNativeChanges) return "draft-rebased";
  return null;
};

const performSelectedProfileSync = async (
  item,
  generation,
  { poll = false, minimumCompanionRevision = null } = {},
) => {
  if (!profileOperationIsCurrent(item, generation)) return;
  const isCurrentProfile = () => profileOperationIsCurrent(item, generation)
    && selectedSpaceID === item.credentials.spaceID;
  if (isCurrentProfile()) {
    refreshButton.disabled = true;
    refreshButton.classList.add("is-refreshing");
    companionState.textContent = "Checking Cedar Sync";
    syncMessage.classList.remove("is-error", "is-success", "is-pending");
    syncMessage.textContent = profileForItem(item)
      ? "Checking for newer encrypted companion state…"
      : "Waiting for the first encrypted upload from a Cedar device…";
  }
  const delays = poll ? [0, 1_800, 3_000, 5_000, 8_000, 12_000] : [0];
  try {
    for (const [delayIndex, delay] of delays.entries()) {
      if (delay) await sleep(delay);
      if (!isCurrentProfile()) return;
      const previousCompanion = item.companion;
      const result = await fetchLatestCompanion(
        item.credentials,
        item.record.cursor || 0,
        item.companion,
      );
      const reconciliation = await persistSyncResult(item, result, generation);
      if (reconciliation === "cancelled") return;
      if (!isCurrentProfile()) return;
      if (result.companion !== previousCompanion || reconciliation) {
        const focusToken = captureCompanionFocus();
        renderCompanion({ preserveFocus: false });
        if (focusToken && !restoreCompanionFocus(focusToken)) focusCompanionStatus();
      }
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      if (reconciliation === "companion-removed") {
        companionState.textContent = "Cedar Link access removed";
        syncMessage.textContent = "The owning Cedar app removed companion access. Cached profile, configuration, and device details were cleared from this browser.";
        syncMessage.classList.add("is-pending");
        return;
      }
      if (reconciliation === "profile-removed") {
        companionState.textContent = "Profile removed in Cedar";
        syncMessage.textContent = "The owning Cedar app removed this cached profile snapshot and its pending browser edit.";
        syncMessage.classList.add("is-pending");
        return;
      }
      if (reconciliation === "configuration-applied" || reconciliation === "presentation-applied") {
        companionState.textContent = "Cedar Link connected";
        syncMessage.textContent = reconciliation === "configuration-applied"
          ? "Changes confirmed and published by the owning Cedar app."
          : "Profile edit confirmed and published by the owning Cedar app.";
        syncMessage.classList.add("is-success");
        return;
      }
      if (reconciliation === "configuration-rejected" || reconciliation === "presentation-rejected") {
        companionState.textContent = "Cedar kept the newer profile";
        syncMessage.textContent = "These changes were based on an older profile. Cedar kept the newer native version.";
        syncMessage.classList.add("is-error");
        return;
      }
      if (reconciliation === "draft-rebased") {
        companionState.textContent = "Review newer Cedar changes";
        syncMessage.textContent = "Cedar published newer fields while this browser had unsaved edits. Unrelated browser edits were kept; Cedar's newer value won anywhere the same field changed. Review before sending.";
        syncMessage.classList.add("is-pending");
        return;
      }
      const waitingForNativeChange = Number.isSafeInteger(minimumCompanionRevision)
        && (!Number.isSafeInteger(item.companion?.revision)
          || item.companion.revision <= minimumCompanionRevision);
      if (waitingForNativeChange) {
        companionState.textContent = "Waiting for Cedar response";
        syncMessage.textContent = "The encrypted request reached Cedar Sync. Waiting for the owning Cedar app to publish its updated state…";
        syncMessage.classList.add("is-pending");
        if (poll && delayIndex < delays.length - 1) continue;
        return;
      }
      if (item.pending || item.configurationPending) {
        companionState.textContent = "Waiting for Cedar confirmation";
        syncMessage.textContent = "The encrypted edit is at the relay. Open the owning Cedar app; it will validate, apply, and publish the result.";
        syncMessage.classList.add("is-pending");
        if (poll && delayIndex < delays.length - 1) continue;
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
    if (isCurrentProfile()) {
      companionState.textContent = "Sync needs attention";
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      syncMessage.textContent = error instanceof CedarSyncError
        ? error.message
        : "This browser could not open the encrypted Cedar profile. Try refreshing.";
      syncMessage.classList.add("is-error");
    }
  } finally {
    if (isCurrentProfile()) {
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-refreshing");
    }
  }
};

const syncProfile = (item, options = {}) => {
  if (!item) return Promise.resolve();
  const spaceID = item.credentials.spaceID;
  const existing = syncInFlightBySpace.get(spaceID);
  if (existing) return existing;
  const generation = profileOperationGeneration(spaceID);
  const task = performSelectedProfileSync(item, generation, options).finally(() => {
    if (syncInFlightBySpace.get(spaceID) === task) syncInFlightBySpace.delete(spaceID);
  });
  syncInFlightBySpace.set(spaceID, task);
  return task;
};

const syncSelectedProfile = (options = {}) => syncProfile(selectedProfile(), options);

const syncUntilCompanionRevision = async (item, generation, baselineRevision) => {
  const spaceID = item?.credentials?.spaceID;
  if (!spaceID || !Number.isSafeInteger(baselineRevision)) return;
  const existing = syncInFlightBySpace.get(spaceID);
  if (existing) await existing;
  if (!profileOperationIsCurrent(item, generation)) return;
  if (Number.isSafeInteger(item.companion?.revision)
    && item.companion.revision > baselineRevision) return;
  await syncProfile(item, { poll: true, minimumCompanionRevision: baselineRevision });
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
  if (!avatarCatalog && !avatarCatalogPromise) {
    avatarGrid.innerHTML = '<p class="library-loading">Loading recovered avatars…</p>';
    avatarCatalogPromise = (async () => {
      const response = await fetch("../catalogs/avatars.json", { cache: "force-cache", credentials: "omit" });
      if (!response.ok) throw new Error("avatar catalog unavailable");
      const value = await response.json();
      if (!Array.isArray(value.avatars)) throw new Error("avatar catalog invalid");
      avatarCatalog = value.avatars.filter((avatar) => (
        typeof avatar?.name === "string"
        && typeof avatar?.url === "string"
        && AVATAR_PATH_PATTERN.test(avatar.url)
      ));
    })().finally(() => {
      avatarCatalogPromise = null;
    });
  }
  if (avatarCatalogPromise) await avatarCatalogPromise;
  avatarMatches = filterAvatarCatalog(avatarCatalog, avatarSearch.value);
  renderAvatars();
};

const renderAvatars = () => {
  avatarGrid.replaceChildren();
  const fragment = document.createDocumentFragment();
  const item = selectedProfile();
  const presentationDraft = ensureCompanionDraft(item)?.configuration.presentation || draftPresentation;
  const avatarEditingUnavailable = profileForItem(item)?.avatarEditable !== true;
  for (const avatar of avatarMatches.slice(0, visibleAvatarCount)) {
    const choice = document.createElement("button");
    choice.className = "avatar-choice";
    choice.type = "button";
    choice.title = avatar.name;
    choice.dataset.path = `..${avatar.url}`;
    choice.dataset.name = avatar.name;
    choice.dataset.value = new URL(`..${avatar.url}`, location.href).href;
    const selected = choice.dataset.value === presentationDraft?.avatarSymbol;
    choice.classList.toggle("is-selected", selected);
    choice.setAttribute("aria-pressed", String(selected));
    choice.disabled = Boolean(
      item?.pending
      || item?.configurationPending
      || isSavingProfile
      || isSavingCompanion
      || isForgettingProfile
      || avatarEditingUnavailable
    );
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
  const presentationDraft = ensureCompanionDraft(item)?.configuration.presentation || draftPresentation;
  const installed = Array.isArray(profile?.installedBadgePacks) ? profile.installedBadgePacks : [];
  const currentSelection = profile?.badgeSelection || "builtIn";
  const selected = presentationDraft?.badgeSelection || currentSelection;

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
    || Boolean(
      item?.pending
      || item?.configurationPending
      || isSavingProfile
      || isSavingCompanion
      || isForgettingProfile
    );

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

const uploadCompanionChange = async (item, makeChange, generation) => {
  if (!profileOperationIsCurrent(item, generation)) return null;
  const reservation = await reserveOutboundSequence(item.recordKey);
  if (!profileOperationIsCurrent(item, generation)) return null;
  item.record = reservation.record;
  const submittedAt = Date.now();
  const change = makeChange(reservation.sequence, submittedAt);
  const envelope = await sealEnvelope(change, item.credentials, reservation.sequence, {
    createdAtEpochMilliseconds: submittedAt,
  });
  if (!profileOperationIsCurrent(item, generation)) return null;
  await uploadEnvelope(item.credentials, envelope);
  if (!profileOperationIsCurrent(item, generation)) return null;
  return submittedAt;
};

const activateCompanionPanel = (panelName) => {
  for (const tab of companionTabs.querySelectorAll("button[data-panel]")) {
    const selected = tab.dataset.panel === panelName;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of companion.querySelectorAll("[data-companion-panel]")) {
    const selected = panel.dataset.companionPanel === panelName;
    panel.hidden = !selected;
    panel.classList.toggle("is-active", selected);
  }
};

const clearCompanionValidation = () => {
  for (const field of companion.querySelectorAll("input, select")) {
    field.setCustomValidity?.("");
    field.removeAttribute("aria-invalid");
  }
};

const fieldForDraftIssue = (issue) => issue.branchIndex == null
  ? document.getElementById(issue.field)
  : branchEditorList.querySelector(`[data-index="${issue.branchIndex}"] input[type="text"]`);

const showCompanionValidationIssue = (issue) => {
  activateCompanionPanel(issue.section === "presentation" ? "profile" : issue.section);
  const field = fieldForDraftIssue(issue);
  field?.setCustomValidity?.(issue.message);
  field?.setAttribute("aria-invalid", "true");
  syncMessage.classList.remove("is-success", "is-pending");
  syncMessage.classList.add("is-error");
  syncMessage.textContent = issue.message;
  field?.focus();
  field?.reportValidity?.();
};

const validatedCompanionDraft = (replacementValue) => {
  clearCompanionValidation();
  const issue = companionDraftValidationIssues(replacementValue)[0];
  if (issue) {
    showCompanionValidationIssue(issue);
    return null;
  }
  try {
    return validateCompanionConfiguration(replacementValue);
  } catch (error) {
    companionState.textContent = "Changes need attention";
    syncMessage.classList.remove("is-success", "is-pending");
    syncMessage.classList.add("is-error");
    syncMessage.textContent = error instanceof CedarSyncError
      ? error.message
      : "Review the highlighted configuration and try again.";
    return null;
  }
};

const saveCompanionConfiguration = async (replacementValue, successMessage) => {
  const item = selectedProfile();
  if (!item?.companion || item.configurationPending || isSavingCompanion || isForgettingProfile) return;
  const generation = profileOperationGeneration(item.credentials.spaceID);
  const replacement = validatedCompanionDraft(replacementValue);
  if (!replacement) return;
  const focusToken = captureCompanionFocus();
  const baseCompanion = structuredClone(item.companion);
  isSavingCompanion = true;
  syncMessage.classList.remove("is-error", "is-success", "is-pending");
  syncMessage.textContent = "Encrypting this configuration update for Cedar…";
  renderCompanion();
  try {
    const submittedAt = await uploadCompanionChange(item, (sequence, createdAt) => (
      createCompanionConfigurationPatchChange(baseCompanion, replacement, sequence, createdAt)
    ), generation);
    if (!Number.isSafeInteger(submittedAt) || !profileOperationIsCurrent(item, generation)) return;
    const pending = {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      profileID: baseCompanion.profileID,
      baseRevision: baseCompanion.revision,
      submittedAt,
      replacement,
    };
    const encryptedPending = await encryptValue(pending);
    if (!profileOperationIsCurrent(item, generation)) return;
    await writeRecord(`configuration-pending:${item.credentials.spaceID}`, {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      ...encryptedPending,
    });
    if (!profileOperationIsCurrent(item, generation)) return;
    item.configurationPending = pending;
    const currentDraft = ensureCompanionDraft(item);
    companionDrafts.set(item.credentials.spaceID, {
      ...currentDraft,
      configuration: structuredClone(replacement),
    });
    if (selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Waiting for Cedar confirmation";
      syncMessage.textContent = successMessage;
      syncMessage.classList.add("is-pending");
    }
  } catch (error) {
    if (profileOperationIsCurrent(item, generation) && selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Sync needs attention";
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      syncMessage.textContent = error instanceof CedarSyncError
        ? error.message
        : "The encrypted companion update could not be sent. Try again.";
      syncMessage.classList.add("is-error");
    }
  } finally {
    isSavingCompanion = false;
    if (selectedProfile()) renderCompanion();
    if (profileOperationIsCurrent(item, generation)
      && selectedSpaceID === item.credentials.spaceID) restoreOperationFocus(focusToken);
  }
};

const sendDeviceAction = async (targetDeviceID, action, displayName = null) => {
  const item = selectedProfile();
  if (!item?.companion || isSavingCompanion || isForgettingProfile) return;
  const generation = profileOperationGeneration(item.credentials.spaceID);
  const focusToken = captureCompanionFocus();
  const baseCompanion = structuredClone(item.companion);
  let shouldPoll = false;
  isSavingCompanion = true;
  profileSelector.disabled = true;
  renderCompanionPanels(item);
  try {
    const submittedAt = await uploadCompanionChange(item, (sequence, createdAtEpochMilliseconds) => (
      createDeviceRequestChange(baseCompanion, targetDeviceID, action, sequence, {
        displayName,
        createdAtEpochMilliseconds,
      })
    ), generation);
    if (!Number.isSafeInteger(submittedAt) || !profileOperationIsCurrent(item, generation)) return;
    shouldPoll = true;
    if (selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Owner action requested";
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      syncMessage.textContent = action === "revoke"
        ? "Encrypted revoke request sent. The owning Cedar app will validate and complete it."
        : "Encrypted rename request sent. The owning Cedar app will validate and publish it.";
      syncMessage.classList.add("is-success");
    }
  } catch (error) {
    if (profileOperationIsCurrent(item, generation) && selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Sync needs attention";
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      syncMessage.textContent = error instanceof CedarSyncError ? error.message : "The device request could not be sent.";
      syncMessage.classList.add("is-error");
    }
  } finally {
    isSavingCompanion = false;
    if (selectedProfile()) renderCompanion();
    if (profileOperationIsCurrent(item, generation)
      && selectedSpaceID === item.credentials.spaceID) restoreOperationFocus(focusToken);
  }
  if (shouldPoll && profileOperationIsCurrent(item, generation)) {
    await syncUntilCompanionRevision(item, generation, baseCompanion.revision);
  }
};

const sendRemoteCommand = async (command) => {
  const item = selectedProfile();
  if (!item?.companion || !remoteDevice.value || isSavingCompanion || isForgettingProfile) return;
  const generation = profileOperationGeneration(item.credentials.spaceID);
  const focusToken = captureCompanionFocus();
  const baseCompanion = structuredClone(item.companion);
  const targetDeviceID = remoteDevice.value;
  let shouldPoll = false;
  isSavingCompanion = true;
  profileSelector.disabled = true;
  renderRemote(item);
  try {
    const submittedAt = await uploadCompanionChange(item, (sequence, createdAtEpochMilliseconds) => (
      createRemoteCommandChange(
        baseCompanion,
        targetDeviceID,
        command,
        sequence,
        createdAtEpochMilliseconds,
      )
    ), generation);
    if (!Number.isSafeInteger(submittedAt) || !profileOperationIsCurrent(item, generation)) return;
    shouldPoll = true;
    if (selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Remote command sent";
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      syncMessage.textContent = "The encrypted transport command was sent to Cedar. No media was sent to this browser.";
      syncMessage.classList.add("is-success");
    }
  } catch (error) {
    if (profileOperationIsCurrent(item, generation) && selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Sync needs attention";
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      syncMessage.textContent = error instanceof CedarSyncError ? error.message : "The remote command could not be sent.";
      syncMessage.classList.add("is-error");
    }
  } finally {
    isSavingCompanion = false;
    if (selectedProfile()) renderCompanion();
    if (profileOperationIsCurrent(item, generation)
      && selectedSpaceID === item.credentials.spaceID) restoreOperationFocus(focusToken);
  }
  if (shouldPoll && profileOperationIsCurrent(item, generation)) {
    await syncUntilCompanionRevision(item, generation, baseCompanion.revision);
  }
};

const saveProfilePresentation = async () => {
  const item = selectedProfile();
  const profile = profileForItem(item);
  const configurationDraft = ensureCompanionDraft(item)?.configuration;
  const presentationDraft = configurationDraft?.presentation || draftPresentation;
  if (!profile
    || item.pending
    || item.configurationPending
    || isSavingProfile
    || isSavingCompanion
    || isForgettingProfile
    || !presentationDraft) return;
  const generation = profileOperationGeneration(item.credentials.spaceID);

  if (item.companion) {
    await saveCompanionConfiguration(
      configurationDraft,
      "Changes sent securely. Waiting for the owning Cedar app to validate and publish them.",
    );
    return;
  }

  let replacement;
  try {
    replacement = validateProfilePresentation(presentationDraft);
  } catch (error) {
    companionState.textContent = "Changes need attention";
    syncMessage.classList.remove("is-success", "is-pending");
    syncMessage.classList.add("is-error");
    syncMessage.textContent = error instanceof CedarSyncError
      ? error.message
      : "Review the profile edit and try again.";
    profileNameInput.setAttribute("aria-invalid", "true");
    profileNameInput.focus();
    return;
  }
  if (presentationsMatch(presentationForProfile(profile), replacement)) return;

  const focusToken = captureCompanionFocus();
  isSavingProfile = true;
  syncMessage.classList.remove("is-error", "is-success", "is-pending");
  syncMessage.textContent = "Encrypting this profile edit for the owning Cedar app…";
  renderEditorState();
  try {
    const reservation = await reserveOutboundSequence(item.recordKey);
    if (!profileOperationIsCurrent(item, generation)) return;
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
    if (!profileOperationIsCurrent(item, generation)) return;
    await uploadEnvelope(item.credentials, envelope);
    if (!profileOperationIsCurrent(item, generation)) return;
    const pending = {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      profileID: profile.profileID,
      baseRevision: profile.snapshotRevision,
      submittedAt,
      replacement,
    };
    const encryptedPending = await encryptValue(pending);
    if (!profileOperationIsCurrent(item, generation)) return;
    await writeRecord(`presentation-pending:${item.credentials.spaceID}`, {
      schemaVersion: 1,
      spaceID: item.credentials.spaceID,
      ...encryptedPending,
    });
    if (!profileOperationIsCurrent(item, generation)) return;
    item.pending = pending;
    draftPresentation = replacement;
    if (selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Waiting for Cedar confirmation";
      syncMessage.textContent = "Edit sent securely. Open the owning Cedar app; it will apply the edit and publish confirmation.";
      syncMessage.classList.add("is-pending");
    }
  } catch (error) {
    if (profileOperationIsCurrent(item, generation) && selectedSpaceID === item.credentials.spaceID) {
      companionState.textContent = "Sync needs attention";
      syncMessage.classList.remove("is-error", "is-success", "is-pending");
      syncMessage.textContent = error instanceof CedarSyncError
        ? error.message
        : "The encrypted profile edit could not be sent. Try again.";
      syncMessage.classList.add("is-error");
    }
  } finally {
    isSavingProfile = false;
    if (selectedProfile()) renderCompanion();
    if (profileOperationIsCurrent(item, generation)
      && selectedSpaceID === item.credentials.spaceID) restoreOperationFocus(focusToken);
  }
};

const initialize = async () => {
  invitation = invitationFromFragment();
  const configResponse = await fetch("../sync-config.json", { cache: "no-store", credentials: "omit" });
  if (!configResponse.ok) throw new Error("configuration unavailable");
  const config = await configResponse.json();
  if (config.schemaVersion !== 1) throw new Error("configuration unavailable");
  relayBaseURL = config.relayBaseURL ? normalizeRelay(config.relayBaseURL) : "";
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
    "In Cedar on your Apple device, open Settings → Cedar Link and create a browser link.",
  );
};

button.addEventListener("click", async () => {
  if (!invitation || !relayBaseURL || button.disabled) return;
  button.disabled = true;
  setState("Linking securely", "Protecting this browser…", "Claiming the invitation and waiting for Cedar's encrypted upload.");
  try {
    if (invitation.expiresAt <= Date.now()) throw new Error("expired invitation");
    const pending = await pendingCredentials(invitation);
    const baseline = await claim(invitation, pending.secrets);
    await activate(pending.recordKey, pending.secrets, baseline);
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
  activateCompanionPanel(tab.dataset.panel);
});

companionTabs.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const tabs = [...companionTabs.querySelectorAll("button[data-panel]")];
  const currentIndex = tabs.indexOf(event.target.closest("button[data-panel]"));
  if (currentIndex < 0) return;
  const isMobileGrid = window.matchMedia("(max-width: 680px)").matches;
  let nextIndex;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = tabs.length - 1;
  else if (event.key === "ArrowDown" && isMobileGrid) {
    nextIndex = currentIndex + 3 < tabs.length ? currentIndex + 3 : currentIndex;
  } else if (event.key === "ArrowUp" && isMobileGrid) {
    nextIndex = currentIndex - 3 >= 0 ? currentIndex - 3 : currentIndex;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    nextIndex = (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  } else {
    return;
  }
  event.preventDefault();
  activateCompanionPanel(tabs[nextIndex].dataset.panel);
  tabs[nextIndex].focus();
});

profileEditor.addEventListener("submit", (event) => {
  event.preventDefault();
  saveProfilePresentation();
});

const updatePresentationDraftFromEditor = () => {
  const item = selectedProfile();
  const current = ensureCompanionDraft(item)?.configuration.presentation || draftPresentation;
  if (!current) return;
  const updated = {
    ...current,
    name: profileNameInput.value,
    theme: profileTheme.value,
  };
  profileNameInput.setCustomValidity("");
  profileNameInput.removeAttribute("aria-invalid");
  if (item?.companion) setCompanionDraftSection(item, "presentation", updated);
  else draftPresentation = updated;
  renderEditorState();
};

profileNameInput.addEventListener("input", updatePresentationDraftFromEditor);
profileTheme.addEventListener("change", updatePresentationDraftFromEditor);

profileSelector.addEventListener("change", async () => {
  const targetSpaceID = profileSelector.value;
  const currentItem = selectedProfile();
  if (isSavingProfile || isSavingCompanion || isForgettingProfile
    || !activeProfiles.some((item) => item.credentials.spaceID === targetSpaceID)) {
    profileSelector.value = selectedSpaceID;
    return;
  }
  if (targetSpaceID !== selectedSpaceID && hasUnsavedEditorChanges(currentItem)) {
    const shouldDiscard = window.confirm("Discard unsaved Cedar Link changes before switching profiles?");
    if (!shouldDiscard) {
      profileSelector.value = selectedSpaceID;
      return;
    }
    if (currentItem?.companion) {
      const currentDraft = ensureCompanionDraft(currentItem);
      companionDrafts.set(currentItem.credentials.spaceID, discardCompanionDraftChanges(currentDraft));
    }
  }
  clearInvitationDisplay();
  selectedSpaceID = targetSpaceID;
  draftSpaceID = "";
  draftPresentation = null;
  clearCompanionValidation();
  renderCompanion({ preserveFocus: false });
  await syncSelectedProfile();
});

const updateSettingsDraftFromEditor = () => {
  const item = selectedProfile();
  const current = ensureCompanionDraft(item)?.configuration.settings;
  if (!current) return;
  metadataLanguage.setCustomValidity("");
  metadataLanguage.removeAttribute("aria-invalid");
  setCompanionDraftSection(item, "settings", {
    ...current,
    metadataLanguageCode: metadataLanguage.value,
    automaticallyPlayBestSource: automaticallyPlayBest.checked,
    automaticallyTryNextBestSource: automaticallyTryNext.checked,
    quickPlayFromPosters: quickPlayPosters.checked,
    hideUnreleasedTitles: hideUnreleased.checked,
    showsPosterCardRatings: posterRatings.checked,
    topShelfPresentation: topShelfPresentation.value,
    showsTopShelfViewingActivity: topShelfActivity.checked,
    cleansUpLiveChannelNames: cleanLiveNames.checked,
  });
  renderCompanionSaveState(item);
};

settingsEditor.addEventListener("input", updateSettingsDraftFromEditor);
settingsEditor.addEventListener("change", updateSettingsDraftFromEditor);

settingsEditor.addEventListener("submit", (event) => {
  event.preventDefault();
  const item = selectedProfile();
  const replacement = ensureCompanionDraft(item)?.configuration;
  if (!replacement) return;
  saveCompanionConfiguration(
    replacement,
    "Changes sent securely. Waiting for the owning Cedar app to validate and publish them.",
  );
});

addBranchButton.addEventListener("click", () => {
  const item = selectedProfile();
  const current = ensureCompanionDraft(item)?.configuration;
  if (!current || current.branches.length >= 50) return;
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
  const branches = structuredClone(current.branches);
  branches.push({
    id: crypto.randomUUID().toLowerCase(),
    title: labels[preset] || "Cedar Row",
    position: branches.length,
    isEnabled: true,
    preset,
    sourceKind: "catalog",
    presentationKind: "row",
  });
  setCompanionDraftSection(item, "branches", branches);
  renderBranches(item);
  renderCompanionSaveState(item);
});

branchesEditor.addEventListener("submit", (event) => {
  event.preventDefault();
  const configurationDraft = ensureCompanionDraft(selectedProfile())?.configuration;
  if (!configurationDraft) return;
  saveCompanionConfiguration(
    configurationDraft,
    "Changes sent securely. Waiting for Cedar to configure the rows and publish confirmation.",
  );
});

const clearInvitationTimers = () => {
  if (invitationCountdownTimer) clearInterval(invitationCountdownTimer);
  if (invitationRevealTimer) clearTimeout(invitationRevealTimer);
  invitationCountdownTimer = null;
  invitationRevealTimer = null;
};

const maskInvitation = () => {
  if (invitationRevealTimer) clearTimeout(invitationRevealTimer);
  invitationRevealTimer = null;
  invitationURL.value = currentInvitationURL
    ? "Invitation hidden — use Copy link or Reveal"
    : "";
  revealInvitationButton.setAttribute("aria-pressed", "false");
  revealInvitationButton.textContent = "Reveal link";
};

const clearInvitationDisplay = ({ expired = false } = {}) => {
  clearInvitationTimers();
  currentInvitationURL = "";
  currentInvitationSpaceID = "";
  currentInvitationExpiresAt = 0;
  invitationURL.value = expired ? "Invitation expired" : "";
  invitationExpiry.textContent = expired ? "Invitation expired" : "One-use link ready";
  revealInvitationButton.disabled = true;
  revealInvitationButton.setAttribute("aria-pressed", "false");
  revealInvitationButton.textContent = "Reveal link";
  copyInvitationButton.disabled = true;
  copyInvitationButton.textContent = "Copy link";
  invitationResult.hidden = !expired;
};

const updateInvitationCountdown = () => {
  if (!currentInvitationURL || currentInvitationSpaceID !== selectedSpaceID) {
    clearInvitationDisplay();
    return;
  }
  const remainingSeconds = Math.ceil((currentInvitationExpiresAt - Date.now()) / 1_000);
  if (remainingSeconds <= 0) {
    clearInvitationDisplay({ expired: true });
    syncMessage.classList.remove("is-success", "is-error");
    syncMessage.classList.add("is-pending");
    syncMessage.textContent = "The one-use invitation expired and was cleared from this page. Create another when you need it.";
    return;
  }
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  invitationExpiry.textContent = `Expires in ${minutes}:${seconds}`;
};

const showInvitationDisplay = (spaceID, result) => {
  clearInvitationTimers();
  currentInvitationURL = result.url;
  currentInvitationSpaceID = spaceID;
  currentInvitationExpiresAt = result.expiresAtEpochMilliseconds;
  invitationResult.hidden = false;
  revealInvitationButton.disabled = false;
  copyInvitationButton.disabled = false;
  maskInvitation();
  updateInvitationCountdown();
  invitationCountdownTimer = setInterval(updateInvitationCountdown, 1_000);
};

const revealInvitation = () => {
  if (!currentInvitationURL
    || currentInvitationSpaceID !== selectedSpaceID
    || currentInvitationExpiresAt <= Date.now()) return;
  invitationURL.value = currentInvitationURL;
  revealInvitationButton.setAttribute("aria-pressed", "true");
  revealInvitationButton.textContent = "Hide link";
  if (invitationRevealTimer) clearTimeout(invitationRevealTimer);
  invitationRevealTimer = setTimeout(maskInvitation, 30_000);
};

createInvitationButton.addEventListener("click", async () => {
  const item = selectedProfile();
  if (!item || createInvitationButton.disabled || isForgettingProfile) return;
  const requestSpaceID = item.credentials.spaceID;
  const generation = profileOperationGeneration(requestSpaceID);
  const focusToken = captureCompanionFocus();
  clearInvitationDisplay();
  isCreatingInvitation = true;
  renderCompanionPanels(item);
  createInvitationButton.textContent = "Creating encrypted link…";
  try {
    const result = await createWebInvitation(item.credentials, window.location.href);
    if (!profileOperationIsCurrent(item, generation)
      || selectedSpaceID !== requestSpaceID
      || selectedProfile() !== item) return;
    showInvitationDisplay(requestSpaceID, result);
    syncMessage.classList.remove("is-error", "is-pending");
    syncMessage.textContent = "One-use invitation created. It expires in 10 minutes; share it only with a device you trust.";
    syncMessage.classList.add("is-success");
  } catch (error) {
    if (!profileOperationIsCurrent(item, generation) || selectedSpaceID !== requestSpaceID) return;
    clearInvitationDisplay();
    syncMessage.classList.remove("is-success", "is-pending");
    syncMessage.textContent = error instanceof CedarSyncError ? error.message : "The one-use invitation could not be created.";
    syncMessage.classList.add("is-error");
  } finally {
    isCreatingInvitation = false;
    createInvitationButton.textContent = "Create one-use link";
    if (selectedProfile()) renderCompanionPanels(selectedProfile());
    if (profileOperationIsCurrent(item, generation)
      && selectedSpaceID === requestSpaceID) restoreOperationFocus(focusToken);
  }
});

revealInvitationButton.addEventListener("click", () => {
  if (revealInvitationButton.getAttribute("aria-pressed") === "true") maskInvitation();
  else revealInvitation();
});

copyInvitationButton.addEventListener("click", async () => {
  if (!currentInvitationURL
    || currentInvitationSpaceID !== selectedSpaceID
    || currentInvitationExpiresAt <= Date.now()) return;
  try {
    await navigator.clipboard.writeText(currentInvitationURL);
    copyInvitationButton.textContent = "Copied";
    const copiedSpaceID = currentInvitationSpaceID;
    setTimeout(() => {
      if (currentInvitationSpaceID === copiedSpaceID) copyInvitationButton.textContent = "Copy link";
    }, 2_000);
  } catch {
    revealInvitation();
    invitationURL.select();
    syncMessage.textContent = "Copy is unavailable in this browser. The invitation is revealed and selected for manual copying.";
  }
});

forgetBrowserButton.addEventListener("click", async () => {
  const item = selectedProfile();
  if (!item || isSavingProfile || isSavingCompanion || isForgettingProfile) return;
  if (!window.confirm("Forget this Cedar Link profile in this browser? This removes its protected local key and any unsent edits, and cannot be undone here.")) return;
  const spaceID = item.credentials.spaceID;
  isForgettingProfile = true;
  invalidateProfileOperations(spaceID);
  clearInvitationDisplay();
  renderCompanion();
  try {
    // IndexedDB serializes this transaction after any already-started write. Coupled
    // with the generation gate above, the deletion is the final local operation.
    await deleteRecords([
      item.recordKey,
      `snapshot:${spaceID}`,
      `companion:${spaceID}`,
      `presentation-pending:${spaceID}`,
      `configuration-pending:${spaceID}`,
    ]);
    activeProfiles = activeProfiles.filter((value) => value !== item);
    companionDrafts.delete(spaceID);
    syncInFlightBySpace.delete(spaceID);
    selectedSpaceID = activeProfiles[0]?.credentials.spaceID || "";
    draftSpaceID = "";
    draftPresentation = null;
  } catch {
    companionState.textContent = "Browser storage needs attention";
    syncMessage.classList.remove("is-success", "is-pending");
    syncMessage.classList.add("is-error");
    syncMessage.textContent = "This profile could not be removed from protected browser storage. Try again.";
    isForgettingProfile = false;
    renderCompanion();
    return;
  }
  isForgettingProfile = false;
  if (activeProfiles.length) {
    renderCompanion({ preserveFocus: false });
    await syncSelectedProfile();
  } else {
    window.location.reload();
  }
});

discardCompanionChangesButton?.addEventListener("click", () => {
  const item = selectedProfile();
  const current = ensureCompanionDraft(item);
  if (!current || item?.configurationPending || isSavingCompanion) return;
  companionDrafts.set(item.credentials.spaceID, discardCompanionDraftChanges(current));
  clearCompanionValidation();
  syncMessage.classList.remove("is-error", "is-success", "is-pending");
  syncMessage.textContent = "Unsaved browser changes were discarded. Cedar was not changed.";
  renderCompanion();
});

saveCompanionChangesButton?.addEventListener("click", () => {
  const configurationDraft = ensureCompanionDraft(selectedProfile())?.configuration;
  if (!configurationDraft) return;
  saveCompanionConfiguration(
    configurationDraft,
    "Changes sent securely. Waiting for the owning Cedar app to validate and publish them.",
  );
});

avatarLibrary.addEventListener("toggle", () => {
  if (avatarLibrary.open) loadAvatars().catch(() => {
    avatarGrid.innerHTML = '<p class="library-loading">The avatar library could not be loaded.</p>';
  });
});

avatarSearch.addEventListener("input", () => {
  if (!avatarCatalog) {
    if (!avatarCatalogPromise) loadAvatars().catch(() => {
      avatarGrid.innerHTML = '<p class="library-loading">The avatar library could not be loaded.</p>';
    });
    return;
  }
  avatarMatches = filterAvatarCatalog(avatarCatalog, avatarSearch.value);
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
  const presentationDraft = ensureCompanionDraft(item)?.configuration.presentation || draftPresentation;
  if (
    !choice
    || !currentProfile
    || currentProfile.avatarEditable !== true
    || item.pending
    || item.configurationPending
    || isSavingProfile
    || isSavingCompanion
    || !presentationDraft
  ) return;
  const updated = { ...presentationDraft, avatarSymbol: choice.dataset.value };
  if (item.companion) setCompanionDraftSection(item, "presentation", updated);
  else draftPresentation = updated;
  setAvatar(currentProfile, choice.dataset.path, choice.dataset.name);
  for (const current of avatarGrid.querySelectorAll(".avatar-choice")) {
    const selected = current === choice;
    current.classList.toggle("is-selected", selected);
    current.setAttribute("aria-pressed", String(selected));
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
  const presentationDraft = ensureCompanionDraft(item)?.configuration.presentation || draftPresentation;
  if (!profileForItem(item)
    || item.pending
    || item.configurationPending
    || isSavingProfile
    || isSavingCompanion
    || !presentationDraft) return;
  const updated = { ...presentationDraft, badgeSelection: badgeSelector.value };
  if (item.companion) setCompanionDraftSection(item, "presentation", updated);
  else draftPresentation = updated;
  renderBadges();
  renderEditorState();
  const set = badgeCatalog?.find((value) => value.sourceURL === badgeSelector.value);
  const label = badgeSelector.value === "none"
    ? "Badges off"
    : badgeSelector.value === "builtIn"
      ? "Cedar built-in badges"
      : set?.label || "Installed badge set";
  syncMessage.classList.remove("is-error", "is-success", "is-pending");
  syncMessage.textContent = `${label} selected. Send changes when you are ready.`;
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && selectedProfile()) syncSelectedProfile();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted && selectedProfile()) syncSelectedProfile();
});

window.addEventListener("beforeunload", (event) => {
  const hasUnsavedCompanionChanges = activeProfiles.some((item) => {
    const draft = companionDrafts.get(item.credentials.spaceID);
    return draft && companionDraftIsDirty(draft, pendingComparison(item));
  });
  if (!hasUnsavedCompanionChanges && !hasDirtyLegacyPresentation(selectedProfile())) return;
  event.preventDefault();
  event.returnValue = "";
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
