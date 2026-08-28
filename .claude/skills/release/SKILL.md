---
name: release
description: >-
  Cut a signed macOS GitHub release of Arcelle (Electron): bump the version,
  write the changelog, build the sidecar + app, sign, package the DMG and
  updater payload, publish the GitHub release, and install the built app
  locally. Also covers a LOCAL REBUILD + REINSTALL without publishing. Use
  whenever the user asks to release, ship, cut a release, "build re-install and
  release", publish a new version, roll a patch/minor — or just to "reinstall"
  / rebuild the app locally after code changes. Encodes the verified
  post-Tauri-cutover procedure and its gotchas, and ALWAYS appends the required
  Install section to the notes.
---

# Releasing Arcelle (Electron)

Cut a release end to end. `scripts/release.sh` does the heavy lifting
(prereq gates → preflight → sidecar build → package + sign → updater tar →
Tauri-key signature → `latest.json` → `gh release`); this skill is the
checklist around it, plus the things a script can't decide: the version/notes,
the **mandatory Install section**, and the local install at the end.

`RELEASING.md` in the repo root is the canonical reference. **The app is
Electron now** — there is no `src-tauri/`, no cargo, no `tauri build`. The only
Tauri thing left is the updater KEY (`~/.tauri/private-room.key`) and the Tauri
CLI v2 that signs the update payload with it.

For a quick local rebuild without publishing, jump to
**"Local reinstall (no release)"** at the bottom.

## ⚠️ ALWAYS: the Install section

`release.sh` REFUSES notes that don't contain, verbatim: a `## Install`
heading, the sentence `The build is ad-hoc signed (not notarized)`, and the
exact line `/usr/bin/xattr -cr "/Applications/Arcelle.app"`. Append this after
the changelog body and show the assembled notes to the user before publishing:

```markdown
## Install

Download the DMG below — macOS 12+, Apple Silicon. The build is ad-hoc signed (not notarized), so clear quarantine once after installing:

```sh
/usr/bin/xattr -cr "/Applications/Arcelle.app"
```
```

## Steps

### 0. Room to build
`df -h /` first. A release needs ~10 GB free: the packaged app + DMG + updater
tar land in `apps/desktop/release/` (~6.5 GB total). If
short, two safe reclaims:
- the `release/` dir from the PREVIOUS release, once `gh release view v<prev>`
  shows all four assets published;
- `${HOME}/Arcelle-Developer-Backups/` — the install flow preserves the
  outgoing `/Applications/Arcelle.app` there, outside the worktree (~1.4 GB
  per reinstall). Keep the newest backup and prune older copies deliberately;
  every released version's DMG is on GitHub too. App bundles and user data
  must never be stored in the repository.

A full disk mid-PyInstaller can leave a truncated sidecar that still LOOKS
built — see the sidecar boot check in the local-reinstall section.

