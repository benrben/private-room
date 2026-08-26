#!/bin/bash
# The deep test opens a real encrypted room under Electron, so its native DB
# addon must target Electron's ABI during the run. Always restore Node's ABI on
# exit because Vitest loads the same addon directly.
set -uo pipefail
cd "$(dirname "$0")/.."

NATIVE_MODULE="better-sqlite3-multiple-ciphers"
ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version")"

restore_node_abi() {
  local exit_code=$?
  echo "[e2e] restoring ${NATIVE_MODULE} for Node"
  if ! npm rebuild "$NATIVE_MODULE"; then
    echo "[e2e] failed to restore ${NATIVE_MODULE} for Node" >&2
    exit 1
  fi
  if ! node -e "const D=require('${NATIVE_MODULE}'); const db=new D(':memory:'); db.close()"; then
    echo "[e2e] restored addon does not load under Node" >&2
    exit 1
  fi
  exit "$exit_code"
}
trap restore_node_abi EXIT

echo "[e2e] rebuilding ${NATIVE_MODULE} for Electron ${ELECTRON_VERSION}"
if ! ./node_modules/.bin/electron-rebuild -f -w "$NATIVE_MODULE" -v "$ELECTRON_VERSION"; then
  echo "[e2e] native Electron rebuild failed" >&2
  exit 1
fi
if ! ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e \
  "const D=require('${NATIVE_MODULE}'); const db=new D(':memory:'); db.close()"; then
  echo "[e2e] rebuilt addon does not load under Electron" >&2
  exit 1
fi

node ../../e2e/electron-deep.mjs
