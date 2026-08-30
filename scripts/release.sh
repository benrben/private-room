#!/usr/bin/env bash
# Build a signed Electron release, authenticate its updater payload with
# Arcelle's existing Tauri-compatible Minisign key, then publish with `gh`. Developer ID +
# notarization is preferred; an explicit stable-DR ad-hoc release remains
# supported for the current distribution workflow.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "release refused: $*" >&2
  exit 1
}

# Generic Minisign needs the decoded form of Tauri's outer-base64 key wrapper.
# Keep that decoded secret in one narrowly-named owner-only directory, remove
# only the two files this script can create, and refuse any broader cleanup.
SIGNING_TMP=""
cleanup_updater_signing_tmp() {
  [[ -n "$SIGNING_TMP" ]] || return 0
  case "$SIGNING_TMP" in
    /tmp/arcelle-updater-signing.*) ;;
    *)
      echo "release cleanup refused unexpected path: $SIGNING_TMP" >&2
      return 1
      ;;
  esac
  for signing_file in "$SIGNING_TMP/minisign.key" "$SIGNING_TMP/Arcelle.app.tar.gz.minisig"; do
    [[ ! -e "$signing_file" && ! -L "$signing_file" ]] || unlink "$signing_file"
  done
  rmdir "$SIGNING_TMP"
  SIGNING_TMP=""
}
trap cleanup_updater_signing_tmp EXIT

ROOT="$(pwd -P)"
REPO="benrben/private-room"
APP_DIR="apps/desktop"
VER="$(node -p "require('./${APP_DIR}/package.json').version")"
TAG="v${VER}"
RELEASE_NOTES="${RELEASE_NOTES:-}"
# `npm --prefix` runs the package script from APP_DIR. Keep the defaults
# absolute so electron-builder does not accidentally resolve them relative to
# that nested working directory.
MODELS="${ARCELLE_MODELS_DIR:-${ROOT}/${APP_DIR}/resources/models}"
SIDECAR="${ARCELLE_SIDECAR_STAGE_DIR:-${ROOT}/services/agent-sidecar/dist/arcelle-sidecar}"

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
[[ -x /usr/bin/expect ]] || fail "macOS expect is required for the protected updater key"

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
# exact key. The key of record is a base64 wrapper around a normal Minisign
# secret-key file. Only its path and password enter this process; decoded bytes
# live briefly in the owner-only temporary directory created immediately before
# signing and never enter argv, logs, command substitution, or an environment
# variable.
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

if [[ -n "${ARCELLE_MINISIGN:-}" ]]; then
  MINISIGN="$ARCELLE_MINISIGN"
else
  MINISIGN="$(command -v minisign || true)"
fi
[[ -n "$MINISIGN" && -x "$MINISIGN" ]] || \
  fail "Minisign 0.12 is required for updater compatibility (brew install minisign)"
MINISIGN_VERSION="$($MINISIGN -v)"
[[ "$MINISIGN_VERSION" == "minisign 0.12" ]] || \
  fail "Minisign 0.12 is required; found: $MINISIGN_VERSION"

git diff --quiet && git diff --cached --quiet && \
  [[ -z "$(git ls-files --others --exclude-standard)" ]] || \
  fail "the Git worktree must be clean before a release"
HEAD_TAG="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
[[ "$HEAD_TAG" == "$TAG" ]] || \
  fail "HEAD must already carry release tag $TAG before publishing"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated"
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 && \
  fail "GitHub release $TAG already exists; refusing to replace published assets"

echo "release prerequisites passed: signing=$SIGNING_MODE ($DEV_ID); notarization=$NOTARY_METHOD; $MINISIGN_VERSION"
scripts/preflight.sh
./services/agent-sidecar/build-sidecar.sh
[[ -x "$SIDECAR/arcelle-sidecar" ]] || fail "missing built sidecar: $SIDECAR"
for model in nemo_en_titanet_small.onnx ggml-silero-v5.1.2.bin ggml-large-v3-turbo-q5_0.bin; do
  [[ -s "$MODELS/$model" ]] || fail "missing production model: $MODELS/$model"
done

CSC_IDENTITY_AUTO_DISCOVERY=true ARCELLE_MAC_IDENTITY="${ARCELLE_MAC_IDENTITY:-}" \
ARCELLE_MODELS_DIR="$MODELS" ARCELLE_SIDECAR_STAGE_DIR="$SIDECAR" \
  ARCELLE_SKIP_DISPLAY_MEDIA_CAPTURE=1 npm run package:mac

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

