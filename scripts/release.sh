#!/usr/bin/env bash
# Build a signed/notarized Electron release and publish its assets with `gh`.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_DIR="electron-migration/electron-app"
VER="$(node -p "require('./${APP_DIR}/package.json').version")"
TAG="v${VER}"
MODELS="${ARCELLE_MODELS_DIR:-${APP_DIR}/assets/models}"
SIDECAR="${ARCELLE_SIDECAR_STAGE_DIR:-sidecar/dist/arcelle-sidecar}"

scripts/preflight.sh
command -v uv >/dev/null || { echo "uv is required" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh is required to publish" >&2; exit 1; }
./sidecar/build-sidecar.sh
[[ -x "$SIDECAR/arcelle-sidecar" ]] || { echo "missing built sidecar: $SIDECAR" >&2; exit 1; }
for model in nemo_en_titanet_small.onnx ggml-silero-v5.1.2.bin ggml-large-v3-turbo-q5_0.bin; do
  [[ -s "$MODELS/$model" ]] || { echo "missing production model: $MODELS/$model" >&2; exit 1; }
done

CSC_IDENTITY_AUTO_DISCOVERY=true ARCELLE_MODELS_DIR="$MODELS" \
ARCELLE_SIDECAR_STAGE_DIR="$SIDECAR" npm run package:mac

OUT="$APP_DIR/release"
APP="$OUT/mac-arm64/Arcelle.app"
TAR="$OUT/Arcelle.app.tar.gz"
node "$APP_DIR/scripts/packTarGz.mjs" "$APP" "$TAR"

[[ -n "${MINISIGN_SECRET_KEY:-}" ]] || { echo "MINISIGN_SECRET_KEY is required" >&2; exit 1; }
command -v minisign >/dev/null || { echo "minisign is required" >&2; exit 1; }
minisign -S -s "$MINISIGN_SECRET_KEY" -m "$TAR" -x "$TAR.sig"
node "$APP_DIR/scripts/buildLatestManifest.mjs" \
  --version "$VER" --notes "${RELEASE_NOTES:-Release $VER.}" \
  --sig-file "$TAR.sig" --out "$OUT/latest.json"

gh release create "$TAG" \
  "$OUT/Arcelle_${VER}_aarch64.dmg" "$TAR" "$TAR.sig" "$OUT/latest.json" \
  --title "Arcelle $VER" --notes "${RELEASE_NOTES:-Release $VER.}"
