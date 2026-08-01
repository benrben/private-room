# Browser downloads — save anything into the room (BROWSE-2)

**Date:** 2026-07-31 · **Status:** BUILT same day (Phases 1–3 + most of 4) — see "Implementation status" at the end
**Scope:** the browser (and its agent) can download/save *anything* — files, pages, links, selections, videos — into the room; the user can do all of the same by hand. Continues the D-numbering of `browser-mode-agent-control-plan-2026-07-29.md` (D1–D12).

---

## Part A — Design

### A.1 Where we actually stand (audit results)

The good news: most of the hard plumbing already exists. The bad news: the pieces are not connected, and one of them is *promised but not built*.

**Already built and reusable:**

| Piece | Where | State |
|---|---|---|
| WKDownload interception | `browser.rs:427-459` (`download_allowed` via wry) | Works — stages the file to `$TMPDIR/arcelle-browse-downloads/`, journals, emits `browser-download` |
| Universal ingestion funnel | `import_files` → `commands/files.rs:3-119` | Everything rides it: blob into the encrypted room DB, extraction, OCR/STT lanes, RAG chunks, auto-index, privacy scan |
| Link import | `import_link` → `files.rs:551-586` | Fetches readable text, saves a markdown doc with `Source:` header |
| Video download | `ytdlp.rs` (202 lines) | yt-dlp fetched on demand, best-mp4, temp dir → `import_files` → Whisper transcription. **User-only, YouTube-only in the UI** |
| Guarded fetch | `web/fetch.rs` + `web/guard.rs` | SSRF-safe (DNS pin, redirect re-check), but **text-only** — rejects binary content types (`fetch.rs:122-130`) |
| Durable job tier | `commands/jobs/queue.rs` | Queue, progress events, cancel, Activity cards; dispatch table at `queue.rs:147-151` takes new kinds |

**The four holes in the existing download path** (found by code audit, all in/around `browser.rs:427-459`):

1. **The staged file is orphaned.** Nothing ever reads `$TMPDIR/arcelle-browse-downloads/` — a clicked download lands in temp and dies there. D9 ("downloads only into the room") is currently violated in the worst way: downloads go *nowhere*.
2. **`browser-download` has no consumer.** The event is emitted at `browser.rs:448`; no Rust or frontend listener exists anywhere.
3. **The emitted path is always `None` on macOS** (tauri limitation, documented at `browser.rs:424-426`). We choose the staging path ourselves in `Requested` but never remember it for `Finished`.
4. **The download branch bypasses the URL guard.** wry short-circuits `shouldPerformDownload` before our `navigation_allowed` runs (`wry .../navigation.rs:66-73`) — a `<a download>` click is the one navigation `check_public_http_url` never sees.

**The truthfulness bug:** `prompts.py:205-207` already tells the browse agent *"A file the PAGE downloads is imported into this room automatically."* That is false today. Under our own hardening doctrine this is a live silent-fabrication path — Phase 1 makes the claim true (or, if this plan stalls, the sentence must be deleted).

**The agent gap:** no agent tool can ingest anything. `import_files`/`import_link`/`import_youtube_video` are user-only Tauri commands; the only agent path is `fetch_page` → `create_file` (paste text). No binary, no video, no link bookmark.

### A.2 One funnel, four inlets

**Core principle (proposed D13): every way bytes arrive converges on `import_files`.** No second ingestion path, ever. That funnel already gives us extraction, OCR/STT lanes, RAG indexing, auto-index, the privacy scan, and collision-safe naming — video included (yt-dlp already proves it).

New shared primitives (Phase 2):

- `web::download_to_temp(url, cap) -> (PathBuf, ContentMeta)` — the missing generic binary downloader. Built on the existing `guarded_get` + capped streaming (`fetch.rs:14-36`), so the SEC-5 DNS-pinning guard applies to binaries exactly as it does to text today. Own byte cap, separate from the 8 MB text cap.
- `import_download(app, state, path, origin: DownloadOrigin) -> ImportReport` — thin wrapper over `import_files` that records provenance (source URL, referring page, initiator user|agent, timestamp) and cleans up the temp file. Files get `source="download"`; a new nullable `origin_url` column on `files` (migration) carries the URL for binaries the way `import_link`'s markdown header does for text.

