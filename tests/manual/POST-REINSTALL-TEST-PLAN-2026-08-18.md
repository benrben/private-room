# Post-reinstall test plan — 2026-08-18

Arcelle v0.24.0, freshly built and installed. 537 changes across 237 files.

**How to read this.** Each check has a **Do** and an **Expect**. A check fails if the
Expect does not happen *exactly* — "close enough" is how the defects in this list
survived a green test suite for months. Anything marked **P0** is a must-pass;
if one fails, stop and report it rather than continuing.

Agent prompts are written to be pasted verbatim into the chat box.

---

## 0. Before you start

- Quit and relaunch Arcelle once, so you are testing the installed build.
- Have a room with: a `.md` note, a PDF, a spreadsheet (ideally semicolon-separated),
  a recording with a transcript, and at least one sketch.
- Settings → Cloud privacy: know where the switch and the block list are.
- Some checks need a `-cloud` Ollama model (§1.1) or a second machine (§1.2). Skip
  and note them if you cannot set them up — do not mark them passed.

---

## 1. The four P0s — must pass

### 1.1 The privacy door engages for `-cloud` models **P0**
This is the most serious bug fixed. It only reproduces on Ollama's *sized* cloud
tags — the ones written `gpt-oss:120b-cloud`, not `something:cloud`.

**Do**
1. Settings → Cloud privacy → ON. Add your own full name to the block list.
2. Set the room's model to an Ollama hosted tag of the `<size>-cloud` form
   (`gpt-oss:120b-cloud`, `qwen3-vl:235b-cloud`).
3. Ask: `Write one sentence about <YOUR FULL NAME>.`

**Expect** — the privacy indicator reports the door ENGAGED for this turn, and the
reply refers to a placeholder (`[Person A]`), not your real name.
**Fail** = your real name appears in the answer, or the indicator says nothing was
hidden. That means content left the Mac unredacted under a promise it would not.

### 1.2 The privacy door engages for a relayed Ollama (the Closet) **P0**
**Do** Settings → Connections → point Ollama at another machine's URL. Keep an
ordinary local-sounding model name (`qwen3.5:4b`). Cloud privacy ON, name in the
block list. Ask the same question as 1.1.

**Expect** the door ENGAGES — placeholder, not your real name. The model *name*
says local; the traffic is not, and the app now knows the difference.

### 1.3 Background jobs keep running after a recording is read **P0**
**Do**
1. Record ~30 seconds and press Stop. The recording is read automatically.
2. Wait for the read to finish.
3. Start any other background job — a deep summary, a file pass, a download.

**Expect** the new job **starts and completes**.
**Fail** = it sits at "queued" forever. Before this fix, the first recording read
never released the single work slot, so every later job stalled until restart.

### 1.4 Preview no longer eats unsaved note text **P0**
**Do** Open a `.md` note → Edit → type a sentence, do **not** save → click
**Preview** → click **Source**.

**Expect** your sentence is still there. ⌘S still saves. Closing the note still
warns about unsaved edits.
**Fail** = the text is gone (it used to be destroyed silently, and ⌘S and the
unsaved-edits warning went quiet with it).

---

## 2. Losing work — the guards

| # | Do | Expect |
|---|---|---|
| 2.1 | Edit a note without saving, press **Esc** | A prompt. Cancel keeps your text. |
| 2.2 | Edit a note without saving, click a **different file** in the Library | A prompt. Cancel leaves you where you were. |
| 2.3 | Edit a note, **⌘Q**, click **Cancel**, then **⌘Q again** | The dialog appears **again**. (It used to quit silently the second time and bin the buffer.) |
| 2.4 | With a file already open, press **⌘T** / "New page" | The new note opens **in edit mode with a cursor** — not read-only. |
| 2.5 | Edit a skill's SKILL.md, don't save, click another skill | A prompt, not silent loss. |
| 2.6 | Edit a skill's SKILL.md, don't save, add/remove a resource file | Your unsaved text survives. |
| 2.7 | Record ~90s, **⌘Q** while recording, reopen the room | The **last minute is still there** — audio and words. |
| 2.8 | Draw in a sketch, ask the room to draw into it, then press **⌘Z** | One undo removes the room's drawing. Your own shapes are not lost. |

---

## 3. Prompts to the agent, and what it should answer

Paste each verbatim. The point is the *shape* of the answer, not the wording.

### 3.1 Nonsense question — must admit no match
> `asdf qwerty kzzzt vorplex`

**Expect** it says it found nothing relevant in the room.
**Fail** = it answers using six unrelated chunks presented as "context from files
stored in this room". Before the fix, once anything was indexed, *no* question could
ever come back unmatched.

### 3.2 `#find` — must not return the whole room
> `#find asdf qwerty`

**Expect** "No matches found" (or similar).
**Fail** = a list of every chunk in the room.

### 3.3 Stop before the first word
> Ask anything long: `Write a 500 word essay about the sea.`
> Press **Stop** immediately, before any text appears.

**Expect** the transcript says the agent **was stopped**.
**Fail** = "the reply was lost before it reached the app… Please try again". That is
the app blaming itself for something you did — and inviting a retry that can double
a job.

### 3.4 A URL carrying a protected name (privacy ON, name in block list)
> `Save this link: https://example.com/search?q=<YOUR FULL NAME>`

**Expect** a refusal saying the URL carries protected names and must not leave the
Mac. Try the same with `download this file from <same URL>`.
**Fail** = it fetches. Before the fix only `fetch_page` was guarded; save/download
were open doors.

