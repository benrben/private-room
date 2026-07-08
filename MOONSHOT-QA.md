# Private Room — Test Check-list (for a computer-use agent)

This is a simple, step-by-step list to test the new features.
Do each step in order. For each check, there is:
- **Do:** what to click or type.
- **See:** what should happen (this is a PASS).
- **Bug if:** what means it is broken (write it down with a screenshot).

Write down every bug with a screenshot and the step number.

---

## Before you start

- The app is already installed and open. If it is closed, open
  **Applications → Private Room** (or press Command+Space, type "Private Room",
  press Return).
- Some features need **Ollama** (the local AI). Part A works WITHOUT Ollama.
  Part B needs Ollama running. Do Part A first.
- Take a screenshot after each big step so we can see what happened.

---

## PART A — Works without Ollama (test these first)

### A1. Make a new room and see "The Seal" open
- **Do:** On the start screen, choose to create a new room. Pick a location and
  name (for example `Test.roomai`), type a password like `test1234`, and confirm.
- **See:** A short, smooth violet "door opening" glow plays, then the room opens.
- **Bug if:** No animation at all, or the screen flashes/freezes.

### A2. See the recovery code sheet
- **Do:** Right after the room is created, a window with a **recovery code**
  should appear (six groups of letters/numbers).
- **See:** The code is shown big. There is a **Print** button and an
  **"I saved it"** button and a **Skip** option.
- **Do:** Click **Print**. A normal Mac print window should open showing a clean
  page with the big code (no app menus around it). Close the print window.
- **Do:** Click **"I saved it"** to continue. WRITE DOWN THE CODE — you need it in A4.
- **Bug if:** No code sheet appears, or the print page is blank/cut off.

### A3. Lock the room and see "The Seal" close
- **Do:** Press **Command+L** (or click the Lock button).
- **See:** The room gently folds/shrinks and you hear a soft short sound, then it
  returns to the lock screen.
- **Bug if:** No animation, or the app closes completely, or an error appears.

### A4. Unlock with the recovery code
- **Do:** On the lock screen for that room, look for a small link like
  **"Forgot password? Use a recovery code."** Click it. Type the code from A2.
- **See:** The room opens (same as a normal unlock).
- **Do:** Lock again (Command+L), then unlock the normal way with the password
  `test1234` to confirm the password still works too.
- **Bug if:** The recovery link is missing, or the correct code does not open it,
  or a wrong code shows an ugly crash instead of a calm "not correct" message.

### A5. See the Front Page
- **Do:** After unlocking, look at the main area before opening any file.
- **See:** A calm dashboard with recent files, recent chats, memory, and counts.
  (A brand-new empty room may show a welcome screen instead — that is fine.)
- **Bug if:** The area is blank white or shows an error.

### A6. Import a few files
- **Do:** Add 3–5 files (drag them onto the window, or use the **+** / import
  button). Use simple files: two or three text/markdown files and maybe a PDF.
- **See:** The files appear in the Files list on the left.
- **Bug if:** Import fails or the app freezes.

### A7. The Room Map (constellation)
- **Do:** In the Files header, find the **Map** toggle/button. Click it.
- **See:** A dark map with your files as violet "stars." (Lines between files may
  only show after the AI has made embeddings in Part B — that is OK for now.)
  You should be able to drag to move and scroll to zoom.
- **Do:** Hover a star (see its name) and click it (it should open that file).
  Click Map again to go back to the list.
- **Bug if:** The Map button is missing, the map is empty even though you have
  files, or clicking a star does nothing.

### A8. Time Machine (file history)
- **Do:** Open a text file. Change some text and save it (Command+S). Do this
  twice so there are versions. Then open the file's **History** button.
- **See:** A timeline strip with rows showing the reason ("You edited") and a
  time. Clicking a row restores that version.
- **Bug if:** No history shows, or restore does nothing.

### A9. The #help command and command list
- **Do:** Click in the chat box at the bottom. Type `#help` and press Return.
- **See:** A list of all chat commands with how to use each one (usage text).
- **Do:** Now just type a single `#`.
- **See:** A pop-up list of commands appears, each with a short "how to use" line,
  and it includes `#research`.
- **Bug if:** `#help` does nothing, or the command list shows no usage text, or
  only shows a few commands.

### A10. Check the fixed privacy wording
- **Do:** Look at the empty viewer area / trust note (where it talks about the
  file being encrypted).
- **See:** It should say **"Encrypted on your Mac."** (NOT "End-to-end encrypted.")
- **Bug if:** It still says "End-to-end encrypted."

### A11. Settings — the new sections
- **Do:** Open **Settings** (gear icon, or press Command+Comma). Scroll through
  the left menu. Check each new section opens and looks normal:
  - **Remote AI** (the "Closet") — a box to type another Mac's Ollama URL.
  - **Room server** (the "Leash") — an on/off switch.
  - **Room role** — a list: default / tutor / critic / opposing counsel / scribe.
  - **AI helpers** — shows if the vision model and semantic-search model are
    installed, with download buttons.
  - **Recovery key** — a **"Create a recovery key"** button.
