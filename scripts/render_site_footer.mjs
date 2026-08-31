import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { footerStylesheet, renderSiteFooter } from "./site_components.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(repositoryRoot, "public");

async function findIndexPages(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const pages = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      pages.push(...await findIndexPages(path));
    } else if (entry.name === "index.html") {
      pages.push(path);
    }
  }
  return pages.sort();
}

function renderPage(source, relativePath) {
  const footerMatches = source.match(/^[ \t]*<footer(?:\s[^>]*)?>[\s\S]*?<\/footer>/gm) ?? [];
  if (footerMatches.length !== 1) {
    throw new Error(`${relativePath} must contain exactly one footer`);
  }

  let output = source.replace(footerMatches[0], renderSiteFooter());
  if (!output.includes(footerStylesheet.trim())) {
    output = output.replace("  </head>", `${footerStylesheet}\n  </head>`);
  }
  return output;
}

const argumentsList = process.argv.slice(2);
const checkOnly = argumentsList.includes("--check");
if (argumentsList.some((argument) => !["--check", "--write"].includes(argument))) {
  throw new Error("supported arguments are --write and --check");
}

const pages = await findIndexPages(publicRoot);
for (const path of pages) {
  const relativePath = path.replace(`${repositoryRoot}/`, "");
  const source = await readFile(path, "utf8");
  const expected = renderPage(source, relativePath);
  if (checkOnly) {
    if (source !== expected) {
      throw new Error(`${relativePath} does not use the current shared footer; run node scripts/render_site_footer.mjs --write`);
    }
  } else if (source !== expected) {
    await writeFile(path, expected, "utf8");
  }
}

console.log(`${checkOnly ? "Verified" : "Rendered"} the shared footer across ${pages.length} pages`);
