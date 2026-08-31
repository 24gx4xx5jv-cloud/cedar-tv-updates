import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

async function findIndexPages(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const pages = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) pages.push(...await findIndexPages(path));
    else if (entry.name === "index.html") pages.push(path);
  }
  return pages.sort();
}

test("landing page presents Cedar as one multi-platform product", async () => {
  const source = await readFile("public/index.html", "utf8");
  for (const phrase of [
    "Cedar across every screen",
    "Android TV · Google TV · Fire TV · iPhone · iPad · Apple TV · Mac",
    "One Cedar.",
    "Choose your screen",
    "All platform releases",
  ]) {
    assert.ok(source.includes(phrase), `landing page should include ${phrase}`);
  }

  for (const platform of ["android-tv", "iphone", "ipad", "apple-tv", "mac"]) {
    assert.match(source, new RegExp(`data-platform-version="${platform}"`));
    assert.match(source, new RegExp(`data-platform-status="${platform}"`));
  }

  assert.doesNotMatch(source, /content="[^"]*designed for Android TV[^"]*"/i);
  assert.doesNotMatch(source, />Cedar for Android TV<\/p>/);
});

test("user-facing sequence labels never use leading zeroes", async () => {
  for (const path of await findIndexPages("public")) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, />0[1-9](?:\s*\/[^<]*)?</, `${path} should use natural sequence numbering`);
  }
});

test("landing page reads current platform release data", async () => {
  const source = await readFile("public/site.js", "utf8");
  assert.match(source, /fetch\("releases\/releases\.json"/);
  assert.match(source, /data-platform-version/);
  assert.match(source, /data-platform-status/);
  assert.match(source, /data-build/);
});
