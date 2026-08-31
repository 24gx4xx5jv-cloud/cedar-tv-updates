import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceCatalogPath = resolve(repositoryRoot, "release-notes/apple/releases.json");
const publicRoot = resolve(repositoryRoot, "public/apple/releases");
const publicBaseURL = "https://cedartv.github.io/cedar-tv-updates/apple/releases";
const projectBasePath = "/cedar-tv-updates";

const platforms = [
  {
    id: "iphone",
    name: "Cedar for iPhone",
    shortName: "iPhone",
    description: "Mobile release notes for Cedar on iPhone.",
  },
  {
    id: "ipad",
    name: "Cedar for iPad",
    shortName: "iPad",
    description: "Tablet release notes for Cedar on iPad.",
  },
  {
    id: "apple-tv",
    name: "Cedar for Apple TV",
    shortName: "Apple TV",
    description: "Living-room release notes for Cedar on Apple TV.",
  },
  {
    id: "mac",
    name: "Cedar for Mac",
    shortName: "Mac",
    description: "Desktop release notes for Cedar on Mac.",
  },
];

const platformByID = new Map(platforms.map((platform) => [platform.id, platform]));
const statusLabels = new Map([
  ["release-candidate", "Release candidate"],
  ["testflight", "TestFlight"],
  ["released", "Released"],
]);

function fail(message) {
  throw new Error(`Apple release catalog: ${message}`);
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

function requireDate(value, label) {
  requireText(value, label, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} is not a real calendar date`);
  }
  return value;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return rightParts[index] - leftParts[index];
    }
  }
  return 0;
}

function compareReleases(left, right) {
  return right.date.localeCompare(left.date)
    || compareVersions(left.version, right.version)
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

function releaseAnchor(release) {
  return `version-${release.version.replaceAll(".", "-")}-build-${release.build}`;
}

function renderMarkdown(markdown, expectedTitle) {
  if (markdown.includes("<") || markdown.includes(">")) {
    fail(`${expectedTitle} notes cannot contain raw HTML`);
  }
  const lines = markdown.replaceAll("\r\n", "\n").trimEnd().split("\n");
  if (lines.shift() !== `# ${expectedTitle}`) {
    fail(`notes must begin with \"# ${expectedTitle}\"`);
  }

  const output = [];
  let paragraph = [];
  let listOpen = false;
  const closeParagraph = () => {
    if (paragraph.length > 0) {
      output.push(`<p>${escapeHTML(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
  };

  for (const line of lines) {
    if (line.length === 0) {
      closeParagraph();
      closeList();
      continue;
    }
    if (line.startsWith("## ")) {
      closeParagraph();
      closeList();
      const heading = requireText(line.slice(3), `${expectedTitle} section heading`, 120);
      output.push(`<h3>${escapeHTML(heading)}</h3>`);
      continue;
    }
    if (line.startsWith("- ")) {
      closeParagraph();
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${escapeHTML(requireText(line.slice(2), `${expectedTitle} list item`, 500))}</li>`);
      continue;
    }
    if (line.startsWith("#") || line.startsWith("-")) {
      fail(`${expectedTitle} contains unsupported Markdown: ${line}`);
    }
    closeList();
    paragraph.push(requireText(line, `${expectedTitle} paragraph line`, 1_000));
  }
  closeParagraph();
  closeList();
  if (!output.some((line) => line.startsWith("<h3>"))) {
    fail(`${expectedTitle} must contain at least one section`);
  }
  return output.join("\n");
}

