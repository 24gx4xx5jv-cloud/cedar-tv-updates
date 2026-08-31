import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const platformIDs = ["android-tv", "iphone", "ipad", "apple-tv", "mac"];

test("Android release source matches the signed update manifest", async () => {
  const source = JSON.parse(await readFile("release-notes/android-tv/releases.json", "utf8"));
  const manifest = JSON.parse(await readFile("public/update-v1.json", "utf8"));
  assert.equal(source.schemaVersion, 1);
  assert.equal(source.releases.length, 1);
  const release = source.releases[0];
  assert.equal(release.platform, "android-tv");
  assert.equal(release.version, manifest.versionName);
  assert.equal(release.build, String(manifest.versionCode));
  assert.equal(release.status, "released");
  assert.equal(release.notes, `release-notes/android-tv/${release.version}.md`);
  await access(release.notes);
});

test("cross-platform release hub publishes version, build, and honest status for every product", async () => {
  const page = await readFile("public/releases/index.html", "utf8");
  const catalog = JSON.parse(await readFile("public/releases/releases.json", "utf8"));
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.platforms.map((platform) => platform.id), platformIDs);
  assert.equal(catalog.platforms.length, 5);

  for (const platform of catalog.platforms) {
    assert.match(platform.version, /^\d+\.\d+\.\d+$/);
    assert.match(platform.build, /^[1-9]\d*$/);
    assert.ok(["release-candidate", "testflight", "released"].includes(platform.status));
    assert.match(page, new RegExp(`Version ${platform.version.replaceAll(".", "\\.")}`));
    assert.match(page, new RegExp(`Build ${platform.build}`));
  }

  assert.equal(catalog.platforms.find((platform) => platform.id === "android-tv").status, "released");
  for (const platform of catalog.platforms.filter((item) => item.id !== "android-tv")) {
    assert.equal(platform.status, "release-candidate");
  }
  assert.match(page, /Candidates stay labeled as candidates/);
});

test("Android release page exposes the matching signed APK", async () => {
  const page = await readFile("public/releases/android-tv/index.html", "utf8");
  const manifest = JSON.parse(await readFile("public/update-v1.json", "utf8"));
  assert.match(page, new RegExp(manifest.apkUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(page, new RegExp(`Version ${manifest.versionName.replaceAll(".", "\\.")}`));
  assert.match(page, new RegExp(`Build ${manifest.versionCode}`));
  assert.match(page, /Released/);
});
