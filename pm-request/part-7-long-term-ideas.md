# Part 7 — Long-term ideas (explorations, not commitments)

Big bets for after the core is solid. Each item's "acceptance criteria" is
a decision artifact (a prototype or a written decision), not a shipped
feature.

---

## LT-1 — Windows version

**Goal**
Double the audience. Tauri already targets Windows; the Rust core is
portable.

**Task**
Time-boxed spike: build and run the app on a Windows machine, list what
breaks.

**How to do it**
1. Known Mac-only spots: `zsh -lc` detection of CLIs and MarkItDown paths
   (`commands.rs`, `extraction.rs`), the Finder file-open event in
   `lib.rs`, DMG styling, `.roomai` file association.
2. Wrap each in platform checks; find Windows equivalents (registry file
   association is handled by Tauri bundler; CLI detection via `where`).
3. Verify SQLCipher bundling on Windows (rusqlite bundled-sqlcipher).

**How to check it**
Create a room, import a PDF, chat with Ollama for Windows, lock/unlock.

**Acceptance criteria**
- [ ] A written list of every Mac-only assumption and its Windows fix.
- [ ] Go/no-go decision with an effort estimate.

---

## LT-2 — Voice input (local Whisper)

**Goal**
Dictate into the vault — perfect fit for journal/medical use, and it stays
on-message: audio never leaves the Mac.

**Task**
Prototype a microphone button in the composer that transcribes locally
(whisper.cpp or Apple's Speech framework on-device mode) into the text box.

**How to do it**
1. Compare: Apple SFSpeechRecognizer (on-device flag) vs whisper.cpp
   (bundle a small model ~75 MB).
2. Add mic permission entry to `Info.plist`.
3. Prototype behind a setting; measure latency and accuracy on Hebrew and
   English (the user writes both).

**How to check it**
Dictate a 30-second note in each language; read the transcript.

**Acceptance criteria**
- [ ] Working prototype on one engine.
- [ ] Measured accuracy/latency note for both languages.
- [ ] Confirmation that no network is used (Little Snitch or proxy check).

---

## LT-3 — Multiple rooms open at once

**Goal**
Power users will want their "Taxes" and "Health" rooms open side by side.

**Task**
Design (not build) multi-window support: one window per room.

**How to do it**
1. Today `AppState` holds a single `room: Mutex<Option<Room>>` — the app
   literally cannot hold two. Design: a `HashMap<WindowLabel, Room>` keyed
   by Tauri window, commands take the calling window's label.
2. MCP manager and model warm-up become per-room concerns; RAM budget
   (one model!) is shared — design the arbitration.
3. Write it up as a one-page design doc with effort estimate.

**How to check it**
Design review: does every existing command have a clear owner window?

**Acceptance criteria**
- [ ] Design doc covering state, MCP, RAM, and file-association routing.
- [ ] Decision: build now, later, or never.

---

## LT-4 — Mobile viewer (read-only)

**Goal**
"Your vault in your pocket" — open and read a `.roomai` on iPhone, no
agent, no editing.

**Task**
Feasibility spike: unlock and browse a room on iOS.

**How to do it**
1. Tauri 2 supports iOS; SQLCipher works there. The viewers are web tech
   already.
2. Cut everything except: unlock screen, file list, viewers, chat history
   reading. No Ollama on-device (or explore MLX/llama.cpp later).
3. Check App Store rules for encrypted-content apps (export compliance).

**How to check it**
Open a room created on the Mac, on a phone/simulator; view a PDF and a chat.

**Acceptance criteria**
- [ ] Room created on Mac opens on iOS simulator.
- [ ] Written scope for a v1 viewer + store-compliance notes.

---

## LT-5 — Positioning & launch material

**Goal**
The unique story ("an encrypted file that is an AI workspace, and the AI
drives the app") reaches people intact.

**Task**
Produce the launch kit: three 20-second screen recordings + a landing page
draft.

**How to do it**
1. Record the three magic moments: "mark where the signature is" (boxes
   appear), "fix the typo in my contract" (file edits itself), the 📍 chip
   re-opening a highlight.
2. Landing page: lead with the file ("This is not an app subscription.
   It's a file you own."), the privacy table (what leaves the Mac: nothing,
   unless you flip these two switches), and the recordings.
3. Comparison paragraph vs local-AI chat apps (Msty, AnythingLLM, Reor):
   they chat NEXT to your files; Private Room's AI works INSIDE them.

**How to check it**
Show the page to two people who never saw the app; ask them to explain it
back. If they say "encrypted file + AI that acts", it works.

**Acceptance criteria**
- [ ] Three recordings captured at final UI quality.
- [ ] Landing page draft reviewed.
- [ ] The two-sentence pitch survives the retell test.