function navigation(current) {
  const items = [
    ["apple", "Apple apps", `${projectBasePath}/apple/`],
    ["releases", "Release notes", `${projectBasePath}/apple/releases/`],
    ["support", "Support", `${projectBasePath}/support/`],
    ["privacy", "Privacy", `${projectBasePath}/privacy/`],
    ["cedar-link", "Cedar Link", `${projectBasePath}/cedar-link/`],
  ];
  return items.map(([id, label, href]) => {
    const currentAttribute = id === current ? ' aria-current="page"' : "";
    return `<a href="${href}"${currentAttribute}>${label}</a>`;
  }).join("\n          ");
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
  </head>
  <body>
    <div class="site-frame">
      <header class="policy-header">
        <a class="site-brand" href="${projectBasePath}/" aria-label="Cedar home">
          <img src="${projectBasePath}/assets/cedar-app-icon.png" alt="" width="34" height="34" aria-hidden="true">
          <span>Cedar</span>
        </a>
        <nav aria-label="Primary navigation">
          ${navigation("releases")}
        </nav>
      </header>

${body}

      <footer class="policy-footer">
        <p>© 2026 Cedar. Cedar is a media player and organizer. It does not provide, host, or sell media content.</p>
        <nav aria-label="Policy navigation">
          <a href="${projectBasePath}/apple/">Apple apps</a>
          <a href="${projectBasePath}/support/">Support</a>
          <a href="${projectBasePath}/privacy/">Privacy</a>
          <a href="${projectBasePath}/content-policy/">Content policy</a>
          <a href="${projectBasePath}/accessibility/">Accessibility</a>
        </nav>
      </footer>
    </div>
  </body>
</html>
`;
}

function releaseMetadata(release) {
  return `<div class="release-metadata">
              <span class="release-status release-status-${release.status}">${statusLabels.get(release.status)}</span>
              <span>Version ${escapeHTML(release.version)}</span>
              <span>Build ${escapeHTML(release.build)}</span>
              <time datetime="${release.date}">${formatDate(release.date)}</time>
            </div>`;
}

function renderIndex(releases) {
  const cards = platforms.map((platform) => {
    const latest = releases.filter((release) => release.platform === platform.id).sort(compareReleases)[0];
    return `          <article class="release-card">
            <p class="eyebrow">${escapeHTML(platform.shortName)}</p>
            <h2>${escapeHTML(platform.name)}</h2>
            <p>${escapeHTML(latest.summary)}</p>
            ${releaseMetadata(latest)}
            <a class="inline-document-link" href="${projectBasePath}/apple/releases/${platform.id}/">View ${escapeHTML(platform.shortName)} notes</a>
          </article>`;
  }).join("\n");

  return pageShell({
    title: "Cedar Apple release notes",
    description: "Versioned release notes for Cedar on iPhone, iPad, Apple TV, and Mac.",
    canonical: `${publicBaseURL}/`,
    body: `      <main class="document-page release-page">
        <header class="document-header release-header">
          <p class="eyebrow">Release history</p>
          <h1>What’s new on every Apple device.</h1>
          <p>Each Cedar build has its own platform-specific notes. Release candidates and TestFlight builds are labeled separately from public App Store releases.</p>
        </header>

        <section class="release-grid" aria-label="Apple platform release notes">
${cards}
        </section>

        <section class="policy-callout compact-callout" aria-labelledby="release-process-title">
          <p class="eyebrow">One source of truth</p>
          <h2 id="release-process-title">Notes follow the build.</h2>
          <p>The public changelog, App Store “What’s New” copy, and release evidence are versioned together. A candidate is never presented as released until its store status is confirmed.</p>
        </section>
      </main>`,
  });
}

function renderPlatformPage(platform, releases) {
  const entries = releases
    .filter((release) => release.platform === platform.id)
    .sort(compareReleases)
    .map((release) => `        <article class="release-entry" id="${releaseAnchor(release)}">
          <header>
            <p class="eyebrow">${escapeHTML(platform.shortName)}</p>
            <h2>Version ${escapeHTML(release.version)}</h2>
            <p class="release-summary">${escapeHTML(release.summary)}</p>
            ${releaseMetadata(release)}
          </header>
          <div class="release-notes-body">
${release.notesHTML.split("\n").map((line) => `            ${line}`).join("\n")}
          </div>
        </article>`)
    .join("\n");

  return pageShell({
    title: `${platform.name} release notes`,
    description: platform.description,
    canonical: `${publicBaseURL}/${platform.id}/`,
    body: `      <main class="document-page release-page">
        <a class="release-back" href="${projectBasePath}/apple/releases/">All Apple release notes</a>
        <header class="document-header release-header">
          <p class="eyebrow">${escapeHTML(platform.shortName)} changelog</p>
          <h1>${escapeHTML(platform.name)} release notes.</h1>
          <p>Build-by-build changes, with public releases distinguished from TestFlight and release candidates.</p>
        </header>

        <div class="release-stack">
${entries}
        </div>
      </main>`,
  });
}

const sourceCatalog = JSON.parse(await readFile(sourceCatalogPath, "utf8"));
if (sourceCatalog.schemaVersion !== 1 || !Array.isArray(sourceCatalog.releases) || sourceCatalog.releases.length === 0) {
  fail("releases.json must contain a nonempty schema version 1 release array");
}

const seen = new Set();
const releases = [];
for (const [index, source] of sourceCatalog.releases.entries()) {
  const label = `release ${index + 1}`;
  const platform = platformByID.get(source.platform);
  if (!platform) {
    fail(`${label} has unknown platform ${String(source.platform)}`);
  }
  const version = requireText(source.version, `${label} version`, 30);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`${label} version must use three numeric components`);
  }
  const build = requireText(source.build, `${label} build`, 20);
  if (!/^[1-9]\d*$/.test(build)) {
    fail(`${label} build must be a positive integer string`);
  }
  const date = requireDate(source.date, `${label} date`);
  const status = requireText(source.status, `${label} status`, 40);
  if (!statusLabels.has(status)) {
    fail(`${label} status must be release-candidate, testflight, or released`);
  }
  const summary = requireText(source.summary, `${label} summary`, 280);
  const expectedNotesPath = `release-notes/apple/${platform.id}/${version}.md`;
  if (source.notes !== expectedNotesPath) {
    fail(`${label} notes path must be ${expectedNotesPath}`);
  }
  const identity = `${platform.id}:${version}:${build}`;
  if (seen.has(identity)) {
    fail(`${identity} appears more than once`);
  }
  seen.add(identity);
  const markdown = await readFile(resolve(repositoryRoot, source.notes), "utf8");
  const expectedTitle = `${platform.name} ${version}`;
  releases.push({
    platform: platform.id,
    version,
    build,
    date,
    status,
    summary,
    notesHTML: renderMarkdown(markdown, expectedTitle),
  });
}

for (const platform of platforms) {
  if (!releases.some((release) => release.platform === platform.id)) {
    fail(`${platform.name} must have at least one release`);
  }
}

const publicCatalog = {
  schemaVersion: 1,
  platforms: platforms.map((platform) => ({
    id: platform.id,
    name: platform.name,
    releasesURL: `${publicBaseURL}/${platform.id}/`,
  })),
  releases: releases.sort(compareReleases).map(({ notesHTML: _, ...release }) => ({
    ...release,
    notesURL: `${publicBaseURL}/${release.platform}/#${releaseAnchor(release)}`,
  })),
};

const outputs = new Map([
  [resolve(publicRoot, "index.html"), renderIndex(releases)],
  [resolve(publicRoot, "releases.json"), `${JSON.stringify(publicCatalog, null, 2)}\n`],
  ...platforms.map((platform) => [
    resolve(publicRoot, platform.id, "index.html"),
    renderPlatformPage(platform, releases),
  ]),
]);

const argumentsList = process.argv.slice(2);
const checkOnly = argumentsList.includes("--check");
if (argumentsList.some((argument) => !["--check", "--write"].includes(argument))) {
  fail("supported arguments are --write and --check");
}

if (checkOnly) {
  for (const [path, expected] of outputs) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) {
      fail(`${path.replace(`${repositoryRoot}/`, "")} is not current; run node scripts/render_apple_releases.mjs --write`);
    }
  }
  console.log(`Verified ${releases.length} Apple release entries across ${platforms.length} platforms`);
} else {
  for (const [path, contents] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  console.log(`Rendered ${releases.length} Apple release entries across ${platforms.length} platforms`);
}
