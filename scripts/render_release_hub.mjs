import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { footerStylesheet, projectBasePath, renderSiteFooter } from "./site_components.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(repositoryRoot, "public/releases");
const publicBaseURL = "https://cedartv.github.io/cedar-tv-updates/releases";

const platformDefinitions = [
  {
    id: "android-tv",
    name: "Cedar for Android TV",
    shortName: "Android TV",
    description: "Android TV, Google TV, and Fire TV release notes.",
    notesURL: `${projectBasePath}/releases/android-tv/`,
  },
  {
    id: "iphone",
    name: "Cedar for iPhone",
    shortName: "iPhone",
    description: "Mobile releases for Cedar on iPhone.",
    notesURL: `${projectBasePath}/apple/releases/iphone/`,
  },
  {
    id: "ipad",
    name: "Cedar for iPad",
    shortName: "iPad",
    description: "Tablet releases for Cedar on iPad.",
    notesURL: `${projectBasePath}/apple/releases/ipad/`,
  },
  {
    id: "apple-tv",
    name: "Cedar for Apple TV",
    shortName: "Apple TV",
    description: "Living-room releases for Cedar on Apple TV.",
    notesURL: `${projectBasePath}/apple/releases/apple-tv/`,
  },
  {
    id: "mac",
    name: "Cedar for Mac",
    shortName: "Mac",
    description: "Desktop releases for Cedar on Mac.",
    notesURL: `${projectBasePath}/apple/releases/mac/`,
  },
];

const statusLabels = new Map([
  ["release-candidate", "Release candidate"],
  ["testflight", "TestFlight"],
  ["released", "Released"],
]);

function fail(message) {
  throw new Error(`Release hub: ${message}`);
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function requireText(value, label, maximumLength = 1_000) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > maximumLength) {
    fail(`${label} must be nonempty, trimmed text no longer than ${maximumLength} characters`);
  }
  return value;
}

function validateRelease(source, expectedPlatform, label) {
  if (source.platform !== expectedPlatform) fail(`${label} must target ${expectedPlatform}`);
  const version = requireText(source.version, `${label} version`, 30);
  const build = requireText(source.build, `${label} build`, 20);
  const date = requireText(source.date, `${label} date`, 10);
  const status = requireText(source.status, `${label} status`, 40);
  const summary = requireText(source.summary, `${label} summary`, 280);
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${label} version must use three numeric components`);
  if (!/^[1-9]\d*$/.test(build)) fail(`${label} build must be a positive integer string`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).valueOf())) {
    fail(`${label} date must be a real YYYY-MM-DD date`);
  }
  if (!statusLabels.has(status)) fail(`${label} has unsupported status ${status}`);
  return { platform: expectedPlatform, version, build, date, status, summary, notes: source.notes };
}

function compareReleases(left, right) {
  return right.date.localeCompare(left.date)
    || right.version.localeCompare(left.version, undefined, { numeric: true })
    || Number(right.build) - Number(left.build);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function releaseMetadata(release) {
  return `<div class="release-metadata">
              <span class="release-status release-status-${release.status}">${statusLabels.get(release.status)}</span>
              <span>Version ${escapeHTML(release.version)}</span>
              <span>Build ${escapeHTML(release.build)}</span>
              <time datetime="${release.date}">${formatDate(release.date)}</time>
            </div>`;
}

function renderMarkdown(markdown, expectedTitle) {
  if (markdown.includes("<") || markdown.includes(">")) fail(`${expectedTitle} notes cannot contain raw HTML`);
  const lines = markdown.replaceAll("\r\n", "\n").trimEnd().split("\n");
  if (lines.shift() !== `# ${expectedTitle}`) fail(`notes must begin with \"# ${expectedTitle}\"`);
  const output = [];
  let listOpen = false;
  let paragraph = [];
  const closeParagraph = () => {
    if (paragraph.length > 0) {
      output.push(`<p>${escapeHTML(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) output.push("</ul>");
    listOpen = false;
  };
  for (const line of lines) {
    if (!line) {
      closeParagraph();
      closeList();
    } else if (line.startsWith("## ")) {
      closeParagraph();
      closeList();
      output.push(`<h3>${escapeHTML(requireText(line.slice(3), "section heading", 120))}</h3>`);
    } else if (line.startsWith("- ")) {
      closeParagraph();
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${escapeHTML(requireText(line.slice(2), "list item", 500))}</li>`);
    } else {
      closeList();
      paragraph.push(requireText(line, "paragraph line", 1_000));
    }
  }
  closeParagraph();
  closeList();
  return output.join("\n");
}

