# End-to-end tests

Four things live here, because they answer different questions and run in
different places.

| Suite | Command | Drives | Runs on |
| --- | --- | --- | --- |
| **Page-script tests** | `npm run test:page` | `src-tauri/src/browser/page.js`, `src/workspace/address.ts` and `qa/qa-mock.js` under a hand-rolled DOM, in plain Node | everywhere |
| **UI regressions** | `npm run e2e:qa` | the real React app in Chrome against `dist/qa.html`, with `qa/qa-mock.js` standing in for the Rust backend | everywhere, macOS included |
| **Screenshot capture** | `npm run capture` | the same Chrome vehicle, walking every screen to write the vision dataset | everywhere, macOS included |
| **Demo happy path** (HLT-8) | `npm run e2e` | the packaged app via `tauri-driver`, real Rust backend, mocked Ollama | **nowhere — see below** |

The first two are the ones to run on a change; the rest of this page says what
each covers and, for the last one, why it covers nothing today.

## What to run before calling a change done

```bash
npm test          # build + page-script tests + cargo test + the sidecar's pytest
npm run e2e:qa    # the UI, in a real browser (~1 min) — NOT part of `npm test`
```

`npm test` (`scripts/preflight.sh --suites`) and `.github/workflows/ci.yml`
both cover the first line. Neither runs the browser suites: they need Chrome
and a served build, so `npm run e2e:qa` — and `npm run capture` — stay a
deliberate, by-hand step. Nothing here installs a git hook or runs itself.

