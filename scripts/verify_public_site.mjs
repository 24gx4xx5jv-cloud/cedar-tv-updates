import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "public/index.html",
  "public/styles.css",
  "public/policy.css",
  "public/assets/cedar-app-icon.png",
  "public/assets/cedar-wordmark.png",
  "public/assets/tmdb-logo.svg",
  "public/apple/index.html",
  "public/support/index.html",
  "public/privacy/index.html",
  "public/accessibility/index.html",
  "public/content-policy/index.html",
  "public/cedar-link/index.html",
  "public/demo/cedar-review.m3u",
  "public/link/index.html",
  "public/link/link.css",
  "public/link/link.js",
  "public/link/companion-draft.mjs",
  "public/link/cedar-sync.mjs",
  "public/link/companion-ui.mjs",
  "public/link/vendor/fflate-inflate.mjs",
  "public/link/vendor/fflate-LICENSE.txt",
  "public/catalogs/avatars.json",
  "public/catalogs/badges.json",
  "public/sync-config.json",
];

await Promise.all(requiredFiles.map((path) => access(path)));

const policyPages = [
  "apple",
  "support",
  "privacy",
  "accessibility",
  "content-policy",
  "cedar-link",
];
for (const route of policyPages) {
  const policyPage = await readFile(`public/${route}/index.html`, "utf8");
  const canonical = `https://24gx4xx5jv-cloud.github.io/cedar-tv-updates/${route}/`;
  if (
    !policyPage.includes(`<link rel="canonical" href="${canonical}">`)
    || !policyPage.includes("Content-Security-Policy")
    || !policyPage.includes('/cedar-tv-updates/support/')
    || !policyPage.includes('/cedar-tv-updates/privacy/')
    || /\[(?:SUPPORT EMAIL|LEGAL HOLDER|OWNER REQUIRED)\]/i.test(policyPage)
    || /chatgpt\.site/i.test(policyPage)
  ) {
    throw new Error(`${route} is missing canonical policy metadata or contains a release placeholder`);
  }
}

const supportPage = await readFile("public/support/index.html", "utf8");
if (!supportPage.includes("https://discord.gg/TFTx7j86v") || !supportPage.includes("/issues")) {
  throw new Error("The public Support URL must contain working contact options");
}

const privacyPage = await readFile("public/privacy/index.html", "utf8");
for (const requiredPrivacyTopic of [
  "Data on your device",
  "Services you connect",
  "Cedar Link retention and deletion",
  "Tracking and advertising",
  "Your choices and contact",
]) {
  if (!privacyPage.includes(requiredPrivacyTopic)) {
    throw new Error(`The privacy policy is missing ${requiredPrivacyTopic}`);
  }
}

const demoPlaylist = await readFile("public/demo/cedar-review.m3u", "utf8");
if (!demoPlaylist.startsWith("#EXTM3U\n") || !demoPlaylist.includes("Big Buck Bunny") || !demoPlaylist.includes("https://")) {
  throw new Error("The App Review demo playlist is incomplete");
}

const config = JSON.parse(await readFile("public/sync-config.json", "utf8"));
if (config.schemaVersion !== 1 || typeof config.relayBaseURL !== "string") {
  throw new Error("sync-config.json must contain the version 1 Cedar Link configuration");
}

const relay = new URL(config.relayBaseURL);
if (
  relay.protocol !== "https:"
  || relay.username
  || relay.password
  || relay.search
  || relay.hash
) {
  throw new Error("Cedar Link requires a clean HTTPS relay origin");
}

const page = await readFile("public/link/index.html", "utf8");
if (!page.includes(`connect-src 'self' ${relay.origin}`)) {
  throw new Error("The Cedar Link CSP must allow its configured relay origin");
}
if (
  !page.includes('href="link.css?v=workspace-1"')
  || !page.includes('type="module" src="link.js?v=workspace-2"')
  || !page.includes('id="link-button"')
  || !page.includes('id="link-companion"')
  || !page.includes('id="profile-selector"')
  || !page.includes('id="profile-editor"')
  || !page.includes('id="save-profile"')
  || !page.includes('id="settings-editor"')
  || !page.includes('id="branches-editor"')
  || !page.includes('id="device-list"')
  || !page.includes('id="forget-browser"')
  || !page.includes('id="remote-controls"')
  || !page.includes('id="companion-savebar"')
  || !page.includes('role="tablist"')
) {
  throw new Error("The Cedar Link page is missing its required script or primary action");
}
if (/<(?:video|audio|iframe|canvas)\b/i.test(page)) {
  throw new Error("Cedar Link must remain a configuration and remote-control companion, not a player");
}

const script = await readFile("public/link/link.js", "utf8");
if (!script.includes('from "./cedar-sync.mjs?v=companion-6"')) {
  throw new Error("The Cedar Link protocol module needs the current cache token");
}
if (!script.includes('from "./companion-draft.mjs?v=workspace-1"')) {
  throw new Error("The Cedar Link draft module needs the current cache token");
}
if (
  script.indexOf("history.replaceState") < 0
  || script.indexOf("history.replaceState") > script.indexOf("parseWebInvitationFragment(fragment)")
) {
  throw new Error("The Cedar Link fragment must be removed before invitation parsing continues");
}
for (const requiredPath of ["/v1/health", "/claim", "../sync-config.json", "../catalogs/avatars.json", "../catalogs/badges.json"]) {
  if (!script.includes(requiredPath)) {
    throw new Error(`The Cedar Link client is missing ${requiredPath}`);
  }
}

const badges = JSON.parse(await readFile("public/catalogs/badges.json", "utf8"));
if (!Array.isArray(badges.sets) || badges.sets.length === 0) {
  throw new Error("The Cedar badge catalog is empty");
}
for (const set of badges.sets) {
  const source = new URL(set.sourceURL);
  if (
    typeof set.id !== "string"
    || !/^[a-z0-9_-]+$/i.test(set.id)
    || source.origin !== "https://24gx4xx5jv-cloud.github.io"
    || source.pathname !== `/cedar-tv-updates/badge-packs/${set.id}.json`
  ) {
    throw new Error(`Badge set ${set.label || "unknown"} has an invalid install source`);
  }
  const pack = JSON.parse(await readFile(`public/badge-packs/${set.id}.json`, "utf8"));
  if (!Array.isArray(pack.groups) || !Array.isArray(pack.filters) || pack.filters.length === 0) {
    throw new Error(`Badge set ${set.label || set.id} is not installable`);
  }
}

const protocol = await readFile("public/link/cedar-sync.mjs", "utf8");
for (const requiredProtocol of [
  "cedar-sync-v1:",
  "/changes",
  "/invitations",
  "AES-GCM",
  "DecompressionStream",
  "inflateSync",
  "scope",
  "ownerDeviceID",
  "cedar-companion-snapshot",
  "browser-companion-configuration",
  "browser-remote-command",
  "browser-device-action",
]) {
  if (!protocol.includes(requiredProtocol)) {
    throw new Error(`The Cedar Link protocol client is missing ${requiredProtocol}`);
  }
}

console.log(`Verified Cedar Link for ${relay.origin}`);
