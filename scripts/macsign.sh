#!/bin/bash
# Re-sign a built Arcelle.app with a STABLE designated requirement.
#
# Why this exists: macOS keys every TCC grant (Microphone, Screen & System
# Audio Recording) to the app's designated requirement. An ad-hoc signature's
# default requirement is `cdhash H"…"` — a per-build hash — so every rebuild
# silently invalidates every permission the user granted, while System
# Settings keeps DISPLAYING the toggles as on. Embedding an explicit
# identifier-based requirement makes the grants survive rebuilds.
#
# Tradeoff (dev-machine only): the requirement is not cryptographically
# anchored, so any locally-run binary claiming this bundle identifier would
# match it. A Developer ID certificate replaces this properly at release.
#
# Usage: scripts/macsign.sh [path/to/Arcelle.app]
set -euo pipefail

APP="${1:-src-tauri/target/release/bundle/macos/Arcelle.app}"
IDENT="com.benreich.privateroom"
ENTITLEMENTS="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/Entitlements.plist"

[ -d "$APP" ] || { echo "no app bundle at: $APP" >&2; exit 1; }
[ -f "$ENTITLEMENTS" ] || { echo "no entitlements at: $ENTITLEMENTS" >&2; exit 1; }

# A real certificate (Developer ID / Apple Development) already gives the app
# a stable designated requirement AND survives notarization — re-signing
# ad-hoc on top would DESTROY it. This script is only the stopgap for ad-hoc
# dev builds; with a certificate it must be a no-op.
if codesign -dv "$APP" 2>&1 | grep -q "TeamIdentifier=[A-Z0-9]"; then
  echo "already signed with a real identity — leaving the signature alone:"
  codesign -dv "$APP" 2>&1 | grep -E "Authority|TeamIdentifier" | head -3 || true
  exit 0
fi

# The helper binary keeps its own ad-hoc signature; only the bundle's main
# signature (the one TCC reads) needs the stable requirement.
codesign --force --sign - \
  --identifier "$IDENT" \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --requirements "=designated => identifier \"$IDENT\"" \
  "$APP"

codesign --verify --strict "$APP"
codesign -d -r- "$APP" 2>&1 | grep -F "identifier \"$IDENT\"" >/dev/null \
  || { echo "designated requirement not embedded" >&2; exit 1; }
echo "signed: $APP"
echo "designated requirement: identifier \"$IDENT\" (stable across rebuilds)"
