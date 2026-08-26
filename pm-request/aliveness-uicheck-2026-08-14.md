# Computer-use check: the aliveness / honesty wave

Paste everything below the line into a computer-use agent that can see and
drive this Mac's screen.

---

You are checking a freshly installed macOS app called **Arcelle**
(`/Applications/Arcelle.app`) — a private, local-first AI workspace. A wave of
changes just shipped whose single theme was **honesty**: the app should never
show motion, progress, or a claim that does not correspond to something real
happening. Your job is to find where it still lies.

## How to work

**Try to falsify each check, not to confirm it.** A check passes only if you
saw the passing state with your own eyes. If you could not set up the
conditions, the result is **BLOCKED**, never PASS. Do not infer a pass from
code, from this document, or from a similar-looking screen.

For every check report exactly: `PASS` / `FAIL` / `BLOCKED`, one sentence on
**what you actually saw**, and a screenshot. When something fails, say what
was on screen instead of what you expected.

Take a screenshot before and after each interaction. Work slowly — several of
these are timing-sensitive and a fast click will miss the window.

### Do not

- Do not delete files, rooms, chats or recordings.
- Do not change the AI model, the provider, or any API key.
- Do not touch macOS System Settings privacy/permission toggles.
- If a check asks you to flip an app setting, **restore it immediately after**
  and confirm the restore on screen.
- If the app asks for a PIN or password you were not given, stop and report
  `BLOCKED — needs the owner to unlock`.

### Setup

1. Launch Arcelle from `/Applications` (double-click; do not run the binary
   from a terminal).
