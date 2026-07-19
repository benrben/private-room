# Releasing Private Room (macOS)

One script cuts a release: [`scripts/release.sh`](scripts/release.sh). It
builds the Python agent sidecar, builds and signs the app, packages the DMG
and the updater payload, writes `latest.json`, and publishes the GitHub
release. This document is the checklist around it: what to set up once, what
to export per release, and how to verify the result.

---

## 0. One-time setup

### Apple Developer ID (signing + notarization)

1. **(one-time)** Join the [Apple Developer Program](https://developer.apple.com/programs/)
   (99 USD/yr). A free Apple ID cannot create Developer ID certificates.
2. **(one-time)** Create a **"Developer ID Application"** certificate (Xcode →
   Settings → Accounts, or the Developer portal) and install it into your
   login keychain:
   ```sh
   security find-identity -v -p codesigning
   # look for: "Developer ID Application: Your Name (TEAMID)"
   ```
3. **(one-time)** Store notarization credentials once:
   ```sh
   xcrun notarytool store-credentials private-room
   # uses your Apple ID + an app-specific password from appleid.apple.com
   ```
   `release.sh` notarizes and staples automatically when
   `APPLE_NOTARY_PROFILE=private-room` is exported.

> **Without a Developer ID**, `release.sh` falls back to an ad-hoc signature
> with a stable designated requirement (`scripts/macsign.sh`) so macOS
> permission grants (mic, screen recording) survive updates on machines that
> install these builds. Users clear Gatekeeper quarantine once — the README's
> Download section walks them through it.

### Updater signing keypair (minisign)

The auto-updater verifies each update against the public key committed in
`src-tauri/tauri.conf.json` at `plugins.updater.pubkey`. The matching
**private key must never be committed** — it belongs in a password manager
and/or CI secret (`TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

> **Key history:** v0.1.0–v0.2.3 were signed with an ephemeral dev key that
> lived at `/tmp/pr_updater.key` and did not survive the machine. That key is
> lost, so **the keypair was rotated at v0.3.0**: the key of record now lives
> at `~/.tauri/private-room.key` (no password — back it up in your password
> manager and/or a CI secret; do NOT regenerate, that would orphan 0.3.0+
> installs the same way). Consequences of the rotation: 0.2.x installs cannot
> verify the new signature, so those users download the DMG once; auto-update
> is live again from 0.3.0 onward.
>
> If the key is ever lost again: generate a new one and update the committed
> pubkey —
> ```sh
> npm run tauri signer generate -- -w ~/.tauri/private-room.key
> ```
> then put the printed **public key** into `tauri.conf.json` →
> `plugins.updater.pubkey`, commit it, and ship a release built from that
> config. Keep the private key out of git.

### Voice model

Release builds bundle the Whisper voice model (~574 MB, gitignored). Fetch it
into place once per machine, or the bundle step fails on the missing resource:

```sh
mkdir -p src-tauri/resources/models
curl -L -o src-tauri/resources/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

---

## 1. Environment for a release build

```sh
# Updater signing (required for the full flow; omit for a DMG-first release)
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/private-room.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"

# Notarization (optional — only with a Developer ID certificate installed)
export APPLE_NOTARY_PROFILE="private-room"
```

---

## 2. Every release

1. **Bump the version** in all five places (keep them in sync):
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`
   - `sidecar/pyproject.toml` → `version` (the sidecar's `/health` reports it)
   - `sidecar/privateroom_sidecar/__init__.py` → `__version__`
2. **Update `CHANGELOG.md`** — the release notes come from it.
3. **Merge to `main`, tag, push:**
   ```sh
   git tag v<version> && git push origin main v<version>
   ```
4. **Run the release script:**
   ```sh
   RELEASE_NOTES="$(cat /path/to/notes.md)" scripts/release.sh
   ```
   It does, in order: sidecar build (PyInstaller onedir) → app build → final
   signature (Developer ID + notarize, or ad-hoc via `macsign.sh`) → updater
   tar + minisign `.sig` → DMG → `latest.json` → `gh release create` (or
   `--clobber` upload if the tag's release already exists).

   Build gotchas the script already handles or that you should know:
   - It prepends `/usr/bin` to `PATH` so the real `xattr`/`hdiutil` win over
     any Python shims (a pyenv `xattr` breaks the bundler).
   - If the sidecar's Python dependencies changed since the last build, run
     `./sidecar/build-sidecar.sh --clean` first — PyInstaller's cache can
     ship stale modules.
   - A plain local `npm run tauri build` exits 1 at the updater-signing step
     when `TAURI_SIGNING_PRIVATE_KEY` is unset — *after* the `.app` is fully
     built. For local installs that's harmless; `release.sh` packages the
     updater tar itself.

---

## 3. DMG-first release (no updater key on the machine)

When the updater key isn't available, still ship — the updater can be lit up
afterwards without rebuilding:

1. Build everything the same way (`release.sh` steps, skipping the minisign
   sign + `latest.json`), and publish the release with **both** the DMG and
   the **unsigned** `Private.Room.app.tar.gz`.
2. `releases/latest/download/latest.json` now 404s, so existing installs'
   update checks quietly no-op — nobody sees an error; downloads work.
3. Later, on a machine with the key: download that exact `app.tar.gz` asset,
   sign it, write `latest.json`, upload both:
   ```sh
   gh release download v<version> -p "Private.Room.app.tar.gz"
   npm run tauri signer sign -- --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
     ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:+--password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"} \
     Private.Room.app.tar.gz
   # build latest.json from the .sig (version, notes, pub_date, url — see
   # the template block in scripts/release.sh), then:
   gh release upload v<version> --clobber Private.Room.app.tar.gz latest.json
   ```
   Auto-update is live the moment `latest.json` lands on the release marked
   **Latest**.

---

## 4. Verify the release end-to-end

1. `gh release view v<version>` — assets present, release marked **Latest**.
2. Fresh download on a Mac that has never seen the app: DMG opens, the
   README's Gatekeeper steps work, app launches, sidecar features respond.
3. `codesign --verify --strict "/Applications/Private Room.app"` — and for a
   notarized build, `spctl -a -vv` → `accepted · source=Notarized Developer ID`.
4. If the updater manifest shipped: install the *previous* version, launch,
   and confirm **"Update available — Install & relaunch"** appears and
   relaunches into the new version. Quick check without installing:
   ```sh
   curl -sL https://github.com/benrben/private-room/releases/latest/download/latest.json
   ```

---

## Notes

- Local/dev builds need none of this — `signingIdentity: "-"` ad-hoc builds
  run fine on the build machine. After every local rebuild, run
  `scripts/macsign.sh` or macOS silently drops the app's mic/screen grants
  (TCC keys grants to the signature).
- Keep the updater pubkey, endpoint, and private key consistent across
  releases — rotating the key orphans auto-update for every install that
  shipped with the old pubkey (they recover with one manual DMG download).
- The updater endpoint is
  `https://github.com/benrben/private-room/releases/latest/download/latest.json`;
  marking a release **Latest** (not pre-release) is what makes it live.
