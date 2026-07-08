# Releasing Private Room (macOS)

This is the checklist for cutting a signed, notarized, auto-updatable
release. Steps marked **(one-time)** are done once; the rest run every
release. Nothing here is automated yet — the Apple account steps require a
human with the developer account.

---

## 0. One-time setup (do these once, keep the secrets safe)

### Apple Developer ID (signing + notarization)

1. **(one-time)** Join the [Apple Developer Program](https://developer.apple.com/programs/)
   (99 USD/yr). You need a paid membership — a free Apple ID cannot create
   Developer ID certificates.
2. **(one-time)** In Xcode → Settings → Accounts (or the Developer portal),
   create a **"Developer ID Application"** certificate. Install it into your
   login keychain. Confirm it is present:
   ```sh
   security find-identity -v -p codesigning
   # look for: "Developer ID Application: Your Name (TEAMID)"
   ```
3. **(one-time)** Note your **Team ID** (10 chars, e.g. `AB12CD34EF`) from
   the Developer portal → Membership.
4. **(one-time)** Create an **app-specific password** for notarization at
   <https://appleid.apple.com> → Sign-In & Security → App-Specific Passwords.
   This is the value for `APPLE_PASSWORD` (NOT your real Apple ID password).

### Updater signing keypair

The auto-updater verifies each update with a Tauri (minisign) keypair that is
separate from Apple code signing.

> **Current state:** a keypair has already been generated during development and
> its **public key is already committed** in `src-tauri/tauri.conf.json` at
> `plugins.updater.pubkey`. The matching **private key was written to
> `/tmp/pr_updater.key`** (an ephemeral, no-password dev key — it is NOT in git
> and must never be committed). Before the first real release you must EITHER:
> - move that private key into a CI secret (see step 7) and keep the committed
>   pubkey as-is, OR
> - regenerate a password-protected keypair (step 5) and replace the pubkey.
>
> Since no public release has shipped with this key yet, regenerating now is
> safe (it only breaks updates for users already on a build signed with the old
> key — of which there are none).

5. **(one-time)** Generate the keypair:
   ```sh
   npm run tauri signer generate -- -w ~/.tauri/private-room.key
   ```
   - Choose a strong password when prompted; save it in your password manager.
   - This prints (and writes) a **public key** and a **private key**.
6. **(one-time)** Put the **public key** into `src-tauri/tauri.conf.json` at
   `plugins.updater.pubkey` (already done for the current dev key). Commit that
   change — the public key is safe to commit.
7. **(one-time)** Keep the **private key** and its password OUT of git. The
   private key belongs in **CI secrets**, never in the repo:
   - GitHub Actions: store the private key text as the secret
     `TAURI_SIGNING_PRIVATE_KEY` and (if password-protected) the password as
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The release workflow reads them as
     env vars at sign time.
   - For local release builds, they are supplied via env vars (see below).
   - Delete the ephemeral `/tmp/pr_updater.key` once it is safely in the secret
     store — a temp file is not a keystore.
8. **(one-time)** Set the release endpoint in `tauri.conf.json` at
   `plugins.updater.endpoints`. The default points at:
   ```
   https://github.com/benrben/private-room/releases/latest/download/latest.json
   ```
   Adjust the `owner/repo` if the GitHub repo differs.

---

## 1. Environment variables for a release build

Export these in the shell that runs the build (do not commit them):

```sh
# --- Apple notarization ---
export APPLE_ID="you@example.com"            # your Apple ID email
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"  # the app-specific password
export APPLE_TEAM_ID="AB12CD34EF"            # your 10-char Team ID

# --- Code signing identity ---
# tauri.conf.json currently has bundle.macOS.signingIdentity = "-" (ad-hoc,
# for local/unsigned dev builds). For a real release, either edit it to your
# full identity string OR override via env:
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (AB12CD34EF)"

# --- Updater signing (minisign) ---
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/private-room.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="the-keypair-password"
```

> With `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` present, Tauri notarizes
> and staples automatically during `tauri build`. With the two
> `TAURI_SIGNING_*` vars present, it signs the update bundle and emits a
> `.sig` file next to the artifact.

---

## 2. Every release

1. **Bump the version** in both places (keep them in sync):
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`
2. **Build** (signs + notarizes + staples + signs the update bundle when the
   env vars above are set):
   ```sh
   npm ci
   npm run tauri build
   ```
   Artifacts land in `src-tauri/target/release/bundle/`:
   - `dmg/Private Room_<version>_aarch64.dmg` — the download for new users.
   - `macos/Private Room.app.tar.gz` — the updater payload.
   - `macos/Private Room.app.tar.gz.sig` — the minisign signature.
3. **Verify Gatekeeper acceptance** on the built app:
   ```sh
   spctl -a -vv "src-tauri/target/release/bundle/macos/Private Room.app"
   # expect: "accepted" and "source=Notarized Developer ID"
   xcrun stapler validate "src-tauri/target/release/bundle/macos/Private Room.app"
   ```
4. **Write `latest.json`** (this is what the app polls). Template:
   ```json
   {
     "version": "0.2.0",
     "notes": "What changed in this release.",
     "pub_date": "2026-07-04T00:00:00Z",
     "platforms": {
       "darwin-aarch64": {
         "signature": "<paste contents of Private Room.app.tar.gz.sig>",
         "url": "https://github.com/benrben/private-room/releases/download/v0.2.0/Private.Room.app.tar.gz"
       }
     }
   }
   ```
   - `version` must match the new version.
   - `signature` is the full text of the `.sig` file.
   - `url` must point at the uploaded `.app.tar.gz` asset for this release.
   - Add a `darwin-x86_64` entry too if you ship an Intel build.
5. **Publish the GitHub Release** (tag `v<version>`) and upload:
   - the `.dmg` (for fresh installs),
   - the `.app.tar.gz` (updater payload),
   - `latest.json`.
   ```sh
   gh release create "v0.2.0" \
     "src-tauri/target/release/bundle/dmg/Private Room_0.2.0_aarch64.dmg" \
     "src-tauri/target/release/bundle/macos/Private Room.app.tar.gz" \
     "latest.json" \
     --title "Private Room 0.2.0" --notes "…"
   ```
   The updater `endpoints` URL uses `releases/latest/download/latest.json`, so
   marking the release as **latest** (not pre-release) makes it live.

---

## 3. Verify the release end-to-end

1. On a Mac (or a fresh user account) that has never seen the app: download
   the DMG, open it → **no "unidentified developer" warning**, app runs first
   try.
2. `spctl -a -vv "Private Room.app"` → accepted / notarized.
3. Install the PREVIOUS version, launch it, then publish this bumped release:
   the running app should show **"Update available — Install & relaunch"**,
   install, and relaunch into the new version.

---

## Notes

- **Local/dev builds don't need any of this.** `signingIdentity: "-"` gives an
  ad-hoc-signed, unsigned-to-the-world build that runs fine on the build
  machine. The Apple env vars are only read at release time.
- If `pubkey` is still the placeholder, the launch update check (`src/updater.ts`
  → `checkForUpdatesQuietly`) simply no-ops/errs quietly — it never bothers the
  user.
- Keep `pubkey`/endpoint, the Apple certificate, and the minisign private key
  consistent across releases; rotating the updater key breaks updates for users
  on older builds.
