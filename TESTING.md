# Private Room — QA Mission for a Claude Coworker

You are a **QA tester** for **Private Room**, a macOS app: an encrypted `.roomai`
file that is also a private AI workspace (files + chat + memory + generated docs),
with a local Ollama model that can *drive the app* (open files, highlight quotes,
mark images, edit files). Your job is to **play with every feature, try to break
it, and log what you find.** Be adversarial and curious — do the wrong thing on
purpose, not just the happy path.

This app was just rebuilt across 59 feature items. This playbook walks the whole
surface. Work top-to-bottom; each suite says what to do and what "pass" looks like.

> **You drive the app yourself with computer use.** This is a native macOS app,
> so DOM tools (Playwright / Selenium / WebDriver) can't reach it — **but computer
> use can**: take a screenshot to see the current state, move and click the mouse,
> type, and send ⌘-shortcuts, exactly like a person. That is the whole point —
> operate the **installed** app at `/Applications/Private Room.app` end to end,
> autonomously. Run the **Bash tool in parallel** for the evidence a screenshot
> can't show (spawned processes, file sizes, `shasum`, `strings`, `cargo test`,
> the app-data dir). Your core loop for every step:
> **screenshot → decide → click/type → screenshot to confirm → cross-check with Bash → log.**

---

## 0. Setup (do this first)

### 0.0 How you'll drive it (computer use)
- **Launch the app:** `open "/Applications/Private Room.app"` (Bash), then screenshot to see the gate screen. Or, when you want to *see errors/logs*, run it in dev mode (§0.1) and right-click → **Inspect Element** for the devtools console.
- **See:** take a screenshot before and after every action. Read the actual pixels — don't assume a click landed; confirm it.
- **Act:** click buttons/fields by their on-screen position, type text, use the real Mac shortcuts (⌘F, ⌘N, ⌘L, ⌘,). For native **file dialogs** (Create/Open/Export pickers) you also drive them with the mouse/keyboard — type the path into the Finder sheet (⌘⇧G "Go to folder" is handy) and confirm.
- **Verify out-of-band with Bash** (this is what makes you a good tester, not just a clicker): after a GUI action, prove it with the filesystem/process checks in §0.3. Example: after "Allow" on an MCP dialog, screenshot *and* `ps aux | grep uvx`.
- **Pace:** the local model streams slowly and OCR/embeddings run in the background — wait and re-screenshot rather than assuming a hang. Give async work a few seconds.
- If a step needs something you can't do from the GUI (e.g. renaming `Ollama.app` to simulate "not installed"), do it in Bash, then return to the GUI.

### 0.1 Build & run in dev mode (best for testing — live logs + devtools)
```sh
cd /Users/benreich/private-room
# Terminal A — Ollama must be running:
ollama serve            # (or the Ollama.app menubar item)
ollama pull qwen3.5:4b            # the standard chat model
ollama pull qwen2.5vl:3b          # OPTIONAL: vision (image marking) — any qwen2.5vl tag
ollama pull nomic-embed-text      # OPTIONAL: meaning-based search (ADD-13)

# Terminal B — run the app with logs & right-click "Inspect Element" available:
npm run tauri dev
```
Or test the **installed release**: `open "/Applications/Private Room.app"`
(no console; use dev mode when you need to see errors).

### 0.2 Make test fixtures
```sh
mkdir -p /tmp/pr-fixtures && cd /tmp/pr-fixtures
# a plain text note (used for edit/version/annotate tests)
printf 'Project Apollo\nWe landed twelve people on the Moon between 1969 and 1972.\nThe budget was significant.\n' > notes.txt
# a CSV whose FIRST ROW IS DATA (not headers) — for CHG-3
printf 'alice,42,lawyer\nbob,37,doctor\ncarol,29,engineer\n' > data.csv
# a BIG text file to trip the 2000-chunk / 6000-char caps (HLT-4, UX-4)
python3 -c "print(('The quick brown fox jumps over the lazy dog. '*40+'\n')*1500)" > big.txt
# a Hebrew note (RTL test, UX-1)
printf 'שלום עולם\nזהו מסמך עברי לבדיקה.\n' > hebrew.txt
# grab a real text PDF and a real image if you can (any PDF with selectable text; any photo).
# For OCR (ADD-14) you need a SCANNED / image-only PDF or a photo of text.
echo "Now import these via the app's + Add button (or drag-drop)."
```
Keep a scratch folder for exports and duplicated rooms: `mkdir -p /tmp/pr-out`.