- **Do:** In **Recovery key**, click **Create a recovery key**.
- **See:** A code is shown once with a **Print** button.
- **Do:** In **Room server**, turn the switch **ON**.
- **See:** It shows a local address (starts with `http://127.0.0.1:`) and a
  copyable config box, plus a note that it turns off when you lock.
- **Bug if:** Any section is missing, blank, or shows an error.

### A12. Try a demo room
- **Do:** Go back to the start screen (lock the current room). Click
  **"Try a demo room."**
- **See:** A ready-made room opens with a Welcome file and a couple of sample
  files (a project brief and notes).
- **Bug if:** The button is missing or the demo room is empty.

### A13. Toast button when AI is off (only if Ollama is NOT running)
- **Do:** With Ollama NOT running, type any normal question in the chat and send.
- **See:** A small message (toast) appears saying the AI is not reachable AND it
  has a button like **"Open Ollama."**
- **Bug if:** The message has no button, or nothing happens at all.

---

## PART B — Needs Ollama (the local AI)

First, turn on the AI:
- **Do:** Open the Ollama app (or in a terminal run `ollama serve`). In Private
  Room, if asked, pick a model (for example `qwen3.5:4b`) and wait for it to
  download. Then ask a simple question in the chat to confirm the AI answers.

### B1. Turn on semantic search
- **Do:** Settings → **AI helpers** → click **"Turn on semantic search"** (this
  downloads a small model). Wait for it to finish.
- **See:** It then shows semantic search is on. (After this, the Room Map from A7
  should start drawing lines between related files.)
- **Bug if:** The button does nothing or errors.

### B2. Front Page suggestions
- **Do:** Lock and unlock the room (or reopen the Front Page).
- **See:** Under the dashboard, a few clickable suggested questions appear.
  Clicking one puts it into the chat box.
- **Bug if:** No suggestions ever appear (with the AI on and files present).

### B3. Studio Shelf (make things)
- **Do:** On the Front Page, find the **Studio** buttons. Click **Flashcards**.
  Wait.
- **See:** A new file is made and opens showing flashcards you can flip / quiz.
- **Do:** Try **Mind map** and **Podcast script** too.
- **See:** Mind map opens as a small tree. Podcast script opens as a two-person
  talk transcript with a note that audio is coming later.
- **Bug if:** A button errors with the AI on, or the made file is empty/broken.

### B4. Memory suggestion card
- **Do:** Have a short chat where you tell the AI a clear fact (for example
  "My lease ends in March 2027"). Let it answer.
- **See:** A small card may appear asking **"Remember this?"** with the fact and
  **Save** / **Ignore** buttons. Click **Save**.
- **Do:** Open the Memory panel and check the fact was added.
- **Bug if:** Save does nothing, or it saves memory without asking.

### B5. Smart import suggestion
- **Do:** Import a new file with a messy name (for example `scan001.pdf` with
  real text inside).
- **See:** A small chip may suggest a better title / folder / tags, with
  **Apply** / **Dismiss**. Click **Apply** and check the file is renamed/moved.
- **Bug if:** Apply does nothing or renames wrongly.

### B6. Receipts (verified quotes)
- **Do:** Open a file with clear text. In chat, ask the AI to highlight an exact
  sentence from that file (for example: "Highlight the sentence about the budget
  in @filename").
- **See:** The answer has a highlight chip; a real, word-for-word highlight shows
  in the file; the chip has a green **verified** check and a **"Copy as receipt"**
  button. Click Copy as receipt and paste into any note to see the quote + file.
- **Bug if:** The check is missing, or "Copy as receipt" copies nothing.

### B7. Image marking + vision helper
- **Do:** Import an image (a photo or a scan). Open it. Use the **"Ask AI to mark
  something"** bar and ask it to mark an object.
- **See:** If the vision model is not installed, a button offers to download it.
  After it is installed, asking to mark something draws a box in the right place.
- **Bug if:** No offer to download appears when it is missing, or boxes are wildly
  wrong after the vision model is installed.

### B8. The Airlock (#research) — needs web turned on
- **Do:** In Settings → Online features, turn on a web provider (DuckDuckGo is
  free). Then in chat type `#research` and a question about something online.
- **See:** It searches, saves the pages it used INTO the room as new files, and
  answers from them with sources. After it finishes, web access should be back to
  how you left it (it should not silently stay on).
- **Bug if:** It never saves sources, or it leaves web on when it should not.

### B9. The Leash (room as an AI server) — advanced, optional
- **Do:** Settings → **Room server** → turn ON. Copy the config box.
- **See:** You can paste that config into another MCP app (like Claude Desktop /
  Cursor) and it can read the room. When you **lock** the room, that connection
  should stop working.
- **Bug if:** The server does not stop when you lock the room.

---

## After testing

- Make a short list: which steps PASSED and which had a BUG (with the step number
  and a screenshot for each bug).
- Note anything that looked ugly or confusing, even if it did not fully break.
- Two known limits (not bugs): the podcast is a script only (no audio yet), and
  the app is not notarized by Apple (normal for a test build).
