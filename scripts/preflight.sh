#!/usr/bin/env bash
# Electron-era release gate.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  --checks)
    npm --prefix electron-migration/electron-app run check:versions
    node qa/check-mock-coverage.mjs --bridge=electron
    ;;
  --suites)
    npm run lint
    npm test
    npm run build
    ;;
  "")
    npm --prefix electron-migration/electron-app run check:versions
    node qa/check-mock-coverage.mjs --bridge=electron
    npm run lint
    npm test
    npm run build
    ;;
  *) echo "usage: scripts/preflight.sh [--checks|--suites]" >&2; exit 2 ;;
esac
