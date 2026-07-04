# Private Room

![Private Room — a private AI workspace sealed inside a single file](docs/banner.png)

<p align="center">
  <img src="docs/badge-encrypted.svg" alt="End-to-end encrypted" height="28">
  <img src="docs/badge-offline.svg" alt="Offline-first" height="28">
  <img src="docs/badge-local-ai.svg" alt="Local AI via Ollama" height="28">
  <img src="docs/badge-macos.svg" alt="Made for macOS" height="28">
</p>

A `.roomai` file works like a document: double-click it in Finder, unlock it
with your password, and you're inside a private workspace containing your
files, chat history, AI memory, and generated documents. Everything lives in
**one SQLCipher-encrypted SQLite file**. By default nothing leaves your
computer — the AI runs locally through Ollama.

## What's in a room

| | |
|---|---|
| **Files** | PDFs, Office documents, spreadsheets, Markdown, code, images — stored as encrypted blobs, previewed with real viewers |
| **Chat** | Streaming conversations with the room's AI, grounded in your files; any reply can be saved back into the room as a new document |
| **Memory** | Facts the AI should always remember, editable in the sidebar — the AI can also add its own |
| **Settings** | Per-room model choice, creativity (temperature), and custom instructions |

## The AI lives in the room

- **Local by default.** Ollama at `127.0.0.1:11434`, default model
  `qwen3.5:4b` (text + vision + tool calling; context capped at 8K so a
  16 GB Mac stays comfortable). The model is pre-warmed when you unlock.
- **It can drive the app.** The model has tools — `search_room`,
  `list_room_files`, `open_file` (jumps to a page, cell, or phrase),
  `mark_image`, `annotate_file`, `create_file`, `edit_file`, `write_file`,
  `set_cells`, `add_memory` — so "open the budget spreadsheet at Q3",
  "mark the signature in this scan", or "fix the typo in my notes"
  actually happen in the UI.
- **It can edit files.** Exact-text replacement in text, code, CSV and
  DOCX files (run-aware XML editing keeps Word formatting), full rewrites
  of text files, and cell edits in .xlsx/.csv by A1 reference. PDFs are
  honest: not editable in place — the AI highlights or saves a corrected
  copy instead. Every edit re-indexes the file for retrieval.
- **It can point at things.** Beyond image boxes, `annotate_file`
  highlights an exact quote in PDFs (drawn over the page), DOCX and
  Markdown (CSS Custom Highlight API), or a cell range in spreadsheets.
  The model must quote text verbatim — the app verifies it before marking,
  and each reply carries a 📍 chip that re-opens the highlight.
- **Optional web access.** Off by default; the search tools are not even
  offered to the model until you pick a provider in Settings → Online
  features (Brave Search with your own key, or a SearXNG instance you
  trust). Fetches run in Rust with a private-network guard, results are
  clamped to fit a small context, and pages are cached in the room.
- **It can see.** Attach an image with the paperclip and ask about it.
  "Where is X?" questions draw labeled boxes on the image; grounding
  auto-routes to a Qwen-VL model when one is installed (measured: far more
  accurate boxes than the chat model). Images are transcoded to PNG and
  downscaled before inference — formats Ollama can't decode just work.
- **Retrieval.** Imported files are chunked and keyword-scored; the best
  excerpts travel with your question, and sources are shown on each answer.
  (An embeddings column is already reserved for vector search.)
- **Optional cloud engines.** If the Claude Code or Codex CLI is installed,
  it appears in Settings as an engine choice. The UI warns clearly: cloud
  engines send your questions and room context to your own account —
  images never leave; vision always stays local.
- **Model manager.** Download models with live progress, switch, and delete
  — all from Settings, no terminal needed.

## Viewers & editing

| Format | Viewer |
|---|---|
| PDF | PDF.js page renderer |
| DOCX | docx-preview |
| XLSX / CSV | SheetJS grid with sheet tabs |
| Markdown | Rendered view with an edit toggle |
| Code / text | Monaco editor — ⌘S saves back into the room and re-indexes |
| Images | Zoomable viewer with "locate" bar for visual grounding |

Everything is bundled locally; no CDN, no network fetch.

## How it works

1. **Create / unlock** — your password is the SQLCipher key (PBKDF2-derived
   internally). A wrong password can't read a single byte; there is no
   recovery.
2. **Import** — files are stored as encrypted blobs; readable text is
   extracted by built-in Rust extractors (PDF, DOCX, XLSX, HTML, Markdown,
   code, CSV, plain text), with Microsoft's MarkItDown as a fallback for
   exotic formats when installed (`pipx install markitdown`).
3. **Ask** — your question is scored against every chunk in the room, the
   best excerpts are sent to the model, tools let it act on the room, and
   both sides of the chat are saved inside the file.
4. **Generate** — any assistant reply can be saved back into the room
   ("Save to room"), where it's indexed like any other file.

## Development

```sh
npm install
npm run tauri dev     # run the app
npm run tauri build   # build Private Room.app + DMG (registers .roomai)
cd src-tauri && cargo test   # encryption + extraction tests
```

Requires: Rust, Node, and [Ollama](https://ollama.com) with a model pulled
(`ollama pull qwen3.5:4b`) — or pull it from inside the app via Settings.

**Stack:** Tauri 2 (Rust) · React + TypeScript · SQLCipher (AES-256) ·
Ollama.

## Design

The brand is a violet keyhole-doorway on ink — private, sealed, calm.

| Token | Hex | Role |
|---|---|---|
| Ink | `#0e1014` | Backgrounds |
| Panel | `#161a22` / `#1c212c` | Surfaces |
| Border | `#262d3b` | Strokes and dividers |
| Text / Slate | `#e8eaf0` / `#8b93a7` | Foreground / secondary |
| **Violet** | **`#8b7cf6`** | The accent — keyholes, glows, focus |
| Green / Amber / Red | `#4cc38a` / `#e3b341` / `#e5646c` | Status only |

In-app icons are React components in [`src/icons.tsx`](src/icons.tsx);
master artwork and the asset-generation pipeline (app icon, `.roomai`
document icon, DMG background, this README's banner) live in
[`art/`](art/README.md).

## Roadmap

- Touch ID unlock (LocalAuthentication + Keychain-wrapped key)
- Link import with offline page archiving (readability extraction)
- Embedding-based retrieval (sqlite-vec)
- In-place DOCX/XLSX editing and DOCX export
- OCR for scanned documents
