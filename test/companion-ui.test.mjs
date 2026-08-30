import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  renderDeviceList,
  renderHomeBranches,
  renderRemoteControls,
} from "../public/link/companion-ui.mjs";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.focused = false;
    this.validationMessage = "";
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  focus() { this.focused = true; }
  setCustomValidity(message) { this.validationMessage = message; }
}

class FakeDocument {
  createElement(tagName) { return new FakeElement(tagName); }
  createTextNode(textContent) { return { nodeType: 3, textContent }; }
}

const document = new FakeDocument();
const ownerID = "ad72a672-d5ad-4549-a41c-dd1be6331167";
const browserID = "ae85e32e-72a6-43c9-ab1e-e50e77ee280d";
const androidID = "b8069fca-fca3-4f73-a1dd-6c861b7cbb56";
const snapshot = {
  devices: [{
    id: ownerID,
    displayName: "<img src=x onerror=alert(1)>",
    platform: "apple",
    linkedAtEpochMilliseconds: 1_800_000_000_000,
    lastSeenAtEpochMilliseconds: 1_800_000_009_000,
    isCurrent: true,
    supportsRemoteControl: true,
  }, {
    id: browserID,
    displayName: "Living Room Browser",
    platform: "browser",
    linkedAtEpochMilliseconds: 1_800_000_005_000,
    lastSeenAtEpochMilliseconds: 1_800_000_008_000,
    isCurrent: false,
    supportsRemoteControl: false,
  }, {
    id: androidID,
    displayName: "Fire TV",
    platform: "android",
    linkedAtEpochMilliseconds: 1_800_000_006_000,
    lastSeenAtEpochMilliseconds: 1_800_000_007_000,
    isCurrent: false,
    supportsRemoteControl: false,
  }],
  remoteStatuses: [{
    deviceID: ownerID,
    isOnline: true,
    isPlaying: true,
    isLive: false,
    supportedCommands: ["status", "toggle-playback", "skip-forward"],
    updatedAtEpochMilliseconds: 1_800_000_010_000,
  }],
};

