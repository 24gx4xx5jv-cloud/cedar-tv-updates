#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const publicRoot = path.join(repositoryRoot, "public");
const defaultReportsRoot = path.resolve(repositoryRoot, "../Cedar/Reports");

const avatarCatalogPath = path.resolve(
  process.argv[2] ??
    path.join(
      defaultReportsRoot,
      "Xperience-Avatar-Recovery/avatar-catalog.json",
    ),
);
const badgeCatalogPath = path.resolve(
  process.argv[3] ??
    path.join(
      defaultReportsRoot,
      "Xperience-Badge-Recovery/badge-source-catalog.json",
    ),
);

const concurrency = 24;
const expectedOrigin = "https://cdn.xperience-app.com";
const allowedExtensions = new Set([".gif", ".svg", ".webp"]);

function sourceDescriptor(sourceURL, collection) {
  const url = new URL(sourceURL);
  const expectedPrefix = `/${collection}/`;

  if (url.origin !== expectedOrigin || !url.pathname.startsWith(expectedPrefix)) {
    throw new Error(`Unexpected ${collection} asset URL: ${sourceURL}`);
  }

  const decodedPathname = decodeURIComponent(url.pathname);
  const relativePath = decodedPathname.slice(1);
  const pathParts = relativePath.split("/");
  const extension = path.extname(relativePath).toLowerCase();

  if (
    pathParts.some((part) => !part || part === "." || part === "..") ||
    !allowedExtensions.has(extension)
  ) {
    throw new Error(`Unsafe or unsupported asset path: ${sourceURL}`);
  }

  return {
    collection,
    extension,
    localURL: url.pathname,
    outputPath: path.join(publicRoot, relativePath),
    path: relativePath,
    sourceURL,
  };
}

