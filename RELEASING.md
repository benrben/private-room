# Releasing Arcelle

Arcelle ships as an Electron macOS app. [`scripts/release.sh`](scripts/release.sh)
runs the complete gate, builds the Python sidecar, packages/signs/notarizes the
app with electron-builder, creates the updater archive and manifest, and
publishes the GitHub release.

## One-time setup

- Install Node, `uv`, `gh`, and `minisign`.
- Install a Developer ID Application certificate in the login keychain.
- Configure notarization using one of the credential sets accepted by
  [`afterSign.mjs`](electron-migration/electron-app/scripts/afterSign.mjs).
- Keep the updater minisign secret key outside the repository and pass its path
  as `MINISIGN_SECRET_KEY`.

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
3. Publish:

```bash
export MINISIGN_SECRET_KEY=/secure/path/arcelle.key
export APPLE_KEYCHAIN_PROFILE=arcelle-notary
RELEASE_NOTES="$(cat /path/to/notes.md)" scripts/release.sh
```

For a structural unsigned package without real release resources, use
`npm run package:dir`; the build labels fixture-resource output explicitly and
must never be published.
