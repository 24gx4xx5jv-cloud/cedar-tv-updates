import { access, readFile } from "node:fs/promises";

const requiredFiles = [
  "public/index.html",
  "public/styles.css",
  "public/assets/cedar-app-icon.png",
  "public/assets/cedar-wordmark.png",
  "public/link/index.html",
  "public/link/link.css",
  "public/link/link.js",
  "public/link/cedar-sync.mjs",
  "public/link/vendor/fflate-inflate.mjs",
  "public/link/vendor/fflate-LICENSE.txt",
  "public/catalogs/avatars.json",
  "public/catalogs/badges.json",
  "public/sync-config.json",
];

await Promise.all(requiredFiles.map((path) => access(path)));

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
  !page.includes('type="module" src="link.js?v=companion-1"')
  || !page.includes('id="link-button"')
  || !page.includes('id="link-companion"')
  || !page.includes('id="profile-selector"')
  || !page.includes('id="profile-editor"')
  || !page.includes('id="save-profile"')
  || !page.includes('id="settings-editor"')
  || !page.includes('id="branches-editor"')
  || !page.includes('id="device-list"')
  || !page.includes('id="remote-controls"')
) {
  throw new Error("The Cedar Link page is missing its required script or primary action");
}
if (/<(?:video|audio|iframe|canvas)\b/i.test(page)) {
  throw new Error("Cedar Link must remain a configuration and remote-control companion, not a player");
}

const script = await readFile("public/link/link.js", "utf8");
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