### 3.5 Image + cloud model + privacy ON
> Attach a screenshot and ask: `What is in this image?`

**Expect** either it answers from a **local** description, or it says the image was
**held back**. It must NOT claim "the image is attached to your context" while the
door strips the pixels.

### 3.6 Ask about a file by an ambiguous name
Have both `notes.md` and `old notes.md` in the room.
> `Rewrite notes.md so the first line is "Hello".`

**Expect** it edits `notes.md`, or asks which one you mean — and the message names
the file it actually wrote. **Fail** = it silently rewrites `old notes.md`.

### 3.7 Undo an AI edit
> Ask the agent to change a line in a note. Then press **Undo edit** on that answer.

**Expect** it restores the version *that answer* created. If you saved your own
changes since, it should refuse or warn rather than roll your work back onto the
AI's wording.

### 3.8 Ask the room to draw
> `#sketch a five column flow: Intake, Triage, Build, Review, Ship`

**Expect** the connectors actually meet the boxes, including the rightmost ones on a
wide page. **Fail** = arrows detached from the shapes on the right.

### 3.9 Browser — the agent and a new-window link
> Open a page with the private browser, then: `Click the first link that opens in a new tab.`

**Expect** the agent either navigates the page or says plainly it cannot open a new
window. **Fail** = it reports success and the journal records a URL you never visited.

---

## 4. UI / UX checks by page

### Create
- [ ] Start a generation. **No progress bar sitting at 0%** for the whole run — the
      fabricated one is gone; you should see a state that is either real or honest.
- [ ] A running generation can be **stopped** from the Create page.
- [ ] The "made in this room" grid does **not** list sketches or the room summary.
- [ ] If a model catalogue fails, the **other** tab keeps its models (and no message
      blames the provider for something that didn't happen).
- [ ] Typing in a shot title feels instant (it no longer rewrites the whole board per
      keystroke).

### Private browser
- [ ] The toolbar has **seven** controls, not eight — the Journal button is gone; the
      journal opens from the privacy chip.
- [ ] **Back / Forward are greyed out** when there is nowhere to go.
- [ ] Search from an open page: the results skeleton is **visible**, not painted under
      the live page.
- [ ] After searching there is a way **back to the page you were on**.
- [ ] The privacy claims match reality — no "nothing is written to disk" while the
      room keeps a web cache.
- [ ] Reading view and journal are not both on screen at once.

### Recording
- [ ] Playback **scrolls the transcript along with it**.
- [ ] Renaming a speaker is discoverable without hovering.
- [ ] "Reading this recording…" **clears** if the read fails.
- [ ] A recording with audio but no transcript offers a way forward (not "record more").
- [ ] The page says **which model** is reading it.
- [ ] Volume/playback-rate persist across recordings.

### Notes / viewers
- [ ] Markdown editor: Source / Split / Preview all keep your text (see 1.4).
- [ ] A `.txt` and a PDF each show **one** reading-progress stroke, not two.
- [ ] Slides never say "Drawing slide…" forever.
- [ ] An RTF doesn't claim its text can't be selected while showing selectable text.
- [ ] Open a **semicolon-separated CSV**, edit a cell in the grid, save, reopen —
      the value is in the right column and the row is intact.

### Settings
- [ ] Every switch you flip is still set after reopening Settings.
- [ ] Dragging from inside the sheet to outside does **not** close it.
- [ ] "Reset to Arcelle defaults" does what it says (or no longer says it).
- [ ] "Test connection" does not save a remote address that failed the test.
- [ ] The Model page's claim about images matches §3.5's behaviour.

### Chat
- [ ] It is clear at all times **which model** is answering and whether it's local.
- [ ] **Regenerate** does not duplicate your question in the transcript.
- [ ] **Edit & resend** respects the page scope you have set.
- [ ] Switching to Studio and back does not wipe the agent diagram.
- [ ] Attach 6 images — it either uses them or **says** which it dropped.

### Trash / files
- [ ] Open Trash with items, delete the **last** one. **The panel must not crash.**
- [ ] Restore from Trash puts the file back in the Library.

### Shell / navigation
- [ ] On launch, a rail row is **highlighted** (Home no longer starts with nothing lit).
- [ ] ⌘K, Home cards, and skill/workflow/script entry points all respect the
      unsaved-edits prompt (see §2.2).
- [ ] Escape closes popovers without closing the file behind them.
- [ ] Modals trap Tab — you cannot Tab out behind them.

---

## 5. Expected, not a bug

- **A file pass paused *before* this build will refuse to resume**, saying "The file
  changed since this pass started." That is the one-time cost of a fix: extraction no
  longer silently collapses repeated identical lines, so three identical ledger rows
  now reach the model as three rather than one. Restart the pass; nothing is lost.
- **No `arcelle-sidecar` process right after launch** is correct — it starts on demand.
- Long runs of identical lines in a document now show
  `[N more identical lines omitted]` instead of vanishing.

---

## 6. Regression watch list

Things most likely to be broken by 537 changes. Give each 30 seconds:

- [ ] App launches, unlocks, and the room opens where you left it.
- [ ] Import a file; it appears and is searchable.
- [ ] Ask one ordinary question and get one ordinary answer.
- [ ] Record 10 seconds, stop, transcript appears.
- [ ] Open one of each viewer you use (PDF, sheet, image, note).
- [ ] Lock and unlock the room.
- [ ] Quit and relaunch.

If any of these seven fail, that outweighs everything above — report it first.