function navigation() {
  return [
    ["Apple apps", `${projectBasePath}/apple/`],
    ["Release notes", `${projectBasePath}/releases/`],
    ["Support", `${projectBasePath}/support/`],
    ["Privacy", `${projectBasePath}/privacy/`],
    ["Cedar Link", `${projectBasePath}/cedar-link/`],
  ].map(([label, href]) => `<a href="${href}"${label === "Release notes" ? ' aria-current="page"' : ""}>${label}</a>`).join("\n          ");
}

function pageShell({ title, description, canonical, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#08090b">
    <meta name="description" content="${escapeHTML(description)}">
    <meta name="robots" content="index,follow">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self'; style-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'">
    <title>${escapeHTML(title)}</title>
    <link rel="canonical" href="${canonical}">
    <link rel="icon" type="image/png" href="${projectBasePath}/assets/cedar-app-icon.png">
    <link rel="apple-touch-icon" href="${projectBasePath}/assets/cedar-app-icon.png">
    <link rel="stylesheet" href="${projectBasePath}/policy.css">
${footerStylesheet}
  </head>
  <body>
    <div class="site-frame">
      <header class="policy-header">
        <a class="site-brand" href="${projectBasePath}/" aria-label="Cedar home">
          <img src="${projectBasePath}/assets/cedar-app-icon.png" alt="" width="34" height="34" aria-hidden="true">
          <span>Cedar</span>
        </a>
        <nav aria-label="Primary navigation">
          ${navigation()}
        </nav>
      </header>

${body}

${renderSiteFooter()}
    </div>
  </body>
</html>
`;
}

const appleCatalog = JSON.parse(await readFile(resolve(repositoryRoot, "release-notes/apple/releases.json"), "utf8"));
const androidCatalog = JSON.parse(await readFile(resolve(repositoryRoot, "release-notes/android-tv/releases.json"), "utf8"));
const updateManifest = JSON.parse(await readFile(resolve(repositoryRoot, "public/update-v1.json"), "utf8"));
if (appleCatalog.schemaVersion !== 1 || androidCatalog.schemaVersion !== 1) fail("source catalogs must use schema version 1");

const currentReleases = [];
for (const platform of platformDefinitions) {
  const catalog = platform.id === "android-tv" ? androidCatalog : appleCatalog;
  const matches = catalog.releases
    .filter((release) => release.platform === platform.id)
    .map((release, index) => validateRelease(release, platform.id, `${platform.name} release ${index + 1}`))
    .sort(compareReleases);
  if (matches.length === 0) fail(`${platform.name} needs at least one release`);
  currentReleases.push({ ...matches[0], ...platform });
}

const androidRelease = currentReleases.find((release) => release.id === "android-tv");
if (updateManifest.versionName !== androidRelease.version || String(updateManifest.versionCode) !== androidRelease.build) {
  fail("Android release catalog must match update-v1.json versionName and versionCode");
}
const expectedAPKURL = `https://github.com/CedarTV/cedar-tv-updates/releases/download/v${androidRelease.version}/Cedar-TV-${androidRelease.version}.apk`;
if (updateManifest.apkUrl !== expectedAPKURL) fail("Android release APK URL does not match the current version");

const cards = currentReleases.map((release) => `          <article class="release-card">
            <p class="eyebrow">${escapeHTML(release.shortName)}</p>
            <h2>${escapeHTML(release.name)}</h2>
            <p>${escapeHTML(release.summary)}</p>
            ${releaseMetadata(release)}
            <a class="inline-document-link" href="${release.notesURL}">View ${escapeHTML(release.shortName)} notes</a>
          </article>`).join("\n");

const indexPage = pageShell({
  title: "Cedar release notes",
  description: "Current version, build, status, and release notes for Cedar on Android TV, iPhone, iPad, Apple TV, and Mac.",
  canonical: `${publicBaseURL}/`,
  body: `      <main class="document-page release-page">
        <header class="document-header release-header">
          <p class="eyebrow">All platforms</p>
          <h1>One release view. Every Cedar platform.</h1>
          <p>See the current version, build number, availability status, and notes for Android TV, iPhone, iPad, Apple TV, and Mac.</p>
        </header>

        <section class="release-grid" aria-label="Current Cedar releases">
${cards}
        </section>

        <section class="policy-callout compact-callout" aria-labelledby="release-status-title">
          <p class="eyebrow">Clear status</p>
          <h2 id="release-status-title">Candidates stay labeled as candidates.</h2>
          <p>Android direct releases, Apple TestFlight builds, release candidates, and public App Store releases are identified separately. The status changes only when the matching build is actually available in that channel.</p>
        </section>
      </main>`,
});

const androidNotesPath = resolve(repositoryRoot, androidRelease.notes);
if (androidRelease.notes !== `release-notes/android-tv/${androidRelease.version}.md`) {
  fail(`Android notes path must be release-notes/android-tv/${androidRelease.version}.md`);
}
const androidNotes = renderMarkdown(await readFile(androidNotesPath, "utf8"), `${androidRelease.name} ${androidRelease.version}`);
const androidPage = pageShell({
  title: "Cedar for Android TV release notes",
  description: androidRelease.description,
  canonical: `${publicBaseURL}/android-tv/`,
  body: `      <main class="document-page release-page">
        <a class="release-back" href="${projectBasePath}/releases/">All platform releases</a>
        <header class="document-header release-header">
          <p class="eyebrow">Android TV changelog</p>
          <h1>Cedar for Android TV release notes.</h1>
          <p>Current signed builds for Android TV, Google TV, and Fire TV, with their matching build numbers and notes.</p>
        </header>

        <article class="release-entry" id="version-${androidRelease.version.replaceAll(".", "-")}-build-${androidRelease.build}">
          <header>
            <p class="eyebrow">Android TV</p>
            <h2>Version ${escapeHTML(androidRelease.version)}</h2>
            <p class="release-summary">${escapeHTML(androidRelease.summary)}</p>
            ${releaseMetadata(androidRelease)}
            <div class="apple-actions">
              <a class="inline-action" href="${escapeHTML(updateManifest.apkUrl)}">Download signed APK</a>
              <a class="secondary-action" href="https://github.com/CedarTV/cedar-tv-updates/releases/tag/v${escapeHTML(androidRelease.version)}">GitHub release</a>
            </div>
          </header>
          <div class="release-notes-body">
${androidNotes.split("\n").map((line) => `            ${line}`).join("\n")}
          </div>
        </article>
      </main>`,
});

const publicCatalog = {
  schemaVersion: 1,
  platforms: currentReleases.map((release) => ({
    id: release.id,
    name: release.name,
    version: release.version,
    build: release.build,
    date: release.date,
    status: release.status,
    summary: release.summary,
    notesURL: new URL(release.notesURL, "https://cedartv.github.io").href,
    ...(release.id === "android-tv" ? { downloadURL: updateManifest.apkUrl } : {}),
  })),
};

const outputs = new Map([
  [resolve(publicRoot, "index.html"), indexPage],
  [resolve(publicRoot, "releases.json"), `${JSON.stringify(publicCatalog, null, 2)}\n`],
  [resolve(publicRoot, "android-tv/index.html"), androidPage],
]);

const argumentsList = process.argv.slice(2);
const checkOnly = argumentsList.includes("--check");
if (argumentsList.some((argument) => !["--check", "--write"].includes(argument))) {
  fail("supported arguments are --write and --check");
}

if (checkOnly) {
  for (const [path, expected] of outputs) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) fail(`${path.replace(`${repositoryRoot}/`, "")} is not current; run node scripts/render_release_hub.mjs --write`);
  }
} else {
  for (const [path, contents] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
}

console.log(`${checkOnly ? "Verified" : "Rendered"} current version and build data for ${currentReleases.length} Cedar platforms`);
