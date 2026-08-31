# Cedar public site and Android TV updates

This public repository contains Cedar's cross-platform public information, Cedar Link companion,
Android TV product site, update metadata, and release APKs:

- GitHub Pages serves Cedar's branded landing pages, Apple support and policy documents, Cedar Link,
  and `update-v1.json`, its small, signed Android update manifest.
- GitHub Releases serves versioned APK files.
- The app verifies the manifest's ECDSA signature, the APK's SHA-256 and size, its package name and version, and its Android signing certificate before opening Android's installer.

The Cedar source code, service credentials, Android signing keystore, and OTA manifest private key do not belong in this repository.

## Apple support and App Store information

The static Apple-facing routes are versioned alongside the Cedar Link site:

- `public/apple/` — Apple-platform product information and marketing URL.
- `public/support/` — public support and contact options.
- `public/privacy/` — the hosted privacy policy used by App Store Connect and the app.
- `public/accessibility/` — device-specific accessibility information.
- `public/content-policy/` — authorized-content policy, attribution, and reviewer demo link.
- `public/cedar-link/` — public Cedar Link privacy, retention, revocation, and deletion explanation.
- `public/demo/cedar-review.m3u` — credential-free, lawfully licensed App Review sample playlist.

Keep these pages consistent with the final Apple binaries, privacy manifests, App Store privacy
answers, and review notes. Do not add personal contact information without the account holder's
approval, and never publish production credentials, customer data, private media URLs, or pairing
invitations.

## Cedar Link and encrypted sync relay

`public/link/` contains the static, phone-friendly Cedar Link surface. It is safe-by-default,
verifies relay health before accepting an invitation, and remains disabled while
`public/sync-config.json` has an empty relay URL. Current Apple invitations provide only a derived
companion key. After a link is claimed, the browser authenticates Cedar's encrypted, content-free
companion checkpoint locally and deliberately advances past full-profile journal entries that this
limited key cannot decrypt. The linked configuration and device credentials remain AES-GCM
protected in browser storage.

The companion can edit allowlisted profile presentation, playback/discovery settings, and Home
branch configuration with optimistic revision checks. It can also create one-use recovery links,
forget its own protected key, request owner-enforced device actions, and send expiring transport
commands to linked Apple and Android Cedar devices. Cedar Link is deliberately not a player: it has
no media element and never receives catalogs, guide rows, channel/program names, media titles,
artwork, stream URLs, source candidates, or playback payloads. Its remote status contains only
online, playing/paused, live-mode, and supported-command booleans.

The invitation-bound Apple owner remains authoritative for profile configuration and the canonical
device/status projection. Authenticated updates from other linked devices cannot replace that
owner snapshot in the browser.

Legacy linked browsers can still bounded-decompress the Apple profile snapshot to migrate their
existing presentation cache. New companion features use only the smaller explicit projection.

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
- `public/catalogs/avatars.json` and `public/catalogs/badges.json` power the Cedar Link selectors.
- `public/badge-packs/` contains 33 bounded Cedar-compatible manifests whose images stay on GitHub Pages.
- `public/catalogs/xperience-assets.json` records byte sizes, source URLs, and SHA-256 checksums for every mirrored file.

Run `node scripts/import-xperience-assets.mjs` to verify the local copies and regenerate the catalogs from the recovery reports. Existing valid files are reused.

## Release order

Run `scripts/publish_release.sh` from a clean `main` checkout. It publishes the signed APK first and commits the signed manifest last. This prevents devices from seeing a manifest whose APK is not yet available.
