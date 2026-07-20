---
name: release
description: >-
  Cut a signed macOS GitHub release of Arcelle: bump the version, write the
  changelog, build + sign the app, package the DMG and updater payload, publish
  the GitHub release, and install the built app locally. Use whenever the user
  asks to release, ship, cut a release, "build re-install and release", publish a
  new version, or roll a patch/minor of this app. Encodes the verified procedure
  and its gotchas, and ALWAYS appends the required Install section to the notes.
---

# Releasing Arcelle

Cut a release of this project end to end. `scripts/release.sh` does the heavy
lifting (sidecar build → app build → sign → DMG + updater tar → minisign →
`latest.json` → `gh release`); this skill is the checklist around it, plus the
two things a script can't decide: the version/notes, and the **mandatory Install
section** below.

`RELEASING.md` in the repo root is the canonical reference — read it if anything
here is unclear. This skill is the operational shortcut.

## ⚠️ ALWAYS: the Install section

Every release's notes MUST end with this exact section, appended after the
changelog body. Never omit it, never reword the xattr line — the build is
ad-hoc signed (not notarized), so without it users hit Gatekeeper and can't open
the app. Show the assembled notes to the user before publishing.

```markdown
## Install

Download the DMG below — macOS 12+, Apple Silicon. The build is ad-hoc signed (not notarized), so clear quarantine once after installing:

```sh
/usr/bin/xattr -cr "/Applications/Arcelle.app"
```
```

## Steps

### 1. Decide the version (semver)
- Patch (`0.5.0 → 0.5.1`): bug fixes only.
- Minor (`0.5.0 → 0.6.0`): new user-facing features.
- Check current: `node -p "require('./src-tauri/tauri.conf.json').version"`.

### 2. Bump the version in ALL FIVE files (must stay in sync)
- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `[package] version`
- `sidecar/pyproject.toml` → `version` (the sidecar's `/health` reports it)
- `sidecar/arcelle_sidecar/__init__.py` → `__version__`

Then refresh the lockfile so the build doesn't rebuild it dirty:
`(cd src-tauri && cargo update -p arcelle --precise <NEW_VERSION>)`
(use the repo's cargo, e.g. `/opt/homebrew/bin/cargo` — rustup shims are broken).

### 3. Write the CHANGELOG
Add a `## <version> — <YYYY-MM-DD>` section at the top of `CHANGELOG.md` (below
the header), in the voice of the existing entries: user-facing, plain, what
changed and why it matters. This is the source of the release notes.

### 4. Commit + tag + push
Convention: a fix/feature commit, then a mechanical `Release <version>` commit
that carries only the five version bumps + `Cargo.lock` + `CHANGELOG.md`.
```sh
git add <changed source files> && git commit -m "<what changed>"
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml \
        src-tauri/Cargo.lock sidecar/pyproject.toml \
        sidecar/arcelle_sidecar/__init__.py CHANGELOG.md
git commit -m "Release <version>"
git tag v<version> && git push origin main v<version>
```
End commit messages with the `Co-Authored-By` trailer per the repo/global rules.

### 5. Assemble the release notes
Extract this version's changelog section, then **append the Install section**:
```sh
BODY="$(awk '/^## <version>/{f=1;next}/^## /{f=0}f' CHANGELOG.md)"
RELEASE_NOTES="$BODY

## Install

Download the DMG below — macOS 12+, Apple Silicon. The build is ad-hoc signed (not notarized), so clear quarantine once after installing:

\`\`\`sh
/usr/bin/xattr -cr \"/Applications/Arcelle.app\"
\`\`\`"
```
`RELEASE_NOTES` feeds BOTH the GitHub release body and `latest.json`. Show it to
the user before running the release.

### 6. Run the release script — with BOTH gotchas
```sh
rm -rf sidecar/build sidecar/dist                       # gotcha A
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/private-room.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""             # gotcha B — MUST be explicit
RELEASE_NOTES="$RELEASE_NOTES" scripts/release.sh
```
Run it in the background (5–10 min) and wait for completion.

- **Gotcha A** — `release.sh` calls `build-sidecar.sh` WITHOUT `--clean`, and
  PyInstaller aborts on a non-empty `dist/`. Wipe `sidecar/build sidecar/dist`
  first, or a stale sidecar ships.
- **Gotcha B** — the updater key has no password. If
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is UNSET, tauri PROMPTS for one, and in a
  non-TTY/background shell that dies with `failed to decode secret key … Device
  not configured (os error 6)`. Export it as an explicit empty string.
- Exit 0 = released. `✓ Released v<version> — <url>` prints at the end.

### 7. Scrub the log
`release.sh` passes the private updater key as a CLI arg to `tauri signer sign`,
so npm echoes it into any captured log. **Delete the release log/task-output
file** after the run — do not leave the key on disk.

### 8. Verify the published release
```sh
gh release view v<version> --repo benrben/private-room \
  --json tagName,isPrerelease,assets \
  --jq '{tag:.tagName, prerelease:.isPrerelease, assets:[.assets[].name]}'
curl -sL https://github.com/benrben/private-room/releases/latest/download/latest.json \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['version'])"
```
Expect three assets (`.dmg`, `Private.Room.app.tar.gz`, `latest.json`),
`prerelease:false`, and `latest.json` → the new version. Marking the release
**Latest** (the default, non-prerelease) is what makes auto-update go live.

### 9. Install the built app locally + verify
```sh
osascript -e 'tell application "Arcelle" to quit'   # quit the running copy
APP="src-tauri/target/release/bundle/macos/Arcelle.app"
codesign --verify --strict "$APP"
rm -rf "/Applications/Arcelle.app" && ditto "$APP" "/Applications/Arcelle.app"
codesign --verify --strict "/Applications/Arcelle.app"
/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" \
  "/Applications/Arcelle.app/Contents/Info.plist"      # expect the new version
open -a "Arcelle"
```
`release.sh` already applied the final (ad-hoc, stable-DR) signature, so a
separate `macsign.sh` run is not needed here — but if you ever rebuild locally
outside `release.sh`, run `scripts/macsign.sh` or TCC drops the mic/screen
grants.

### 10. Record it in memory
Update the release-history memory (`private-room-v030-release.md`) and its
`MEMORY.md` index line with the new version, date, what shipped, and any new
gotcha. Convert relative dates to absolute.

## Notes / invariants
- **Never regenerate `~/.tauri/private-room.key`** — it is the key of record;
  regenerating orphans every installed copy's auto-update. Back it up, don't
  rotate.
- Keep the five version files and the git tag in lockstep — a crate version
  mismatch is user-visible (MCP `serverInfo`) and the tag drives the assets.
- If the key isn't on the machine, cut a **DMG-first** release instead (publish
  the DMG + unsigned tar now, sign `latest.json` later on a machine with the
  key) — see RELEASING.md §3.