**The four inlets, all feeding that funnel:**

| Inlet | Mechanism | Covers | Phase |
|---|---|---|---|
| **In-page click** | WKDownload (already wired, needs the 4 holes closed) | User or agent clicks any download link; keeps the page's session/cookies | 1 |
| **Explicit URL fetch** | `download_to_temp` (guarded reqwest) | "Download this URL" for any public file — PDF, CSV, zip, image, dataset | 2 |
| **Media engine** | yt-dlp, generalized beyond YouTube (~1,800 supported sites) | Videos/audio anywhere yt-dlp works; long-running → job tier | 3 |
| **Session-true save** | `WKWebView startDownloadUsingRequest:` via objc2 (macOS 11.3+, we target 12.0) | Downloads that need the logged-in session's cookies but weren't triggered by a click | 4 |

Plus one **non-network capture**: **save the live DOM** — the rendered page as the user/agent actually sees it (post-JS, post-login). Strictly better than `fetch_page` for SPAs and authenticated pages, and it needs no new network path at all: a new `capture` op in `page.js` returns readable markdown + raw HTML, and (optionally, Phase 4) WKWebView's PDF snapshot for visual fidelity. Format per the `#research` airlock precedent (proposed D21): markdown primary (RAG-friendly), raw HTML alongside (fidelity).

### A.3 User surface

The browser toolbar lives in React *above* the native webview (the one strip that can hold UI), so everything hangs off it:

1. **Clicked downloads just work** (Phase 1): click any download link — in takeover or while watching the agent — and the file lands in the room. Toast: "quarterly-report.pdf arrived in the room". Journal row. No dialog — see A.5.
2. **Save menu on the toolbar** (Phase 2): one button, four verbs —
   - **Save page** → live-DOM capture (markdown + HTML, `Source:` header)
   - **Save link** → bookmark the current URL as a link doc (reuses `import_link` internals)
   - **Save selection** → whatever's selected in the page (`window.getSelection()` via a new `page.js` op; context menus can't be customized over a native webview, so the toolbar button reads the current selection — same reason the consent card parks the browser)
   - **Download video** → feed the current URL to the media engine (works on any yt-dlp site, not just YouTube)
3. **Save as PDF** (Phase 4) via `createPDFWithConfiguration` — the page exactly as rendered.
4. **AddLinkModal generalization** (Phase 3): the "Video + transcript" radio appears for any yt-dlp-supported URL, not only YouTube.
5. **Visibility**: quick saves toast + appear in the files list immediately; long media downloads are durable **job cards** in Activity (progress %, cancel) — the same cards deep-summary uses. The browse journal gains `download`/`save` rows so the room's audit trail stays complete (D10).

### A.4 Agent surface

**Four new tools** (proposed D17), placed where they make sense rather than all-in-one-box:

| Tool | Boxes | What it does | Result shape |
|---|---|---|---|
| `save_page` | chat.browse | Capture the live DOM (mode: `page` \| `selection`) into the room | filename + size + "indexed" |
| `download_url` | chat.web, chat.browse | Guarded binary fetch of a URL → room. ≤64 MB inline; bigger auto-promotes to a download job and returns the job id (proposed D18) | filename + size, or job id |
| `download_media` | chat.web, chat.browse | yt-dlp any supported site → room. Always a durable job (videos are slow); agent tracks it with the existing `job_status` tool | job id + honest "transcription will follow" |
| `save_link` | chat.web | Bookmark a URL as a link doc with readable text (existing `import_link` logic) | filename |