function validateAsset(buffer, extension, sourceURL) {
  let valid = false;

  if (extension === ".webp") {
    valid =
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP";
  } else if (extension === ".gif") {
    const signature = buffer.subarray(0, 6).toString("ascii");
    valid = signature === "GIF87a" || signature === "GIF89a";
  } else if (extension === ".svg") {
    valid = buffer.subarray(0, 4096).toString("utf8").includes("<svg");
  }

  if (!valid) {
    throw new Error(`Downloaded content is not a valid ${extension}: ${sourceURL}`);
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function existingAsset(descriptor) {
  try {
    const fileStats = await stat(descriptor.outputPath);
    if (!fileStats.isFile() || fileStats.size === 0) return null;

    const buffer = await readFile(descriptor.outputPath);
    validateAsset(buffer, descriptor.extension, descriptor.sourceURL);
    return buffer;
  } catch (error) {
    if (error.code !== "ENOENT") {
      await unlink(descriptor.outputPath).catch(() => {});
    }
    return null;
  }
}

async function downloadAsset(descriptor) {
  const existing = await existingAsset(descriptor);
  if (existing) {
    return { buffer: existing, reused: true };
  }

  await mkdir(path.dirname(descriptor.outputPath), { recursive: true });
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(descriptor.sourceURL, {
        cache: "no-store",
        headers: { "user-agent": "Cedar asset recovery/1.0" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      validateAsset(buffer, descriptor.extension, descriptor.sourceURL);

      const partialPath = `${descriptor.outputPath}.part`;
      await writeFile(partialPath, buffer);
      await rename(partialPath, descriptor.outputPath);
      return { buffer, reused: false };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  }

  throw new Error(
    `Failed to download ${descriptor.sourceURL}: ${lastError?.message}`,
  );
}

async function mapConcurrent(items, limit, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const publishedBaseURL = "https://cedartv.github.io/cedar-tv-updates";
const badgeGroupNames = new Map([
  ["r", "Resolution"],
  ["q", "Source quality"],
  ["v", "Video"],
  ["a", "Audio"],
  ["c", "Channels"],
  ["co", "Codec"],
  ["p", "Provider"],
  ["other", "Other"],
]);
const specialBadgePatterns = new Map([
  ["4k", "(?:2160p|\\b4k\\b)"],
  ["dolby vision", "(?:dolby[ ._-]?vision|\\bdv\\b)"],
  ["hdr10+", "(?:hdr10\\+|hdr10plus)"],
  ["web-dl", "web[ ._-]?dl"],
  ["dd+", "(?:dd\\+|ddp|eac3|e-ac-3)"],
  ["dts:x", "dts[ ._-]?x"],
  ["dts-hd ma", "dts[ ._-]?hd[ ._-]?ma"],
  ["truehd", "true[ ._-]?hd"],
]);

function badgeSetIdentifier(set) {
  const slug = (value) => value.toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const creator = set.creator === "Xperience" ? "xp" : slug(set.creator || "community");
  const identifier = `${creator}_${slug(set.label)}`;
  if (!/^[a-z0-9_-]+$/i.test(identifier) || identifier.length > 96) {
    throw new Error(`Badge set ${set.label} has an unsafe identifier.`);
  }
  return identifier;
}

function badgePattern(name) {
  const normalized = name.trim().toLowerCase();
  const special = specialBadgePatterns.get(normalized);
  if (special) return `(?i)(?:^|[^A-Za-z0-9])(?:${special})(?:$|[^A-Za-z0-9])`;
  const escaped = name.trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[ ._-]*");
  return `(?i)(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`;
}

function badgeGroupID(imageURL) {
  const filename = new URL(imageURL).pathname.split("/").at(-1).replace(/\.[^.]+$/, "");
  const prefix = filename.includes("-") ? filename.split("-")[0].toLowerCase() : "other";
  return badgeGroupNames.has(prefix) ? prefix : "other";
}

const avatarCatalog = JSON.parse(await readFile(avatarCatalogPath, "utf8"));
const badgeCatalog = JSON.parse(await readFile(badgeCatalogPath, "utf8"));

if (!Array.isArray(avatarCatalog.avatars) || !Array.isArray(badgeCatalog.sets)) {
  throw new Error("The recovered catalog files do not have the expected shape.");
}

const avatarDescriptors = avatarCatalog.avatars.map((avatar) =>
  sourceDescriptor(avatar.url, "avatars"),
);
const badgeDescriptors = badgeCatalog.sets.flatMap((set) =>
  set.badges.map((badge) => sourceDescriptor(badge.imageURL, "badges")),
);

const descriptorsByPath = new Map();
for (const descriptor of [...avatarDescriptors, ...badgeDescriptors]) {
  const previous = descriptorsByPath.get(descriptor.path);
  if (previous && previous.sourceURL !== descriptor.sourceURL) {
    throw new Error(
      `Two source URLs resolve to ${descriptor.path}: ${previous.sourceURL} and ${descriptor.sourceURL}`,
    );
  }
  descriptorsByPath.set(descriptor.path, descriptor);
}

const descriptors = [...descriptorsByPath.values()].sort((a, b) =>
  a.path.localeCompare(b.path),
);

let completed = 0;
let downloadedCount = 0;
let reusedCount = 0;

const assetResults = await mapConcurrent(
  descriptors,
  concurrency,
  async (descriptor) => {
    const { buffer, reused } = await downloadAsset(descriptor);
    completed += 1;
    if (reused) reusedCount += 1;
    else downloadedCount += 1;

    if (completed % 100 === 0 || completed === descriptors.length) {
      console.log(`Processed ${completed}/${descriptors.length} assets`);
    }

    return {
      collection: descriptor.collection,
      path: descriptor.path,
      sourceURL: descriptor.sourceURL,
      bytes: buffer.length,
      sha256: sha256(buffer),
    };
  },
);

const localURLBySource = new Map(
  descriptors.map((descriptor) => [descriptor.sourceURL, descriptor.localURL]),
);

const localAvatarCatalog = {
  ...avatarCatalog,
  sourcePage: "https://xperience-app.com/avatars",
  avatars: avatarCatalog.avatars.map((avatar) => ({
    ...avatar,
    originalURL: avatar.url,
    url: localURLBySource.get(avatar.url),
  })),
};

const badgePackManifests = badgeCatalog.sets.map((set) => {
  const identifier = badgeSetIdentifier(set);
  const usedGroups = [...new Set(set.badges.map((badge) => badgeGroupID(badge.imageURL)))];
  return {
    identifier,
    sourceURL: `${publishedBaseURL}/badge-packs/${identifier}.json`,
    pack: {
      name: set.label,
      groups: usedGroups.map((id) => ({ id, name: badgeGroupNames.get(id), isExpanded: true })),
      filters: set.badges.map((badge, index) => ({
        id: `${identifier}-${index + 1}`,
        name: badge.name,
        groupId: badgeGroupID(badge.imageURL),
        isEnabled: badge.enabled !== false,
        pattern: badgePattern(badge.name),
        imageURL: `${publishedBaseURL}${localURLBySource.get(badge.imageURL)}`,
      })),
    },
  };
});

if (new Set(badgePackManifests.map((value) => value.identifier)).size !== badgePackManifests.length) {
  throw new Error("Recovered badge sets do not have unique stable identifiers.");
}

const badgePackByIdentifier = new Map(
  badgePackManifests.map((value) => [value.identifier, value]),
);

const localBadgeCatalog = {
  ...badgeCatalog,
  sets: badgeCatalog.sets.map((set) => {
    const identifier = badgeSetIdentifier(set);
    const manifest = badgePackByIdentifier.get(identifier);
    return {
      ...set,
      id: identifier,
      sourceURL: manifest.sourceURL,
      badges: set.badges.map((badge) => ({
        ...badge,
        originalImageURL: badge.imageURL,
        imageURL: localURLBySource.get(badge.imageURL),
      })),
    };
  }),
};

const generatedAt = new Date().toISOString();
const totalBytes = assetResults.reduce((sum, asset) => sum + asset.bytes, 0);
const manifest = {
  generatedAt,
  assetCount: assetResults.length,
  avatarAssetCount: assetResults.filter(
    (asset) => asset.collection === "avatars",
  ).length,
  badgeAssetCount: assetResults.filter(
    (asset) => asset.collection === "badges",
  ).length,
  totalBytes,
  downloadedCount,
  reusedCount,
  assets: assetResults,
};

const catalogsDirectory = path.join(publicRoot, "catalogs");
const badgePacksDirectory = path.join(publicRoot, "badge-packs");
await mkdir(catalogsDirectory, { recursive: true });
await mkdir(badgePacksDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(catalogsDirectory, "avatars.json"), json(localAvatarCatalog)),
  writeFile(path.join(catalogsDirectory, "badges.json"), json(localBadgeCatalog)),
  writeFile(
    path.join(catalogsDirectory, "xperience-assets.json"),
    json(manifest),
  ),
  ...badgePackManifests.map(({ identifier, pack }) => writeFile(
    path.join(badgePacksDirectory, `${identifier}.json`),
    json(pack),
  )),
]);

console.log(
  json({
    assets: manifest.assetCount,
    avatars: manifest.avatarAssetCount,
    badges: manifest.badgeAssetCount,
    bytes: manifest.totalBytes,
    downloaded: downloadedCount,
    reused: reusedCount,
  }).trim(),
);
