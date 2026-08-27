#!/usr/bin/env bash
# Build a signed Electron release, authenticate its updater payload with
# Arcelle's existing Tauri key, then publish with `gh`. Developer ID +
# notarization is preferred; an explicit stable-DR ad-hoc release remains
# supported for the current distribution workflow.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "release refused: $*" >&2
  exit 1
}

ROOT="$(pwd -P)"
REPO="benrben/private-room"
APP_DIR="electron-migration/electron-app"
VER="$(node -p "require('./${APP_DIR}/package.json').version")"
TAG="v${VER}"
RELEASE_NOTES="${RELEASE_NOTES:-}"
# `npm --prefix` runs the package script from APP_DIR. Keep the defaults
# absolute so electron-builder does not accidentally resolve them relative to
# that nested working directory.
MODELS="${ARCELLE_MODELS_DIR:-${ROOT}/${APP_DIR}/assets/models}"
SIDECAR="${ARCELLE_SIDECAR_STAGE_DIR:-${ROOT}/sidecar/dist/arcelle-sidecar}"

[[ -n "$RELEASE_NOTES" ]] || fail "RELEASE_NOTES is required"
grep -Fq '## Install' <<<"$RELEASE_NOTES" || \
  fail "RELEASE_NOTES must contain the required Install section"
grep -Fq 'The build is ad-hoc signed (not notarized)' <<<"$RELEASE_NOTES" || \
  fail "RELEASE_NOTES must disclose the ad-hoc, non-notarized build"
grep -Fqx '/usr/bin/xattr -cr "/Applications/Arcelle.app"' <<<"$RELEASE_NOTES" || \
  fail "RELEASE_NOTES must contain the required xattr command exactly"

# ---------------------------------------------------------------------------
# Release-only prerequisites. All of these run before the expensive preflight
# and package build. Signing mode must be explicit: a missing certificate never
# silently changes a Developer ID release into an ad-hoc one.

command -v uv >/dev/null || fail "uv is required"
command -v gh >/dev/null || fail "gh is required to publish"
command -v security >/dev/null || fail "macOS security tool is required"
command -v codesign >/dev/null || fail "macOS codesign is required"
command -v xcrun >/dev/null || fail "Xcode command-line tools are required"
command -v spctl >/dev/null || fail "macOS spctl is required"

[[ "${ARCELLE_PACKAGE_UNSIGNED_PROOF:-}" != "1" ]] || \
  fail "ARCELLE_PACKAGE_UNSIGNED_PROOF cannot be used for a release"

IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
if [[ "${ARCELLE_MAC_IDENTITY:-}" == "-" ]]; then
  SIGNING_MODE="ad-hoc"
  DEV_ID="none (explicit stable designated-requirement ad-hoc mode)"
  NOTARY_METHOD="not applicable to ad-hoc signing"
elif [[ -n "${CSC_NAME:-}" ]]; then
  SIGNING_MODE="developer-id"
  grep -Fq "\"${CSC_NAME}\"" <<<"$IDENTITIES" || \
    fail "CSC_NAME does not name a valid keychain signing identity"
  [[ "$CSC_NAME" == Developer\ ID\ Application:* ]] || \
    fail "CSC_NAME must be a Developer ID Application identity"
  DEV_ID="$CSC_NAME"
else
  SIGNING_MODE="developer-id"
  DEV_ID="$(sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' <<<"$IDENTITIES" | head -n 1)"
  [[ -n "$DEV_ID" ]] || fail \
    "no Developer ID identity is installed; set ARCELLE_MAC_IDENTITY=- only for an intentional ad-hoc release"
  CSC_NAME="$DEV_ID"
