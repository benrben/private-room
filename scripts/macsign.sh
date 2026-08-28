#!/usr/bin/env bash
# Ad-hoc development signing for an Electron bundle. Real release signing and
# notarization are handled by electron-builder's afterSign hook.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="${1:-apps/desktop/release/mac-arm64/Arcelle.app}"
ENTITLEMENTS="apps/desktop/scripts/entitlements.mac.plist"
IDENT="com.benreich.privateroom"

[[ -d "$APP" ]] || { echo "no app bundle at: $APP" >&2; exit 1; }
codesign --force --deep --sign - --identifier "$IDENT" --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --requirements "=designated => identifier \"$IDENT\"" "$APP"
codesign --verify --strict --deep "$APP"
echo "signed: $APP"
