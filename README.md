# Cedar Android TV updates

This public repository contains Cedar Android TV's public product site, update metadata, and release APKs:

- GitHub Pages serves Cedar's branded landing page and `update-v1.json`, its small, signed update manifest.
- GitHub Releases serves versioned APK files.
- The app verifies the manifest's ECDSA signature, the APK's SHA-256 and size, its package name and version, and its Android signing certificate before opening Android's installer.

The Cedar source code, service credentials, Android signing keystore, and OTA manifest private key do not belong in this repository.

## Cedar Link and encrypted sync relay

`public/link/` contains the static, phone-friendly Cedar Link surface. It is safe-by-default,
verifies relay health before accepting an invitation, and remains disabled while
`public/sync-config.json` has an empty relay URL. After a link is claimed, the browser fetches,
authenticates, decrypts, and bounded-decompresses the Apple profile snapshot locally. The linked
profile summary and device credentials remain AES-GCM protected in browser storage. The current
companion is read-only; avatar and badge choices are previews until write-back conflict handling is
available on every Cedar platform.

Safari versions without raw `DecompressionStream` support use the vendored, MIT-licensed
`fflate` 0.8.3 inflate routine. Only that tree-shaken routine is shipped, and Cedar applies the
same 6 MB decompression ceiling before parsing the authenticated snapshot.

`worker/` contains an optional Cloudflare Worker/D1 ciphertext relay. The relay stores device-token
hashes and encrypted envelopes; it never receives a profile encryption key or plaintext profile
data. See [`worker/README.md`](worker/README.md) for verification and deployment steps. The complete
rollout and conflict policy is recorded in Cedar Android's `docs/CROSS_PLATFORM_SYNC.md`.

## Profile avatars and badge artwork

The companion's recovered Xperience artwork is stored directly in Git and served by GitHub Pages:

- `public/avatars/` contains 1,465 profile avatars.
- `public/badges/` contains 1,581 unique badge images across 33 sets.
- `public/catalogs/avatars.json` and `public/catalogs/badges.json` expose stable, site-local URLs for future selectors.
- `public/catalogs/xperience-assets.json` records byte sizes, source URLs, and SHA-256 checksums for every mirrored file.

Run `node scripts/import-xperience-assets.mjs` to verify the local copies and regenerate the catalogs from the recovery reports. Existing valid files are reused.

## Release order

Run `scripts/publish_release.sh` from a clean `main` checkout. It publishes the signed APK first and commits the signed manifest last. This prevents devices from seeing a manifest whose APK is not yet available.
