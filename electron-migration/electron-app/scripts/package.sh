#!/bin/bash
# The ABI-safe package wrapper: compile, FORCE the native database module to
# Electron's ABI, package it, prove the module inside the finished app loads
# under that app's Electron runtime, then rebuild the workspace copy BACK to
# Node's own ABI (137 on this Node 24) UNCONDITIONALLY -- in a bash `trap`,
# so a build failure never leaves the ~200 vitest files that touch the DB
# broken afterward. This is the mechanism the committed decision in
# `electron/main/index.electron.test.ts`'s own "NATIVE-MODULE BOUNDARY" doc
# comment calls for and that this batch exists to actually wire up.
#
# The explicit `electron-rebuild -f` is load-bearing. electron-builder's normal
# rebuild pass can find this package's ABI-specific prebuilt file and report it
# prepared while leaving `build/Release/better_sqlite3.node` on Node's ABI.
# The package's `bindings` lookup loads that build/Release path first, producing
# ERR_DLOPEN_FAILED only when a real room is opened. Both the pre-package
# Electron load and the post-package load below exercise the exact binding.
#
# Usage:
#   scripts/package.sh --dir          # proof build: raw `.app` directory only, no installer
#   scripts/package.sh                # dmg + dir
#
# Ordering (research doc section 9, "release.mjs" note): preflight — which
# runs the suites under NODE's ABI — must complete BEFORE packaging flips
# the ABI forward. This script runs `npm run typecheck` and `npm test`
# first, for exactly that reason: if either fails, the ABI is never touched
# at all.
#
# Never wired as a postinstall hook (the committed decision this whole batch
# exists to satisfy) -- this script only runs when a human/CI explicitly
# invokes it.
set -uo pipefail
cd "$(dirname "$0")/.."

NATIVE_MODULE="better-sqlite3-multiple-ciphers"

echo "▶ Preflight: typecheck + full suite (must stay green under Node's own ABI before packaging touches it)"
if ! npm run typecheck; then
  echo "✗ typecheck failed — not touching the native module ABI." >&2
  exit 1
fi
if ! npm test; then
  echo "✗ test suite failed — not touching the native module ABI." >&2
  exit 1
fi

echo "▶ Compiling main process and copying its runtime assets"
if ! npm run build:main; then
  echo "✗ compile failed — not touching the native module ABI." >&2
  exit 1
fi

rebuild_back() {
  local exit_code=$?
  echo "▶ Rebuilding ${NATIVE_MODULE} back to Node's ABI (unconditional — runs whether packaging just succeeded or failed)"
  if ! npm rebuild "$NATIVE_MODULE"; then
    echo "✗✗ FAILED to rebuild ${NATIVE_MODULE} back to Node's ABI." >&2
    echo "   The workspace's native module is now Electron-ABI-only and ~200 vitest" >&2
    echo "   files that touch the DB will fail until this is fixed by hand:" >&2
    echo "     npm rebuild ${NATIVE_MODULE}" >&2
    exit 1
  fi
  echo "▶ Verifying ${NATIVE_MODULE} loads under Node's own ABI (a real require + a real :memory: open, not just an exit code)"
  if ! node -e "
    const Database = require('${NATIVE_MODULE}');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t(x)');
    db.prepare('INSERT INTO t VALUES (1)').run();
    if (db.prepare('SELECT x FROM t').get().x !== 1) throw new Error('unexpected row');
  "; then
    echo "✗✗ ${NATIVE_MODULE} rebuilt but does not actually open a database under Node's ABI." >&2
    exit 1
  fi
  echo "✓ ${NATIVE_MODULE} confirmed back on Node's ABI."
  exit "$exit_code"
}
trap rebuild_back EXIT

ELECTRON_VERSION="${ELECTRON_VERSION:-$(node -p "require('./node_modules/electron/package.json').version")}"
echo "▶ Rebuilding ${NATIVE_MODULE} for Electron ${ELECTRON_VERSION} (forced)"
if ! ./node_modules/.bin/electron-rebuild -f -w "$NATIVE_MODULE" -v "$ELECTRON_VERSION"; then
  echo "✗ Failed to rebuild ${NATIVE_MODULE} for Electron ${ELECTRON_VERSION}." >&2
  exit 1
fi

echo "▶ Verifying ${NATIVE_MODULE} under Electron before packaging"
if ! ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "
  const Database = require('${NATIVE_MODULE}');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(x)');
  db.prepare('INSERT INTO t VALUES (148)').run();
  if (db.prepare('SELECT x FROM t').get().x !== 148) throw new Error('unexpected row');
"; then
  echo "✗ ${NATIVE_MODULE} does not load under Electron before packaging." >&2
  exit 1
fi

echo "▶ electron-builder --config electron-builder.config.mjs $*"
# CSC_IDENTITY_AUTO_DISCOVERY defaults to FALSE here -- deliberately safer
# than electron-builder's own default (which auto-searches the keychain for
# a signing identity when this var is unset). This batch's safety rules
# forbid any real codesign from happening in this session, ad-hoc included,
# so this wrapper opts OUT of that search by default rather than relying on
# "this sandbox's keychain happens to be empty" as the only guard. A real
# release run, on a real machine, with a real intent to sign, sets it
# explicitly:  CSC_IDENTITY_AUTO_DISCOVERY=true scripts/package.sh
UNSIGNED_PROOF="${ARCELLE_PACKAGE_UNSIGNED_PROOF:-}"
if [[ " $* " == *" --dir "* ]] && [[ -z "$UNSIGNED_PROOF" ]]; then
  UNSIGNED_PROOF="1"
fi
CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}" \
ARCELLE_PACKAGE_UNSIGNED_PROOF="$UNSIGNED_PROOF" \
  npx electron-builder --config electron-builder.config.mjs --mac "$@"
builder_status=$?
if [[ "$builder_status" -ne 0 ]]; then
  exit "$builder_status"
fi

PACKAGED_APP="$PWD/release/mac-arm64/Arcelle.app"
PACKAGED_MODULE="$PACKAGED_APP/Contents/Resources/app.asar/node_modules/$NATIVE_MODULE"
echo "▶ Verifying the packaged ${NATIVE_MODULE} under the packaged Electron runtime"
if [[ ! -d "$PACKAGED_APP" ]]; then
  echo "✗ Packaged app not found at $PACKAGED_APP." >&2
  exit 1
fi
if ! ELECTRON_RUN_AS_NODE=1 ARCELLE_PACKAGED_NATIVE="$PACKAGED_MODULE" \
  "$PACKAGED_APP/Contents/MacOS/Arcelle" -e '
    const Database = require(process.env.ARCELLE_PACKAGED_NATIVE);
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(x)");
    db.prepare("INSERT INTO t VALUES (148)").run();
    if (db.prepare("SELECT x FROM t").get().x !== 148) throw new Error("unexpected row");
  '; then
  echo "✗ Finished app contains the wrong native-module ABI." >&2
  exit 1
fi
echo "✓ Packaged native database module loads under Electron."