# v0.26.9's Electron runtime cannot provide BLAKE2b through node:crypto. It can
# still verify Minisign's standard direct-Ed25519 `Ed` form, which the bridge
# verifier deliberately accepts. Keep publishing that compatibility form so an
# installation which missed v0.26.10 can update directly to any later release.
SIGNING_TMP="$(mktemp -d /tmp/arcelle-updater-signing.XXXXXX)"
chmod 700 "$SIGNING_TMP"
DECODED_UPDATER_KEY="$SIGNING_TMP/minisign.key"
RAW_UPDATER_SIGNATURE="$SIGNING_TMP/Arcelle.app.tar.gz.minisig"
ARCELLE_WRAPPED_KEY_PATH="$UPDATER_KEY_PATH" \
ARCELLE_DECODED_KEY_PATH="$DECODED_UPDATER_KEY" \
node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

const encoded = (await readFile(process.env.ARCELLE_WRAPPED_KEY_PATH, "utf8")).trim();
if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
  throw new Error("the updater key wrapper is not canonical base64");
}
const decoded = Buffer.from(encoded, "base64");
if (decoded.toString("base64") !== encoded) {
  throw new Error("the updater key wrapper is not canonical base64");
}
new TextDecoder("utf-8", { fatal: true }).decode(decoded);
await writeFile(process.env.ARCELLE_DECODED_KEY_PATH, decoded, { mode: 0o600, flag: "wx" });
NODE

# `expect` supplies the password over the signer's protected terminal. The
# value is removed from the environment before Minisign is spawned, is not in
# argv, and terminal echo is disabled by Minisign while it is entered.
ARCELLE_MINISIGN="$MINISIGN" \
ARCELLE_MINISIGN_KEY="$DECODED_UPDATER_KEY" \
ARCELLE_MINISIGN_PAYLOAD="$TAR" \
ARCELLE_MINISIGN_SIGNATURE="$RAW_UPDATER_SIGNATURE" \
ARCELLE_MINISIGN_PASSWORD="$UPDATER_KEY_PASSWORD" \
/usr/bin/expect <<'EXPECT'
set timeout -1
set signer_password $env(ARCELLE_MINISIGN_PASSWORD)
unset env(ARCELLE_MINISIGN_PASSWORD)
spawn -noecho $env(ARCELLE_MINISIGN) -S -l -s $env(ARCELLE_MINISIGN_KEY) -m $env(ARCELLE_MINISIGN_PAYLOAD) -x $env(ARCELLE_MINISIGN_SIGNATURE)
expect {
  -re {Password:} {
    send -- "$signer_password\r"
    exp_continue
  }
  eof
}
set wait_result [wait]
exit [lindex $wait_result 3]
EXPECT
[[ -s "$RAW_UPDATER_SIGNATURE" ]] || fail "Minisign did not create the updater signature"
ARCELLE_RAW_SIGNATURE="$RAW_UPDATER_SIGNATURE" ARCELLE_OUTER_SIGNATURE="$TAR.sig" \
node --input-type=module <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
const raw = await readFile(process.env.ARCELLE_RAW_SIGNATURE);
if (raw.length === 0) throw new Error("the updater signature is empty");
await writeFile(process.env.ARCELLE_OUTER_SIGNATURE, raw.toString("base64"), { mode: 0o644 });
NODE
cleanup_updater_signing_tmp
[[ -s "$TAR.sig" ]] || fail "compatibility signer did not create $TAR.sig"

# Do not trust a successful signer exit code alone. Verify the exact payload
# and signature through the same pinned public key and verifier the installed
# Electron app uses. A wrong private key therefore fails before publication.
ARCELLE_UPDATE_PAYLOAD="$TAR" ARCELLE_UPDATE_SIGNATURE="$TAR.sig" \
node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import {
  decodeOuterBase64,
  parseSignatureFile,
  verifyManifestSignature,
} from "./apps/desktop/dist_package/src/main/updater/minisignVerify.js";
import { TAURI_UPDATE_PUBKEY_B64 } from "./apps/desktop/dist_package/src/main/updater/tauriUpdater.js";
const signatureB64 = readFileSync(process.env.ARCELLE_UPDATE_SIGNATURE, "utf8").trim();
const parsed = parseSignatureFile(
  decodeOuterBase64(signatureB64, "malformed_signature", "release signature"),
);
if (parsed.prehashed) {
  throw new Error("release signature is ED/prehashed; v0.26.9 requires the compatible Ed form");
}
verifyManifestSignature(
  readFileSync(process.env.ARCELLE_UPDATE_PAYLOAD),
  signatureB64,
  TAURI_UPDATE_PUBKEY_B64,
);
NODE

# Run the same verification in Electron's BoringSSL-backed Node runtime. This
# is the exact crypto environment where v0.26.9 rejected an `ED` signature.
ARCELLE_UPDATE_PAYLOAD="$TAR" ARCELLE_UPDATE_SIGNATURE="$TAR.sig" \
ELECTRON_RUN_AS_NODE=1 "$ROOT/node_modules/.bin/electron" --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { verifyManifestSignature } from "./apps/desktop/dist_package/src/main/updater/minisignVerify.js";
import { TAURI_UPDATE_PUBKEY_B64 } from "./apps/desktop/dist_package/src/main/updater/tauriUpdater.js";
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