fi
if [[ "$SIGNING_MODE" == "developer-id" ]]; then
  export CSC_NAME
  if [[ -n "${APPLE_KEYCHAIN_PROFILE:-${APPLE_NOTARY_PROFILE:-}}" ]]; then
    NOTARY_METHOD="keychain profile"
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    NOTARY_METHOD="Apple ID"
  elif [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
    NOTARY_METHOD="App Store Connect API key"
  else
    fail "Developer ID mode needs complete notarization credentials (profile, Apple ID set, or API-key set)"
  fi
fi

# The old Tauri updater and the Electron bridge pin the public half of this
# exact key. Use Tauri's signer, not generic minisign: the key of record is the
# Tauri CLI's base64 private-key format, and Tauri writes the already-base64
# signature string expected by latest.json. The *_PATH hand-off lets the signer
# read the existing file itself; private bytes never enter argv, logs, command
# substitution, or an exported environment variable.
[[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || \
  fail "unset TAURI_SIGNING_PRIVATE_KEY; use TAURI_SIGNING_PRIVATE_KEY_PATH so key bytes are not exported"
UPDATER_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-${HOME}/.tauri/private-room.key}"
UPDATER_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
unset TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD
[[ ! -L "$UPDATER_KEY_PATH" ]] || fail "updater key must be a regular file, not a symlink: $UPDATER_KEY_PATH"
[[ -f "$UPDATER_KEY_PATH" && -r "$UPDATER_KEY_PATH" && -s "$UPDATER_KEY_PATH" ]] || \
  fail "updater key is missing, unreadable, or empty: $UPDATER_KEY_PATH"
[[ "$(stat -f '%Su' "$UPDATER_KEY_PATH")" == "$(id -un)" ]] || \
  fail "updater key must be owned by the release user: $UPDATER_KEY_PATH"
KEY_MODE="$(stat -f '%Lp' "$UPDATER_KEY_PATH")"
(( (8#$KEY_MODE & 8#077) == 0 )) || \
  fail "updater key permissions are $KEY_MODE; run: chmod 600 '$UPDATER_KEY_PATH'"

if [[ -n "${ARCELLE_TAURI_CLI:-}" ]]; then
  TAURI_CLI="$ARCELLE_TAURI_CLI"
elif [[ -x "$ROOT/node_modules/.bin/tauri" ]]; then
  TAURI_CLI="$ROOT/node_modules/.bin/tauri"
elif command -v tauri >/dev/null; then
  TAURI_CLI="$(command -v tauri)"
else
  fail "Tauri CLI v2 is required only for updater signing (install @tauri-apps/cli@2.11.4)"
fi
[[ -x "$TAURI_CLI" ]] || fail "Tauri CLI is not executable: $TAURI_CLI"
TAURI_VERSION="$($TAURI_CLI --version)"
[[ "$TAURI_VERSION" == tauri-cli\ 2.* ]] || fail "Tauri CLI v2 is required; found: $TAURI_VERSION"

git diff --quiet && git diff --cached --quiet && \
  [[ -z "$(git ls-files --others --exclude-standard)" ]] || \
  fail "the Git worktree must be clean before a release"
HEAD_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
[[ "$HEAD_TAG" == "$TAG" ]] || \
  fail "HEAD must already carry release tag $TAG before publishing"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated"
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && \
  fail "GitHub release $TAG already exists; refusing to replace published assets"

echo "release prerequisites passed: signing=$SIGNING_MODE ($DEV_ID); notarization=$NOTARY_METHOD; $TAURI_VERSION"
scripts/preflight.sh
./sidecar/build-sidecar.sh
[[ -x "$SIDECAR/arcelle-sidecar" ]] || fail "missing built sidecar: $SIDECAR"
for model in nemo_en_titanet_small.onnx ggml-silero-v5.1.2.bin ggml-large-v3-turbo-q5_0.bin; do
  [[ -s "$MODELS/$model" ]] || fail "missing production model: $MODELS/$model"
done

CSC_IDENTITY_AUTO_DISCOVERY=true ARCELLE_MAC_IDENTITY="${ARCELLE_MAC_IDENTITY:-}" \
ARCELLE_MODELS_DIR="$MODELS" ARCELLE_SIDECAR_STAGE_DIR="$SIDECAR" npm run package:mac

OUT="$APP_DIR/release"
APP="$OUT/mac-arm64/Arcelle.app"
DMG="$OUT/Arcelle_${VER}_aarch64.dmg"
TAR="$OUT/Arcelle.app.tar.gz"
[[ -d "$APP" && -f "$DMG" ]] || fail "packaging did not produce the expected app and DMG"

# Prove the finished bundle matches the chosen signing mode before constructing
# or signing either distribution payload. Both modes require a valid deep
# signature. Developer ID additionally requires authority, Team ID, stapled
# notarization, and Gatekeeper. Ad-hoc requires Arcelle's stable designated
# requirement so TCC identity survives replacement on development installs.
codesign --verify --strict --deep --verbose=2 "$APP"
SIGNING_DETAILS="$(codesign -dv --verbose=4 "$APP" 2>&1)"
if [[ "$SIGNING_MODE" == "developer-id" ]]; then
  grep -q '^TeamIdentifier=[A-Z0-9]' <<<"$SIGNING_DETAILS" || fail "packaged app has no real TeamIdentifier"
  grep -q '^Authority=Developer ID Application:' <<<"$SIGNING_DETAILS" || \
    fail "packaged app is not signed by Developer ID Application"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose "$APP"
else
  grep -q '^TeamIdentifier=not set$' <<<"$SIGNING_DETAILS" || \
    fail "explicit ad-hoc build unexpectedly carries a TeamIdentifier"
  DESIGNATED_REQUIREMENT="$(codesign -d -r- "$APP" 2>&1)"
  grep -Fq 'designated => identifier "com.benreich.privateroom"' <<<"$DESIGNATED_REQUIREMENT" || \
    fail "ad-hoc app is missing Arcelle's stable designated requirement"
  echo "warning: publishing an explicitly requested ad-hoc, non-notarized build" >&2
fi

node "$APP_DIR/scripts/packTarGz.mjs" "$APP" "$TAR"
TAURI_SIGNING_PRIVATE_KEY_PATH="$UPDATER_KEY_PATH" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$UPDATER_KEY_PASSWORD" \
  "$TAURI_CLI" signer sign "$TAR"
[[ -s "$TAR.sig" ]] || fail "Tauri signer did not create $TAR.sig"

# Do not trust a successful signer exit code alone. Verify the exact payload
# and signature through the same pinned public key and verifier the installed
# Electron app uses. A wrong private key therefore fails before publication.
ARCELLE_UPDATE_PAYLOAD="$TAR" ARCELLE_UPDATE_SIGNATURE="$TAR.sig" \
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { verifyManifestSignature } from "./electron-migration/electron-app/dist_package/electron/main/updater/minisignVerify.js";
import { TAURI_UPDATE_PUBKEY_B64 } from "./electron-migration/electron-app/dist_package/electron/main/updater/tauriUpdater.js";
verifyManifestSignature(
  readFileSync(process.env.ARCELLE_UPDATE_PAYLOAD),
  readFileSync(process.env.ARCELLE_UPDATE_SIGNATURE, "utf8").trim(),
  TAURI_UPDATE_PUBKEY_B64,
);
NODE

node "$APP_DIR/scripts/buildLatestManifest.mjs" \
  --version "$VER" --notes "$RELEASE_NOTES" \
  --tauri-sig-file "$TAR.sig" --out "$OUT/latest.json"

gh release create "$TAG" --repo "$REPO" \
  "$DMG" "$TAR" "$TAR.sig" "$OUT/latest.json" \
  --title "Arcelle $VER" --notes "$RELEASE_NOTES"

echo "released $TAG — https://github.com/${REPO}/releases/tag/${TAG}"
