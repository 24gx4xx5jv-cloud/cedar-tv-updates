const allowedRepositoryPath = "/CedarTV/cedar-tv-updates/releases/download/";

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const applyRelease = (manifest) => {
  const version = typeof manifest.versionName === "string" ? manifest.versionName.trim() : "";
  const download = new URL(manifest.apkUrl, window.location.href);
  const trustedDownload = download.protocol === "https:" &&
    download.hostname === "github.com" &&
    download.pathname.startsWith(allowedRepositoryPath);

  if (!version || !trustedDownload) return;

  document.querySelectorAll("[data-version]").forEach((node) => { node.textContent = version; });
  const build = Number(manifest.versionCode);
  if (Number.isSafeInteger(build) && build > 0) {
    document.querySelectorAll("[data-build]").forEach((node) => { node.textContent = String(build); });
  }
  document.querySelectorAll("[data-download-link]").forEach((link) => { link.href = download.href; });
  document.querySelectorAll("[data-release-link]").forEach((link) => {
    link.href = `https://github.com/CedarTV/cedar-tv-updates/releases/tag/v${encodeURIComponent(version)}`;
  });

  const fileSize = formatBytes(Number(manifest.apkSize));
  if (fileSize) {
    document.querySelectorAll("[data-file-size]").forEach((node) => { node.textContent = fileSize; });
  }
};

const statusLabels = new Map([
  ["release-candidate", "Release candidate"],
  ["testflight", "TestFlight"],
  ["released", "Released"],
]);

const applyPlatformReleases = (catalog) => {
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.platforms)) return;
  const releases = new Map(catalog.platforms.map((release) => [release.id, release]));

  document.querySelectorAll("[data-platform-version]").forEach((node) => {
    const release = releases.get(node.dataset.platformVersion);
    if (!release || typeof release.version !== "string" || !/^\d+\.\d+\.\d+$/.test(release.version)) return;
    const build = String(release.build ?? "");
    if (!/^[1-9]\d*$/.test(build)) return;
    node.textContent = `Version ${release.version} · Build ${build}`;
  });

  document.querySelectorAll("[data-platform-status]").forEach((node) => {
    const release = releases.get(node.dataset.platformStatus);
    const label = release ? statusLabels.get(release.status) : null;
    if (label) node.textContent = label;
  });
};

fetch("update-v1.json", { cache: "no-store", credentials: "omit" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("Manifest unavailable")))
  .then(applyRelease)
  .catch(() => {});

fetch("releases/releases.json", { cache: "no-store", credentials: "omit" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("Release catalog unavailable")))
  .then(applyPlatformReleases)
  .catch(() => {});

document.querySelectorAll("[data-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});
