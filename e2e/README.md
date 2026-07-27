# End-to-end tests

Two suites, because they answer different questions and run in different places.

| Suite | Command | Drives | Runs on |
| --- | --- | --- | --- |
| **Demo happy path** (HLT-8) | `npm run e2e` | the real packaged app via `tauri-driver`, real Rust backend, mocked Ollama | Linux / Windows only |
| **Issue regressions** | `npm run e2e:qa` | the real React app in Chrome against `dist/qa.html`, with `qa/qa-mock.js` standing in for the Rust backend | everywhere, macOS included |

`tauri-driver` has no macOS support (WKWebView has no WebDriver), so on the
machine this app is developed on the first suite cannot run at all. The second
one exists so UI regressions are still caught locally — it covers the real
components, state, event wiring and layout maths, but **not** the Rust commands.
Where a fix spans both halves, the Rust half carries its own `cargo test`
(e.g. `recording::tests::speaker_names_*` for GH #5).

## Issue regressions — `npm run e2e:qa`

One spec per GitHub issue, in `e2e/qa-specs/`. Each was checked to go **red**
against the pre-fix code, so it is a regression test rather than a description.

| Spec | Issue | Guards |
| --- | --- | --- |
| `gh2-sidebar-expand.e2e.mjs` | #2 | the activity rail expands to full labels and remembers it; the Library splitter's grip is visible at rest, widens past the old 32% ceiling, and the panes trade so the center floor holds |
| `gh3-feedback-modal.e2e.mjs` | #3 | the feedback modal opens empty after publishing **and** after cancelling |
| `gh4-mic-volume.e2e.mjs` | #4 | `autoGainControl` is never requested on any mic path; echo cancellation stays on by default and the Settings toggle releases it |
| `gh5-speaker-names.e2e.mjs` | #5 | naming a speaker renames every line they said, persists, clears, and Escape abandons |

```bash
npm run e2e:qa                 # build, generate qa.html, serve, run
SKIP_BUILD=1 npm run e2e:qa    # reuse dist/ while iterating on specs
HEADED=1 npm run e2e:qa        # watch it drive
```

Only Chrome is needed — WebdriverIO downloads its own driver.

**When a spec needs new backend data**, add the command to `qa/qa-mock.js`
rather than weakening the assertion; an unhandled command logs
`[qa-mock] unhandled command:` and usually surfaces as an error toast sitting on
top of whatever the next step tries to click.

---

# Demo smoke test (HLT-8)

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
