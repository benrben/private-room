#!/usr/bin/env bash
# ADD-33: build the Python agent sidecar into a single self-contained binary the
# Tauri app ships in Contents/Resources/sidecar/, so a released app needs no
# Python on the user's Mac.
#
# langgraph/langchain load a lot of code by dynamic import + importlib.metadata,
# which PyInstaller's static analysis misses — hence the --collect-all /
# --copy-metadata flags below. Output: dist/privateroom-sidecar (one file).
#
# Usage:  ./build-sidecar.sh            # build into sidecar/dist/
#         ./build-sidecar.sh --clean    # wipe build/ dist/ first
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf build dist
fi

# An isolated build venv so the bundle contains only what the sidecar imports
# (never the dev toolchain). uv is the project's Python package manager.
VENV=".build-venv"
uv venv "$VENV" --python 3.13
uv pip install --python "$VENV/bin/python" -e . pyinstaller

# --collect-all pulls a package's submodules + data + metadata; the langgraph /
# langchain / pydantic stacks load code by dynamic import so static analysis
# misses them. Package IMPORT names here (langchain_core, not langchain-core);
# the sidecar depends on langchain-core/langchain-ollama directly, NOT the
# `langchain` umbrella. --copy-metadata takes DISTRIBUTION names for the
# importlib.metadata.version() lookups these libraries do at import time.
# --onedir (NOT --onefile): a one-file binary extracts libpython + its C-extension
# dylibs to a temp dir at launch and dlopen()s them, which fails under the
# hardened runtime a notarized app requires ("mapped file … different Team IDs")
# because those temp copies aren't covered by the app's signature. --onedir keeps
# the dylibs on disk next to the executable, so scripts/release.sh deep-signs them
# with the app's Developer ID in one pass and library validation passes.
"$VENV/bin/pyinstaller" \
  --onedir \
  --name privateroom-sidecar \
  --console \
  --collect-all langgraph \
  --collect-all langgraph_checkpoint \
  --collect-all langgraph_prebuilt \
  --collect-all langgraph_sdk \
  --collect-all langchain_core \
  --collect-all langchain_ollama \
  --collect-all ollama \
  --collect-all fastapi \
  --collect-all uvicorn \
  --collect-all pydantic \
  --collect-all pydantic_core \
  --collect-all edge_tts \
  --collect-all aiohttp \
  --copy-metadata edge-tts \
  --copy-metadata langgraph \
  --copy-metadata langchain-core \
  --copy-metadata langchain-ollama \
  --copy-metadata ollama \
  --collect-submodules privateroom_sidecar \
  launch.py

# Stage the onedir bundle where Tauri bundles resources from (src-tauri/resources/),
# using a clean relative path — tauri.conf.json cannot reference `..` above
# src-tauri. This dir is gitignored; a release runs this script before `tauri
# build`. We do NOT codesign here: the real release deep-signs the whole staged
# dir with the Developer ID + sidecar-entitlements.plist (hardened runtime) inside
# scripts/release.sh/macsign.sh, which is the only signature the notary accepts.
# For LOCAL dev, sidecar_lifecycle.rs prefers the dev fallback anyway.
STAGE="../src-tauri/resources/sidecar"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R dist/privateroom-sidecar "$STAGE/privateroom-sidecar"

# Deep-sign the staged bundle so it actually launches under a hardened runtime:
# PyInstaller's default per-file signing isn't --deep-consistent, so library
# validation rejects the _internal dylibs ("different Team IDs") unless we re-sign
# the whole tree with one identity + the entitlements. Ad-hoc here is enough to
# RUN it locally and to prove the recipe; scripts/release.sh re-signs the same
# tree with the Developer ID for notarization (a strictly more-trusted identity,
# same flags), so what notarizes is what we validated here.
codesign --force --deep --options runtime \
  --entitlements sidecar-entitlements.plist \
  --sign - "$STAGE/privateroom-sidecar/privateroom-sidecar" 2>/dev/null || true

echo
echo "Built + staged: $(cd "$STAGE" && pwd)/privateroom-sidecar/privateroom-sidecar"
echo "Smoke-test it with:  ./dist/privateroom-sidecar/privateroom-sidecar --port 0"
echo "RELEASE: deep-sign the staged dir with the Developer ID + hardened runtime:"
echo "  codesign --force --deep --options runtime \\"
echo "    --entitlements sidecar/sidecar-entitlements.plist \\"
echo "    --sign \"Developer ID Application: …\" \\"
echo "    src-tauri/resources/sidecar/privateroom-sidecar"
