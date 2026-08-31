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

test("every public page uses the shared Cedar footer", async () => {
  const pages = await findIndexPages("public");
  assert.ok(pages.length >= 15, "expected the complete public route set");

  for (const page of pages) {
    const source = await readFile(page, "utf8");
    assert.equal((source.match(/<footer\b/g) ?? []).length, 1, `${page} should have one footer`);
    assert.equal((source.match(/class="site-footer"/g) ?? []).length, 1, `${page} should use the shared footer`);
    assert.match(source, /href="\/cedar-tv-updates\/footer\.css"/);
    assert.match(source, /href="https:\/\/discord\.gg\/TFTx7j86v" aria-label="Join Cedar on Discord"/);
    assert.match(source, /src="\/cedar-tv-updates\/assets\/discord-symbol\.svg"/);
    assert.match(source, /href="\/cedar-tv-updates\/releases\/"/);
    assert.match(source, /href="\/cedar-tv-updates\/accessibility\/"/);
  }
});

test("shared footer styles keep interactive states bounded and accessible", async () => {
  const source = await readFile("public/footer.css", "utf8");
  assert.match(source, /width: 44px;\n  height: 44px;/);
  assert.match(source, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
});
