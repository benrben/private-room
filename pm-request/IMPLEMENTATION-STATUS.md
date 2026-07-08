# Moonshot implementation — status (2026-07-06)

Built on branch `moonshot-impl` by a coordinated set of parallel agents, each
owning a disjoint set of files against a shared interface contract. This is an
honest accounting of what shipped, how it was verified, and what is deliberately
partial or blocked by this environment.

## Verification summary (what actually ran, green)

| Check | Result |
|---|---|
| `cargo test` (backend unit + integration) | ✅ 13 lib + 3 mcp_client + 3 roomfile + doctests, all pass |
| `cargo test --test roomai_cli` (new e2e CLI test) | ✅ create → verify → info → wrong-password → recover → export |
| `cargo build` (dev) | ✅ clean, first try, 9 parallel tracks integrated |
| `cargo build --release` (distribution compile) | ✅ clean, 3m11s — app (31M) + `roomai` CLI (5.9M) |
| `npm run build` (tsc strict + vite) | ✅ clean, incl. `noUnusedLocals`/`noUnusedParameters` |
| `npm run e2e` (wdio + tauri-driver) | ⛔ **not runnable on macOS** — tauri-driver supports Linux/Windows only (WKWebView has no WebDriver). Not an app defect. |

The two mega-files (`commands.rs` 7.9k lines, `Workspace.tsx` 3.9k lines) each
had a single owner to avoid write races; everything else parallelized around them.
Total change: ~5,000 insertions across 25 files (6 new).

## DONE + TESTED (has an automated test that passes)

- **Recovery key** (the printed sheet). Sidecar `<room>.recovery`: PBKDF2-HMAC-SHA256
  (200k iters) → AES-256-GCM wrap of the password, stored OUTSIDE the encrypted
  db (it has to be — it unlocks the very file it sits beside). Unit test: create →
  write → recover roundtrip + wrong-code rejection. Does NOT change the existing
  SQLCipher key=password scheme (zero risk to existing rooms). `db.rs`
- **SQLCipher pinning** — `PRAGMA cipher_compatibility = 4` in create+open;
  reopen-still-decrypts test. `db.rs`
- **Meta helpers** `set_meta`/`get_meta`; embeddings now stamped with model+dim. `db.rs`
- **Closet (remote inference)** — runtime Ollama URL override (override > env >
  default) with a unit test. `ollama.rs` + `set_ollama_url`/`get_ollama_url`
- **Room Map backend** `room_graph` — mean per-file embedding + cosine edges,
  keyword-Jaccard fallback; unit test builds an in-memory room and asserts edges. `commands.rs`
- **Roles** `list_roles`, **recommended_models** — unit tests. `commands.rs`
- **`roomai` CLI** — `verify` / `info` / `recover` / `export`; arg-parse unit
  tests + a full integration test driving the built binary. `src/bin/roomai.rs`
- **Web helper** `fetch_readable` reusing the SSRF-guarded fetch (guard intact). `web.rs`

## DONE (compiles + registered + degrades safely; runtime needs a live model/GUI)

These are wired end-to-end and type-check, but their happy path needs a running
Ollama and the actual app window, which cannot run headless on macOS here. Each
degrades gracefully (empty/partial, never panics) when the model or room is absent.

- **Receipts** — verified-verbatim badge on annotation chips + "Copy as receipt";
  PDF highlights drop a green ✓. (`Workspace.tsx`, `highlight.ts`, `PdfView.tsx`)
- **The Seal** — unlock bloom (fires on every open via `enterRoom`) + lock fold
  with a soft WebAudio blip and reduced-motion fallback. (`App.tsx`, `Workspace.tsx`, `App.css`)
- **Front Page** — instant dashboard on unlock (recent files/chats/memory/counts)
  + lazy AI suggestion chips. `front_page` / `front_page_suggestions`
- **Room Map UI** — `RoomMap.tsx`, hand-rolled Fruchterman-Reingold constellation
  (no external lib), zoom/pan, edge-reason tooltips, perf caps; "Map" toggle.
- **Time Machine** — version timeline (cause + timestamp) with one-click restore.
- **Studio Shelf** — flashcards + mind map + podcast-script buttons; each produces
  a self-contained interactive HTML file that opens in the sandboxed viewer.
  `studio_flashcards` / `studio_mindmap` / `generate_podcast_script`
- **Memory suggestions** — after an answer, a dismissible "Remember this?" card. `memory_suggestion`
- **Smart import** — suggests title/folder/tags as an undoable chip (only when it
  differs from the current name). `suggest_file_meta`
- **The Airlock** — `#research`: web search → save each source into the room →
  answer offline with source chips (never leaves web access on). `commands.rs`
- **The Leash** — persistent room-as-MCP-server toggle, copyable client config,
  per-app consent, dies on lock; cloud clients gated behind a blunt warning.
  `set_room_server` / `room_server_status`, `Settings.tsx`
- **Semantic search wake-up** — `ensure_embed_model` pulls the embed model and
  backfills; Settings surfaces a one-click "Turn on semantic search."
- **Vision helper offer** — ImageView + Settings offer the vision model download
  when it's missing (fixes image-marking-broken-by-default).
- **Recovery UI** — one-time code reveal at create (print-safe), "unlock with
  recovery code" on the gate, "create recovery key" in Settings.
- **First Room demo** — a data-only demo template (Welcome + two cross-referenced
  files that show off `#extract`), plus a "Try a demo room" button. `App.tsx`
- **Roles UI**, **Closet UI**, **#help + command discoverability**, **toast action
  buttons**, **"End-to-end encrypted" → "Encrypted on your Mac"** fix.
- **CSP** set (was null); **updater** owner fixed (`benreich`→`benrben`) + a real
  minisign pubkey generated; **README/spec/pledge** written.

## SCAFFOLDED (deliberately partial, clearly labeled in-product)

- **Private Podcast = script only.** `generate_podcast_script` produces a styled
  two-host transcript with an in-product note that audio narration is coming
  later. Real on-device TTS (bundling a small TTS model + Metal + audio stitching)
  is a follow-on wave — it needs a large native dependency this pass intentionally
  did not add.

## BLOCKED by this environment / needs external action (not attempted as "done")

- **Bundled inference engine (remove the Ollama install).** Still requires Ollama.
  Embedding llama.cpp/MLX is a large native-dependency + model-download effort and
  was left out to keep the tree green and honest. Path documented in the moonshot doc.
- **Apple notarization.** The config is fixed (updater owner, real signing pubkey,
  CSP), but actual notarization needs your Apple Developer account + a real signed
  release upload. Updater private key is at `/tmp/pr_updater.key` (not committed) —
  move it to a CI secret and rotate before first release (see RELEASING.md).
- **DMG theatre (password on the DMG art + shipping a locked demo room in the DMG).**
  The in-app demo template IS built; putting the code on the DMG background art and
  bundling a sealed demo room is a release-packaging step (art + bundler).
- **sqlite-vec ANN.** Deferred — brute-force cosine works today; documented as the
  scaling step when rooms get large.
- **Visual QA of the Seal animation and all new UI.** Everything compiles, but
  "does it look and feel right" needs a human at the GUI — not verifiable headless.

## How to try it locally

```sh
npm install && npm run tauri dev          # run the app with the new UI
cd src-tauri && cargo test                # backend + CLI tests
cargo build --release --bin roomai        # the standalone CLI
./target/release/roomai verify your.roomai
```
