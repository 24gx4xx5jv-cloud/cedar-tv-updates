# Cedar Android TV updates

This public repository contains Cedar Android TV's public product site, update metadata, and release APKs:

- GitHub Pages serves Cedar's branded landing page and `update-v1.json`, its small, signed update manifest.
- GitHub Releases serves versioned APK files.
- The app verifies the manifest's ECDSA signature, the APK's SHA-256 and size, its package name and version, and its Android signing certificate before opening Android's installer.

The Cedar source code, service credentials, Android signing keystore, and OTA manifest private key do not belong in this repository.

## Release order

Run `scripts/publish_release.sh` from a clean `main` checkout. It publishes the signed APK first and commits the signed manifest last. This prevents devices from seeing a manifest whose APK is not yet available.