2. If a room needs unlocking and you have no PIN, stop and report BLOCKED.
3. **Any configured model works for almost everything here** — cloud (Codex,
   Claude, OpenRouter) or local. Asking the room a question is a normal,
   expected action: **go ahead and ask questions.** Do not skip a check merely
   because the room is on a cloud model.

   Only these two genuinely require a **local** model, because a local model
   does the work itself: **C2** (the privacy document scanner) and **I2**
   (automatic file describing — its setting literally reads "with the local
   AI"). Mark only those BLOCKED if no local model is installed.

4. **You may create test material.** Several checks need a file to import or a
   job to run. Make your own rather than waiting for one to be provided: add a
   new page/note in the room, or import a small text/markdown file you create
   in `~/Documents`. Creating and importing a small file is safe and expected —
   it is the only way to exercise the import and job paths.

5. Ask questions freely, but keep them cheap and about the room's own files
   ("summarise this file in one line"). If the room is on a **cloud** model, a
   privacy warning may appear — that is the app working, not a failure.

---

## Group A — Fabricated citations (highest priority)

The app can quote selected text into chat, stamped with the file it came
from. It used to offer that button for **any** text on screen, so text
selected in the chat pane itself came back stamped with an unrelated
document's name — a fabricated citation.

**A1.** Open a markdown, PDF or text file and select a sentence in it.
→ PASS: a **"Quote in chat"** button appears near the selection.
→ FAIL: no button.

**A2.** Click that button.
→ PASS: the quote lands in the composer attributed to **the document you
actually have open** — check the file name character by character.
→ FAIL: any other name, or no attribution.

**A3.** Now select a sentence **in the chat pane** — the agent's own reply
text, on the right-hand side.
→ **PASS: no "Quote in chat" button appears at all.**
→ FAIL: the button appears. If it does, click it and report exactly what file
name it stamped — that is a fabricated citation and the single most important
finding in this pass.

**A4.** Repeat A3 selecting text in the **sidebar** (file list) and in the
**top bar** / any settings panel.
→ PASS: no quote button anywhere outside the document body.

### A5–A8 — the formats that draw in their own frame (new)

These three used to offer no quote button anywhere, for a reason unrelated to
quoting. Each now has a second reading in the app's own page.

**A5.** Open a **saved web page / HTML file** (it shows `Page | Text | Source`
tabs). On the **Page** tab — the rendered page — select a sentence.
→ PASS: the **"Quote in chat"** button appears **over the rendered page**, and
clicking it quotes that sentence under that page's name.
→ FAIL: no button.

**A6.** Same file, **Text** tab. Select a sentence.
→ PASS: the button appears here too.

**A7.** Open an **e-book** (`.epub`). There is now a `Page | Text` pair in its
toolbar. Switch to **Text**.
→ PASS: the chapter's words appear as a plain readable page, and selecting a
sentence offers the quote button.
→ FAIL: no `Text` button in the toolbar, or no quote button on it.

**A8.** Open a legacy **`.doc` / `.rtf`** document. Same `Page | Text` pair.
→ PASS: `Text` shows the document's words and they can be quoted.

> On A7 and A8 the **Page** tab still offers no quote button, and that is
> correct — a book and a Word file are rendered with scripting fully disabled,
> and the app will not weaken that to sell a quote button. `Text` is where
> those are quoted.

**A10.** In the e-book, open **Contents** and select a chapter title in that
list. Then select the word **"Page"** or **"Text"** on a mode button.
→ **PASS: no quote button on either.** Those are navigation, and they sit
inside the same scroll region as the prose — quoting them would attribute the
app's own furniture to the document.
→ FAIL: the button appears over a chapter title or a toolbar label.

**A9 (the guard, if you can manage it).** A page that builds its text with
JavaScript rather than containing it will **not** offer a quote on the `Page`
tab. That is deliberate: the app only offers to quote wording it can find in
the file itself, so a page cannot invent a sentence and have it quoted under
its own name. If you have such a page, → PASS: no quote button. Report
`BLOCKED` if you have none — do not fake one.

---

## Group B — Progress bars that correspond to real work

The app runs **one job at a time**; the rest queue. A queued job has not
started, so it must not animate.

**B1.** Start two or more background jobs quickly in succession — e.g. import
two large documents, or ask for two file summaries back to back — so at least
one is forced to wait. Open the AI / activity pane.

→ PASS: the waiting row is labelled **"Queued"**, and its bar sits still at a
real position with a written count like `0/12` beside it.
→ FAIL: the queued row shows a **sliding, pulsing or indeterminate bar** — a
job that has not begun pretending to make progress.

**B2.** Look at the row that is genuinely **running** but has not yet reported
a step.
→ PASS: an indeterminate (moving) bar with **no** `n/total` number beside it —
it does not invent a quantity it doesn't have.
→ FAIL: a moving bar *and* a fraction, or a bar frozen at 100%.

**B3.** Turn on **System Settings → Accessibility → Display → Reduce Motion**,
then repeat B1/B2. *(This is the one system toggle you may change — restore it
afterwards.)*
→ PASS: the indeterminate bar stops animating and does **not** jump to a full
bar. A job that hasn't started must never look finished.
→ FAIL: the bar renders full.
→ Restore Reduce Motion to its previous state and confirm.

---

## Group C — Idle claims

**C1.** Open the AI / activity pane with nothing running.

The wording depends on whether this room has **any** past work, so check which
case you are in first — the pane shows a `HISTORY` section if it does.

- **Room with history** (the normal case): → PASS: the history section is
  labelled **"a record, nothing to act on"** (optionally "the N most recent of
  M — "). It must not present old finished work as if it were live.
  → FAIL: finished jobs shown without that qualifier, or any of them animating.
- **Room with no history at all** (a fresh room — create one only if that is
  easy and safe): → PASS: **"The room is idle. Work you start will show its
  progress here."**

The literal "The room is idle" sentence is the **empty-pane** state only. Seeing
the history label instead, in a room with history, is a PASS — not a failure.

**C2.** *(Needs a local model — the scanner is a local model reading files. If
none is installed, mark BLOCKED.)* Trigger a privacy document scan (Settings →
Cloud privacy → **Scan now**, with the privacy switch left **ON** — if it is
off, turn it on for this check and restore it after). While it is scanning,
look at the activity pane.
→ **PASS: it does NOT say the room is idle** — a scan is real work and the
pane must account for it.
→ FAIL: "The room is idle" while a scan is visibly running.

---

## Group D — The composer while the agent works

**D1.** Ask the agent any question. While it is thinking/answering, look at the
box you typed into.
→ PASS: the composer has a visible **pending-coloured border** — a still
border, not a pulsing or travelling one.
→ FAIL: no visual change at all, or an animated shimmer.

**D2.** While it is still working, **click into the composer**.
→ PASS: the normal focus outline appears and **wins** — you can clearly tell
the box is focused.
→ FAIL: the busy border swallows the focus outline and you cannot tell the box
has focus.

---

## Group E — "Scan now" when the door is shut

**E1.** Settings → **Cloud privacy**. Note the current position of the "Hide
private details from cloud AI" switch so you can restore it. Turn it **OFF**.
A warning ("The door is open") should appear.

**E2.** Now click **"Scan now"**.
→ PASS: a **visible error message explains why nothing can scan** while the
door is off, and the button returns to normal.
→ FAIL: nothing happens at all; or the panel says "Starting the scan" /
"Scanning…" and stays that way forever with the button stuck disabled.

**E3.** **Restore the switch to its original position** and screenshot it.

---

## Group F — Work is not destroyed underneath you

**F1.** Go to the **Create** page and type a long prompt — several sentences —
but **do not submit it**. *(Typing alone starts nothing and costs nothing; the
whole point is that the text is unsaved work sitting in a box. If there is no
Create page, any other page with a half-filled text box will do.)*

**F2.** Now open a file from the sidebar. While it opens, watch the screen
closely, then navigate back to the Create page.
→ PASS: your typed prompt is **still there**, and while opening you saw at most
an overlay laid *over* the page — the page underneath never blanked or
flashed away and rebuilt.
→ FAIL: the prompt is gone, or the page visibly tore down and came back empty.

**F3.** Try to open a file that fails to open if you can find one (a
corrupted/unsupported file). Same question: is the page underneath intact?

---

## Group G — Finishing jobs must not yank the screen

**G1.** Start a slow background job (import or summarise something large).
**Immediately** ask the agent a question, so the job will finish *while you are
mid-answer*. Watch the moment it finishes.
→ PASS: a **notification appears with an "Open" button** and you stay on the
answer you were reading.
→ FAIL: the app jumps you to the finished file, throwing away the answer in
progress.

**G2.** Now start the same kind of job with **no question in flight**, and wait.
→ PASS: when it finishes the app **opens the result directly** (no extra click
needed).
→ FAIL: nothing happens and you have to hunt for the result.

---

## Group H — Notifications that stay put

**H1.** Cause an error notification (E2 above will do).
→ PASS: the error message **stays on screen until you dismiss it**.
→ FAIL: it fades away on its own before you have read it.

**H2.** Cause an ordinary success notification with no button on it.
→ PASS: it disappears by itself after a few seconds.

---

## Group I — Off means off

**I1.** Find the setting that automatically describes/indexes imported files
(Settings → Behaviour, wording like auto-describe or automatic summaries).
Note its position. Turn it **OFF**.

**I2.** *(Needs a local model — this setting only ever drives the local one.)*
Import a document — **create your own** small `.md` or `.txt` file in
`~/Documents` and import that; do not wait to be given one. Watch the activity
pane for the next minute.
→ **PASS: no describe/summarise job appears at all.**
→ FAIL: a describing/indexing job runs anyway — the switch is decorative.

**I3.** Restore the setting.

---

## Group J — Steps that name what is happening

**J1.** Ask a question that forces the agent to search the room ("what do my
files say about X").
→ PASS: the step list shows **"Preparing the search…"** before any results
appear — the wait is accounted for rather than silent.

**J2.** *(NOT UI-CHECKABLE — do not report a failure here.)* The wording
`Sent the viewer to <thing> in "<file>"` is what the **model** is told after it
moves the viewer, not a step drawn on screen. It exists so the model cannot be
told the mark landed when only the instruction was sent. You will never see
that sentence in the UI; what you see is the model's own prose. Mark
`NOT CHECKABLE`.

What you CAN check: with a document open, ask the agent to point you at
something in it, then confirm the viewer really did move to that passage.
→ FAIL only if the answer claims to have highlighted something and the viewer
did not move at all.

---

## Group K — Chat list order

**K1.** Note the order of chats in the sidebar. Open an **old** chat and send a
message.
→ PASS: it moves to the top — the list is ordered by last activity.

**K2.** Start a **brand-new** chat and send nothing.
→ PASS: it appears at the top, not buried at the bottom. An empty chat with no
messages must fall back to when it was created.
→ FAIL: the new empty chat sorts to the very bottom.

---

## Group L — Sketch page

**L1.** Open or generate a sketch **that already has content** (ask the room to
draw one, or open an existing one).
→ PASS: strokes appear progressively, and the whole reveal finishes in about a
second — it does not crawl for many seconds on a complex drawing.

> **Drawing by hand is not part of this check.** The canvas only creates a
> shape from a drag that emits real `pointermove` events between press and
> release, and only past a small minimum size (so a stray click cannot litter
> the page with dots). A synthetic press-then-release with no movement in
> between correctly produces nothing. If you want to exercise the canvas, drag
> slowly across a wide area — but a failure here is more likely to be your
> input than the app, so report it as `INCONCLUSIVE — synthetic drag`, not
> FAIL.

**L2.** With **Reduce Motion** on (as in B3), open a sketch again.
→ PASS: the drawing appears **complete, immediately**, with no stroke-by-stroke
animation. Restore Reduce Motion afterwards.

**L3.** If you can make a sketch fail to parse, check that a **written note
explains the failure** rather than showing an empty canvas.

---

## Group M — Voice, if a voice is configured

**M1.** Turn on spoken replies and ask a question.
→ PASS: the first thing spoken is a **complete phrase**, not a two-word
fragment followed by a pause.

**M2.** If speech fails for any reason (no voice installed, offline, audio
device busy), → PASS: **a written message tells you speech failed.**
→ FAIL: silence with no explanation — the app looks broken rather than
degraded.

---

## Not checkable from the screen — do not guess

These shipped in the same wave but **cannot** be verified by driving the UI.
Mark them `NOT CHECKABLE` and do not report a pass:

- The idle timer no longer unloads the model inside its own warm window
  (a 35-minute behaviour).
- Locking the room winds that idle clock back.
- The memory budget now counts characters rather than bytes (visible only with
  a non-Latin script such as Hebrew, and only in what the model was sent).
- The screen-reading agent skips hidden text and removes its own overlay
  before acting.

---

## Report

Finish with a table: check ID → PASS / FAIL / BLOCKED / NOT CHECKABLE → one
line of what you saw. Then list the failures again in severity order, with
**A3 first if it failed**. Do not soften a failure and do not pad the report
with checks you did not actually run.
