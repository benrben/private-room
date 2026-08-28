#!/usr/bin/env bash
# Build the Python agent sidecar into a self-contained onedir bundle that the
# Electron app ships in Contents/Resources/sidecar/, so a release needs no
# Python on the user's Mac.
#
# langgraph/langchain load a lot of code by dynamic import + importlib.metadata,
# which PyInstaller's static analysis misses — hence the --collect-all /
# --copy-metadata flags below. Output: dist/arcelle-sidecar (one onedir bundle).
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
# misses them. Web search adds four more for the same reason: bs4 picks its HTML
# parser by name at runtime, soupsieve is its CSS-selector engine, and requests
# needs certifi's cacert.pem as DATA or every https call fails to verify. Package IMPORT names here (langchain_core, not langchain-core);
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
  --noconfirm \
  --onedir \
  --name arcelle-sidecar \
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
  --collect-all bs4 \
  --collect-all soupsieve \
  --collect-all requests \
  --collect-all certifi \
  --copy-metadata edge-tts \
  --copy-metadata langgraph \
  --copy-metadata langchain-core \
  --copy-metadata langchain-ollama \
  --copy-metadata ollama \
  --collect-submodules arcelle_sidecar \
  launch.py

# Deep-sign the built bundle so it launches under a hardened runtime:
# PyInstaller's default per-file signing isn't --deep-consistent, so library
# validation rejects the _internal dylibs ("different Team IDs") unless we re-sign
# the whole tree with one identity + the entitlements. Ad-hoc here is enough to
# RUN it locally and to prove the recipe; scripts/release.sh re-signs the same
# tree with the Developer ID for notarization (a strictly more-trusted identity,
# same flags), so what notarizes is what we validated here.
# A failure here is fatal (set -e): an unsigned or half-signed bundle only shows
# up much later, as the sidecar refusing to launch on a user's Mac.
codesign --force --deep --options runtime \
  --entitlements sidecar-entitlements.plist \
  --sign - "dist/arcelle-sidecar/arcelle-sidecar"

# Prove the shipped bundle carries no LangGraph Studio / dev tooling — the code
# that cloudpickles conversation threads to PLAINTEXT files in the CWD. This is
# the enforcement of that guarantee, so it runs on every build (the build venv
# already has PyInstaller, which the check reads the archive with).
"$VENV/bin/python" devtools/verify_bundle_clean.py \
  "dist/arcelle-sidecar/arcelle-sidecar"

echo
echo "Built: $(cd dist/arcelle-sidecar && pwd)/arcelle-sidecar"
echo "Smoke-test it with:  ./dist/arcelle-sidecar/arcelle-sidecar --port 0"
echo "The ad-hoc signature above is for local runs; scripts/release.sh re-signs"
echo "the packaged tree with the Developer ID for notarization."
