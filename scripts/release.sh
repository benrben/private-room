#!/usr/bin/env bash
# Cut a signed GitHub release for the current version.
#
# Why this script exists: the release needs three assets — the .dmg (manual
# download), the .app.tar.gz updater payload, and a latest.json whose signature
# comes from the private updater key. That signature can only be produced on a
# machine that holds TAURI_SIGNING_PRIVATE_KEY, so the release can't be cut from
# a sandbox that lacks the key. Run this in your own shell with the key set.
#
# Usage:
#   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/private-room.key)"   # or the key text
#   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"
#   scripts/release.sh
#
# It reads the version from tauri.conf.json, builds (with the /usr/bin PATH shim
# so the DMG bundler's hdiutil works — see private-room-build-xattr-shim), writes
# latest.json, and creates the GitHub release. Idempotent-ish: re-run after a
# failed upload; `gh release create` refuses to clobber an existing release.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="benrben/private-room"
VER="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="v${VER}"
echo "▶ Releasing ${TAG}"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "✗ TAURI_SIGNING_PRIVATE_KEY is not set — the updater payload can't be signed." >&2
  echo "  Set it (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD) and re-run." >&2
  exit 1
fi

# The /usr/bin PATH shim keeps the real xattr/hdiutil ahead of any overrides so
# the DMG bundler doesn't fail (project memory: private-room-build-xattr-shim).
echo "▶ Building signed bundle + updater artifacts…"
PATH=/usr/bin:"$PATH" npm run tauri build

MACOS="src-tauri/target/release/bundle/macos"
DMG="src-tauri/target/release/bundle/dmg/Private Room_${VER}_aarch64.dmg"
TAR="${MACOS}/Private Room.app.tar.gz"
SIG="${MACOS}/Private Room.app.tar.gz.sig"

for f in "$DMG" "$TAR" "$SIG"; do
  [[ -f "$f" ]] || { echo "✗ missing build artifact: $f" >&2; exit 1; }
done

# GitHub renders spaces in asset names as dots; stage dotted copies so the
# updater URL in latest.json is deterministic and matches the uploaded asset.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$DMG" "${STAGE}/Private.Room_${VER}_aarch64.dmg"
cp "$TAR" "${STAGE}/Private.Room.app.tar.gz"

SIGNATURE="$(cat "$SIG")"
PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOTES="${RELEASE_NOTES:-Release ${VER}.}"

cat > "${STAGE}/latest.json" <<JSON
{
  "version": "${VER}",
  "notes": "${NOTES}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "https://github.com/${REPO}/releases/download/${TAG}/Private.Room.app.tar.gz"
    }
  }
}
JSON

echo "▶ Creating GitHub release ${TAG}…"
gh release create "$TAG" \
  --repo "$REPO" \
  --title "Private Room ${VER}" \
  --notes "$NOTES" \
  "${STAGE}/Private.Room_${VER}_aarch64.dmg" \
  "${STAGE}/Private.Room.app.tar.gz" \
  "${STAGE}/latest.json"

echo "✓ Released ${TAG} — https://github.com/${REPO}/releases/tag/${TAG}"
