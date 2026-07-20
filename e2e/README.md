# End-to-end smoke test (HLT-8)

Drives the **real** Arcelle app through the demo happy path —
create room → import files → ask a question → see an annotation chip — with
the AI faked so it runs anywhere, with no real Ollama and no network.

```
create room ──▶ import notes.txt + data.csv ──▶ ask ──▶ 📍 annotation chip
                          (mock Ollama replays a scripted tool call)
```

## What's here

| File | Role |
| --- | --- |
| `mock-ollama.mjs` | Zero-dependency Node HTTP server that replays canned Ollama responses. `/api/chat` emulates one tool-calling round: first an `annotate_file` tool call (drives the 📍 chip), then a final text answer. Also serves `/api/tags`, `/api/generate`, `/api/embed`, `/api/pull`, `/api/delete`. |
| `wdio.conf.mjs` | WebdriverIO config. Builds the release binary, starts the mock, launches the app through `tauri-driver` with `ARCELLE_OLLAMA_URL` pointed at the mock. |
| `specs/smoke.e2e.mjs` | The test. Bypasses the two native file dialogs by stubbing `window.__TAURI_INTERNALS__.invoke` for `plugin:dialog|save`/`open` only; every other call hits the real Rust backend. |
| `fixtures/notes.txt`, `fixtures/data.csv` | Imported into the room. `notes.txt` contains the exact line the scripted `annotate_file` call highlights. |

## Run it (one command)

```bash
npm run e2e
```

That builds `src-tauri` in release, starts the mock, and runs the spec. Green in
well under two minutes; **no real model or network required.**

## First-time prerequisites

`tauri-driver` is a Rust binary (a cargo crate, *not* an npm package):

```bash
npm install                 # installs @wdio/* dev dependencies
cargo install tauri-driver  # the WebDriver bridge Tauri uses for e2e
```

**Platform note.** `tauri-driver` supports **Linux** (needs `webkit2gtk-driver` /
`WebKitWebDriver`) and **Windows** (needs `msedgedriver` matching your WebView2).
It does **not** yet support macOS — WKWebView has no WebDriver — so run this
suite on Linux/Windows or Linux CI. The mock server and spec are
platform-independent; only the driver launch in `wdio.conf.mjs` is OS-gated.

## Run just the mock (debugging)

```bash
npm run e2e:mock            # serves on http://127.0.0.1:11434
# then, in another shell, launch the app pointed at it:
ARCELLE_OLLAMA_URL=http://127.0.0.1:11434 npm run tauri dev
```

## When it fails

The spec label names the broken step (e.g. the composer never appears → room
didn't open; no `.annot-chip` → the tool-call / annotation path regressed;
rename the `ask` command → the ask call rejects and the assertion fails loudly).
