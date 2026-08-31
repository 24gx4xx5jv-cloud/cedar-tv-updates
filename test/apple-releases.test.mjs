import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const platformIDs = ["iphone", "ipad", "apple-tv", "mac"];
const platformNames = new Map([
  ["iphone", "Cedar for iPhone"],
  ["ipad", "Cedar for iPad"],
  ["apple-tv", "Cedar for Apple TV"],
  ["mac", "Cedar for Mac"],
]);

test("Apple release catalog covers every product with versioned source notes", async () => {
  const source = JSON.parse(await readFile("release-notes/apple/releases.json", "utf8"));
  assert.equal(source.schemaVersion, 1);
  assert.deepEqual([...new Set(source.releases.map((release) => release.platform))].sort(), [...platformIDs].sort());

  const identities = new Set();
  for (const release of source.releases) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/);
    assert.match(release.build, /^[1-9]\d*$/);
    assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(["release-candidate", "testflight", "released"].includes(release.status));
    assert.ok(release.summary.length > 40 && release.summary.length <= 280);
    assert.equal(release.notes, `release-notes/apple/${release.platform}/${release.version}.md`);
    assert.ok(!identities.has(`${release.platform}:${release.version}:${release.build}`));
    identities.add(`${release.platform}:${release.version}:${release.build}`);

    const markdown = await readFile(release.notes, "utf8");
    assert.ok(markdown.startsWith(`# ${platformNames.get(release.platform)} ${release.version}\n`));
    assert.doesNotMatch(markdown, /<(?:script|iframe|form)\b/i);
  }
});

test("generated Apple changelogs are static, canonical, and machine readable", async () => {
  const overview = await readFile("public/apple/releases/index.html", "utf8");
  assert.match(overview, /https:\/\/cedartv\.github\.io\/cedar-tv-updates\/apple\/releases\//);
  assert.match(overview, /Release candidates and TestFlight builds are labeled separately/);
  assert.doesNotMatch(overview, /<(?:script|iframe|form)\b/i);

  const publicCatalog = JSON.parse(await readFile("public/apple/releases/releases.json", "utf8"));
  assert.equal(publicCatalog.schemaVersion, 1);
  assert.deepEqual(publicCatalog.platforms.map((platform) => platform.id), platformIDs);
  assert.equal(publicCatalog.releases.length, 4);

  for (const platform of platformIDs) {
    const path = `public/apple/releases/${platform}/index.html`;
    await access(path);
    const page = await readFile(path, "utf8");
    assert.match(page, new RegExp(`https://cedartv\\.github\\.io/cedar-tv-updates/apple/releases/${platform}/`));
    assert.match(page, /Version 1\.0\.0/);
    assert.match(page, /Build 1/);
    assert.match(page, /Release candidate/);
    assert.doesNotMatch(page, /chatgpt\.site|\[(?:SUPPORT EMAIL|LEGAL HOLDER|OWNER REQUIRED)\]/i);
    assert.doesNotMatch(page, /<(?:script|iframe|form)\b/i);
  }
});
