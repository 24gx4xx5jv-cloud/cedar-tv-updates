#!/bin/zsh
set -euo pipefail

if [[ $# -ne 2 ]]; then
    print -u2 "Usage: $0 SIGNED_APK RELEASE_NOTES_FILE"
    exit 2
fi

SOURCE_APK="${1:A}"
RELEASE_NOTES="${2:A}"
SCRIPT_DIR="${0:A:h}"
REPOSITORY_ROOT="${SCRIPT_DIR:h}"
ANDROID_ROOT="${CEDAR_ANDROID_ROOT:-${REPOSITORY_ROOT:h}}"
MANIFEST_KEY="$ANDROID_ROOT/private-config/github-ota/manifest-signing-key.pem"
MANIFEST_OUTPUT="$REPOSITORY_ROOT/public/update-v1.json"
SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
APKANALYZER="$SDK_ROOT/cmdline-tools/latest/bin/apkanalyzer"
APKSIGNER="$(find "$SDK_ROOT/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)/apksigner"

for command in gh git python3 openssl; do
    command -v "$command" >/dev/null || { print -u2 "$command is required."; exit 1; }
done
if [[ ! -f "$SOURCE_APK" || ! -f "$RELEASE_NOTES" || ! -f "$MANIFEST_KEY" ]]; then
    print -u2 "The signed APK, release notes, or private manifest key is missing."
    exit 1
fi
if [[ ! -x "$APKANALYZER" ]]; then
    APKANALYZER="$(find "$SDK_ROOT/cmdline-tools" -path '*/bin/apkanalyzer' -type f | sort -V | tail -n 1)"
fi
if [[ ! -x "$APKANALYZER" || ! -x "$APKSIGNER" ]]; then
    print -u2 "Android SDK apkanalyzer and apksigner are required."
    exit 1
fi

cd "$REPOSITORY_ROOT"
[[ "$(git branch --show-current)" == "main" ]] || { print -u2 "Publish from main."; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { print -u2 "The update repository must be clean."; exit 1; }
gh auth status >/dev/null

NAME_WITH_OWNER="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
VERSION_NAME="$($APKANALYZER manifest version-name "$SOURCE_APK")"
VERSION_CODE="$($APKANALYZER manifest version-code "$SOURCE_APK")"
TAG="v${VERSION_NAME}"
ASSET_NAME="Cedar-TV-${VERSION_NAME}.apk"
ASSET_URL="https://github.com/${NAME_WITH_OWNER}/releases/download/${TAG}/${ASSET_NAME}"
SIGNER_DIGEST="$($APKSIGNER verify --verbose --print-certs "$SOURCE_APK" | sed -nE 's/.*Signer.*certificate SHA-256 digest: ([0-9a-fA-F]{64}).*/\1/p' | tr '[:upper:]' '[:lower:]' | sort -u)"

[[ "$VERSION_CODE" =~ '^[1-9][0-9]*$' ]] || { print -u2 "APK version code is invalid."; exit 1; }
[[ "$SIGNER_DIGEST" =~ '^[0-9a-f]{64}$' ]] || { print -u2 "Could not determine the APK signer."; exit 1; }
if gh release view "$TAG" >/dev/null 2>&1; then
    print -u2 "Release $TAG already exists; versioned releases are immutable."
    exit 1
fi

STAGING="$REPOSITORY_ROOT/.staging"
mkdir -p "$STAGING"
trap 'rm -rf "$STAGING"' EXIT
cp "$SOURCE_APK" "$STAGING/$ASSET_NAME"

gh release create "$TAG" "$STAGING/$ASSET_NAME" \
    --title "Cedar Android TV ${VERSION_NAME}" \
    --notes-file "$RELEASE_NOTES"

python3 "$ANDROID_ROOT/scripts/ota/make_release_manifest.py" \
    --apk "$SOURCE_APK" \
    --apk-url "$ASSET_URL" \
    --private-key "$MANIFEST_KEY" \
    --output "$MANIFEST_OUTPUT" \
    --release-notes-file "$RELEASE_NOTES" \
    --apkanalyzer "$APKANALYZER" \
    --apksigner "$APKSIGNER" \
    --expected-signer-sha256 "$SIGNER_DIGEST"

git add public/update-v1.json
git commit -m "Publish Cedar Android TV ${VERSION_NAME} (${VERSION_CODE})"
git push origin main

print "Published $TAG and queued the signed Pages manifest deployment."