### 0.3 How to observe (non-GUI evidence — use these constantly)
- **Processes** (did a plug-in / cloud CLI actually spawn?): `ps aux | grep -iE 'uvx|ollama|claude|codex' | grep -v grep`
- **Room file size** (SEC-7 vacuum, export byte-identity): `ls -l ~/path/to/Room.roomai`
- **The room is a SQLCipher DB** — you *cannot* read it without the password (that's the point). Verify opacity: `strings Room.roomai | head` should reveal **no** plaintext of your notes.
- **Approvals / recent list live OUTSIDE the room** (per-Mac): look under the app data dir, e.g. `ls "$HOME/Library/Application Support/com.benreich.privateroom/"` — expect `recent.json`, `mcp_approvals.json`.
- **Keychain** (Touch ID): open **Keychain Access.app**, search `PrivateRoom`.
- **Exported bytes identical**: `shasum original imported_then_exported`.

### 0.4 Bug log format (append findings to `/tmp/pr-findings.md`)
```
### [SEVERITY] <feature id> — one-line summary
Steps: …
Expected: …
Actual: …
Evidence: (screenshot path / log line / shasum / ps output)
```
Severity = **BLOCKER** (data loss / crash / privacy leak) > **MAJOR** (feature broken) > **MINOR** (cosmetic).
**Privacy leaks and any data loss are BLOCKERS — hunt for them specifically.**

---

## 1. Golden path (smoke test — do this before anything else)
1. Launch → **Create New Room** → pick `/tmp/pr-out/Smoke.roomai` → password `test-1234` (≥8) → Create & Enter.
2. Titlebar reads **"Smoke — Private Room"** (CHG-9).
3. **+ Add** → import `notes.txt` and a real PDF. They appear in the Files list.
4. Click a file → it opens in the middle viewer pane.
5. Ask the chat: *"What is in notes.txt?"* → a streamed answer appears; a **source chip** naming `notes.txt` appears under it.
6. Ask: *"Highlight the sentence about the Moon in notes.txt."* → the answer carries a **📍 chip**; clicking it opens the file with the quote highlighted.
7. **Lock** (top-right) → back to the gate; titlebar returns to **"Private Room"**.
8. **Open Room…** → same file + `test-1234` → all files and chat history are still there.

✅ Pass = create→import→view→ask→annotate→lock→reopen all work and nothing is lost.
If step 5/6 fail because the model is missing, finish suite **5.4** (onboarding) first.

---

## 2. Room lifecycle & passwords
- **2.1 Min length (SEC-2):** Create a room, try password `123` → blocked with a clear message; type a long mixed password → the **strength meter** under the first field goes red→amber→green.
- **2.2 Legacy short passwords still open:** if you have any old room with a <8 char password, it must still **open** (only *creation* is restricted).
- **2.3 Wrong password:** Open a room, type garbage → "Wrong password. Try again." (never a raw error).
- **2.4 Change password (SEC-4):** Settings → Privacy → change to a new ≥8 password. Lock. Old password fails, **new password opens** and all content is intact. Wrong "current password" is rejected.
- **2.5 Recent rooms (ADD-5):** Open two different rooms, quit, relaunch → the **Recent** list on the start screen shows both, newest first, ≤5. Click one → its unlock screen. Delete a listed `.roomai` in Finder, click its entry → graceful error; the entry can be removed. Confirm `recent.json` holds only **names/paths**, never contents.
- **2.6 Duplicate room (ADD-4):** Settings → Privacy → Duplicate → choose `/tmp/pr-out/Copy.roomai`, optionally a new password. The copy opens (with the new password if set); file & message counts match the original; the **original is untouched**. Duplicating onto an existing path is refused.
- **2.7 Templates (ADD-15):** Create a **Medical** room → Settings shows its custom instructions; **Welcome.md** is in Files; the memory panel shows starter memories. Create a **Blank** room → completely empty. Try all templates (Legal/Research/Journal) at least once.

---

## 3. Privacy & security (be paranoid here)
- **3.1 MCP approval — the big one (SEC-1):** In a room, Settings → Connections (MCP), paste a config with a real enabled server, e.g.
  ```json
  { "mcpServers": { "web": { "command": "uvx", "args": ["duckduckgo-mcp-server"] } } }
  ```
  Save & Connect (this counts as approval). **Close the room.** Now **watch for spawns**: in a terminal run `ps aux | grep uvx | grep -v grep` and keep it handy. Reopen the room → an **approval dialog ("🔒 This room wants to start programs")** must appear listing the server name + exact command line, and **no `uvx` process may exist until you click Allow.**
    - Click **Keep off** → room works, chat works, tools stay off, `uvx` never spawns.
    - Reopen → **Allow** → server starts. Reopen again → **no dialog** (remembered per-Mac in `mcp_approvals.json`).
    - Edit one character of the config, save, close, reopen → **dialog appears again** (fingerprint changed).
    - Confirm approvals are **never** written into the `.roomai` (they're in app-data). This closes the worst security hole — test it hard.
- **3.2 Web-fetch guard / DNS rebinding (SEC-5):** Turn Web on (Settings → Online features → DuckDuckGo). Ask the AI to fetch `http://localtest.me` and `http://127.0.0.1.nip.io` (both resolve to 127.0.0.1) → **both blocked**. Fetch `http://example.com` → works. A URL that redirects to a private address → blocked at the redirect. (Rust unit tests cover this: `cd src-tauri && cargo test web`.)
- **3.3 Cloud badge (SEC-6):** If Claude Code / Codex CLI is installed it shows as an engine. Select it → a persistent **"☁ Cloud engine active — questions leave this Mac"** badge appears by the composer, the model dropdown is tinted, and **"Switch to local"** returns to the local model. No badge for local models. Survives quit/reopen.
- **3.4 Auto-lock (SEC-3):** Settings → Privacy → set "Lock automatically after 5 minutes" (temporarily hack it lower in code if you don't want to wait, or just set 5 and wait). Go idle → gate screen appears. Move the mouse before the limit → timer resets. **Start a long answer, go idle → it must NOT lock mid-stream; it locks right after the answer finishes.** Close the laptop lid past the limit, reopen → locked. Set "Off" → never locks.
- **3.5 Vacuum on lock (SEC-7):** Create a room, import ~50 MB of files (`ls -l` the `.roomai`), delete them all, **Lock** → the file shrinks back near its empty size on reopen. Small deletions must **not** trigger a slow vacuum. Settings → "Compact room now" reports space recovered.
- **3.6 Cloud-sync warning (HLT-6):** Put a room in iCloud Drive (`~/Library/Mobile Documents/...`) or `~/Library/CloudStorage/...`, open it → a one-time **"lives in a synced folder"** banner; Dismiss; reopen → gone. A room in `~/Documents` → no banner.
- **3.7 Honest source chips (CHG-10):** In a room *with files*, ask *"hello, how are you?"* → the answer has **NO source chips** (nothing matched). Ask a real question about a file → chips appear. (The model is told when context is just "recent content".)

---

## 4. Data safety (nothing should ever be lost by one click)
- **4.1 Version history + undo (ADD-2):** Open `notes.txt`. Ask the AI to *"change the word 'significant' to 'enormous' in notes.txt."* → the **History** button (viewer header) lists the previous version with a cause + time; **Restore** brings the old text back **exactly**. Make 11 edits → only **10** versions kept. Edit an `.xlsx` cell, restore → the old value returns (binary round-trip). History survives lock/reopen; deleting the file removes its history.
- **4.2 Export (ADD-1):** Export a PDF, then `shasum` the original vs the export → **identical bytes**. Export a generated AI note → valid `.md`. **Export all…** a room with two same-named files → both arrive, one renamed `(2)`. Pick a no-write folder → clear error, app fine. First export shows a **"copies are NOT encrypted"** notice once.
- **4.3 Delete confirmations (ADD-3):** Click a file's trash **once** → nothing deletes; it becomes **"Delete? ✓ ✕"** for ~3 s. ✕ or waiting reverts; ✓ deletes. Same two-step for **chat**, **memory ×**, and **Settings → delete model**. Confirm no single click anywhere destroys data.

---

## 5. Chat pipeline (the trickiest wave — probe it hard)
- **5.1 Stop button (ADD-7):** Ask for *"a very long story"* → the Send button becomes **Stop**; click it → text stops within ~1 s, the **partial answer is saved marked "(stopped)"**, and the composer is usable immediately. Next question works normally (no zombie state). With a cloud engine selected, Stop must **kill the process** (`ps aux | grep -iE 'claude|codex'`).
- **5.2 Streaming == saved + step chips (CHG-5):** With Web on, ask something needing a search → **step chips** ("Searched the room", "Fetched a page") appear one by one above the live text; after completion the **visible final text equals the saved message** on reload. Nothing readable should abruptly "disappear" at the end of a turn. A plain no-tool question looks normal.
- **5.3 Markdown while streaming (CHG-6):** Ask for *"a numbered list with a code example"* → list numbers and the code block render **while typing**, with **no re-flow flash** at the end. Stop mid-code-block → no broken layout (fences are auto-balanced).
- **5.4 Onboarding banners (CHG-1 / ADD-10):** Temporarily quit Ollama → banner offers **[Open Ollama]** and the dot turns green without a manual refresh. Rename `/Applications/Ollama.app` aside → **[Get Ollama]** flow (opens the download page) + **[I installed it — check again]**. Select a model you haven't pulled → an **in-banner "Download {model}"** button with a live progress bar; on success the banner clears itself. **There must be NO "run ollama pull in a terminal" text anywhere.**
- **5.5 Lock during answer (HLT-7):** Start a long answer, click **Lock immediately** → gate screen appears with **no raw error toast/banner**. Reopen → the user question is there plus a partial answer marked "(stopped)" (consistent every time). Ask something new → all normal.
- **5.6 Drag-drop + paste (ADD-8):** Drag 3 files from Finder anywhere onto the window → a **"Drop to add"** highlight while dragging; all import, list refreshes. Take a screenshot to clipboard (⌘⇧⌃4), click the composer, **⌘V** → the image imports **and** auto-attaches as a chip; ask *"what is in this image?"* → a vision answer (needs a vision model). Drag a 300 MB file → friendly size error, no crash.
- **5.7 Chat rename/copy/regenerate (ADD-9):** Rename a chat (pencil by the dropdown) → new name persists after relock. Copy an AI message that contained an image-marking block → clipboard has **clean text, no JSON**. Regenerate the last AI answer → old one gone, a new one arrives; earlier history untouched. All three are disabled while streaming.
- **5.8 Clickable source chips (CHG-7):** Ask a file-grounded question → click its source chip → the file opens. Delete the file, click the chip in the old message → **"That file is no longer in the room."**, no crash.
- **5.9 Partial-read warning (UX-4):** Attach `big.txt`, ask for a summary → a toast **names the file** and says only the beginning was included. A small file → no notice.
- **5.10 Toasts (UX-7):** Import 3 unreadable files at once → readable stacked **error toasts** (grouped if >3), none lost, they persist until closed. A success toast auto-dismisses (~5 s). Trigger an error while a success shows → both visible, stacked.

---

## 6. Viewers & RTL
- **6.1 PDF copy (UX-2):** Open a text PDF → hover a page → **"Copy text"** → paste in Notes → matches the page. Header **"Copy all text"** → full document text. A **scanned** PDF → copy buttons hidden (no dead controls).
- **6.2 PDF zoom (UX-3):** −/percentage/+/"Fit width" and **⌘+ / ⌘−** work within 50–300%. A highlighted quote stays correctly placed after zoom. A 50-page PDF stays responsive; reading position is roughly kept across a zoom.
- **6.3 Spreadsheet labels (CHG-3):** Open an `.xlsx` → **column letters (A,B,C…) and row numbers (1,2,3…)** are visible and **sticky** while scrolling. Ask the AI to *"highlight B2:D5"* → the block sits exactly under labels B–D, rows 2–5. Open `data.csv` (first row is data) → it looks like data, **not** a header row.
- **6.4 RTL (UX-1):** Type a Hebrew question → right-aligned RTL in the composer **and** the sent bubble; the Hebrew answer renders RTL. A mixed Hebrew+English line stays readable. English-only content is unaffected. Check memories, chat titles, and Settings custom-instructions too.

---

## 7. Organization & search
- **7.1 Folders (ADD-16):** **+ Folder** "Contracts" → move 2 files in via each row's **move ("🗂") menu** → they group under a collapsible **"▸ Contracts (2)"** header. Collapse/expand; open/attach/delete a file inside a folder behaves exactly as at top level. **Delete the folder → the 2 files return to top level, nothing is lost.** Rename a folder → header updates. Ask the AI *"what is in the Contracts folder?"* → it answers from the file list (folder names are in the inventory). Open a pre-folders room → flat list, still works.
- **7.2 Fast index (HLT-3):** Import a couple of large books (~thousands of chunks). Asking a question should feel instant (FTS5, not a full scan). Edit a file, then search the new words → found (index stayed in sync). Delete a file → its text no longer surfaces.
- **7.3 Partial-index badge (HLT-4):** Import `big.txt` (exceeds the 2000-chunk cap) → the import toast says *partially indexed* and the file row shows a **badge/dot** with a tooltip. Normal files → no badge.
- **7.4 Search overlay (ADD-6):** **⌘F** (or ⌘K) opens a search box. Search a word in a PDF → clicking the result opens the PDF **highlighted**. Search a phrase from an old chat → jumps to that chat/message. Search a memory word → the memory panel opens. Esc closes; arrows + Enter navigate. Feels instant.
- **7.5 Memory edit + dedup (UX-5):** Add "The dog is named Rex" **twice** via the UI → **one** entry. Tell the AI "remember my dog is named Rex" when it already is → it acknowledges, list unchanged. Edit a memory (pencil) → new text persists after relock.
- **7.6 Shortcuts (UX-6):** ⌘N new chat, ⌘L lock, ⌘F search, ⌘, Settings, Esc closes overlay/viewer — all work from anywhere in the workspace and are shown in button tooltips. **Typing the letters in the composer does nothing special** (no hijacking).

---

## 8. Big features
- **8.1 Summarize room (ADD-17):** In a room with a few PDFs/notes, click **"✨ Summarize room"** → a progress counter ("Summarizing file 3 of 12…") → **"Room summary.md"** opens with a purpose paragraph, **one line per file**, three suggested questions, dated today. Add one new file, click again → only the new file is re-summarized (fast) and the summary now includes it. A room with an image and no OCR → the image is listed by name/type with **no invented description**. Quit Ollama, click → friendly error, **no half-written file**. Lock/reopen → the summary file is there.
- **8.2 Link import (ADD-12):** **"🔗 Link"** → paste a Wikipedia URL (note says "fetches one page from the internet") → a readable offline `.md` appears with the title + URL at top. Ask a question answered by that page **with Web OFF** → it answers from the saved copy and cites the file. Add a link to `http://192.168.1.1` → **blocked** (SEC-5 guard applies to this manual action too).
- **8.3 Templates (ADD-15):** already covered in 2.7 — verify the seeded content is **ordinary editable data** (delete/edit it freely).

---

## 9. Hardware-gated items (need real hardware / models — verify what you can)
- **9.1 Touch ID (ADD-11):** Settings → Privacy → toggle **Touch ID unlock** on. Lock. On the unlock screen a **"Use Touch ID"** button appears → fingerprint → opens; wrong finger → falls back to the password field (always present). Disable → the button is gone and **Keychain Access** shows the `PrivateRoom` item removed. Change the password (SEC-4) → Touch ID keeps working (entry is re-stored). ⚠️ Biometric-keychain writes may fail on an **unsigned dev build** (`errSecMissingEntitlement`) — if enable errors, note it and retest on the signed release, or flag as environment-limited.
- **9.2 OCR (ADD-14):** Import a **photo of a receipt** and an **image-only PDF** → after a moment (background pass), searching an amount/word from it finds the file, and asking about it works; the extracted text starts with "(text recognized from scan)". Test a **Hebrew** scan too — accuracy is the key open question. Import a huge scan → the UI stays responsive.
- **9.3 Embeddings / meaning search (ADD-13):** With `nomic-embed-text` pulled: put a file mentioning **"vacation schedule"**, ask *"when are the holiday dates?"* → the right excerpt is retrieved (keyword-only would miss it). Remove the embed model → chat still works via keywords (clean fallback). Vectors live inside the `.roomai` (nothing leaves the Mac).

---

## 10. Regression, migration & shipping
- **10.1 Old-room migration:** Open any room created before this rebuild → it opens fine, gains the new schema (folders/versions/FTS/ai_summary/web_pages index) automatically, and nothing is lost. Rust covers this: `cd src-tauri && cargo test migrates`.
- **10.2 Rust test suite:** `cd src-tauri && cargo test` → **all pass** (currently 55 tests). `npm run build` → typechecks + bundles.
- **10.3 e2e smoke (HLT-8):** `e2e/` has a WebdriverIO + mock-Ollama suite — this is the **headless-CI** path (it uses `tauri-driver`, which supports **Linux/Windows, not macOS WKWebView**): `npm install && cargo install tauri-driver && npm run e2e`. On macOS *you* are the automated coverage (computer use, above); you can still sanity-run the mock standalone here: `node e2e/mock-ollama.mjs` then `curl -s localhost:11434/api/tags` in another shell.
- **10.4 Updater/signing (HLT-2):** These need an Apple account — see `RELEASING.md`. Do **not** expect the updater to do anything until a real pubkey/endpoint is set (it no-ops quietly by design). Verify a local build isn't broken by the placeholders: `npm run tauri build` succeeds and produces `Private Room.app` + a `.dmg`.

---

## 11. Free-play (unscripted — find the weird bugs)
Spend real time *using* the app like a person would, and specifically try to break invariants:
- Do two destructive things fast; interrupt operations (lock mid-import, mid-summarize, mid-OCR, mid-pull).
- Feed junk: a 0-byte file, a file with a huge name, a `.roomai` that isn't ours, an emoji-only chat, a 10 k-word paste.
- Rapid-fire: mash Stop/Send, open/close the viewer, ⌘F ⌘F ⌘F, toggle folders while files load.
- **Privacy probes (highest value):** with Web OFF and no cloud engine and no MCP, confirm via a network monitor (Little Snitch, or `nettop`/`lsof -i` while asking) that **nothing leaves the Mac**. Then flip each switch and confirm exactly what *does* leave and that a badge warns about it.
- Confirm the `.roomai` never reveals plaintext (`strings` it) and that exports, recents, and approvals behave as documented.

---

## What to hand back
Append everything to `/tmp/pr-findings.md` with the severity format from §0.4, then give the human:
1. A one-paragraph verdict (ship / needs-fixes / blocked).
2. The BLOCKERS and MAJORs, most-severe first, each reproducible.
3. Anything you couldn't test and why (missing model, unsigned build, macOS driver limits).
4. Two or three "delight" notes — things that worked notably well.

Test like the product's promise is on the line — because for a privacy app, it is.
