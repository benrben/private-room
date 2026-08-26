# Arcelle full rewrite — Rust/Tauri → TypeScript + Python

**Date:** 2026-08-22 · **Status:** PLAN, nothing built · **Owner ask:** 100% TS+Python source, zero Rust/Tauri kept, DB implementation may change.

**How this was produced:** a 15-agent review wave — 10 inventory agents read all of `src-tauri` (160/160 `.rs` files verified covered by an independent coverage critic; 306 real `#[tauri::command]`s, all accounted for), 4 design agents produced the deep designs in Parts B–E, and the critic swept config/CI/scripts for everything that must be re-homed. Per-file invariants live in the companion doc `electron-python-migration-inventory-2026-08-22.md` (Part I: mapping tables; Part II: per-file must-preserve/gotcha ledger — **the rewrite checklist**).

---

## 1. Decision record

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Shell | **Electron ≥ 39**, `contextIsolation` + `sandbox` everywhere | System-audio loopback is built in (CoreAudio tap; ScreenCaptureKit Rust/ObjC deleted); Node 22 (`fs.statfsSync` replaces the `df -Pk` shell-out); only mature TS shell |
| D2 | DB | **`better-sqlite3-multiple-ciphers`** in an Electron **utilityProcess** | `PRAGMA cipher='sqlcipher'; legacy=4` is byte-compatible with today's SQLCipher-4 `.room` files — **existing rooms open in place, no converter, no migration**; old `roomai`/Rust builds can still read new files. Sync API isolated in `dbHost` so `VACUUM INTO` can't freeze the UI |
| D3 | IPC | Shared TS contract (`shared/ipc-contract.ts`), **no codegen**; channel names = today's command names | Renderer's `api.ts` callers stay byte-compatible; a missing handler is a compile error (mechanizes today's `menu_ids_all_have_a_frontend_handler` guarantee) |
| D4 | AI engine | Python sidecar unchanged as the SOLE engine; grows audio/vision/docs | Already the sole engine; the seam already exists |
| D5 | STT | **pywhispercpp** on a self-built Metal wheel (`GGML_METAL_EMBED_LIBRARY=1`), vendored in-repo | PyPI wheels are CPU-only; embed the metallib or the onedir must carry loose `.metal` resources |
| D6 | Diarization | numpy + **onnxruntime** (TitaNet, Silero-v5 VAD), constants bit-identical | Retires the tract bit-exactness pin; `diar_bench.py` parity gate: any row regressing > 1 pt DER vs the Rust jsonl fails the port |
| D7 | System audio | Renderer `getDisplayMedia` loopback (Electron ≥ 39); mic via `getUserMedia` worklet | `sck.rs` deleted; **never PyObjC for SCK** (pyobjc#647 — stream callbacks never fire, closed not-planned) |
| D8 | Audio transport | **WebSocket** renderer↔sidecar (binary PCM frames, 250 ms cadence); control on POST; DB writes ACK back through a host WS | Chunked HTTP has no server push for partials; file handoff too slow for live |
| D9 | Browser | **`WebContentsView`** + in-memory partition (no `persist:`) + **one** `webRequest` funnel: private-network guard first, then `@ghostery/adblocker` `match()` called manually | `onBeforeRequest` allows exactly ONE listener — last registration silently wins, so `enableBlockingInSession()` must NOT be called (it would evict the guard, or vice-versa). Blocked count becomes real |
| D10 | Page agent | Preload in **isolated world** (stronger than WKUserScript — page can't see it); `executeJavaScriptInIsolatedWorld` awaits promises natively | Eval ticket protocol deleted; `EVAL_LOST` → promise rejection, still mapped to Loading-not-failure |
| D11 | Readability | **`@mozilla/readability` + linkedom in Electron main** | `dom_smoothie` is a clone of it — zero-drift replacement; reading view's DOM plumbing lives in main; Python gets no HTML article path |
| D12 | yt-dlp | Standalone binary spawned by **main** (TS port of `ytdlp.rs`) | Self-update IS the feature (July binary → August 403 wave); a frozen sidecar can't self-update a pip package |
| D13 | OCR/QuickLook/probe/peaks | **PyObjC in the sidecar** (Vision, QLThumbnailGenerator, AVFoundation) + numpy | Request/response PyObjC is mature; only SCK streaming is broken |
| D14 | MCP | Official **`@modelcontextprotocol/sdk`** for both the outbound client and the room server | Deletes 9.3k lines of hand-rolled JSON-RPC/OAuth plumbing into a maintained SDK (OAuth device/PKCE flows stay ours) |
| D15 | Docs (Python side) | pymupdf (PDF — AGPL, owner Q6), python-docx/pptx/openpyxl, xlrd/odfpy, olefile for legacy `.doc` | Replaces pdf-extract, hand-rolled OOXML walks, calamine, cfb. Port the *tests*, not the parsers |
| D16 | Images/SVG | sharp (main) for downscale/thumbnail; resvg-js or sharp's librsvg for SVG | Prebuilt, no compile |
| D17 | CLI | `roomai` = Node CLI sharing the app's exact DB module, run via `ELECTRON_RUN_AS_NODE` shim | The no-second-decryption-path doctrine of `roomai.rs` |
| D18 | Version files | **7 → 4** (package.json, pyproject.toml, `__init__.py`, uv.lock) | Cargo.toml/Cargo.lock/tauri.conf.json retire |
| D19 | e2e | wdio + `wdio-electron-service` (configs carry over); vitest (main/dbHost); pytest (sidecar) | The "no macOS tauri-driver" gap disappears — e2e gets *easier* |

Open decisions the owner must make are consolidated in §6 — the designs disagreed on two (Touch ID, updater flavor) and raised eleven more.

## 2. Target architecture

```
┌────────────────────────────── Arcelle.app ──────────────────────────────┐
│ Electron main (TS)                                                      │
│   lifecycle · menu(⌘Q door) · geometry · single-instance/.roomai open   │
│   ipc registry (306 channels, typed contract) · event emit helper       │
│   dbHost (utilityProcess): better-sqlite3-multiple-ciphers, SQLCipher-4 │
│     .room in place · rekey · recovery sidecar (format-identical) ·      │
│     checkpoints/rollback drain                                          │
│   browser/: WebContentsView tabs · in-memory session · ONE webRequest   │
│     funnel (guard→ghostery) · preload isolated-world agent · downloads  │
│     · ytdlp.ts · search · journal                                       │
│   agent turn engine (ask/exec_tool) · jobs/workflows · MCP via SDK      │
│   keychain/TouchID · updater · obs log · sidecar spawn (port-print)     │
│ Renderer (React/TS — unchanged views)                                   │
│   api.ts rewired to contextBridge · mic worklet + loopback lane         │
│ Python sidecar (FastAPI, PyInstaller onedir)                            │
│   all AI (unchanged) + rec engine (WS sessions, VAD, lanes, spool/ACK)  │
│   + pywhispercpp Metal + diar (onnxruntime) + dictation                 │
│   + PyObjC: Vision OCR · QuickLook · AVFoundation probe + peaks/decode  │
│   + docs: pymupdf · docx/pptx/xlsx · legacy                             │
└─────────────────────────────────────────────────────────────────────────┘
```

Split rule, unchanged from the research phase: **Electron owns windows, webviews, IPC, the updater, the keychain and the `.room` file. Python owns everything that touches a model, an audio stream, or a document.** The renderer never speaks HTTP to the sidecar except the audio WebSocket (owner Q4).

## 3. Where the 128k lines land

| Subsystem | Files | LOC | Cmds | Est. days | Primarily lands in |
|---|---|---|---|---|---|
| Agent, turns & chat | 9 | 10,633 | 15 | 26 | Electron main (TS) 100% |
| Jobs & workflows | 11 | 18,077 | 27 | 46 | Electron main (TS) 100% |
| Recording, audio & STT | 15 | 15,961 | 37 | 53 | Python sidecar 70%, Electron main (TS) 27% |
| Browser, web & downloads | 14 | 11,080 | 28 | 35 | Electron main (TS) 83%, renderer 15% |
| DB, crypto & rooms | 29 | 13,660 | 21 | 39 | Electron main (TS) 98%, Electron built-in 1% |
| MCP (client + room server) | 6 | 9,342 | 21 | 24 | Electron main (TS) 100% |
| Documents & extraction | 29 | 13,439 | 36 | 48 | Python sidecar 57%, Electron main (TS) 42% |
| Engines, sidecar & models | 10 | 8,877 | 16 | 37 | Electron main (TS) 100% |
| App shell & misc | 16 | 11,439 | 28 | 48 | Electron main (TS) 92%, off-the-shelf lib 4% |
| Feature commands | 22 | 15,510 | 77 | 52 | Electron main (TS) 94%, Python sidecar 5% |
| **Total** | **161** | **128,018** | **306** | **408** | |

Raw estimate sum: **~408 dev-days including test-porting**. The TS lane (~300 d) and Python lane (~110 d) barely share files, so two parallel lanes are natural. Realistic calendar: **8–12 months** with the phasing in §8 (Python lane lands first while the Rust app still ships), or ~14+ months strictly solo-sequential. ~10–15% of the LOC needs no port at all (§4).

## 4. What gets deleted outright (no port)

Verified against current code by the design agents — these exist only to fight the old stack:

- **The blocker race + `START_BLANK` parking + `ThenGo` replay** (`browser.rs:657-743`, `1636-1916`) — WKContentRuleList attached per-webview/post-creation/async; Ghostery attaches to the session before any view exists.
- **Silent whole-list rule rejection handling** (`rules.rs:123-145`, WKErrorDomain 6 + `RULE_LIST_ID` bumping) — Ghostery parses per-rule, skips bad rules, throws on real failure.
- **The eval bridge ticket protocol** (`browser.rs:1548-1624` + `page.js` `begin`/`take`) — isolated-world eval awaits promises natively.
- **iframe-navigation pollution + `believable_for`/`same_site` self-heal** (`browser.rs:700-778`) — Electron navigation events carry `isMainFrame`.
- **The `<200 px` reading refusal + viewport borrow** (`reader.rs:42-64`) — Readability scores a DOM clone, no layout dependency; parked tabs are detached, never 1×1.
- **URL-keyed download dedup** (`browser.rs:1099-1113`) and **"nothing can stop a download"** (`browser.rs:1163-1220`) — `DownloadItem` has identity and `.cancel()`.
- **`Webview::url()` SIGABRT landmine** (`browser.rs:103-111`), **`snapshot.rs` entirely** (→ `capturePage`), **`sck.rs` entirely** (→ loopback), **`stt::unload_ctx` app-side ordering** (becomes the sidecar's own atexit), **tao's unreachable `applicationShouldTerminate` hole** (Electron `before-quit` actually fires — the ⌘Q data-loss bug class dies), **`build.rs`, `gen/`, all `objc2-*`/wry/tao workarounds**.

## 5. Frontend reality check (critic finding)

The "all IPC goes through `api.ts`" premise was **false**: 18 more files import `@tauri-apps/*` — `App.tsx`, `Workspace.tsx`, `updater.ts`, `settings/{AboutSection,useMcpConfig,useModelManagement,AiProvidersSection}`, `workspace/{FeedbackModal,recordingActions,TopBar,effects,workflows/WorkflowDetail,skills/SkillsView}`, `screens/RecoveryModal`, `viewers/{MarkdownView,RecordingView,ImageView}` — using `event.listen`, `getCurrentWindow/Webview`, dialog `confirm/message`, `process exit/relaunch`, updater, opener `openUrl/revealItemInDir`, `app.getVersion`. Plan: preload exposes `arcelle.{invoke,on,dialog,shell,app}`; each of the 18 files is a small mechanical rewire, enumerated in the inventory doc. Also re-home the two **custom URI schemes** registered in Rust (`roommedia:`/`roomdoc:`, `lib.rs:153/173`) as `protocol.handle()` + renderer CSP update.

## 6. Consolidated owner decisions (deduped from the four designs)

**Q1 — Touch ID (designs disagree; a half-day spike decides).** Shell design: call Security.framework via koffi, keep service `"PrivateRoom"` + `biometryCurrentSet` ACL — existing enrollments survive **iff** the re-signed app can read them. DB design: keychain ACLs bind to code signature, assume they don't survive → `promptTouchID()` + `safeStorage` with one-time re-enroll. **Spike:** on a real enrolled Mac, read an existing item from an Electron shell signed the way releases will be signed. Keep koffi path if it works (zero user cost); fall back to re-enroll scheme (specced in Part E) if not. Note `safeStorage` alone has the electron#43233 upgrade-prompt hazard — the fallback uses it only behind an explicit Touch ID gate.

**Q2 — Signing + updater flavor.** Options: (a) Developer ID + notarization + **electron-updater** — TCC grants survive updates natively (the macsign.sh treadmill dies), standard feed; one-time cost: DR change makes migrating users re-grant mic/screen once. (b) Keep minisign + ad-hoc + a **custom updater module** verifying with the existing key (`~/.tauri/private-room.key` — backed up, never regenerate). **Recommendation: (a)**, matching Part E. Either way the bridge is the same: every Electron release also publishes the Tauri-format triplet (`Arcelle.app.tar.gz` + minisign `.sig` + `latest.json`, `COPYFILE_DISABLE=1`) so shipped Tauri installs auto-update INTO the Electron build; keep the triplet ~3 releases (Q10); rehearse on a throwaway repo before cutover; executable name changes `arcelle`→`Arcelle` — hand-test one real old install.

**Q3 — Renderer→sidecar audio WS carries the sidecar token into the renderer** (scoped to WS endpoints). Accept, or force audio through main via MessagePort (adds a hop + backpressure complexity). Recommendation: accept with a WS-only token scope check in `TokenMiddleware`.

**Q4 — Recording spool files hold decrypted PCM on disk between checkpoint ACKs** (0600, unlinked on ACK; today PCM lives in RAM). Accept, or encrypt the spool with a session key. Recommendation: encrypt — it's ~20 lines with Node/Python AES-GCM and removes a real regression vs today's promise.

**Q5 — pymupdf is AGPL.** Fine for a local app distributing unmodified pymupdf? Alternatives: pdfminer.six (MIT, worse layout) or pypdf + Vision-OCR fallback. Needs an explicit owner OK; the plan defaults to pymupdf pending it.

**Q6 — Filter lists:** bundled full EasyList+EasyPrivacy engine (~1.5 MB, built at compile time, never fetched at runtime) vs porting the curated 90-domain table. Recommendation: full lists (Part D).

**Q7 — Legacy `.doc`/`.xls`/`.ods`:** faithful port vs downgrade to QuickLook-preview+OCR only. Recommendation: faithful port (it's small; `olefile` + `xlrd` are mature).

**Q8 — Vendored self-built pywhispercpp Metal wheel** — acceptable under "no compiling in *our* build" (built once, committed)? Recommendation: yes; verify the Metal device log line at sidecar startup.

**Q9 — MAX_TABS=8 keep or raise** (Chromium tabs are cheaper than WKWebViews). **Q10 — triplet releases: 3?** **Q11 — blocked counter in the shield UI** (now real — surface the number?). **Q12 — geometry file:** DIP units mean the old physical-px `window.json` is discarded once (silent default reopen) — acceptable? **Q13 — quit-ask scope:** Electron can now guard Dock-Quit/logout too (tao couldn't) — extend the unsaved-edits ask? Recommendation: yes, it was always a hole. **Q14 — `.roomck` checkpoints stay SQLCipher-4 and restorable, no re-encryption pass** — confirm.

## 7. Config, entitlements, CI — the re-homing ledger (critic sweep)

| Today | Becomes |
|---|---|
| `tauri.conf.json` fileAssociations (.arcelle/.roomai, Editor, document.icns) | electron-builder `fileAssociations` + `open-file`/`second-instance` handlers |
| updater endpoint `releases/latest/download/latest.json` + minisign pubkey | per Q2; bridge triplet during transition |
| CSP naming `roommedia:`/`roomdoc:`/`ipc:` + scheme registration in `lib.rs:153/173` | `protocol.handle()` in main + new renderer CSP |
| window defaults 1180×780 min 900×600 | `BrowserWindow` options (+ geometry module) |
| `bundle.resources`: whisper q5 574 MB, TitaNet ONNX, Silero, sidecar onedir | `extraResources` → `Contents/Resources/{models,sidecar}` — **never** under `Contents/MacOS` (codesign/notary reject non-code there; the PyInstaller `base_library.zip` trap) |
| identifier `com.benreich.privateroom`, productName, min macOS 12 | unchanged (rebrand memory: NEVER rename identifiers) |
| `capabilities/default.json`: `core:window:allow-destroy` (quit-guard close flow), `opener` allowlist `x-apple.systempreferences:*` | `close` event + `preventDefault` + explicit destroy; `shell.openExternal` allowlist |
| `Info.plist`: `NSMicrophoneUsageDescription` (exact wording deliberate), UTI `com.benreich.privateroom.workspace` + `CFBundleDocumentTypes` | `mac.extendInfo` (+ `NSScreenCaptureUsageDescription` for loopback) |
| `Entitlements.plist`: `audio-input` | Electron entitlements: that + `allow-jit` (+ sidecar's own: `disable-library-validation`, `allow-unsigned-executable-memory` — CPython under hardened runtime) |
| `scripts/release.sh` / `preflight.sh` (cargo gate) / `macsign.sh` / `accuracy-tests.sh` (cargo --ignored) | `release.mjs` / preflight w/o cargo / per Q2 / accuracy suites re-homed to pytest `-m bench` |
| `.github/`: ci.yml rust job, audit.yml cargo-audit, dependabot cargo | vitest+pytest+wdio jobs; `npm audit`+`pip-audit`; npm+pip dependabot |
| `package.json` `@tauri-apps/*` deps + `tauri` scripts | electron, electron-builder; delete 5 plugin deps |

## 8. Phased build plan

**Phase 0 — gate spikes (1–2 weeks, all five before any port work):**
S1 `better-sqlite3-multiple-ciphers` opens a real fixture `.room` (+ quote-in-password, rekey, wrong-password classification). S2 Touch ID keychain survival (Q1). S3 pywhispercpp Metal wheel builds; `bench_transcribe_60s` vs Rust numbers. S4 loopback system-audio capture on a real Mac (Electron 39, macOS 15) incl. the TCC prompt path. S5 updater-bridge rehearsal on a throwaway repo. Each has a specced fallback; S1 failing is the only plan-changer (would resurrect the pysqlcipher3 converter — kept as escape hatch).

**Phase 1 — Python lane (~110 d est., the Rust app keeps shipping meanwhile):** Part C checklist order: decode/wav/peaks (pure, first) → STT engine + Metal wheel + mojibake/roundtrip test ports → diar port + **bench parity gate before anything depends on it** → rec engine + WS + spool/ACK → dictation → PyObjC trio → docs extraction. Exit gate: `diar_bench.py` parity (≤1 pt DER per row), STT bench, pytest green, PYZ-decompile verification of the onedir.

**Phase 2 — Electron foundation (~125 d est., overlaps Phase 1 from week 3):** shared contract + preload + registry; rewire `api.ts` + the 18 stray files; window/menu/⌘Q door/geometry/single-instance + ported unit tests; dbHost (open/migrate/recovery/rekey/checkpoints) against the fixture suite; sidecar spawn (port-print handshake) + `/events` fan-out; obs.ts; roomai CLI. Exit gate: open/read/write real rooms; the three shell_exit tests, geometry tests, recovery-format tests green.

**Phase 3 — feature surface (~150 d est.):** turn engine + exec_tool dispatcher; jobs/workflows; MCP via SDK; the 77 feature commands; documents-TS side (formats table, article.ts, viewers' data paths). Exit gate: all 306 channels registered (compile-enforced), vitest ports of the ~176 Rust test blocks that guard invariants, UA checklist agent/jobs/docs sections.

**Phase 4 — browser lane (~35 d est., parallel with Phase 3):** Part D checklist order (guard tables verbatim first, ytdlp.ts port with its 200-line scenario table). Exit gate: guard-parity test (every URL family guard.rs blocks is cancelled as a subresource), wdio capture suite on real pages.

**Phase 5 — packaging + cutover (~3–4 wks):** electron-builder + entitlements + afterPack sidecar signing + notarize; `release.mjs` incl. bridge triplet; CI swap; **cutover release** = last Tauri-format `latest.json` pointing at the Electron payload; keep triplet 3 releases; delete `src-tauri/` in the release after the bridge proves out.

**Freeze discipline:** no feature work in `src-tauri` once Phase 2 starts (the two-sessions-one-repo lesson); the current uncommitted yt-dlp wave ships **before** the freeze.

## 9. Testing & acceptance

- **Behavior ledger = the companion inventory doc**: every per-file *must-preserve* bullet becomes a checklist row; the literal-string couplings (`" *(stopped)*"`, `WRONG_PASSWORD`, `NOTHING_SELECTED`, `SCRIPT_REFUSED` wording, empty-reply notices) get grep-backed drift tests like today's `include_str!` tests.
- **Byte-offset math**: `clamp_bytes`/`excerpt`/`closest_snippet` etc. must be ported with `TextEncoder`, never UTF-16 `.slice` — the Hebrew/emoji corruption class; port the Rust tests first, watch them fail, then port the functions.
- **Parity gates**: diar DER jsonl diff; STT bench; TitaNet-on-onnxruntime revalidated once against Rust tract outputs; fixture `.room` created by the *shipped* Rust app opened by CI forever.
- **After any agent fix wave**: `tsc --noEmit` + a knip/ts-prune dead-export pass — the TS analogue of the `cargo check | grep "never used"` inert-fix lesson.

## 10. Risk register (top 10)

| Risk | Sev | Mitigation |
|---|---|---|
| Diarization DER regression in the numpy port | H | Bench parity gate before dependence; constants bit-identical; CPU EP only |
| Literal-string / event-envelope drift breaking renderer matching | H | Drift tests + the inventory ledger; channel names unchanged |
| Updater bridge strands shipped Tauri installs | H | S5 rehearsal; hand-test a real old install; manual-DMG banner fallback; never drop triplet assets early |
| `webRequest` single-listener silently evicting guard or blocker | H | One funnel by construction + guard-parity test in CI |
| Metal pywhispercpp wheel breaks on whisper.cpp/pywhispercpp bumps | M | Vendored wheel pinned; startup asserts the Metal device log line; rebuild recipe in repo |
| Sync DB stalls (GB `VACUUM INTO`) | M | utilityProcess isolation; drain/rollback sequence ported verbatim |
| Touch ID spike fails → users re-enroll | M | Fallback specced; one-line explainer on first launch |
| TCC re-grant wave on DR change (Q2a) | M | Release-notes comms; one-time cost |
| Renderer-held WS token widens attack surface | M | Q3 scope check; loopback-not-a-boundary doctrine retained everywhere else |
| Chromium/Electron update treadmill (new standing cost) | M | electron-updater automates delivery; pin + monthly bump routine in CI |

Licensing (pymupdf AGPL, Q5) tracked as a decision, not a risk — it blocks Phase 1's docs step only.

---

# Part B — Electron shell, IPC & lifecycle (design agent, verbatim + editor notes)

# Electron Shell Design — Arcelle Rewrite (shell / IPC / lifecycle lane)

## 1. Process architecture

```
electron/
  main/
    index.ts            # lifecycle orchestration only (startup/shutdown sequences below)
    ipc/registry.ts     # typed handler registration; exhaustiveness-checked vs contract
    ipc/proxy.ts        # main→sidecar HTTP proxy (bearer token never leaves main)
    menu.ts             # menu-as-data spec + dispatch + menuSync (port of menu.rs)
    quitDoor.ts         # unsaved-edits quit door (port of shell_exit.rs)
    windowGeometry.ts   # geometry persistence (port of window_geometry.rs)
    pendingOpen.ts      # single-instance + open-file (.roomai association)
    keychain.ts         # Touch ID + Keychain (port of biometrics.rs)
    updater.ts          # in-app updater (see §8)
    obs.ts              # shape-checked host log (port of obs.rs)
    sidecar.ts          # spawn/health/token/port-parse (port of sidecar_lifecycle.rs)
    db/                 # room open/close, better-sqlite3-multiple-ciphers, migration
    browser/            # WebContentsView private browser + @ghostery/adblocker-electron
    dialogs.ts          # native open/save (replaces @tauri-apps/plugin-dialog)
  preload/index.ts      # contextBridge only; ~40 lines, generated from contract
  shared/ipc-contract.ts# THE type seam (see §2)
  shared/events.ts      # event channel names + payload types (AskEnvelope etc.)
cli/roomai.ts           # roomai CLI (see §10)
```

BrowserWindow: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. Renderer loads Vite build (file://) / dev server. Sidecar bearer token (`ARCELLE_SIDECAR_TOKEN`, sidecar_lifecycle.rs:56–74) exists only in main; the renderer never speaks HTTP — loopback-not-a-boundary doctrine preserved.

## 2. Typed IPC replacing 296 invoke() wrappers

**Strategy: shared contract types, no code-gen.** `src/api.ts` is already the single funnel (only file importing `invoke`/`listen`). Keep its exported `api` object shape byte-compatible for callers; rewrite its internals.

- `shared/ipc-contract.ts` declares `interface Commands { create_room: { args: {path: string; password: string; name: string | null}; result: RoomInfo }; ... }` — types imported from the existing `src/apiTypes.ts`, which moves to `shared/`. One entry per current `#[tauri::command]` that stays in main (~120 of 308; the rest become sidecar HTTP endpoints main proxies under the same command names, so the renderer contract is unchanged).
- Preload: `contextBridge.exposeInMainWorld("arcelle", { invoke: (ch, args) => ipcRenderer.invoke("cmd:" + ch, args), on: (ch, cb) => {...returns unsubscribe} })`. Channel strings validated against a frozen allowlist generated from the contract keys — preload rejects unknown channels.
- Main: `registry.ts` exports `defineHandlers(h: { [K in keyof Commands]: (a: Commands[K]["args"]) => Promise<Commands[K]["result"]> })` — a missing or misspelled handler is a **compile error**, mechanizing the same guarantee menu.rs gets from `menu_ids_all_have_a_frontend_handler`.
- `src/api.ts` keeps typed wrappers calling `window.arcelle.invoke("create_room", {...})`; TS infers both sides from the one contract. tsconfig project references share `shared/` between renderer and main builds.

Errors: Tauri commands reject with plain strings; keep that (`throw new Error(msg)` in main → `err.message` in renderer) so the frontend's existing `catch` copy survives.

## 3. Event system

Every `listen()` lives in api.ts (verified; nothing else in src/ uses Tauri events). Channels to carry over verbatim: `room-files-changed`, `file-updated`, `memories-changed`, `workflows-changed`, `skills-changed`, `job-progress`, `rec-partial|segment|segment-drop|relabel|level|state|save-progress|source|error|live-translation|translate-progress|retranscribe|read-done`, `ask-delta|step|lane|plan|agent|step-status|round|report|privacy|token-usage`, `quit-requested`, `menu-action`, `open-room-file`, `agent-open-file`, `agent-annotate`, `browser-blocked|download|journal|searched|navigated`.

Main emits with `mainWindow.webContents.send("evt:" + name, payload)` via one `emit()` helper — the moral successor of `crate::main_window` (menu.rs:18–23): never grab a view by label; the helper holds the one main window. The `AskEnvelope {runId, chatId, v}` wire shape (api.ts:130–155) is unchanged; `askEvent()` keeps unwrapping it. Recording/ask streams originate in the Python sidecar now: main holds one NDJSON long-poll (`GET /events`) per running sidecar and fans lines out to `evt:*` — replacing sidecar.rs's stream-parse-emit.

## 4. Menu + the ⌘Q invariant

Port menu.rs's **menu-as-data** spec: a `const MENU: Section[]` walked by `Menu.buildFromTemplate`, unit-testable without a running app (the exact reason menu.rs is data). Preserved invariants:

- **Edit menu must exist** or ⌘C/⌘V/⌘X/⌘A die app-wide including the password gate (menu.rs:8–16). Electron template includes `role: "editMenu"`; a test asserts the spec declares all four.
- **⌘Q is ours** (menu.rs:62–80, `QUIT_ID = "app.quit"`): the Quit item is a custom item calling `app.quit()` — *not* left to chance — but unlike tao, Electron's `before-quit` fires for menu Quit, Dock Quit, *and* logout, so the door in §5 catches all three (an upgrade over Rust, where Dock/logout bypassed the ask — menu.rs:76–80).
- One event, `menu-action`, carrying the row id (menu.rs:42); renderer's `useNativeMenu` map unchanged.
- `menuSync(view: ViewMenuState)` command sets `checked`/`enabled` per row (menu.rs:587): Electron menus rebuild cheaply — rebuild from spec + state, `Menu.setApplicationMenu`.
- `CLOSE_ID` stays never-gated; with no room open, main closes the window itself (menu.rs:452–473 dispatch fallback).

## 5. Quit door (shell_exit.rs port)

`quitDoor.ts` keeps the exact semantics of shell_exit.rs:20–82:

- `set_unsaved_edits(on)` command → `unsavedEdits` flag; clearing re-arms `quitHeld`.
- `before-quit`: `if (unsavedEdits && !quitHeld) { quitHeld = true; e.preventDefault(); emit("quit-requested"); }` — held **once**; second ⌘Q quits (fail-open, shell_exit.rs:26–31).
- Renderer answers: proceed → `confirm_quit` command → `app.quit()` (passes because latch set); Cancel → `quit_guard_rearm` command clears the latch (Cancel = "not this time", shell_exit.rs:46–58).
- Port the three shell_exit tests as vitest units on the pure `holdQuit(unsaved, alreadyHeld)` function.

Window-close guard: `mainWindow.on("close", e)` → preventDefault + forward to the renderer guard Workspace.tsx already implements via `onCloseRequested`.

## 6. Shutdown sequence (`will-quit`)

Electron `will-quit` handlers can't await, and teardown here is async (sidecar flush). Pattern: `will-quit` → `e.preventDefault()` once → run ordered async teardown → `app.exit(0)`. Order ports lib.rs:615–645:

1. `saveGeometry()` — first, best-effort, must never fail a quit (window_geometry.rs:107–117).
2. Flush live recording via sidecar `POST /rec/flush` and **wait** (lib.rs:104: teardown is deliberately blocking; ADD-27: the un-checkpointed tail is only durable after the final flush). Whisper/ggml teardown ordering (stt::unload_ctx) becomes the sidecar's own atexit problem — one trap deleted.
3. Stop Ollama if ours; stop sidecar if ours (ADD-29/33).
4. Wipe decrypted browser previews; destroy private-browser `WebContentsView` + its non-persistent partition (BROWSE-1: quit is what discards session cookies).
5. Remove Leash discovery file.

Hard timeout (5 s) then `app.exit(0)` — teardown must never wedge a quit.

## 7. Window geometry

Port window_geometry.rs verbatim into `windowGeometry.ts`: throttled note on `move`/`resize` skipping fullscreen (rs:92–105), write-on-quit only, and `geometryIsUsable` with MIN 900×600, `GRABBABLE = 80` title-bar overlap, no-screens = unusable (rs:63–82) validated against `screen.getAllDisplays()` (`bounds` are DIP, not physical px — one deliberate unit change; store DIP, discard the old physical-px `window.json` by schema-versioning the file). Apply geometry in the `BrowserWindow` constructor (`show: false` → `ready-to-show`), which beats Tauri's post-hoc set_size/set_position (no flash). Keep the three unplugged-monitor tests (rs:160–198).

## 8. Single instance + file association + updater

- `app.requestSingleInstanceLock()` first line of main; loser exits. `second-instance` + macOS `open-file` (fires pre-ready — buffer it) both funnel into `pendingOpen.ts`: store path, `emit("open-room-file", path)` — port of lib.rs:647–660 + `take_pending_open` read-and-clear (rooms.rs:688). electron-builder `fileAssociations` for `.roomai` (keep the UTI; rebrand memory says never rename identifiers).
- **Updater — recommendation: keep the minisign updater, custom module.** electron-updater on macOS *requires* Developer ID signing (Squirrel.Mac validates signatures); the app today is ad-hoc signed (macsign.sh) with a minisign key (`~/.tauri/private-room.key`) and a `latest.json` feed (tauri.conf.json:58–63). `updater.ts`: fetch `latest.json` (same format, same endpoint), verify the `.app.tar.gz` with the **existing minisign pubkey** via `libsodium-wrappers` (Ed25519ph + Blake2b), swap the .app, re-run macsign.sh logic (re-sign resets TCC — known), relaunch. Migration is then free: the *last Tauri release* ships an updater payload that is the Electron app, signed with the same minisign key — installed users cross over automatically. Replaces `@tauri-apps/plugin-updater` + `plugin-process` (`relaunch` → `app.relaunch(); app.exit()`) in updater.ts/AboutSection.tsx.

## 9. Touch ID + Keychain

> **Reconciliation note (editor):** this section and the DB/packaging design (§C below) disagree on whether existing Keychain enrollments survive the re-signed app. Resolved in main plan §6 — a half-day spike decides; both paths are specced.

Keep the exact security semantics of biometrics.rs — service `"PrivateRoom"`, account = room path, `biometryCurrentSet` ACL in the data-protection keychain, this-device-only (rs:113–133) — by calling Security.framework directly from main via **koffi** (^2.x, prebuilt FFI, allowed-dependency class): `SecAccessControlCreateWithFlags`, `SecItemAdd/CopyMatching/Delete` with `kSecUseDataProtectionKeychain`. Because bundle id + signing stay the same, **existing enrollments keep working with zero migration**, and the read itself raises the biometric prompt (rs:135–143) — `systemPreferences.promptTouchID` is *not* used for unlock (an LAContext prompt gates nothing; the Keychain ACL is the guard). `has()` keeps the no-prompt attributes-only probe (rs:72–111). Port `message_for` verbatim: every unavailable-path message must name the password (rs:204–217 test). **Do not use safeStorage for room secrets**: electron#43233 — after an update/re-sign, macOS shows a raw "wants to access Safe Storage" keychain prompt; also it's app-keyed, not biometry-gated.

## 10. Observability log + roomai CLI

- `obs.ts`: same doctrine — no function accepts an arbitrary string (obs.rs:16–43). `Val` = branded opaque type; constructors `id/ids/model/state/oneOf/count/bytes/ms/flag/errKind` with the same charsets, `<unloggable>`/`<unexpected>`, 4 MB + one rotated generation, `ARCELLE_LOG` filter, `reveal_logs` command. `state()` takes a literal-narrowed type to approximate `&'static str`.
- `roomai`: a **Node CLI sharing the app's exact DB module** (roomai.rs:3–6 doctrine: no second decryption code path). `cli/roomai.ts` bundled into the app; a `roomai` shim script execs the bundled Electron binary with `ELECTRON_RUN_AS_NODE=1`. Secrets **env-only** (`ROOMAI_PASSWORD`/`ROOMAI_RECOVERY`; argv is world-readable — roomai.rs:8–15); exit codes 0/1/2; subcommands verify/info/recover/export unchanged. It also hosts the one-time `.room` converter (old SQLCipher → new cipher), reading legacy files via `better-sqlite3-multiple-ciphers`' sqlcipher-compat mode.

## 11. Startup sequence

1. Single-instance lock → 2. `obs.init(version)` → 3. read+validate geometry → 4. register **all** IPC handlers (compile-checked complete) → 5. create window (`show:false`, geometry applied) + build menu → 6. load renderer → 7. `ready-to-show` → show → 8. restore connector powers from per-Mac files (defaults OFF, lib.rs:572–592), sweep orphaned script workspaces, publish PATH prefix → 9. sidecar stays **spawn-on-demand** (port learned from its printed `SIDECAR_PORT=N` line, never bind-and-race — sidecar_lifecycle.rs:283–333; bundled PyInstaller onedir ignores the env var and *prints* its port).

## 12. Build checklist (ordered)

1. `shared/` contract + events; move `apiTypes.ts`; preload + registry skeleton; rewire api.ts (no behavior).
2. Window/menu/quit-door/geometry/pendingOpen + their ported unit tests.
3. DB module (better-sqlite3-multiple-ciphers) + open/close/room commands; converter; roomai CLI.
4. Sidecar spawn/token/proxy + `/events` fan-out; migrate command bodies (main vs sidecar split per command).
5. keychain.ts (koffi) + Touch ID flow against a real enrolled item.
6. obs.ts; dialogs; browser/ (WebContentsView + adblocker).
7. updater.ts + bridge release rehearsal on a throwaway repo.
8. electron-builder packaging (onedir sidecar in Resources, fileAssociations, macsign.sh port); e2e harness swap (wdio → Playwright-for-Electron).

## 13. Open questions for the owner

1. **Updater**: accept the custom minisign updater (keeps ad-hoc signing + existing key), or buy a Developer ID cert and adopt electron-updater/Squirrel (also fixes TCC resets)?
2. **Quit-ask scope**: Electron can now guard Dock-Quit and logout too (tao couldn't — menu.rs:76–80). Extend the unsaved-edits ask to them, or keep old behavior?
3. **DB cipher**: stay SQLCipher-compatible (zero-migration open of existing `.room`) vs new cipher + converter? Affects roomai and the converter's existence.
4. **Geometry file**: silently discard old physical-px `window.json` (one-time default reopen) — acceptable?
5. **koffi FFI for Keychain**: approved as an allowed prebuilt native module, or fall back to `@napi-rs/keyring` + `promptTouchID` (loses hardware biometry-gating + requires re-enrollment)?

---

# Part C — Python sidecar expansion: audio / vision / docs (design agent, verbatim)

# Sidecar expansion design — audio / vision / docs (Arcelle rewrite)

## 1. Module layout

```
sidecar/arcelle_sidecar/
  server.py                # existing FastAPI app; gains WS routes + new POST routes
  media/
    __init__.py
    decode.py              # bytes/file -> mono f32@16k (avconvert/afconvert subprocess, WAV parse)
    peaks.py               # numpy envelope port of commands/peaks.rs
    probe.py               # PyObjC AVFoundation probe + last-frame grab (media_probe.rs)
    quicklook.py           # PyObjC QLThumbnailGenerator (quicklook.rs)
    ocr.py                 # PyObjC Vision OCR; pymupdf page rasterizer (ocr.rs)
  stt/
    engine.py              # warm-context lifecycle, transcribe/transcribe_segments (stt.rs)
    models.py              # model download/verify/delete, progress events
    hallucination.py       # is_junk_segment / is_stock_hallucination tables (stt.rs:366-465)
    dictation.py           # dict session worker (stt_cmds.rs dict_*)
  rec/
    engine.py              # the live engine: msg loop, lanes, VAD, checkpoint logic (recording.rs)
    lanes.py               # Lane, LaneState, LaneLang sticky-language votes (recording.rs:1043)
    vad.py                 # Silero v5 via onnxruntime; energy fallback
    meta.py                # RecMeta/RecSegment/cuts/splice/format_stamp (pure-data port + tests)
    wav.py                 # encode_wav/decode_wav/resample_to_16k (recording.rs:506-628)
    retranscribe.py        # offline pass incl. sub-window split (recording.rs:1406)
    session_ws.py          # WebSocket protocol handler (below)
  diar/
    embed.py               # DSP print + TitaNet ONNX print, gates, pitch dims (diarize.rs:425-676)
    cluster.py             # otsu/eigen_count/cluster_gated/SpeakerBook (diarize.rs:737-1256)
    recognize.py           # KnownVoice, identity_print, recognize_groups, veto (diarize.rs:283-423)
    windows.py             # window_prints sub-window recipe (diarize.rs:1664, SPLIT_* consts)
  docs/
    pdf.py                 # pymupdf text + pdf_quality gate port
    office.py              # docx/pptx/xlsx via python-docx/python-pptx/openpyxl
    legacy.py              # .xls/.ods via xlrd/odfpy; .doc via olefile (port of extraction/legacy.rs cfb walk)
tests/bench/diar_bench.py  # acceptance gate port of tests/diar_bench.rs
```

TS side (Electron main): `formats.ts` (pure classify table from `formats.rs:94-193`), `article.ts` (Readability), `recBridge.ts` (session broker: DB writes, WS client for events).

## 2. Transport: one WebSocket per audio session

Chunked HTTP is wrong (no server→client push for partials); file handoff is wrong for live audio (latency + fsync churn). **WebSocket on the existing FastAPI/starlette server**, token-authed by the same `TokenMiddleware` (server.py:211) via `?token=` query param.

- `WS /rec/session` and `WS /dict/session`. **Renderer connects directly** (mic via `getUserMedia` AudioWorklet, system audio via Electron ≥39 `getDisplayMedia` loopback — both lanes now originate in the renderer; sck.rs is deleted). No base64, no double hop through main.
- **Binary frames** (client→server): 12-byte header `{u8 lane (0=mic,1=sys), u8 pad, u16 seq, u32 rate, u32 n}` + `n` little-endian f32 samples. ~250 ms cadence per lane, matching today's wire shape (`rec_push_audio`, recording_cmds.rs:307). Sidecar resamples to 16 k (`resample_to_16k`, recording.rs:603).
- **Text frames** (server→client JSON events): `partial`, `final`, `level`, `source-health` (the `mic_failure_message` state machine, recording.rs:701 — but the *renderer* now also reports loopback-track `ended`), `lang-locked`, `save-status`, `stopped`. Replaces Tauri events.
- **Control** stays on POST (`/rec/start`, `/rec/pause`, `/rec/resume`, `/rec/set_live_stt`, `/rec/set_live_translate`, `/rec/edit_meta`, `/rec/stop`) called from Electron main — preserving the `EditMeta`-through-the-engine invariant (recording.rs:1190: nothing edits a live recording's meta except via the engine thread, or the periodic flush erases it).

**DB seam (split rule: Electron owns the .room file).** The engine no longer writes the room. It spools: raw-PCM checkpoint appends to an owner-only (0600) session spool file, then emits `save` on a *second* WS (`WS /rec/host`, connected by Electron main at start): `{kind:"checkpoint"|"full"|"transcript", spool, from_sample, to_sample, meta}`. Main writes into the DB and ACKs `{ok}`; the engine advances `flushed_samples` **only on ACK**, retrying on the `FLUSH_RETRY_BACKOFF` 5 s cadence (recording.rs:650). Preserved verbatim: `checkpoint_mark` (recording.rs:671) — checkpoints advance to the *lower lane write-floor*, not the head, with `LANE_RESYNC_GAP` (recording.rs:96) as the dead-lane escape; `Save::Transcript` exists so the pause follow-up never re-encodes the whole WAV (recording.rs:630-645). Crash story: spool + last ACKed meta let main recover exactly what today's checkpoint recovery does.

## 3. Recording engine port (rec/engine.py)

One Python thread per session (max one session, as today — `RecState` single slot), `queue.Queue` mailbox mirroring `EngineMsg` (recording.rs:1173). One dedicated **decode thread** owning the whisper context, fed by a job queue — mirrors the single decoder lane (recording.rs:1560: "one thread, one Whisper call at a time, results sent back so the engine stays the single owner of ordering"). Finals get embeddings + `window_prints`; partials never pay for the detector (`LangMode` mapping, recording.rs:1571). Port constants unchanged: FRAME 512, VAD_OPEN 0.35/VAD_SUSTAIN 0.20, PREROLL 0.5 s, MAX_SEGMENT 28 s, PARTIAL_EVERY 1.5 s, FLUSH_EVERY_SEGMENTS 8, RELABEL time-budget adaptivity (recording.rs:73), MAX_SESSION_SAMPLES 3 h, ECHO_* mic/sys dedupe. VAD: Silero **v5 ONNX via onnxruntime** (512-sample frames match FRAME) instead of whisper.cpp's ggml Silero — same model family, same thresholds, keeps VAD independent of pywhispercpp's API surface; energy fallback when the model file is missing (recording.rs:753 fallback rule). Mic watchdog (`last_mic_push`, recording.rs:1680) stays server-side: WS frames are the pushes.

Dictation (`stt/dictation.py`): same WS binary protocol, `stop` control message; final whole-utterance decode with the scaled timeout **enforced by the caller** — Electron main ports `dict_stop_timeout` = 120 s + 2 s/audio-s (stt_cmds.rs:575-583); frontend still awaits its last push before stop (stt_cmds.rs:585 ordering contract).

## 4. STT lifecycle (stt/engine.py)

pywhispercpp (≥1.3, whisper.cpp ≥1.7 with VAD-era API) `Model` wrapped in the warm-context pattern of stt.rs:186: module-level `(model_path, Model)` under a `threading.Lock`; loading a different path replaces it. Preserve:
- **`unload_ctx` before exit** (stt.rs:208): with Metal, ggml *asserts in `ggml_metal_device_free` during teardown* if GPU buffers are resident. `POST /shutdown` (new) → `lock.acquire(blocking=False)`; on success `del model` + force `whisper_free` (pywhispercpp `__del__`), then `os._exit(0)` after the response flushes. Non-blocking on purpose — a decode in flight keeps the rare abort-at-exit, exactly today's confined race. Also an `atexit` best-effort.
- **`unload_model(path)` semantics** (stt.rs:224): "False = come back later" when a decode holds the model; never silently leak the weights for the session.
- Hallucination filters and token→word UTF-8 reassembly (`merge_token_words`, stt.rs:467 — bytes split across tokens; the Hebrew mojibake tests port to pytest).
- Model registry: `ggml-large-v3-turbo-q5_0.bin` 574 MB (stt.rs:24-27), Silero, `nemo_en_titanet_small.onnx`; downloads move into the sidecar (`stt/models.py`, SSE progress), Electron passes the models dir at spawn. **No translate task** on the turbo model (stt.rs:252 — distilled model silently emits near-source text).

## 5. Diarization + acceptance bench

Faithful numpy port, constants bit-identical: WIN 512/HOP 256, BANDS 20 mel bands, pitch dims (F0_CLAMP 70–320, PITCH_WEIGHT 0.6), DSP_GATES vs NEURAL_GATES, EMB_WIN 2 s/EMB_HOP 1 s, KNOWN_SAME **0.72** + KNOWN_MARGIN 0.04 with the veto (diarize.rs:383), `recognized` keyed by **name** not label, enrolled-during-session voices excluded from `known` (recording.rs:1280 rationale), sub-window split SPLIT_WIN_CS 150/HOP 75, AUTO_MAX_SPEAKERS 8, eigen/otsu count estimation. TitaNet via onnxruntime **CPU EP** (model is tiny; CoreML EP is an experiment, not the plan).

**Bench is the gate.** `tests/bench/diar_bench.py` ports tests/diar_bench.rs exactly: reads `PR_BENCH_MANIFEST` (sid\twav\trttm), rewrites `PR_BENCH_RESULTS` jsonl, per-row DER ceiling `PR_BENCH_MAX_DER` (default 30), `PR_BENCH_ALLOW_SPEAKER_DRIFT`; scorer = 10 ms sampled DER, ±0.25 s collar, best 1:1 mapping (diar_bench.rs:57-63); pipeline under test = the Python `retranscribe()` (the shipping offline path, incl. split pass). Run: `uv run pytest -m bench tests/bench/diar_bench.py` against `~/diarization-lab` manifests. **Acceptance = parity**: run the Rust bench once more at cutover, diff the two jsonl files row-by-row; any DER regression > 1 pt absolute on any row fails the port.

## 6. Vision / QuickLook / probe / peaks

- **OCR** (`media/ocr.py`): PyObjC `VNRecognizeTextRequest` directly (not ocrmac — we need the accurate level, `["en","he"]`, and data-backed handlers). Images: `VNImageRequestHandler` initWithData (no temp file). PDFs: rasterize pages with **pymupdf** (replacing the CGPDF raster in ocr.rs:146), cap raster size (port `page_raster_size`, ocr.rs:101) and keep the honest `unread_notes` partial-coverage sentences (ocr.rs:187). Candidates rule unchanged (ocr.rs:14). Best-effort: every failure → `None`.
- **QuickLook** (`media/quicklook.py`): `QLThumbnailGenerator` completion **blocks** work in PyObjC (the pyobjc #647 trap is SCK stream delegates, which we never touch — system audio is Electron's). Preserve quicklook.rs invariants: owner-only temp copy, unique name for extensionless files, O_EXCL no-overwrite, removed on *every* exit path, 20 s timeout, PREVIEW_EDGE 1400.
- **Probe** (`media/probe.py`): PyObjC AVFoundation. Every field independently optional; empty probe → `None` not zeros (media_probe.rs:11-15). Display size = naturalSize × preferredTransform. Duration from the **asset**, not a track. Last-frame grab: anchor to the **video track's** `timeRange` end, not asset duration (media_probe.rs:230 — AAC priming makes audio outrun video ~76 ms and zero-tolerance requests in the gap fail "Cannot Open"); end − 1/30 s, timescale 600, zero tolerance then retry with default (keyframe drift note at media_probe.rs:262).
- **Peaks** (`media/peaks.py`): numpy max-abs envelope, 2000 default/8000 max buckets, NOISE_FLOOR 0.01 silent flag, cache keyed `(id, buckets, size)` LRU 24 — cache lives in the sidecar now (it owns the decode). Decode via `media/decode.py`: keep shelling to `avconvert`/`afconvert` (system binaries, nothing bundled — same bargain as stt.rs:61), decrypted bytes through 0600 temp files removed on every path (media_probe.rs privacy note).

## 7. Document extraction split

- **Readability: TS side, `@mozilla/readability` + `linkedom`, in Electron main.** Justification: `dom_smoothie` is an explicit clone of Mozilla's scorer (extraction/article.rs:8), so the reference implementation is the *zero-drift* replacement; article extraction serves the browser reading view whose DOM/session plumbing lives entirely in Electron; trafilatura uses a different scoring family — output would visibly change, and the reading-view behavior was hand-tuned (browser-audit memory). Python gets no HTML article path.
- Python (`docs/`): PDF text via **pymupdf ≥1.24** (AGPL — see open questions) with the `pdf_quality` garbled-text gate ported; docx/pptx/xlsx via python-docx/python-pptx/openpyxl (replacing the hand-rolled XML walks — port the *tests*, not the parsers); legacy `.xls`/`.ods` via xlrd/odfpy (calamine's role); legacy `.doc` via **olefile** + a port of the compound-file text walk (extraction/legacy.rs:311). `formats.rs` classify table + `MAX_RAW_TEXT_BYTES` stays TS (it gates viewers, pure data).

## 8. Process & concurrency model

One sidecar **process**, threads not subprocesses (PyInstaller-frozen `multiprocessing` needs re-exec games; threads share the warm models). Lanes: (a) asyncio event loop — HTTP/WS only, never decodes; (b) **one whisper decode thread** — recording finals/partials, dictation, file transcription, retranscribe all funnel through its queue (today they contend on the CTX mutex, stt.rs:186 — the queue is the same serialization made explicit); (c) one engine thread per live session; (d) a small `ThreadPoolExecutor(4)` for OCR/QuickLook/probe/peaks/extraction (independent of models). `worker_parallel=1` (graph.py:325) governs the **Ollama** lane and is untouched — STT/diar/TTS never touch Ollama (personalization-session memory). pywhispercpp releases the GIL during `whisper_full`, onnxruntime during `Run`, so the loop stays live.

## 9. PyInstaller onedir

- **pywhispercpp must be a Metal build.** PyPI wheels are CPU-only: build once with `GGML_METAL=1` + `GGML_METAL_EMBED_LIBRARY=1` (embeds the .metallib in the dylib — otherwise `default.metallib`/`ggml-metal.metal` must ship as PyInstaller datas next to the binary and `GGML_METAL_PATH_RESOURCES` must point at it). Vendor the wheel in-repo; verify at startup by asserting the Metal device log line.
- onnxruntime: `collect_dynamic_libs("onnxruntime")` hook (stock hook exists); pin `onnxruntime>=1.20`.
- PyObjC: add `pyobjc-framework-{Vision,Quartz,AVFoundation,CoreMedia,QuickLookThumbnailing}`; PyInstaller hooks exist but **verify by decompiling the bundle PYZ, not by grep** (local-rebuild memory).
- Keep onedir facts: binary two levels deep, ignores `SIDECAR_PORT`, **prints its port** (release memory) — port print stays the contract; `--clean` on rebuild.
- Models are *not* bundled (574 MB): downloaded to app-support/models, path handed to the sidecar at spawn.

## 10. Startup / shutdown

Start: Electron spawns onedir binary → reads printed port → `GET /health` → `POST /configure {models_dir, spool_dir, token}`. Whisper/TitaNet load lazily on first use (today's behavior).
Shutdown (ordered, before Electron `app.quit` proceeds): (1) `POST /rec/stop` if live, await `save-status` full (this is the old ⌘Q door — the QA-report lesson: Quit must not skip it); (2) `POST /shutdown` → non-blocking model unload → sidecar exits; (3) 5 s watchdog then SIGKILL. Never SIGKILL first: that's the ggml Metal abort with a live context.

## 11. Ordered build checklist

1. `media/decode.py` + `wav.py` + `peaks.py` + pytest ports of peaks/wav tests (pure, no PyObjC) — first because everything downstream consumes PCM.
2. `stt/engine.py` + Metal pywhispercpp wheel + `e2e_say_roundtrip`/mojibake test ports; measure `bench_transcribe_60s` vs Rust.
3. `diar/` port + `diar_bench.py`; **parity gate vs Rust jsonl before anything depends on it**.
4. `rec/engine.py` + WS protocol + spool/ACK save path; wire renderer worklets + loopback lane.
5. `stt/dictation.py`.
6. PyObjC trio (`ocr.py`, `quicklook.py`, `probe.py`) — independent, parallelizable.
7. `docs/` extraction + formats.ts + article.ts.
8. PyInstaller spec updates; PYZ-decompile verification; full onedir smoke on a clean user account.
9. Delete Rust modules; run UA checklist recording/dictation/import sections.

## 12. Open questions for the owner

1. **pymupdf is AGPL.** Fine for a proprietary local app that doesn't distribute pymupdf modifications? Alternative: pdfminer.six (MIT, slower, worse layout) or keep pypdf for text + Vision OCR fallback.
2. Vendored self-built pywhispercpp Metal wheel — acceptable under the "no compiling at app build" rule (built once, committed), or must we find/publish prebuilt Metal wheels?
3. Spool files hold **decrypted audio** on disk between checkpoints (0600, unlinked on ACK). Today's engine holds PCM in RAM and writes only into the room. Accept the temp-file exposure window, or require the spool to be encrypted with a session key?
4. Renderer→sidecar direct WS bypasses Electron main for audio. Accept the renderer holding the sidecar token (scoped: WS endpoints only), or must audio hop through main via `MessagePort`?
5. Legacy `.doc`/`.xls`/`.ods` usage is unknown — port faithfully, or downgrade to "QuickLook preview + OCR, no text extraction" and cut `docs/legacy.py`?

---

# Part D — Private browser + web layer on Electron (design agent, verbatim)

# Private Browser + Web Layer on Electron — Design

## 0. What dies with WKWebView (verified against current code)

- **The blocker race & `START_BLANK` parking** (`browser.rs:657-743`, `deferred_since`/`awaits_blocker`/`ThenGo` machinery, `browser.rs:1636-1916`): existed only because WKContentRuleList attaches *per webview, after creation, asynchronously*. In Electron the blocker attaches to the **session before any view exists**, synchronously. Whole subsystem deleted — no deferral, no `DEFER_GRACE`, no parked-blank navigation replay.
- **Silent whole-list rule rejection** (`rules.rs:123-145`, WKErrorDomain 6): `@ghostery/adblocker` parses per-rule, skips bad rules, and `enableBlockingInSession` throws on real failure. `Protection` collapses to `Active | Failed{reason} | Unavailable` set once at session build.
- **The eval bridge's ticket protocol** (`browser.rs:1548-1624`, `page.js` `begin`/`take`): `webContents.executeJavaScriptInIsolatedWorld()` awaits promises and rejects on throw. Async ops return promises; `EVAL_LOST` becomes the "frame was disposed / script killed" rejection, still mapped to *Loading, not failure* (preserve `browser.rs:222-240` and `readiness_from_probe_error` semantics, `browser.rs:1483-1485`).
- **iframe navigation pollution + self-heal** (`browser.rs:700-778` `believable_for`/`same_site`, `record_active_url` at `browser.rs:521-526`): Electron's `did-navigate`/`did-navigate-in-page` fire **main-frame only**; `will-frame-navigate`/`did-frame-navigate` carry `isMainFrame`. The record is written from main-frame events; the poll-based self-heal and the same-site heuristic are deleted.
- **The `<200px` reading refusal** (`reader.rs:42-64`): the fragment-read failure came from `page.js` viewport-visibility heuristics at a 1×1 layout. Readability (`@mozilla/readability`) scores a **DOM clone, no layout dependency**; and parked tabs are `removeChildView`'d, never 1×1. Extraction works at any bounds. Keep a size gate only for `capturePage` ("too small to see").
- **`watch_download_size` can't cancel** (`browser.rs:1163-1220` "Nothing here can stop a download"): `DownloadItem.cancel()` can. Rewrite the message — do not copy the old sentence.
- **URL-keyed download dedup** (`browser.rs:1099-1113`): existed because macOS `Finished` carried only the URL. `DownloadItem` has identity; dedup dropped, staging keeps the `{uuid}-{name}` prefix (`browser.rs:1093`, load-bearing for import).
- **`Webview::url()` SIGABRT landmine** (`browser.rs:103-111`): `webContents.getURL()` is safe; still keep main's own `url` record as the display authority during loads (the `browser_info` fallback logic, `browse.rs:1057-1068`).

## 1. Module layout (Electron main, TS)

```
src-main/
  browser/manager.ts     tabs Map<id,WebContentsView>, active, bounds, MAX_TABS=8 refusal
                         (browser.rs:65-71), heir rule (browser.rs:572-579, shared const w/ TabStrip),
                         takeover flag, sitting-id mint/clear (browser.rs:309-331, 835-837)
  browser/session.ts     session.fromPartition(`browse-${sittingId}`) (NO persist: ⇒ in-memory),
                         one webRequest funnel, protection state, per-tab blocked counters,
                         verifyEphemeral ⇒ assert ses.storagePath===null && !ses.isPersistent()
                         (honest-check doctrine of browser.rs:1918-1972)
  browser/blocker.ts     ElectronBlocker.deserialize(bundled engine.bin built from EasyList+
                         EasyPrivacy at build time — never fetched at runtime, rules.rs:10-15 doctrine)
  browser/guard.ts       TS port of guard.rs: isPublicIp (all ranges incl. CGNAT 100.64/10,
                         v4-mapped v6, trailing-dot root label guard.rs:44-59), checkPublicHttpUrl,
                         resolvePublicAddr (dns.lookup {all:true}, every addr public),
                         hostResolvesPrivate ("couldn't find out" ≠ "yes", guard.rs:84-102)
  browser/navigation.ts  will-navigate/will-frame-navigate guard + app-link schemes
                         (mailto:/tel:/… quiet "open" journal, NOT "blocked" — browser.rs:921-946),
                         did-navigate → record url+drop title (browser.rs:536-545),
                         page-title-updated → record title, async DNS recheck + webContents.stop()
                         (second-layer semantics of browser.rs:1003-1040),
                         setWindowOpenHandler: deny + guarded loadURL in place (replaces
                         NO_POPUPS_JS browser.rs:139-199; bare window.open() ⇒ url:"", deny, return null)
  browser/bridge.ts      executeJavaScriptInIsolatedWorld(WORLD_ID=1004) wrapper; op dispatch;
                         rejection→Loading mapping; SCRIPT_REFUSED wording kept verbatim
                         (browser.rs:1405-1407 — "do not invite retry")
  browser/extract.ts     Readability on cloneNode(document) in isolated world; reading view
                         (browser_page_text contract reader.rs:92-106), selection capture with
                         NOTHING_SELECTED → empty answer (reader.rs:113-165), SELECTION_MAX=40000
                         shared with preload READ_MAX (reader.rs:281-285 drift test → ts test)
  browser/downloads.ts   will-download: guard already ran in webRequest; setSavePath(staging)
                         SYNCHRONOUSLY (else Electron opens a save dialog); 'updated' →
                         cancel when received/total > MAX_DOWNLOAD_BYTES; import funnel; journal
  browser/ytdlp.ts       port of ytdlp.rs (see §4)
  browser/search.ts      browser_search → sidecar POST /web_search (sidecar owns the 7 engines
                         already — web/search.rs:3-6); DB cache shared with agent web_search
                         (browse/search.rs:104-131); journal "search" only when !cached
                         (browse/search.rs:135-137); preview enrich via web/fetch.ts, bytes → data URLs
                         (renderer never fetches — browse/search.rs:20-22)
  browser/journal.ts     insert_browse_journal port; emit 'browser-journal'; room-closed = silent no-op
                         (browser.rs:1277-1291)
  web/fetch.ts           undici ^7: guardedGet (maxRedirections:0, manual hop loop, per-hop
                         literal check + resolve + Agent{connect:{lookup: pinned}} — fetch.rs:79-167),
                         fetchPage/fetchReadable/fetchPreview/fetchImage/downloadToTemp, caps
                         (MAX_FETCH_BYTES 8MiB, MAX_DOWNLOAD_BYTES=900MiB fetch.rs:262-267 —
                         owner raised from 800 on 2026-08-22; SQLite ~953MB blob ceiling reasoning),
                         charset via TextDecoder(label) from Content-Type (windows-1255 vector
                         fetch.rs:607-615), disposition_file_name, safe_file_name (80 chars, fetch.rs:294-305)
src-preload/browse.ts    page script (port of page.js): marks/registry, read, act, settle,
                         capture, find, annotate; contextIsolation:true, sandbox:true,
                         nodeIntegrationInSubFrames:true (preload in ALL frames);
                         push channels replace latches: 'browse:leave' (double-Escape chord,
                         LEAVE_CHORD_MS=700 kept), 'browse:selection' (debounced selectionchange)
```

Renderer: `src/api.ts` browser block (`api.ts:368-447`) rewired to `contextBridge`-exposed `invoke(channel, args)`; **channel names = current command names** (`browser_navigate`, `browser_info`, …) so `apiTypes.ts` and views stay untouched. Events (`browser-journal`, `browser-blocked`, `browser-download`, `browser-download-oversize`, `ytdlp-progress`) become `webContents.send` with same payload shapes.

## 2. The one webRequest funnel (critical trap)

`session.webRequest.onBeforeRequest` supports **exactly one listener — last registration silently wins**. Ghostery's `enableBlockingInSession()` registers its own; adding our private-network guard after it would silently disable ad-blocking (the Electron twin of the WKContentRuleList silent-total-failure, `rules.rs:127-135`). So: **do not call `enableBlockingInSession`**. Register one handler:

1. `checkPublicHttpUrl(details.url)` literal check — main_frame AND every subresource (closes the `<img src="http://localhost:11434/...">` hole `rules.rs:16-22` at the same layer). Cancel ⇒ journal `blocked` + `browser-blocked` (main-frame only, per `browser.rs:948-961` — subresource blocks count silently).
2. `blocker.match(fromElectronDetails(details))` ⇒ cancel/redirect per verdict; increment `blockedCount[tabId]`.
3. Wire `blocker.enableBlockingInSession`'s *other* halves manually: `onHeadersReceived` CSP injection and cosmetic-filter preload the package exposes.

`blockedCount` rides `browser_info` — a **real per-page counter at last** (the audit-wave mockups' "12 blocked" was fiction; this one counts actual cancellations).

DNS-rebinding posture unchanged: webRequest sees address *text* pre-resolution, so keep the two layers — literal check inline, async resolve-and-halt for main-frame names only (IP literals skip, brackets stripped — `browser.rs:978-991`).

## 3. Tabs, info, lifecycle

- **Create**: `new WebContentsView({webPreferences:{partition, preload, contextIsolation:true, sandbox:true, nodeIntegrationInSubFrames:true}})`; `win.contentView.addChildView(view)`; `loadURL(url)` directly — no blank-park. Refuse the 9th tab with the exact wording (`browser.rs:445-448`).
- **Park** = `removeChildView` (state survives; no 1×1 hack, no float-over-workspace bounds juggling `browser.rs:584-595`). Show = `addChildView` + `setBounds(bounds)`. Note: background views throttle timers — acceptable; call `setBackgroundThrottling(false)` only while an agent op is driving a background page.
- **browser_info**: assembled in main from event-driven state (url record, title, ready from `did-start/stop-loading`, protection, session, takeover, `blockedCount`, `hasSelection`/`leaveRequested` from preload pushes). No eval round trip; the 1200ms poll can stay in the renderer or become an event subscription. Preserve: record-url fallback while loading (`browse.rs:1057-1068`), `error` field only-when-present (`browse.rs:1097-1103`), mid-navigation ⇒ `ready:false` + no error (`browse.rs:1107-1136`).
- **Close/quit**: for each tab `view.webContents.close()`; `ses.clearStorageData()` + `clearCache()` (belt-and-braces on an in-memory partition); wipe staging dir; clear takeover/sitting (`browser.rs:854-868`). Electron's `before-quit` fires for ⌘Q (the tao `applicationShouldTerminate:` hole is gone); still route ⌘Q through the app menu owning quit.
- **Snapshots**: `webContents.capturePage()` → `image.toPNG()` replaces all of `snapshot.rs` (ObjC gone). Trap: an occluded/hidden view can return an empty image — keep the `png_too_small_to_see` refusal; capture only the attached, visible view. `<video>`/WebGL capture actually *works* in Chromium (improvement over `snapshot.rs:6-8`).

## 4. Downloads + yt-dlp

- `will-download`: URL already guard-checked in webRequest (uniformly — the `<a download>` bypass `browser.rs:1046-1050` no longer exists as a special case). `setSavePath(staging/{uuid}-{safe_name})` synchronously. On `updated`: if `getTotalBytes()>cap` **or** `getReceivedBytes()>cap` ⇒ `item.cancel()`, journal + `browser-download-oversize` (now truthfully "stopped", not "cannot stop"). On `done/completed` ⇒ `import_download` funnel (main owns DB), journal "arrived in the room", emit `browser-download`.
- **yt-dlp: main spawns the standalone binary** (decision + rationale): the sidecar could `import yt_dlp`, but a PyInstaller-frozen sidecar cannot self-update a pip package, and the self-update **is the feature** (July binary → August 403 wave). Port `ytdlp.rs` wholesale to `browser/ytdlp.ts` (child_process): fetch `yt-dlp_macos` on first use, Mach-O magic sniff before chmod (`ytdlp.rs:79-89`), `.part`+rename, single-flight flag; `-U` when mtime >14d with 180s budget, touch mtime after "already up to date" (`ytdlp.rs:264-302`); `format_selector` verbatim — h264/avc1 first (AVFoundation can't play VP9), merge branches offered **exactly when** a system ffmpeg exists (probe explicit Homebrew/MacPorts paths first — GUI PATH is bare, `ytdlp.rs:312-322`, `337-357`); quality probe `-j` + `quality_options` fold; **first-progress-line over-cap abort** (`parse_ytdlp_total_bytes`, `ytdlp.rs:220-252`, `611-621`); concurrent stderr drain (64KB pipe deadlock, `ytdlp.rs:576-593`); 250ms cancel poll + 60min budget; "brew install ffmpeg" hint only when ffmpeg absent (`ytdlp.rs:507-517`). Never downgrade quality to fit the cap (owner, encoded at `ytdlp.rs:330-336`).
- Download **jobs** (`jobs/download.rs`): same two engines ("fetch" → `web/fetch.ts downloadToTemp`, "media" → ytdlp.ts), created/refused at the same doors.

## 5. Agent bridge & quote semantics

Preload runs in the **isolated world** — page code cannot see or tamper with it (stronger than WKUserScript's shared world). `bridge.ts` calls ops via `executeJavaScriptInIsolatedWorld(1004, [{code:'__arcelleBrowse.call("read",{...})'}])`; promises await natively. Keep: total entry points, `DOC_ID` per document (still needed to report "the click navigated" honestly — `browser.rs:1552-1571`: lost op + new doc-id ⇒ `{navigated:true, snapshot}`, never fabricated completion), mark cap 80, `READ_MAX` 40000, password fencing, cross-origin frame opacity. Quote/selection: capture stays a **claim verified in main** — a passage is only quoted if it appears in the main-frame extraction (the HtmlView verified-bridge doctrine applied at the same seam); `NOTHING_SELECTED` string contract preserved both sides.

## 6. Startup sequence

1. Room opens → nothing (browser is lazy).
2. First tab: mint sitting id → build in-memory session `browse-<sid>` → attach preload path, register the single webRequest funnel (guard + deserialized blocker engine) → set protection verdict → `will-download` hook → create view, loadURL.
3. Blocker engine deserialization failed ⇒ `Failed{reason}`, journalled, browsing still works (`browser.rs:1804-1807` doctrine: a broken blocker must not brick the address bar — but it must be *visible*).

## 7. Build checklist (ordered)

1. `browser/guard.ts` + port guard.rs test tables **verbatim** (`guard.rs:118-198` — trailing dot, CGNAT, v4-mapped v6, public neighbors).
2. `web/fetch.ts` (guardedGet manual redirects + undici pinned lookup; charset tests incl. windows-1255).
3. Build-time script: EasyList+EasyPrivacy → `engine.bin` (checked into build assets); `blocker.ts` deserialize + match unit tests.
4. `session.ts` + single webRequest funnel + guard-parity test: every URL family `guard.rs` blocks is cancelled as a subresource.
5. `manager.ts` (tabs/heir/bounds/takeover/sitting) + `navigation.ts` (events, window-open handler, DNS recheck) + `journal.ts`.
6. Preload port of `page.js` + `bridge.ts` + doc-id navigation reporting.
7. `extract.ts` (Readability reading view, selection, save-page) — verify extraction at parked/zero bounds in a harness.
8. `downloads.ts` + import funnel + oversize-cancel test.
9. `ytdlp.ts` port + its test table (`ytdlp.rs:742-948` scenarios).
10. `search.ts` + preview enrich + data-URL delivery.
11. `api.ts` rewiring + event bridge; drive the wdio capture suite against real pages.

## 8. Open questions for the owner

1. **Filter lists**: full EasyList+EasyPrivacy bundled (~1.5MB engine, far better coverage) vs. porting the curated 90-domain table (`rules.rs:27-121`)? Updates would ship only with app releases either way (no phone-home). Recommend full lists.
2. **yt-dlp**: confirm standalone self-updating binary in main (recommended) over pinned pip package in sidecar (frozen, updates only with releases).
3. **Blocked counter**: now real per-page — surface as a number in the shield, or keep the shield state-only?
4. Keep MAX_TABS=8, or raise (Chromium tabs are cheaper than 8 WKWebViews)?
5. Sitting-scoped in-memory partitions accumulate for the process lifetime (Electron sessions aren't destroyable); acceptable, or reuse one partition + `clearStorageData()` between sittings?

---

# Part E — DB, crypto, room files, packaging & release (design agent, verbatim + editor notes)

# Arcelle rewrite — DB, crypto, .room files, packaging & release

## A. DB layer

### Recommendation: `better-sqlite3-multiple-ciphers` (latest, tracks better-sqlite3 12.x)

| Option | Verdict |
|---|---|
| **better-sqlite3-multiple-ciphers** (SQLite3MultipleCiphers) | **CHOSEN.** `PRAGMA cipher='sqlcipher'; PRAGMA legacy=4` is byte-compatible with SQLCipher 4 (`cipher_compatibility=4`, schema.rs:536) — existing .room files open **in place, no converter**. Prebuilt Electron binaries via prebuild-install; sync API; supports `PRAGMA rekey` and `VACUUM INTO` (encrypted output). |
| better-sqlite3 + app-layer AES-GCM | Rejected. Either whole-file decrypt-to-temp (plaintext on disk — the product's one promise broken) or per-blob crypto (rewrite of every query, no SQL over encrypted columns, FTS dead). Also mandatory converter for every existing room. |
| node-sqlite3 + sqlcipher build | Rejected. Requires compiling against SQLCipher (violates prebuilt-only rule), callback API, weakest maintenance. |

**Consequence:** checkpoints (`.roomck`), duplicated rooms, and the file format itself stay SQLCipher-4; the old Rust app and `roomai` CLI can still open files the new app writes. The pysqlcipher3 sidecar converter is **not built** — kept as a documented escape hatch only if we ever change cipher params.

### Process placement

better-sqlite3 is synchronous; a GB-scale `VACUUM INTO` in Electron main would freeze menus and all IPC. The whole DB module runs in an Electron **utilityProcess** (`dbHost`), one connection, crash-isolated. Contract (MessagePort JSON-RPC): `{id, cmd, args} → {id, ok, result | error}` where `error` is the exact user-facing string today's commands return (renderer code keeps matching on `"WRONG_PASSWORD"`).

### Module layout (Electron main, TS)

```
main/
  db-host/index.ts        # utilityProcess entry, RPC dispatch, single Connection
  db-host/open.ts         # createRoom / openRoom / openReadonly / applyKey / verifyKey
  db-host/migrate.ts      # schema batch + user_version ladder (CURRENT_USER_VERSION = 3)
  db-host/schema.sql      # SCHEMA verbatim from schema.rs
  db-host/recovery.ts     # .recovery sidecar (Node crypto port)
  db-host/checkpoints.ts  # manifest, VACUUM INTO, perform_swap, rollback
  db-host/rekey.ts        # rekey / verify_password / rekey_copy
  db-host/queries/*.ts    # ports of db/{files,chats,messages,...}.rs
  ipc/registry.ts         # 308 command names → handlers (same names as #[tauri::command])
  preload.ts              # contextBridge: window.arcelle.{invoke,listen,dialog}
```

`src/api.ts` change is mechanical: replace `@tauri-apps/api/core` `invoke`/`listen` imports (api.ts:1-2) with the bridge; command names unchanged.

### Invariants ported verbatim (cite = current encoding)

- **One `applyKey` seam** sets key *and* pins cipher params; a fifth caller can't forget half (schema.rs:521-538). Port: `db.pragma("cipher='sqlcipher'"); db.pragma("legacy=4"); db.pragma("key='"+pw.replace(/'/g,"''")+"'")` — pragma has no parameter binding, so double single-quotes; add a test with a quote-containing password.
- **First-read verification + error classification**: only `SQLITE_NOTADB` (and unclassifiable) may say `WRONG_PASSWORD`; every other code names itself, and only the CODE travels — no paths in errors (schema.rs:540-575).
- **New rooms born at `user_version = 3`**, never 0 — a 0-stamp re-runs repair #1 which nulls every embedding (schema.rs:577-586, 613-615). Keep the source-scan test that asserts the constant matches the last `if user_version < N` block (schema.rs:1993-2004).
- **Failed create removes the half-written file plus `-wal`/`-shm`**, connection dropped first (schema.rs:634-651).
- **`meta.format = 'roomai'` gate** before trusting the file (schema.rs:664-676); read-only open for verify — enforced by the engine via `SQLITE_OPEN_READONLY`, not discipline (schema.rs:691-708). better-sqlite3: `new Database(path, {readonly:true})`.
- **Rekey** via `PRAGMA rekey` (versions.rs:170); `verify_password`/`rekey_copy` on throwaway connections so a walk-up attacker can't re-key an open room (versions.rs:159-183).
- **Min password length** enforced at the encrypting seam (schema.rs:600).

### Recovery sidecar — on-disk format IDENTICAL

Port versions.rs:185-397 to `recovery.ts` with Node `crypto`; old `.recovery` files must keep working:

- JSON `{v:1, salt, nonce, ct}` base64; `ct` = GCM body ‖ 16-byte tag (versions.rs:211-218).
- `crypto.pbkdf2Sync(normalized, salt, 200_000, 32, 'sha256')` (versions.rs:199, 221-225).
- `crypto.createDecipheriv('aes-256-gcm', key, nonce)` + `setAuthTag(tag)`; encrypt side appends `getAuthTag()`.
- Code generation: 31-char alphabet (no I/L/O/0/1), **rejection-sampled** (`byte >= 248 → redraw`, versions.rs:230-259); normalize = strip non-alnum, uppercase (versions.rs:263-268).
- **Atomic write**: temp beside the sidecar, `fsync`, rename — same volume; the wrap is the only copy of the sealed password and the likeliest crash moment is a password change (versions.rs:306-335). Node: `fs.writeFileSync(tmp)`, `fs.fsyncSync(fd)`, `fs.renameSync`.
- Delete sidecar when re-wrap after password change fails (versions.rs:342-347); `v != 1 →` "written by a newer version" (versions.rs:359).

### Checkpoints

Port room_checkpoints.rs to `checkpoints.ts`:

- Registry **outside** the DB in `<room>.checkpoints/` + JSON manifest `{v:1, entries}` — must survive rollback (room_checkpoints.rs:6-18, 61-72); payloads `<uuid>.roomck` are full SQLCipher copies keeping the room's key.
- Id gate: reject non-`[A-Za-z0-9_-]{1,64}` before pasting into a path — reject, never sanitize (room_checkpoints.rs:40-46).
- Create: reconcile dir first, disk-space precheck (need + 256 MB headroom; **replace the `df -Pk` shell-out with `fs.statfsSync`** — Node ≥19.6, Electron 39 ships Node 22; keep "can't determine → allow", room_checkpoints.rs:311-355), `VACUUM INTO` tmp → rename, tmp cleaned on every failure (room_checkpoints.rs:375-421).
- Swap: delete `-wal/-shm/-journal` siblings, copy checkpoint to `<room>.swap-<uuid>` **beside the room** (same volume = atomic rename), rename over room path; partial copies removed on every branch (room_checkpoints.rs:438-460).
- Rollback command sequence: verify checkpoint's password on a throwaway connection → set `rollback_in_flight` before drain → drain cancellable writers, **refuse if any didn't finish** → "Before rollback" safety checkpoint, cap autos at 3 → close connection in dbHost → swap → reopen → remount (room_checkpoints.rs:531-600). Timestamps stay `YYYY-MM-DDTHH:MM:SSZ` (room_checkpoints.rs:83-104 — `new Date().toISOString().replace(/\.\d+Z$/,'Z')`).

### Touch ID / keychain

> **Reconciliation note (editor):** see main plan §6 — the shell design proposes the opposite (koffi + same Keychain items, zero re-enroll). A spike on a real enrolled machine decides.

Old app stores room passwords in the data-protection keychain, service `"PrivateRoom"`, account = room path, biometric ACL (biometrics.rs:11-15). Keychain ACLs bind to the app's signature: the re-signed Electron app **cannot read those items**. New scheme: `systemPreferences.promptTouchID()` gates release of a password wrapped by `safeStorage.encryptString()` stored in `app.getPath('userData')/unlock/<hash>.bin`. Users re-enroll Touch ID unlock once per room; first Electron launch shows one line explaining it. (Old items become orphans; optionally the LAST Tauri release deletes them.)

## B. Packaging & release

### electron-builder config (electron-builder ^26, @electron/notarize ^2)

- `appId: com.benreich.privateroom` — **unchanged** (TCC identity + rebrand memory: do NOT rename).
- `mac.target: [dmg, zip]`, **arm64 only** (today's releases are aarch64-only, release.sh:87; universal doubles a ~600 MB payload for no current user).
- `hardenedRuntime: true`; entitlements = Electron's required `com.apple.security.cs.allow-jit` **plus** `com.apple.security.device.audio-input` (Entitlements.plist — necessary beyond the usage string under hardened runtime). `extendInfo`: `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription` (getDisplayMedia loopback audio rides the Screen & System Audio Recording TCC grant), `CFBundleDocumentTypes` via `fileAssociations: [{ext: [arcelle, roomai], icon: document.icns, role: Editor}]` (tauri.conf.json:29-36). Handle `app.on('open-file')` + `second-instance`.
- Models (whisper q5, TitaNet ONNX, Silero — RELEASING.md:71-95, byte counts checked post-fetch) and the PyInstaller onedir go under `extraResources` → `Contents/Resources/{models,sidecar/arcelle-sidecar}` — **never under Contents/MacOS**: codesign/notary reject non-code like `base_library.zip` in MacOS, and Resources is where it already lives (tauri.conf.json:42). TitaNet now runs in the sidecar on onnxruntime, retiring the tract bit-exactness pin (RELEASING.md:92-95) — revalidate embeddings once against the Rust outputs.
- Signing order (port of release.sh:101-137): `afterPack` hook re-signs the sidecar executable with **its own entitlements** (`disable-library-validation` + `allow-unsigned-executable-memory` — CPython under hardened runtime, release.sh:112-123, sidecar/sidecar-entitlements.plist) and every Mach-O in the onedir; then electron-builder's osx-sign seals the app; `afterSign` → `@electron/notarize` with `keychainProfile: "private-room"` (RELEASING.md:24-30) + staple.
- **macsign.sh problem**: with Developer ID the designated requirement is certificate-anchored and stable across builds, so TCC grants survive updates natively — macsign.sh's job disappears for releases. Keep a dev-only equivalent (ad-hoc + `=designated => identifier "com.benreich.privateroom"`, macsign.sh:56-61) for local builds. One unavoidable cost: ad-hoc-DR → Developer-ID DR changes the requirement, so migrating users re-grant mic/screen **once**.

### Updater: electron-updater (not Sparkle)

Sparkle means an ObjC framework, its own EdDSA feed, and no TS surface — electron-updater is generated by the same builder, GitHub-releases provider, feed = `latest-mac.yml` + zip. Decision: **electron-updater**.

**Feed handoff** — tauri installs poll `releases/latest/download/latest.json` (tauri.conf.json:58-63) and verify minisign. The tauri updater just extracts a signed `Arcelle.app.tar.gz` and swaps the bundle — the payload being an Electron app is mechanically fine. Plan:

1. Every Electron release additionally publishes `Arcelle.app.tar.gz` (COPYFILE_DISABLE=1 — the AppleDouble extractor trap, release.sh:157-169), its minisign `.sig` (key `~/.tauri/private-room.key` — backed up, never regenerate), and `latest.json`. Because the endpoint resolves against the **newest** release, dropping these assets would 404 old clients' checks (harmless no-op, RELEASING.md:174) but strand them.
2. Tauri installs therefore auto-update straight into the current Electron build; electron-updater takes over from there.
3. After ~3 releases, stop shipping the tauri triplet; stragglers fall back to manual DMG (documented in README).
4. **Gate**: before cutover, hand-test a real tauri install updating into the Electron tar (executable name changes `arcelle`→`Arcelle`; identifier doesn't).

### Release pipeline & CI

`scripts/release.sh` becomes `scripts/release.mjs`: preflight → `sidecar/build-sidecar.sh` (`--clean` when deps changed) → `electron-builder --mac` (hooks sign/notarize) → tauri-compat triplet via minisign → `gh release create/upload --clobber` (idempotent re-run, release.sh:228-242). Version files shrink to **four**: package.json, sidecar/pyproject.toml, `__init__.py`, uv.lock (Cargo.toml/Cargo.lock/tauri.conf.json retire); preflight.sh keeps the agreement check + changelog gate. PATH-prepend `/usr/bin` retained for hdiutil/xattr shims. Secrets stay env-only, never argv (release.sh:170-181).

CI: **vitest** for main/dbHost (unit tests run against real fixture .room files, including one created by the shipped Rust app — the compatibility test); **pytest** (`uv run`) for sidecar; **wdio + wdio-electron-service** for e2e — the repo's wdio configs carry over, and the "no macOS tauri-driver" gap disappears; regenerate `dist/qa.html` before capture runs.

### Startup / shutdown

Start: `app.whenReady` → spawn `dbHost` utilityProcess → create BrowserWindow → spawn sidecar from `process.resourcesPath` with fresh `ARCELLE_SIDECAR_TOKEN` (server.py:99; loopback is not a boundary) — the bundled onedir **ignores `SIDECAR_PORT` and prints its port** (release-history memory), so read stdout, then poll `/health` (server.py doc). Shutdown: `before-quit` → prompt for unsaved notes (**Electron's quit interception is reliable where tao's `applicationShouldTerminate` was not** — the ⌘Q data-loss bug class dies here) → drain writers → `wal_checkpoint(TRUNCATE)` + close in dbHost → SIGTERM only the sidecar **we** spawned (sidecar_lifecycle.rs:11-13).

## Ordered build checklist

1. dbHost skeleton + `open/migrate/recovery` ports; fixture .room from current app; vitest compat suite green (incl. wrong-password classification, quote-in-password, old `.recovery` decrypt).
2. IPC registry + preload bridge; rewire `src/api.ts`; smoke the app read-only.
3. rekey/verify_password/rekey_copy; Touch ID re-enroll flow.
4. checkpoints.ts + rollback drain sequence; statfs precheck.
5. Sidecar spawn/lifecycle in main; token + port-print handshake.
6. electron-builder config + entitlements + afterPack sidecar signing; notarize on the Dev-ID machine; `spctl` accepted.
7. release.mjs incl. tauri-compat triplet; test tauri→Electron update on a real old install.
8. wdio-electron-service e2e; preflight rewrite; cut handoff release.

## Open questions for the owner

1. Confirm arm64-only stays (Intel was never shipped).
2. How many releases keep the tauri-compat triplet (proposal: 3)?
3. Should the last Tauri release also ship a "manual update" banner as belt-and-braces if the tar handoff test fails?
4. OK to orphan existing Touch ID keychain items (one-time re-enroll), or should the last Tauri release export them into the new safeStorage format first?
5. `.roomck` checkpoints from the Rust era remain SQLCipher-4 and stay restorable — confirm no re-encryption pass wanted.

---

## Companion documents

- `electron-python-migration-inventory-2026-08-22.md` — Part I: per-subsystem mapping tables (all 161 files: LOC, target layer, replacement, effort). Part II: the per-file must-preserve/gotcha ledger. This is the rewrite checklist; nothing in it is guessed — every bullet was read out of the code by the inventory wave.
- Raw structured inventory (JSON) retained in the session workspace if machine processing is wanted.
