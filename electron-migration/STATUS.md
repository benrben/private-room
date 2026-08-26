# Electron / TypeScript migration status

Updated: 2026-08-25

## Migration complete

Arcelle's shipping desktop implementation is now Electron + TypeScript with a
Python sidecar. The interrupted Claude work was recovered, consolidated, and
finished:

- Electron loads the production Vite/React renderer; `bootStub.html` is only a
  copied diagnostic asset and is not the production UI.
- The renderer uses the isolated `window.arcelle` preload bridge. No frontend
  Tauri package or direct Tauri import remains.
- All 306 renderer command contracts are registered. Together with the two
  Electron-only internal channels, boot reports 308 registered channels and an
  empty `KNOWN_UNREGISTERED_COMMANDS` set.
- Room lifecycle, SQLCipher storage, files, chat/grounding, privacy, MCP,
  browser, jobs/workflows, scripts, media, recording/STT, Vision OCR, model
  management, updates, external Claude/Codex detection, and automatic indexing
  are connected to their live production implementations.
- The production build compiles the Electron main/preload code, builds the Vite
  renderer, and stages all required runtime assets in `dist_package/`.
- The former `src-tauri` implementation and Cargo/Tauri shipping configuration
  were removed from the workspace after being moved to the macOS Trash as a
  recoverable migration backup.

## Verified gates

- TypeScript typecheck and Python Ruff lint: passing.
- Full Electron suite: 215 files passing; 6,270 tests passing and 8 skipped.
- Renderer/page suite: 943 of 943 passing. The Electron QA mock audit records
  174 explicit fixtures and documents the commands intentionally left to empty
  or mutation-only behavior; registry tests enforce all 306 real contracts.
- Packaging bridge suite: 23 of 23 passing.
- Production renderer/main build: passing.
- Playwright Electron smoke test: passing against the compiled production
  entry point and preload bridge.
- Self-contained PyInstaller sidecar build: passing, including the bundle audit
  that excludes LangGraph Studio/dev tooling; its `/health` endpoint reports
  version 0.25.0.
- Unsigned 1.2 GB unpacked `.app` with real release resources: passing. It
  contains the actual Whisper, TitaNet, and Silero weights plus the built
  sidecar; packaged bytes match staging exactly. The release wrapper now forces
  the SQLCipher addon onto Electron's ABI, opens a real database inside the
  finished `.app`, and restores the workspace copy to Node's ABI afterward.
- Python sidecar suite: 2,641 passing, 5 environment skips, no failures.
- Clean install at `/Applications/Arcelle.app`: passing. A real encrypted
  SQLCipher database was created, closed, and reopened under the installed
  Electron runtime; an installed-code `rec_start` integration check also passed
  through the bundled 574 MB Whisper-model gate and entered recording state.
  Direct launch reports 308 registered channels, 306 command contracts, and
  `completenessOk: true`.

## Repository hygiene

- `npm run clean:dry-run` lists reproducible build and test output without
  changing the workspace; `npm run clean` removes it while preserving active
  dependencies, bundled model weights, fixtures, source, and local settings.
- Superseded candidate/proof packages, build environments, spike virtualenvs,
  transient caches, and the staged handoff archive were removed after the
  completed migration. The current package uses one production output path:
  `electron-migration/electron-app/dist_package/`.

## Release-machine boundary

Code migration and real-resource local packaging are complete. Publishing a
distributable build still requires secrets that are deliberately not stored in
this repository: an Apple signing identity, notarization credentials, updater
signing keys, and GitHub release authority. Follow `RELEASING.md`; do not
present the locally ad-hoc/unsigned proof as a notarized public release.
