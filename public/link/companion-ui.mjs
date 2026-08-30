const COMMAND_LABELS = Object.freeze({
  status: "Refresh status",
  "toggle-playback": "Play / pause",
  "skip-backward": "Back 10 seconds",
  "skip-forward": "Forward 30 seconds",
  "skip-intro": "Skip intro",
  "next-episode": "Next episode",
  "jump-to-live": "Jump to live",
});

const element = (document, tag, className = "", text = "") => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
};

const platformLabel = (platform) => ({
  apple: "Apple",
  android: "Android TV",
  browser: "Browser",
})[platform] || "Cedar device";

const activityLabel = (timestamp, now) => {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 2 * 60 * 1_000) return "Active recently";
  if (elapsed < 60 * 60 * 1_000) return `${Math.max(2, Math.round(elapsed / 60_000))} min ago`;
  if (elapsed < 24 * 60 * 60 * 1_000) return `${Math.round(elapsed / 3_600_000)} hr ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
};

export const renderDeviceList = (
  document,
  container,
  snapshot,
  {
    ownerDeviceID,
    currentDeviceID,
    disabled = false,
    now = Date.now(),
    onRename = () => {},
    onRevoke = () => {},
  } = {},
) => {
  container.replaceChildren();
  const statuses = new Map(snapshot.remoteStatuses.map((status) => [status.deviceID, status]));
  for (const device of snapshot.devices) {
    const row = element(document, "article", "device-row");
    row.dataset.deviceId = device.id;
    const copy = element(document, "div", "device-copy");
    const heading = element(document, "h4", "", device.displayName);
    const qualifiers = [platformLabel(device.platform)];
    if (device.id === currentDeviceID) qualifiers.push("This browser");
    if (device.id === ownerDeviceID) qualifiers.push("Link owner");
    const status = statuses.get(device.id);
    qualifiers.push(status?.isOnline ? (status.isPlaying ? "Playing" : "Online") : activityLabel(
      device.lastSeenAtEpochMilliseconds,
      now,
    ));
    const detail = element(document, "p", "", qualifiers.join(" · "));
    copy.append(heading, detail);

    const actions = element(document, "div", "device-actions");
    const rename = element(document, "button", "small-button", "Rename");
    rename.type = "button";
    rename.disabled = disabled;
    rename.dataset.action = "rename";
    rename.addEventListener("click", () => onRename(device));
    actions.append(rename);
    if (device.id !== ownerDeviceID) {
      const revoke = element(document, "button", "small-button is-destructive", "Revoke");
      revoke.type = "button";
      revoke.disabled = disabled;
      revoke.dataset.action = "revoke";
      revoke.addEventListener("click", () => onRevoke(device));
      actions.append(revoke);
    }
    row.append(copy, actions);
    container.append(row);
  }
  if (snapshot.devices.length === 0) {
    container.append(element(document, "p", "empty-state", "No linked devices are available."));
  }
};

export const renderRemoteControls = (
  document,
  selector,
  statusElement,
  controls,
  snapshot,
  { selectedDeviceID = "", disabled = false, onSelect = () => {}, onCommand = () => {} } = {},
) => {
  const devices = snapshot.devices.filter((device) => device.supportsRemoteControl);
  selector.replaceChildren();
  for (const device of devices) {
    const option = element(document, "option", "", device.displayName);
    option.value = device.id;
    selector.append(option);
  }
  const selected = devices.some((device) => device.id === selectedDeviceID)
    ? selectedDeviceID
    : devices[0]?.id || "";
  selector.value = selected;
  selector.disabled = disabled || devices.length === 0;
  selector.onchange = () => onSelect(selector.value);

  controls.replaceChildren();
  const remoteStatus = snapshot.remoteStatuses.find((status) => status.deviceID === selected);
  if (!selected) {
    statusElement.textContent = "No linked device currently advertises remote control.";
    return "";
  }
  if (!remoteStatus) {
    statusElement.textContent = "Waiting for this device to publish transport status.";
    return selected;
  }
  statusElement.textContent = remoteStatus.isOnline
    ? `${remoteStatus.isPlaying ? "Playing" : "Paused"}${remoteStatus.isLive ? " · Live" : ""}`
    : "Offline";
  for (const command of remoteStatus.supportedCommands) {
    const button = element(document, "button", "remote-button", COMMAND_LABELS[command] || command);
    button.type = "button";
    button.dataset.command = command;
    button.disabled = disabled || (!remoteStatus.isOnline && command !== "status");
    button.addEventListener("click", () => onCommand(selected, command));
    controls.append(button);
  }
  return selected;
};

export const renderHomeBranches = (
  document,
  container,
  branches,
  { disabled = false, onChange = () => {} } = {},
) => {
  container.replaceChildren();
  branches.forEach((branch, index) => {
    const row = element(document, "div", "home-branch-row");
    row.dataset.branchId = branch.id;
    const enabledLabel = element(document, "label", "branch-enabled");
    const enabled = element(document, "input");
    enabled.type = "checkbox";
    enabled.checked = branch.isEnabled;
    enabled.disabled = disabled;
    enabled.setAttribute("aria-label", `Enable ${branch.title}`);
    enabled.addEventListener("change", () => onChange({ type: "enabled", id: branch.id, value: enabled.checked }));
    enabledLabel.append(enabled);

    const title = element(document, "input", "branch-title");
    title.type = "text";
    title.value = branch.title;
    title.maxLength = 80;
    title.disabled = disabled;
    title.setAttribute("aria-label", `Home row name: ${branch.title}`);
    title.addEventListener("input", () => onChange({ type: "title", id: branch.id, value: title.value }));

    const actions = element(document, "div", "branch-actions");
    for (const [direction, label, unavailable] of [
      ["up", "Move up", index === 0],
      ["down", "Move down", index === branches.length - 1],
    ]) {
      const button = element(document, "button", "small-button", direction === "up" ? "↑" : "↓");
      button.type = "button";
      button.title = label;
      button.setAttribute("aria-label", `${label}: ${branch.title}`);
      button.disabled = disabled || unavailable;
      button.addEventListener("click", () => onChange({ type: "move", id: branch.id, direction }));
      actions.append(button);
    }
    row.append(enabledLabel, title, actions);
    container.append(row);
  });
};
