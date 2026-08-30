import assert from "node:assert/strict";
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
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
}

class FakeDocument {
  createElement(tagName) { return new FakeElement(tagName); }
}

const document = new FakeDocument();
const ownerID = "ad72a672-d5ad-4549-a41c-dd1be6331167";
const browserID = "ae85e32e-72a6-43c9-ab1e-e50e77ee280d";
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

test("device DOM uses text nodes and never offers owner revocation", () => {
  const container = new FakeElement("div");
  const renamed = [];
  const revoked = [];
  renderDeviceList(document, container, snapshot, {
    ownerDeviceID: ownerID,
    currentDeviceID: browserID,
    now: 1_800_000_010_000,
    onRename: (device) => renamed.push(device.id),
    onRevoke: (device) => revoked.push(device.id),
  });

  assert.equal(container.children.length, 2);
  const owner = container.children[0];
  assert.equal(owner.children[0].children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(owner.children[1].children.length, 1, "the link owner has rename but no revoke");
  owner.children[1].children[0].dispatch("click");
  assert.deepEqual(renamed, [ownerID]);

  const browser = container.children[1];
  assert.equal(browser.children[1].children.length, 2);
  browser.children[1].children[1].dispatch("click");
  assert.deepEqual(revoked, [browserID]);
});

test("remote DOM exposes only the authenticated advertised command list", () => {
  const selector = new FakeElement("select");
  const status = new FakeElement("p");
  const controls = new FakeElement("div");
  const sent = [];
  const selected = renderRemoteControls(document, selector, status, controls, snapshot, {
    selectedDeviceID: ownerID,
    onCommand: (deviceID, command) => sent.push({ deviceID, command }),
  });

  assert.equal(selected, ownerID);
  assert.equal(selector.children.length, 1);
  assert.equal(status.textContent, "Playing");
  assert.deepEqual(controls.children.map((button) => button.dataset.command), [
    "status", "toggle-playback", "skip-forward",
  ]);
  controls.children[1].dispatch("click");
  assert.deepEqual(sent, [{ deviceID: ownerID, command: "toggle-playback" }]);
});

test("Home DOM emits bounded edits and reorder intents without deleting rows", () => {
  const container = new FakeElement("div");
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
  assert.equal(first.children[1].maxLength, 80);
  assert.equal(first.children[2].children[0].disabled, true);
  assert.equal(first.children[2].children[1].disabled, false);
  first.children[1].value = "Trending Now";
  first.children[1].dispatch("input");
  first.children[2].children[1].dispatch("click");
  assert.deepEqual(changes, [
    { type: "title", id: "first", value: "Trending Now" },
    { type: "move", id: "first", direction: "down" },
  ]);
  assert.equal(first.children[2].children.some((button) => button.dataset.action === "delete"), false);
});
