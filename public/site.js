const allowedRepositoryPath = "/24gx4xx5jv-cloud/cedar-tv-updates/releases/download/";

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
  document.querySelectorAll("[data-download-link]").forEach((link) => { link.href = download.href; });
  document.querySelectorAll("[data-release-link]").forEach((link) => {
    link.href = `https://github.com/24gx4xx5jv-cloud/cedar-tv-updates/releases/tag/v${encodeURIComponent(version)}`;
  });

  const fileSize = formatBytes(Number(manifest.apkSize));
  if (fileSize) {
    document.querySelectorAll("[data-file-size]").forEach((node) => { node.textContent = fileSize; });
  }
};

fetch("update-v1.json", { cache: "no-store", credentials: "omit" })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error("Manifest unavailable")))
  .then(applyRelease)
  .catch(() => {});

document.querySelectorAll("[data-year]").forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});
