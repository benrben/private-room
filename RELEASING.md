# Releasing Arcelle

Arcelle ships as an Electron macOS app. [`scripts/release.sh`](scripts/release.sh)
runs the complete gate, builds the Python sidecar, packages and signs the app
with electron-builder, creates the updater archive and manifest, and publishes
the GitHub release. Developer ID builds are notarized; the current explicit
ad-hoc distribution path is signed with a stable designated requirement.

## One-time setup

- Install Node, `uv`, and `gh`.
- Install Tauri CLI v2 for updater signing only. Version 2.11.4 is the tested
  version: `npm install --global @tauri-apps/cli@2.11.4`. Arcelle remains an
  Electron app; the Tauri signer is retained because existing installations
  pin the public half of the old Tauri updater key.
- Prefer a Developer ID Application certificate in the login keychain. When it
  is not available, an intentional ad-hoc release must set
  `ARCELLE_MAC_IDENTITY=-`; the release script never falls back silently.
- Configure notarization using one complete credential set accepted by
  [`afterSign.mjs`](electron-migration/electron-app/scripts/afterSign.mjs):
  `APPLE_KEYCHAIN_PROFILE`/`APPLE_NOTARY_PROFILE`, Apple ID credentials, or App
  Store Connect API-key credentials. These are required only for Developer ID
  mode because Apple does not notarize ad-hoc builds.
- Keep the existing updater key outside the repository. Its default location
  is `~/.tauri/private-room.key`. It must be owned by the release user, must be
  a regular file rather than a symlink, and must not be readable by group or
  other users:

```bash
chmod 600 ~/.tauri/private-room.key
```

Do not export the key contents as `TAURI_SIGNING_PRIVATE_KEY`, and do not pass
them with `--private-key`. The release script hands only the file path to Tauri
CLI through `TAURI_SIGNING_PRIVATE_KEY_PATH`; the signer reads the file itself.
This keeps private bytes out of command arguments, terminal output, shell
substitution, and child processes that do not need the key.

Download these production weights into
`electron-migration/electron-app/assets/models/` (they are gitignored):

```bash
mkdir -p electron-migration/electron-app/assets/models
curl -L -o electron-migration/electron-app/assets/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
curl -L -o electron-migration/electron-app/assets/models/nemo_en_titanet_small.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
curl -L -o electron-migration/electron-app/assets/models/ggml-silero-v5.1.2.bin \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

## Cut a release

1. Update the version in the two npm packages and the Python sidecar, refresh
   both npm lockfiles and `sidecar/uv.lock`, and add the changelog entry.
2. Run `scripts/preflight.sh`.
3. Confirm that the checkout is clean and the signing prerequisites are ready:

```bash
git status --short
security find-identity -v -p codesigning
tauri --version
```

   The Tauri command must report major version 2. Use a valid
   `Developer ID Application` identity when one is installed. Otherwise make
   the ad-hoc choice explicit when publishing:

```bash
export ARCELLE_MAC_IDENTITY=-
```
4. Publish:

```bash
export APPLE_KEYCHAIN_PROFILE=arcelle-notary
RELEASE_NOTES="$(cat /path/to/notes.md)" scripts/release.sh
```

If the updater key is stored somewhere else, set its path, not its contents:

```bash
export TAURI_SIGNING_PRIVATE_KEY_PATH=/secure/path/private-room.key
```

For a password-protected updater key, also set
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The value is passed only to the signer
process and is never printed.

Before doing expensive work, `release.sh` refuses a dirty checkout, a missing
release tag, an existing GitHub release, an unsafe key mode, ambiguous signing
mode, incomplete Developer ID notarization credentials, or release notes that
omit the required ad-hoc Install disclosure. After packaging, it independently
checks the deep signature. Developer ID mode also checks Team ID, authority,
the stapled ticket and Gatekeeper; ad-hoc mode checks Arcelle's stable
designated requirement. It then signs the updater tar with the existing Tauri
key and verifies that signature through the same pinned public key and verifier
used by installed Arcelle clients before publishing.

For a structural unsigned package without real release resources, use
`npm run package:dir`; the build labels fixture-resource output explicitly and
must never be published.
