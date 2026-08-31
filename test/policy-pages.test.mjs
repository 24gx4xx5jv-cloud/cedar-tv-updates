import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routes = ["apple", "support", "privacy", "accessibility", "content-policy", "cedar-link"];

test("Apple policy pages are static, public, and scoped to the GitHub Pages project", async () => {
  for (const route of routes) {
    const source = await readFile(`public/${route}/index.html`, "utf8");
    assert.match(source, /<meta name="robots" content="index,follow">/);
    assert.match(source, /<meta http-equiv="Content-Security-Policy"/);
    assert.match(source, new RegExp(`https://cedartv\\.github\\.io/cedar-tv-updates/${route}/`));
    assert.match(source, /href="\/cedar-tv-updates\/support\/"/);
    assert.match(source, /href="\/cedar-tv-updates\/privacy\/"/);
    assert.doesNotMatch(source, /chatgpt\.site|\[(?:SUPPORT EMAIL|LEGAL HOLDER|OWNER REQUIRED)\]/i);
    assert.doesNotMatch(source, /<(?:script|iframe|form)\b/i);
  }
});

test("privacy policy identifies collection, use, retention, deletion, and contact", async () => {
  const source = await readFile("public/privacy/index.html", "utf8");
  for (const phrase of [
    "Data on your device",
    "Services you connect",
    "App Store privacy disclosures",
    "Cedar Link retention and deletion",
    "Your choices and contact",
  ]) {
    assert.ok(source.includes(phrase), `privacy policy should include ${phrase}`);
  }
});

test("support page exposes public contact paths without leaking private information", async () => {
  const source = await readFile("public/support/index.html", "utf8");
  assert.match(source, /https:\/\/discord\.gg\/TFTx7j86v/);
  assert.match(source, /https:\/\/github\.com\/CedarTV\/cedar-tv-updates\/issues/);
  assert.doesNotMatch(source, /mailto:|\+\d{6,}|\d+ [A-Za-z]+ (?:Street|St\.|Road|Rd\.)/i);
});

test("review playlist is credential-free and uses the licensed demo stream", async () => {
  const source = await readFile("public/demo/cedar-review.m3u", "utf8");
  assert.match(source, /^#EXTM3U\n/);
  assert.match(source, /Big Buck Bunny — CC BY 3\.0 demo stream/);
  assert.match(source, /https:\/\/test-streams\.mux\.dev\/x36xhzz\/x36xhzz\.m3u8/);
  assert.doesNotMatch(source, /(?:password|token|username)=/i);
});