test("device renderer matches production list markup, uses device-id wiring, and protects owners", () => {
  const container = new FakeElement("ul");
  const renamed = [];
  const revoked = [];
  renderDeviceList(document, container, snapshot, {
    ownerDeviceID: ownerID,
    currentDeviceID: browserID,
    now: 1_800_000_010_000,
    onRename: (device) => renamed.push(device.id),
    onRevoke: (device) => revoked.push(device.id),
  });

  assert.equal(container.children.length, 3);
  const owner = container.children[0];
  assert.equal(owner.tagName, "LI");
  assert.equal(owner.className, "device-row");
  assert.equal(owner.dataset.deviceId, ownerID);
  assert.equal(owner.children[0].tagName, "SPAN");
  assert.equal(owner.children[0].children[0].tagName, "STRONG");
  assert.equal(owner.children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(owner.children[0].children[1].tagName, "SMALL");
  assert.equal(owner.children[1].className, "device-actions");
  assert.equal(owner.children[1].children.length, 1, "the link owner has rename but no revoke");
  assert.equal(owner.children[1].children[0].dataset.deviceId, ownerID);
  owner.children[1].children[0].dispatch("click");
  assert.deepEqual(renamed, [ownerID]);

  const browser = container.children[1];
  assert.equal(browser.children[1].children.length, 1, "this browser cannot revoke itself");
  const android = container.children[2];
  assert.equal(android.children[1].children.length, 2);
  assert.equal(android.children[1].children[1].dataset.deviceId, androidID);
  assert.equal(android.children[1].children[1].attributes["aria-label"], "Revoke Fire TV");
  android.children[1].children[1].dispatch("click");
  assert.deepEqual(revoked, [androidID]);
});

test("remote renderer exposes advertised commands with production labels and dispatches once", () => {
  const selector = new FakeElement("select");
  const status = new FakeElement("p");
  const controls = new FakeElement("div");
  const selectedDevices = [];
  const sent = [];
  const selected = renderRemoteControls(document, selector, status, controls, snapshot, {
    selectedDeviceID: ownerID,
    onSelect: (deviceID) => selectedDevices.push(deviceID),
    onCommand: (deviceID, command) => sent.push({ deviceID, command }),
  });

  assert.equal(selected, ownerID);
  assert.equal(selector.children.length, 1);
  assert.equal(status.textContent, "Playing · No content details shared");
  assert.deepEqual(controls.children.map((button) => button.dataset.command), [
    "toggle-playback", "skip-forward", "status",
  ]);
  assert.deepEqual(controls.children.map((button) => button.textContent), [
    "Play / Pause", "+30", "Refresh",
  ]);
  assert.equal(controls.children[0].className, "remote-primary");
  assert.equal(controls.children[1].attributes["aria-label"], "Skip forward 30 seconds");
  selector.onchange();
  assert.deepEqual(selectedDevices, [ownerID]);
  controls.children[0].dispatch("click");
  assert.deepEqual(sent, [{ deviceID: ownerID, command: "toggle-playback" }]);
});

test("Home renderer matches production markup, emits bounded edits, and restores reorder focus", () => {
  const container = new FakeElement("ol");
  const changes = [];
  const branches = [{
    id: "first",
    title: "Trending",
    isEnabled: true,
  }, {
    id: "second",
    title: "Popular",
    isEnabled: false,
  }];
  renderHomeBranches(document, container, branches, {
    onChange: (change) => changes.push(change),
  });

  assert.equal(container.children.length, 2);
  const first = container.children[0];
  assert.equal(first.tagName, "LI");
  assert.equal(first.className, "branch-row");
  assert.equal(first.dataset.index, "0");
  assert.equal(first.dataset.branchId, "first");
  assert.deepEqual(first.children.map((child) => child.className), [
    "branch-grab", "library-search", "branch-buttons", "branch-enabled",
  ]);
  assert.equal(first.children[1].maxLength, 80);
  assert.equal(first.children[1].attributes["aria-label"], "Name for Home row 1: Trending");
  assert.equal(first.children[2].children[0].disabled, true);
  assert.equal(first.children[2].children[1].disabled, false);
  assert.equal(first.children[3].children[0].attributes["aria-label"], "Show Trending on Cedar devices");

  first.children[1].attributes["aria-invalid"] = "true";
  first.children[1].validationMessage = "Bad title";
  first.children[1].value = "Trending Now";
  first.children[1].dispatch("input");
  first.children[3].children[0].checked = false;
  first.children[3].children[0].dispatch("change");
  first.children[2].children[1].dispatch("click");
  assert.equal(first.children[1].attributes["aria-invalid"], undefined);
  assert.equal(first.children[1].validationMessage, "");
  assert.deepEqual(changes, [
    { type: "title", id: "first", index: 0, value: "Trending Now" },
    { type: "enabled", id: "first", index: 0, value: false },
    { type: "move", id: "first", index: 0, direction: "down" },
  ]);

  renderHomeBranches(document, container, [branches[1], branches[0]], {
    focusTarget: { id: "first", direction: "down" },
  });
  const moved = container.children.find((row) => row.dataset.branchId === "first");
  assert.equal(moved.children[2].children[1].disabled, true);
  assert.equal(moved.children[2].children[0].focused, true, "focus falls back to the available move control");
});

test("production link module delegates all three companion renderers to the tested module", () => {
  const source = readFileSync(new URL("../public/link/link.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\/companion-ui\.mjs\?v=workspace-1"/);
  assert.match(source, /renderDeviceList\(document, deviceList,/);
  assert.match(source, /renderHomeBranches\(document, branchEditorList,/);
  assert.match(source, /renderRemoteControls\(document, remoteDevice, remoteState, remoteControls,/);
  assert.doesNotMatch(source, /deviceList\.addEventListener\("click"/);
  assert.doesNotMatch(source, /remoteControls\.addEventListener\("click"/);
});