Also check `ListAgents`/other sessions: `release.sh` requires a clean worktree,
and the flow may stash concurrent edits ("preserve concurrent … during
release"). After any release, check `git stash list` before assuming in-flight
work was lost.

### 1. Decide the version (semver)
- Patch: bug fixes only. Minor: new user-facing features.
- Current: `node -p "require('./apps/desktop/package.json').version"`

### 2. Bump every shipping version source (gate: `check:versions`)
`apps/desktop/package.json` is the SOURCE OF TRUTH
(electron-builder stamps it into the bundle). The six locations are:

1. `apps/desktop/package.json` → `version` (hand-edit)
2. `package.json` (repo root, hand-edit)
3. `package-lock.json` (the only npm lockfile; run
   `npm install --package-lock-only --ignore-scripts` at the repo root)
4. `services/agent-sidecar/pyproject.toml` `[project] version` (hand-edit)
5. `services/agent-sidecar/src/arcelle_sidecar/__init__.py` `__version__` (hand-edit)
6. `services/agent-sidecar/uv.lock` — regenerate with
   `(cd services/agent-sidecar && uv lock)`, never by hand.

Verify: `npm run check:versions --workspace @arcelle/desktop`.

### 3. Preflight BEFORE tagging
`scripts/preflight.sh` = check:versions + mock-coverage drift
(`--bridge=electron`) + lint + full test suites + build. Run it before the tag
so a bad version never lands on a pushed tag. (`--checks` = fast gates only;
`--suites` = lint+test+build only.)

### 4. CHANGELOG, commit, tag, push
Add `## <version> — <YYYY-MM-DD>` at the top of `CHANGELOG.md` in the voice of
the existing entries. Then a fix/feature commit, then a mechanical
`release Arcelle <version>` commit carrying the version bumps + lockfiles +
CHANGELOG. **`release.sh` requires HEAD to already carry the tag** and the tree
to be clean, and refuses if the GitHub release already exists:

```sh
git tag v<version> && git push origin main v<version>
```
Repo is PUBLIC — check what `git add -A` would stage before staging it.

### 5. Assemble the notes
```sh
BODY="$(awk '/^## <version>/{f=1;next}/^## /{f=0}f' CHANGELOG.md)"
RELEASE_NOTES="$BODY

<the Install section from above>"
```
Feeds BOTH the GitHub release body and `latest.json`. Show it to the user.

### 6. Signing mode + updater key (the gates that actually refuse)
- **Ad-hoc (current shipping mode)**: `export ARCELLE_MAC_IDENTITY=-` — the
  bundle gets Arcelle's STABLE DESIGNATED REQUIREMENT
  (`identifier "com.benreich.privateroom"`), which is what lets TCC grants
  survive reinstalls. This must be explicit; the script never falls back
  silently.
- **Developer ID**: leave `ARCELLE_MAC_IDENTITY` unset with a
  `Developer ID Application` identity in the keychain — but then COMPLETE
  notarization credentials are required (`APPLE_KEYCHAIN_PROFILE`, or the
  APPLE_ID triple, or the App Store Connect API-key triple) or the script
  refuses.
- **Updater key**: do **NOT** export `TAURI_SIGNING_PRIVATE_KEY` (the contents)
  — `release.sh` REFUSES it. It reads the key FILE:
  `TAURI_SIGNING_PRIVATE_KEY_PATH` (default `~/.tauri/private-room.key`), which
  must be a regular file, owned by you, `chmod 600`. Empty password is fine and
  needs no export. **Never regenerate this key** — it orphans every installed
  copy's auto-update. Back it up.
- Needs: `uv`, `gh` (authenticated), Xcode CLT, and Tauri CLI v2 (updater
  signer only — `node_modules/.bin/tauri` counts).

### 7. Run it
```sh
RELEASE_NOTES="$RELEASE_NOTES" scripts/release.sh
```
Background it (10–20 min) and read the `released v<version> — <url>` line.
Inside it runs: `scripts/preflight.sh` →
`./services/agent-sidecar/build-sidecar.sh` (staged to
`services/agent-sidecar/dist/arcelle-sidecar`; PyInstaller runs `--noconfirm`, so a dirty
`dist/` no longer aborts — but after sidecar code changes prefer
`--clean` yourself first so no stale cache ships) → checks the three model
weights exist in `apps/desktop/resources/models/`
(`nemo_en_titanet_small.onnx`, `ggml-silero-v5.1.2.bin`,
`ggml-large-v3-turbo-q5_0.bin`) → `npm run package:mac` → signature checks
(deep verify + stable-DR or notarization+Gatekeeper per mode) → `packTarGz` →
`tauri signer sign` → verifies the signature with the SAME pinned pubkey the
installed app uses → `buildLatestManifest` → `gh release create` with the DMG,
`Arcelle.app.tar.gz`, its `.sig`, and `latest.json`.

**Quit the installed Arcelle BEFORE packaging** (`osascript -e 'tell
application "Arcelle" to quit'`) — the test gate's real-Electron-boot tests
(`index.electron.test.ts`) fail on "Another instance of Arcelle already holds
the single-instance lock" while any copy runs, including one a Playwright
installed-app review left open (`pgrep -fl "Arcelle.app/Contents/MacOS"` shows
`--inspect=0` for those).

**One worktree, one builder.** Packaging, `npm run e2e`, and `electron-rebuild`
all delete-and-recreate the native SQLite binding and the `dist*` trees; a
concurrent session doing any of them fails this gate with hundreds of
"Could not locate the bindings file" errors or vanishing stage dirs. Check
`ListAgents` for peer sessions and ask them to hold builds first.

`package:mac` itself re-runs typecheck + the full Node-ABI test suite, then
flips `better-sqlite3-multiple-ciphers` to Electron's ABI, packages, proves the
packaged module loads under the packaged Electron, and flips the ABI back in a
trap. **If it dies hard, the workspace module is stranded on Electron's ABI and
every later `test:electron` fails** — fix:
`npm run build-release --prefix node_modules/better-sqlite3-multiple-ciphers`.

The key never rides argv or logs anymore (the `*_PATH` hand-off), so there is
no log to scrub — but still avoid capturing env dumps.

### 8. Verify the published release
```sh
gh release view v<version> --repo benrben/private-room \
  --json tagName,isPrerelease,assets \
  --jq '{tag:.tagName, prerelease:.isPrerelease, assets:[.assets[].name]}'
curl -sL https://github.com/benrben/private-room/releases/latest/download/latest.json \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['version'])"
```
Expect FOUR assets (`.dmg`, `Arcelle.app.tar.gz`, `.tar.gz.sig`,
`latest.json`), `prerelease:false`, and `latest.json` → the new version.

### 9. Install the built app locally + verify
```sh
osascript -e 'tell application "Arcelle" to quit'
APP="apps/desktop/release/mac-arm64/Arcelle.app"
codesign --verify --strict "$APP"
BACKUP_DIR="${HOME}/Arcelle-Developer-Backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
if [[ -d "/Applications/Arcelle.app" ]]; then
  mv "/Applications/Arcelle.app" "$BACKUP_DIR/Arcelle-before-${STAMP}.app"
fi
ditto "$APP" "/Applications/Arcelle.app"
codesign --verify --strict "/Applications/Arcelle.app"
/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" \
  "/Applications/Arcelle.app/Contents/Info.plist"
open -a "Arcelle"
```
The packaging already applied the final signature (stable-DR ad-hoc or
notarized Developer ID), so no extra signing step here. `scripts/macsign.sh` is
only for a bundle produced OUTSIDE `package.sh` — without the stable DR, TCC
drops the mic/screen grants.

### 10. Record it in memory
Update the release-history memory (`private-room-v030-release.md`) and its
`MEMORY.md` index line: version, date, what shipped, new gotchas. Absolute
dates.

## Local reinstall (no release)

For "reinstall" / "rebuild and install" after code changes — no version bump,
no tag, no publishing. Verified 2026-08-27:

```sh
df -h /                                     # step 0 applies here too
./services/agent-sidecar/build-sidecar.sh --clean # only if the sidecar changed
# Prove the staged sidecar actually boots (a disk-full build can truncate it):
services/agent-sidecar/dist/arcelle-sidecar/arcelle-sidecar --port 0 & # expect SIDECAR_PORT=<n> within ~30s, then kill it

ARCELLE_MAC_IDENTITY=- ARCELLE_PACKAGE_UNSIGNED_PROOF=0 \
ARCELLE_MODELS_DIR="$PWD/apps/desktop/resources/models" \
ARCELLE_SIDECAR_STAGE_DIR="$PWD/services/agent-sidecar/dist/arcelle-sidecar" \
npm run package:dir
```

- `ARCELLE_MAC_IDENTITY=-` = the same stable-DR ad-hoc signature the installed
  app carries → TCC grants survive the swap. Match the installed app's mode
  (`codesign -dv /Applications/Arcelle.app` — `TeamIdentifier=not set` means
  ad-hoc).
- `ARCELLE_PACKAGE_UNSIGNED_PROOF=0` is load-bearing: a bare `--dir` build
  defaults to an UNSIGNED proof build (`identity: null`), which would nuke TCC
  on install. Any value except `1` keeps signing on.
- `package:dir` produces only `release/mac-arm64/Arcelle.app` (no DMG), runs
  the same typecheck + full-suite + ABI-flip pipeline as `package:mac`.

Then install exactly as step 9 above. The sidecar is spawned ON DEMAND — after
launch, `pgrep -f arcelle-sidecar` showing nothing is normal.
