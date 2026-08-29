#!/bin/bash
# The deep test opens a real encrypted room under Electron, so its native DB
# addon must target Electron's ABI during the run. Always restore Node's ABI on
# exit because Vitest loads the same addon directly.
set -euo pipefail
cd "$(dirname "$0")/.."

NATIVE_MODULE="better-sqlite3-multiple-ciphers"
ELECTRON_VERSION="$(node -p "require('electron/package.json').version")"

restore_node_abi() {
  local exit_code=$?
  echo "[e2e] restoring ${NATIVE_MODULE} for Node"
  if ! npm run build-release --prefix "../../node_modules/${NATIVE_MODULE}"; then
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
if ! npx --no-install electron-rebuild -f -w "$NATIVE_MODULE" -v "$ELECTRON_VERSION"; then
  echo "[e2e] native Electron rebuild failed" >&2
  exit 1
fi
if ! ELECTRON_RUN_AS_NODE=1 npx --no-install electron -e \
  "const D=require('${NATIVE_MODULE}'); const db=new D(':memory:'); db.close()"; then
  echo "[e2e] rebuilt addon does not load under Electron" >&2
  exit 1
fi

node ../../tests/e2e/desktop/electron-deep.mjs

# The deep run proves the provider/Sidecar frame boundary, but it invokes ask
# through preload and therefore cannot prove ChatPane exposes the human-owned
# one-turn image valve. Run exactly that renderer spec under the normal E2E
# release gate. Reuse the renderer build the deep test already required; only
# generate the QA entrypoint here, rather than rebuilding or running the broad
# visual QA suite.
(
  cd ../..
  node tests/support/make-qa.mjs
  SKIP_BUILD=1 npm run e2e:qa -- --spec tests/e2e/qa/cloud-video-privacy.e2e.mjs
)
