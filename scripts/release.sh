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
#   # Optional, for a notarized Developer ID release:
#   export APPLE_NOTARY_PROFILE="private-room"   # from `xcrun notarytool store-credentials`
#   scripts/release.sh
#
# Signing model — the ORDER is what keeps macOS permissions working:
#   1. Build the .app.
#   2. Give it its FINAL signature:
#      - with a "Developer ID Application" identity in the keychain: sign with
#        it (stable identity, notarizable), then notarize + staple when
#        APPLE_NOTARY_PROFILE is set;
#      - otherwise: ad-hoc with a stable designated requirement
#        (scripts/macsign.sh) so TCC grants survive updates on dev machines.
#   3. Build BOTH distribution artifacts (DMG + updater tar) from that exact
#      final app — never sign after packaging.
#   4. Minisign the updater tar (Tauri updater key).
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
# the bundlers work (project memory: private-room-build-xattr-shim).
echo "▶ Building the app…"
PATH=/usr/bin:"$PATH" npm run tauri build -- --bundles app

MACOS="src-tauri/target/release/bundle/macos"
APP="${MACOS}/Private Room.app"
TAR="${MACOS}/Private Room.app.tar.gz"
SIG="${TAR}.sig"
DMG_DIR="src-tauri/target/release/bundle/dmg"
DMG="${DMG_DIR}/Private Room_${VER}_aarch64.dmg"
ENTITLEMENTS="src-tauri/Entitlements.plist"

DEV_ID="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"' || true)"

if [[ -n "$DEV_ID" ]]; then
  echo "▶ Signing with: ${DEV_ID}"
  codesign --force --deep --sign "$DEV_ID" \
    --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    "$APP"
  codesign --verify --strict --deep "$APP"
  if [[ -n "${APPLE_NOTARY_PROFILE:-}" ]]; then
    echo "▶ Notarizing…"
    ZIP="$(mktemp -d)/app.zip"
    /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
    xcrun notarytool submit "$ZIP" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
    spctl --assess --type execute -v "$APP"
  else
    echo "⚠ APPLE_NOTARY_PROFILE not set — signed but NOT notarized (Gatekeeper"
    echo "  will warn on first download). Set it up once with:"
    echo "    xcrun notarytool store-credentials"
  fi
else
  # Dev fallback: stable-designated-requirement ad-hoc signature, so TCC
  # grants survive updates on machines that install these builds.
  echo "▶ No Developer ID identity found — ad-hoc signing with a stable requirement."
  echo "  (Enroll in the Apple Developer Program and create a 'Developer ID"
  echo "   Application' certificate to ship notarized builds.)"
  scripts/macsign.sh "$APP"
fi

# Both artifacts come from the exact app that was just signed.
echo "▶ Packaging updater tar + DMG from the final app…"
tar -czf "$TAR" -C "$MACOS" "Private Room.app"
PATH=/usr/bin:"$PATH" npm run tauri signer sign -- \
  --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
  ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:+--password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"} \
  "$TAR"

mkdir -p "$DMG_DIR"
DMG_STAGE="$(mktemp -d)"
cp -R "$APP" "$DMG_STAGE/"
ln -s /Applications "$DMG_STAGE/Applications"
rm -f "$DMG"
/usr/bin/hdiutil create -volname "Private Room" -srcfolder "$DMG_STAGE" \
  -ov -format UDZO "$DMG" >/dev/null
rm -rf "$DMG_STAGE"

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

# Build latest.json with node (already a dependency, see VER above) so notes
# and signature are JSON-escaped — quotes/newlines in RELEASE_NOTES must not
# break the updater manifest.
NOTES="$NOTES" VER="$VER" PUB_DATE="$PUB_DATE" SIGNATURE="$SIGNATURE" REPO="$REPO" TAG="$TAG" \
node -e 'const e = process.env; process.stdout.write(JSON.stringify({
  version: e.VER,
  notes: e.NOTES,
  pub_date: e.PUB_DATE,
  platforms: {
    "darwin-aarch64": {
      signature: e.SIGNATURE,
      url: `https://github.com/${e.REPO}/releases/download/${e.TAG}/Private.Room.app.tar.gz`
    }
  }
}, null, 2) + "\n")' > "${STAGE}/latest.json"

ASSETS=(
  "${STAGE}/Private.Room_${VER}_aarch64.dmg"
  "${STAGE}/Private.Room.app.tar.gz"
  "${STAGE}/latest.json"
)
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  # A release already exists for this tag (e.g. a DMG-only release cut without
  # the signing key). Add/replace the signed assets — this is what turns on
  # auto-update by publishing latest.json + the matching signed payload.
  echo "▶ Release ${TAG} exists — uploading signed assets (clobber)…"
  gh release upload "$TAG" --repo "$REPO" --clobber "${ASSETS[@]}"
else
  echo "▶ Creating GitHub release ${TAG}…"
  gh release create "$TAG" --repo "$REPO" \
    --title "Private Room ${VER}" --notes "$NOTES" "${ASSETS[@]}"
fi

echo "✓ Released ${TAG} — https://github.com/${REPO}/releases/tag/${TAG}"
