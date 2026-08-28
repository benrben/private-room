# End-to-end tests

Arcelle now uses Electron. The default E2E launches the compiled main process,
the real Python sidecar, and a deterministic local Ollama double. It creates a
disposable encrypted room and verifies the renderer/preload boundary, complete
IPC registration, persistence, all 14 chat-command dispatch routes, specialist
discovery, Main-to-File-agent delegation, every direct `*specialist` route, and live
representative calls across the app's feature families:

```bash
npm run build
npm run e2e
```

The test never opens an existing room, uses the network, or consumes a real
model. Its temporary user-data directory and `.roomai` file are removed even on
failure. The wrapper also forces the encrypted SQLite addon to Electron's ABI
for the test and restores Node's ABI afterward. For a fast renderer/preload-only
launch check, run:

```bash
npm --prefix apps/desktop run e2e:smoke
```

Coverage is deliberately layered. The deep test proves the cross-process wire
and one safe representative flow per family; unit suites cover every IPC
contract and destructive/error edge; browser-hosted suites cover broad visual
interaction; packaging tests cover native dependencies and bundle layout.

The browser-hosted visual suites remain useful for broad UI coverage:

```bash
npm run e2e:qa
npm run capture
```

`npm run test:page` covers the injected private-browser page script and the QA
mock contract under plain Node. Native file dialogs and signed/notarized bundle
behavior are covered by the Electron packaging tests and release-machine QA.
