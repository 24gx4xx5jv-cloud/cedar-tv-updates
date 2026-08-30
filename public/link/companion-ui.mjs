const COMMANDS = Object.freeze({
  status: { label: "Refresh", accessibleLabel: "Refresh status" },
  "toggle-playback": { label: "Play / Pause", accessibleLabel: "Play or pause", primary: true },
  "skip-backward": { label: "−10", accessibleLabel: "Skip backward 10 seconds" },
  "skip-forward": { label: "+30", accessibleLabel: "Skip forward 30 seconds" },
  "skip-intro": { label: "Skip Intro", accessibleLabel: "Skip intro" },
  "next-episode": { label: "Next Episode", accessibleLabel: "Next episode" },
  "jump-to-live": { label: "Jump to Live", accessibleLabel: "Jump to live" },
});
const COMMAND_ORDER = Object.freeze([
  "skip-backward",
  "toggle-playback",
  "skip-forward",
  "skip-intro",
  "next-episode",
  "jump-to-live",
  "status",
]);

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
  if (!Number.isSafeInteger(timestamp)) return "Activity unavailable";
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
    emptyMessage = "No linked devices are available.",
    onRename = () => {},
    onRevoke = () => {},
  } = {},
) => {
  container.replaceChildren();
  const devices = snapshot?.devices || [];
  const statuses = new Map((snapshot?.remoteStatuses || []).map((status) => [status.deviceID, status]));
  for (const device of devices) {
    const row = element(document, "li", "device-row");
    row.dataset.deviceId = device.id;

    const details = element(document, "span", "device-copy");
    const name = element(document, "strong", "", device.displayName);
    const qualifiers = [platformLabel(device.platform)];
    if (device.id === currentDeviceID) qualifiers.push("This browser");
    if (device.id === ownerDeviceID || device.isCurrent) qualifiers.push("Owner device");
    const status = statuses.get(device.id);
    qualifiers.push(status?.isOnline
      ? (status.isPlaying ? "Playing" : "Online")
      : activityLabel(device.lastSeenAtEpochMilliseconds, now));
    const meta = element(document, "small", "", qualifiers.join(" · "));
    details.append(name, meta);

    const actions = element(document, "span", "device-actions");
    const rename = element(document, "button", "", "Rename");
    rename.type = "button";
    rename.disabled = disabled;
    rename.dataset.action = "rename";
    rename.dataset.deviceId = device.id;
    rename.setAttribute("aria-label", `Rename ${device.displayName}`);
    rename.addEventListener("click", () => onRename(device));
    actions.append(rename);

    const isProtected = device.id === ownerDeviceID
      || device.id === currentDeviceID
      || device.isCurrent;
    if (!isProtected) {
      const revoke = element(document, "button", "danger-button", "Revoke");
      revoke.type = "button";
      revoke.disabled = disabled;
      revoke.dataset.action = "revoke";
      revoke.dataset.deviceId = device.id;
      revoke.setAttribute("aria-label", `Revoke ${device.displayName}`);
      revoke.addEventListener("click", () => onRevoke(device));
      actions.append(revoke);
    }

    row.append(details, actions);
    container.append(row);
  }
  if (devices.length === 0) {
    container.append(element(document, "li", "library-loading", emptyMessage));
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
  const devices = (snapshot?.devices || []).filter((device) => device.supportsRemoteControl);
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
  const remoteStatus = (snapshot?.remoteStatuses || []).find((status) => status.deviceID === selected);
  if (!selected) {
    statusElement.textContent = "No remote-capable Cedar device is linked yet.";
    return "";
  }
  if (!remoteStatus) {
    statusElement.textContent = "Waiting for transport status from this Cedar device.";
    return selected;
  }
  statusElement.textContent = remoteStatus.isOnline
    ? `${remoteStatus.isPlaying ? "Playing" : "Paused"}${remoteStatus.isLive ? " · Live mode" : ""} · No content details shared`
    : "Offline · Open Cedar on this device to receive commands.";
  const commands = [...remoteStatus.supportedCommands].sort((left, right) => {
    const leftIndex = COMMAND_ORDER.indexOf(left);
    const rightIndex = COMMAND_ORDER.indexOf(right);
    return (leftIndex < 0 ? COMMAND_ORDER.length : leftIndex)
      - (rightIndex < 0 ? COMMAND_ORDER.length : rightIndex);
  });
  for (const command of commands) {
    const presentation = COMMANDS[command] || {
      label: command,
      accessibleLabel: command,
      primary: false,
    };
    const button = element(
      document,
      "button",
      presentation.primary ? "remote-primary" : "",
      presentation.label,
    );
    button.type = "button";
    button.dataset.command = command;
    button.setAttribute("aria-label", presentation.accessibleLabel);
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
  { disabled = false, focusTarget = null, onChange = () => {} } = {},
) => {
  container.replaceChildren();
  let nextFocus = null;
  branches.forEach((branch, index) => {
    const restoresFocus = focusTarget?.id === branch.id;
    let preferredMoveFocus = null;
    let fallbackMoveFocus = null;
    const row = element(document, "li", "branch-row");
    row.dataset.index = String(index);
    row.dataset.branchId = branch.id;

    const grab = element(document, "span", "branch-grab", "⋮⋮");
    grab.setAttribute("aria-hidden", "true");

    const title = element(document, "input", "library-search");
    title.type = "text";
    title.value = branch.title;
    title.maxLength = 80;
    title.disabled = disabled;
    title.dataset.validationField = `branch-title-${index}`;
    title.setAttribute("aria-label", `Name for Home row ${index + 1}: ${branch.title}`);
    title.addEventListener("input", () => {
      title.setCustomValidity?.("");
      title.removeAttribute("aria-invalid");
      onChange({
        type: "title",
        id: branch.id,
        index,
        value: title.value,
      });
    });

    const actions = element(document, "span", "branch-buttons");
    for (const [direction, label, unavailable] of [
      ["up", "Move up", index === 0],
      ["down", "Move down", index === branches.length - 1],
    ]) {
      const button = element(document, "button", "", direction === "up" ? "↑" : "↓");
      button.type = "button";
      button.dataset.action = direction;
      button.setAttribute("aria-label", `${label}: ${branch.title}`);
      button.disabled = disabled || unavailable;
      button.addEventListener("click", () => onChange({
        type: "move",
        id: branch.id,
        index,
        direction,
      }));
      actions.append(button);
      if (restoresFocus && !button.disabled) {
        if (focusTarget.direction === direction) preferredMoveFocus = button;
        else fallbackMoveFocus = button;
      }
    }

    const enabledLabel = element(document, "label", "branch-enabled");
    const enabled = element(document, "input");
    enabled.type = "checkbox";
    enabled.checked = branch.isEnabled;
    enabled.disabled = disabled;
    enabled.dataset.action = "enabled";
    enabled.setAttribute("aria-label", `Show ${branch.title} on Cedar devices`);
    enabled.addEventListener("change", () => onChange({
      type: "enabled",
      id: branch.id,
      index,
      value: enabled.checked,
    }));
    enabledLabel.append(enabled, document.createTextNode("Show this row on Cedar devices"));

    row.append(grab, title, actions, enabledLabel);
    container.append(row);
    if (restoresFocus) nextFocus = preferredMoveFocus || fallbackMoveFocus || title;
  });
  nextFocus?.focus();
};