`npm run e2e:qa` builds `dist/`, generates `dist/qa.html` and serves it, so it
covers the real components, state, event wiring, CSS and layout maths — but
**not** the Rust commands, which is what `cargo test` is for. Where a fix spans
both halves, each half carries its own test (e.g.
`recording::tests::speaker_names_*` for GH #5).

---

## Page-script tests — `npm run test:page`

`node --test` over `e2e/page-script/`, no browser and no dependencies:

| File | Covers |
| --- | --- |
| `page.test.mjs` | the injected browser page script — mark ordering and the cap, the password fence, ref staleness, label resolution, markdown extraction, Save page / Save selection, the totality contract with the Rust bridge |
| `address.test.mjs` | what the address bar decides from the typed text alone |
| `qa-mock.test.mjs` | the visual-QA backend in `qa/qa-mock.js` — the browser command family as live state (cold start, navigate, tabs, takeover, save, journal), the refusal of private addresses, and the unfaked-command fallback with its on-page badge |
| `dom-stub.mjs` | not a test — the hand-rolled DOM `page.test.mjs` runs against, implementing only the API surface the script touches, so a failure is about the script rather than about the stub |

`page.js` is plain JavaScript and is read from disk. `address.ts` is
TypeScript, so it is type-stripped in memory with the `typescript` dev
dependency and imported — **not** restated. An earlier version of that file
kept a hand-typed copy of the regexes, which passed happily while the real
address bar was broken.

## UI regressions — `npm run e2e:qa`

Specs in `e2e/qa-specs/`. The `gh*` ones are one per GitHub issue, each checked
to go **red** against the pre-fix code, so they are regression tests rather
than descriptions.

| Spec | Guards |
| --- | --- |
| `gh2-sidebar-expand.e2e.mjs` | the activity rail expands to full labels and remembers it; the Library splitter's grip is visible at rest, widens past the old 32% ceiling, and the panes trade so the center floor holds |
| `gh3-feedback-modal.e2e.mjs` | the feedback modal opens empty after publishing **and** after cancelling |
| `gh4-mic-volume.e2e.mjs` | `autoGainControl` is never requested on any mic path; echo cancellation stays on by default and the Settings toggle releases it |
| `gh5-speaker-names.e2e.mjs` | naming a speaker renames every line they said, persists, clears (by emptying it *or* by typing the machine label back), caps a pasted essay at 60 characters, and Escape abandons |
| `areas-and-viewers.e2e.mjs` | every rail area opens its tab and draws something rather than falling into an error boundary, six of the 25 kinds in `ViewerKind` (markdown, PDF, docx, spreadsheet, code, recording) render their file, and no pane reaches a command the mock does not fake |
| `recording-reading.e2e.mjs` | Notes, Highlights and Chapters: every item says who put it there, and an item the ROOM wrote is drawn differently and carries "?" in TEXT — a difference that survives a screenshot, a colourblind reader and a screen reader |
| `voice-recognition.e2e.mjs` | a name the app GUESSED is never indistinguishable from one the user typed, and a voice the room isn't sure about stays "Speaker N" |
| `create-look.e2e.mjs` | the Create page opens as a workspace rather than a wall of model cards, each tab offers only the lengths and starting pictures the model allows, and every script shows its shot arithmetic *before* it charges — and, its own reason for existing, it writes PNGs of each step to `qa/shots/`, because a panel can be the right width, carry the right text and still be unusable because it fills the page |

```bash
npm run e2e:qa                 # build, generate qa.html, serve, run
SKIP_BUILD=1 npm run e2e:qa    # reuse dist/ while iterating on specs
HEADED=1 npm run e2e:qa        # watch it drive
```

Only Chrome is needed — WebdriverIO downloads its own driver.

**When a spec needs new backend data**, add the command to `qa/qa-mock.js`
rather than weakening the assertion. An unfaked command is recorded on
`window.__qaUnhandled`, warns in the console, and paints a red strip along the
bottom of the page naming it — which is what `areas-and-viewers.e2e.mjs` fails
on, and what stops a human eyeballing the harness from reading the mock's
emptiness as the app's. A pane that renders from nothing looks perfectly
healthy otherwise. `node qa/check-mock-coverage.mjs --list` names the whole gap
without running anything.

**The Browser area** is faked as live state rather than a snapshot: the pages
in `qa/qa-mock.js` are created, navigated, selected and closed by the same
commands the chrome calls, and `browser_info` is derived from whichever page is
active. It starts cold (no page, chrome buttons disabled), which is the real
state of a freshly opened room. The one thing that can never appear is the page
itself — it is a native child webview floating above the DOM, so after a
navigation the stage is the empty rectangle that view would be parked over.

## Screenshot capture — `npm run capture`

`e2e/capture-specs/screens.mjs` walks every area × state × theme × viewport,
every Settings page, both palette states, the pane layouts, every viewer kind
and the agent strip, and writes `sidecar/data/vision/images/*.png` plus a
`_shots.jsonl` manifest describing each one.

```bash
npm run capture                                  # the full matrix
SKIP_BUILD=1 CAPTURE_SMOKE=1 npm run capture     # one slice of it, to check wiring
```

Two rules the file enforces on itself, both learned the hard way:

* **The coverage contract.** Every expected bucket — kind, state, theme, area,
  viewer and the finer `detail` label — must come back non-empty, or the run
  fails. The first full run passed green having captured zero viewers, because
  one selector matched nothing and the loop moved on. (The smoke run captures a
  deliberate slice, so there the gaps are printed instead of thrown.)
* **No mislabelled shots.** A shot claiming `empty`, `loading` or `error` is
  only written if the pane demonstrably shows it. `?qa_state=` only reaches
  commands `qa/qa-mock.js` recognises as reads, so a pane whose loader is not
  named `list_*`/`get_*` used to come back fully stocked under a label saying
  otherwise. Skipped combinations are listed at the end of the run.

---

## Demo smoke test (HLT-8) — currently unrunnable

Drives the **real** Arcelle app through the demo happy path —
create room → import files → ask a question → see an annotation chip — with
the AI faked so it needs no real Ollama and no network.

```
create room ──▶ import notes.txt + data.csv ──▶ ask ──▶ 📍 annotation chip
                          (mock Ollama replays a scripted tool call)
```

**It does not run anywhere today, and `npm run e2e` says so and stops:**

* **macOS** — `tauri-driver` has no macOS support (WKWebView exposes no
  WebDriver), so nothing can drive the packaged app on the platform Arcelle
  ships for.
* **Linux / Windows** — `tauri-driver` works there, but the release build this
  config starts with does not: `whisper-rs` is pinned with Apple's `metal`
  feature in `src-tauri/Cargo.toml` outside any target gate, and the app is
  macOS-only by design besides.

It is kept rather than deleted because it is the only thing that exercises the
real Rust backend end to end, and because everything in it except the driver
launch is portable. Reviving it needs a WebDriver for WKWebView (not ours to
write) or target-gated Cargo features plus a non-macOS build of the app. Until
then the coverage it was standing in for lives in `cargo test` (the commands)
and `npm run e2e:qa` (the UI).

| File | Role |
| --- | --- |
| `mock-ollama.mjs` | Zero-dependency Node HTTP server that replays canned Ollama responses. `/api/chat` emulates one tool-calling round: first an `annotate_file` tool call (drives the 📍 chip), then a final text answer. Also serves `/api/tags`, `/api/show`, `/api/generate`, `/api/embed`, `/api/pull`, `/api/delete`, and warns on stdout for any path it has no fixture for. |
| `wdio.conf.mjs` | WebdriverIO config. Refuses on macOS; elsewhere builds the release binary, starts the mock, and launches the app through `tauri-driver` with `ARCELLE_OLLAMA_URL` pointed at the mock. |
| `specs/smoke.e2e.mjs` | The test. Bypasses the two native file dialogs by stubbing `window.__TAURI_INTERNALS__.invoke` for `plugin:dialog\|save`/`open` only; every other call hits the real Rust backend. |
| `fixtures/notes.txt`, `fixtures/data.csv` | Imported into the room. `notes.txt` contains the exact line the scripted `annotate_file` call highlights. |

### The mock on its own (useful on any platform)

```bash
npm run e2e:mock            # serves on http://127.0.0.1:11434
# then, in another shell, launch the app pointed at it:
ARCELLE_OLLAMA_URL=http://127.0.0.1:11434 npm run tauri dev
```

That part works on a Mac: it is how you drive the app by hand with no model
loaded and no network.