chat.browse grows 6 → 9 tools; chat.web 2 (+CORE) → 5. Registration is the known five-place drill (`browse_tools_specs`/`BROWSE_TOOL_NAMES` in `commands/browse.rs:56,89`, trust classes in `room_mcp.rs:663-674`, `routing.py:98-110`, `labels.py:60-71`) **plus** the pinned tests that will rightly scream: `test_browse_agent.py:53` (exactly six tools) and the 4,500-byte spec-budget test (`browse.rs:948-956`) both get deliberate, reviewed bumps.

Trust classes: all four are `read_only=false` (they add room files), `destructive=false`, `open_world=true`; `download_url`/`download_media` non-idempotent.

**Truthfulness rules baked in:**
- Tool results return **metadata, never bytes** (the cloud tool-result cap stays irrelevant by construction).
- Import is honest about async work: "video imported; transcription queued" — the STT lane is serial and slow, and the tool must not claim a transcript exists before Whisper runs.
- The `prompts.py:205-207` auto-import sentence becomes true in Phase 1; `BROWSE_PROMPT` and `WEB_PROMPT` gain the new verbs in the same commit that ships them — prompt claims and shipped behavior move together (proposed D20, the ratchet that keeps v0.12's hardening intact).

### A.5 Consent & privacy stance

The audit's cleanest finding: **an inbound download crosses none of the four privacy doors.** All four (chat/model seam, remote-connector seam, outbound-typing consent, SSRF guard) exist to protect *room content leaving*. A download is bytes arriving; the only thing that leaves is the URL — which is already the exposure of `browse_open` itself.

Therefore (proposed D14): **no consent card for downloads.** Consent friction here would protect nothing and would train users to click through the doors that matter (the typing door). What we do instead:

- **Guards that DO apply, everywhere:** the room internet switch (`web_access_enabled`), the per-room browse/search lanes, and the SSRF guard on **every** inlet — including two fixes: `download_allowed` gets its own `check_public_http_url` call (closing hole #4), and the media engine gets a pre-flight `resolve_public_addr` check on the target URL before yt-dlp is spawned (closing the existing bypass where yt-dlp does its own networking; residual subprocess-redirect risk is documented and accepted — proposed D16, same posture the YouTube feature already ships with).
- **Journal everything** (D10): every download and save gets a journal row with URL, filename, size, initiator.
- **Size caps, truthfully enforced** (proposed D15): the room is one SQLCipher file with a ~1 GB SQLite per-blob ceiling — hard cap **800 MB** per download with a clear refusal ("too large for a room file"), and `download_media` keeps the best-*single-file*-mp4 format selection so we never need ffmpeg and rarely hit the cap.
- **Privacy scan runs automatically** on everything imported (already wired into `import_files`) — downloaded content is immediately known to the outbound doors.
- **Temp hygiene:** staging dirs cleaned on import, on failure, and swept on room close; downloads inherit the room-epoch pin the OCR/STT lanes already use, so a room switch mid-download can't cross-import.
- **Incognito story unchanged:** in-page downloads use WKDownload inside the ephemeral session — nothing new persists in the browser layer; the bytes' only home is the encrypted room DB (D4 + D9, finally both true).

### A.6 Jobs tier integration

New job kind `"download"` in the dispatch table (`queue.rs:147-151`), payload `{url, engine: fetch|ytdlp, origin}`:
- Progress: yt-dlp's stdout percent (parser exists, `ytdlp.rs:95-103`) or streamed-bytes/content-length → existing `job-progress` events → existing Activity cards. No new UI component needed.
- Cancel: kills the child process / aborts the stream; partial temp files deleted.
- Agent access rides the existing `job_tools` scope gating (`room_mcp.rs:103-108`) — a consulted cloud advisor still can't start downloads, exactly matching the current tier design.

### A.7 Known platform limitation (accepted, with escape hatches)

wry's `decidePolicyForNavigationResponse` turns a response into a download **only when the MIME type can't be displayed** — it never inspects `Content-Disposition: attachment` (`wry .../navigation.rs:85-103`). So a server saying "download this PDF" will *display* the PDF instead. Accepted for v1 because the escape hatches are good: the user hits **Save page/Save as PDF** on the displayed document, and the agent has `download_url` for the same URL. If it bites in practice, the fix is a wry patch (upstream PR), not a fork — noted in the risk register.

---

## Part B — Implementation plan

### B.0 Phase 0 — decisions + one spike (~½ day)
- Ratify D13–D22 below.
- **Spike:** `startDownloadUsingRequest:` from objc2 — can we own the returned `WKDownload`'s delegate without fighting wry's? (wry only sets a delegate on downloads *it* creates, so this should be clean — verify in a release build, per the wry eval-crash precedent.) If it fights: fallback is copying cookies from `WKHTTPCookieStore` into a reqwest fetch. This only gates Phase 4.

### B.1 Phase 1 — close the orphan (~1 day, ships alone)
The smallest change that makes D9 and the prompt true:
- `download_allowed/Requested`: run `check_public_http_url` (refuse = return `false`); remember `url → staged path` in the browser state.
- `download_allowed/Finished`: look up the staged path (ignore tauri's always-`None` path), call `import_download` (v0: direct `import_files` + journal), emit `browser-download` **with the real path and filename**.
- Frontend: `onBrowserDownload` listener in `api.ts` → toast + files-list refresh.
- Temp-dir sweep on room close; failure path journals honestly.
- e2e errand: agent clicks a CSV download link → file exists in room → agent's report names it.
- QA: the Yahoo-Finance QA case's download assertions (`qa/BROWSER-AGENT-YAHOO-FINANCE.md:178-183`) finally pass.

### B.2 Phase 2 — shared plumbing + save surface (~2–3 days)
- `web::download_to_temp` + `import_download` + `origin_url` migration.
- `page.js`: new `capture` op (readable markdown + raw HTML + selection variant) — same walker, same `READ_MAX` discipline for the markdown, raw HTML capped by bytes.
- Toolbar Save menu (page / link / selection / video) in `BrowserView.tsx`.
- Agent tools `save_page`, `save_link`, `download_url` (inline ≤64 MB) — five-place registration, trust classes, prompt updates, pinned-test bumps.
- Tests: guard-bypass regression, binary-cap refusal, SPA capture beats `fetch_page` fixture, spec-budget re-pin.

### B.3 Phase 3 — media engine (~2–3 days)
- Generalize `ytdlp.rs`: `import_media_url(url)` for any yt-dlp site; keep `-f b[ext=mp4]/b`; pre-flight SSRF check; 800 MB cap enforced post-download before import.
- Job kind `"download"`: dispatch arm, progress, cancel, epoch pin.
- Agent tool `download_media` (always a job; result = job id + queued-transcription honesty).
- `AddLinkModal`: video option for any supported site; non-YouTube caption branch skipped (straight to download+transcribe).
- e2e errand: "download this talk and summarize it" — download job → STT lane → summary cites the transcript.

### B.4 Phase 4 — session-true saves + polish (~2 days)
- `startDownloadUsingRequest:` primitive (per spike) — powers "save this asset behind login" and image-saving.
- Save as PDF (`createPDFWithConfiguration` via objc2 — snapshot crate pattern already exists in `snapshot.rs`).
- Downloads section in the journal side panel.
- UA checklist rows for every new button/verb (`qa/UA-FEATURE-CHECKLIST.md` — update, don't re-derive).

### Binding decisions (proposed — flag any to reopen)

| # | Decision |
|---|---|
| D13 | Every inlet converges on `import_files`; no second ingestion path |
| D14 | Downloads auto-import with **no consent card** — inbound crosses no privacy door; journal + toast are the visibility |
| D15 | 800 MB per-file hard cap (SQLite blob ceiling), truthful refusal beyond |
| D16 | yt-dlp is the sole media engine, generalized to all its sites; pre-flight SSRF check; subprocess-redirect residual risk documented and accepted |
| D17 | Four new tools: `save_page` (browse), `download_url` + `download_media` (web+browse), `save_link` (web); browse box 6→9 |
| D18 | `download_url` ≤64 MB inline, larger auto-promotes to a `"download"` job; `download_media` is always a job |
| D19 | Provenance: `source="download"` + `origin_url` column; every download journaled |
| D20 | Prompt claims and shipped behavior change in the same commit — never let `prompts.py` promise what the tools can't do |
| D21 | Page capture = markdown (primary) + raw HTML (fidelity), per the `#research` airlock precedent; PDF is Phase 4 |
| D22 | User-clicked and agent-clicked downloads take the identical path — one code path, one journal, one funnel |

### Risk register

| Risk | Mitigation |
|---|---|
| `Content-Disposition: attachment` on displayable types never downloads (wry checks only `canShowMIMEType`) | Save-page/PDF + `download_url` cover it; upstream wry PR if it bites |
| `startDownloadUsingRequest` delegate conflicts with wry | Phase 0 spike; fallback = cookie-copy into guarded reqwest |
| yt-dlp subprocess evades DNS pinning on redirects | Pre-flight check + documented acceptance (existing YouTube posture); revisit with `--proxy` through a pinning proxy if ever needed |
| Big blobs bloat the room DB / media staging map (`MAX_STAGED=4`) | 800 MB cap; media plays via existing streaming, never re-read whole |
| 4,500-byte spec budget + six-tool pin tests break | Deliberate reviewed bumps, specs kept terse |
| Room switch mid-download cross-imports | Epoch pin, same as OCR/STT lanes |
| Temp staging leaks on crash | Sweep on room open *and* close |

### Effort: ~6–9 days total; Phase 1 alone (~1 day) already fixes the shipped truthfulness bug and D9.

---

## Implementation status (2026-07-31, built same day)

**Shipped (all tests green: Rust 539+, sidecar 973, tsc + vite):**
- Phase 1 complete: guard inside `download_allowed` (+ regression test), staged path remembered, import on `Finished` via `import_download`, `browser-download` event → toast, staging swept on room close, prompt claim now true.
- Phase 2 complete: `web::download_to_temp` (typed `DownloadOutcome::TooLarge`, cancel flag, progress callback), `origin_url` migration + `insert_file_from_url`, `page.js` `capture` op, toolbar **Save strip** (a second chrome ROW — a dropdown cannot exist over the native webview), agent tools registered end-to-end, tool-catalog snapshot regenerated.
- Phase 3 complete: `ytdlp.rs` generalized (`download_media_to_temp` + `import_media_url`, SSRF pre-flight, 800 MB cap, cancel kills the subprocess), job kind `"download"` (progress % on the existing job cards, cancel, resume-from-scratch), AddLinkModal offers the video option for every URL. YouTube imports now ride `import_download`, so they finally carry `source="download"` + `origin_url`.
- Live e2e errand added (`test_the_web_agent_saves_a_link_with_the_one_step_verb`), UA checklist section 29b extended.

**Deviations from the plan, with reasons:**
- `save_page` shipped as **`browse_save`** — the `browse_` prefix is load-bearing (lane filter conventions, prefix-scanning tests, journal vocabulary).
- **D17 revised:** the download verbs (`save_link`, `download_url`, `download_media`) are boxed on `chat.web` ONLY. The browse box was already at the small-model cap; the Browser agent ingests by CLICKING download links (auto-import) and by `browse_save`, which covers its errands without growing its choice budget. `MAX_BOX_TOOLS` 6 → 7 (justified: `browse_save` is browse-native and the box was full).
- D14/D22/D13/D15/D16/D18/D19/D20/D21 implemented as written.

**Deferred on record (Phase 4 tail):**
- `startDownloadUsingRequest:` session-true saves — plan-gated on an objc2 delegate spike; in-page clicks already download with the session's cookies via WKDownload, so the gap is only "fetch an authed asset that no link points at".
- Save as PDF — needs the `WKPDFConfiguration` objc2 feature + a release-build check (the wry eval-crash precedent); additive polish.
- Real-network QA of the new paths (download click, big-file promote, non-YouTube video) still to run in the installed app.
