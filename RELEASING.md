# Releasing Arcelle

Arcelle ships as an Electron macOS app. [`scripts/release.sh`](scripts/release.sh)
runs the complete gate, builds the Python sidecar, packages and signs the app
with electron-builder, creates the updater archive and manifest, and publishes
the GitHub release. Developer ID builds are notarized; the current explicit
ad-hoc distribution path is signed with a stable designated requirement.

## One-time setup

- Install Node, `uv`, `gh`, and Minisign 0.12 (`brew install minisign`). Arcelle
  remains an Electron app; Minisign is retained because existing installations
  pin the public half of the old Tauri updater key.
- Prefer a Developer ID Application certificate in the login keychain. When it
  is not available, an intentional ad-hoc release must set
  `ARCELLE_MAC_IDENTITY=-`; the release script never falls back silently.
- Configure notarization using one complete credential set accepted by
  [`afterSign.mjs`](apps/desktop/scripts/afterSign.mjs):
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
them with `--private-key`. The release script reads only the path supplied by
`TAURI_SIGNING_PRIVATE_KEY_PATH`, decodes Tauri's wrapper into an owner-only
temporary directory, gives Minisign that temporary path, and removes it before
publication. The password crosses Minisign's protected terminal through the
system `expect` tool; it is removed from the child environment and never enters
command arguments, terminal output, or shell substitution.

Updater archives deliberately carry Minisign's legacy `Ed` signature rather
than its default prehashed `ED` form. v0.26.9's Electron runtime cannot provide
BLAKE2b through `node:crypto`, but it already verifies standard direct Ed25519.
Keeping `Ed` preserves a safe update path even for an installation that was
offline during v0.26.10. The release gate verifies the finished archive in both
ordinary Node and Electron before publishing it.

Download these production weights into
`apps/desktop/resources/models/` (they are gitignored):

```bash
mkdir -p apps/desktop/resources/models
curl -L -o apps/desktop/resources/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
curl -L -o apps/desktop/resources/models/nemo_en_titanet_small.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
curl -L -o apps/desktop/resources/models/ggml-silero-v5.1.2.bin \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

## Cut a release

1. Update the version in the repository and desktop workspace packages plus
   the Python sidecar, refresh the root npm lock and
   `services/agent-sidecar/uv.lock`, and add the changelog entry.
2. Run `scripts/preflight.sh`.
3. Confirm that the checkout is clean and the signing prerequisites are ready:

```bash
git status --short
security find-identity -v -p codesigning
minisign -v
```

   Minisign must report version 0.12. Use a valid
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
designated requirement. It then signs the updater tar with the existing
Tauri-compatible key, refuses the incompatible `ED` algorithm, and verifies the
legacy `Ed` signature through the same pinned public key in both Node and
Electron before publishing.

For a structural unsigned package without real release resources, use
`npm run package:dir`; the build labels fixture-resource output explicitly and
must never be published.
