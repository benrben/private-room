# Computer-use check: Models & Spend

Paste everything below the line into a computer-use agent that can see and drive
this Mac's screen.

---

You are checking a newly built feature in a macOS app called **Arcelle**
(`/Applications/Arcelle.app`) — a private, local-first AI workspace. A new
Settings section called **Models & Spend** has just shipped. It is supposed to
show the user where their AI money and tokens go, and to let them choose how the
room picks a model.

Its single design theme is **honesty about money**: the app must never show a
number that overstates what it knows. Your job is to find where it fails that.

## How to work

**Try to falsify each check, not to confirm it.** A check passes only if you saw
the passing state with your own eyes. If you could not set up the conditions, the
result is **BLOCKED**, never PASS. Do not infer a pass from a similar-looking
screen, and never from this document.

For every check report exactly: `PASS` / `FAIL` / `BLOCKED`, one sentence on
**what you actually saw**, and a screenshot. When something fails, say what was
on screen instead of what you expected.

Take a screenshot before and after each interaction. Work slowly. If the app
becomes unusable, say so immediately and stop — that is the most important
finding you could report.

## Known-incomplete — do NOT report these as bugs

These are already known and deliberately unfinished. Finding them again wastes
your run:

1. **Economy mode does not change which model runs.** The mode and the dial save
   and display correctly, but nothing routes on them yet. Do not test whether
   picking level 0 makes answers cheaper — it will not.
2. **Summaries, AI actions, whole-file passes, studio, workflow generation and
   image/video generation record no spend.** Only chat and agent turns do. The
   section is supposed to SAY this (check 9 below tests exactly that).
3. **Codex costs will show as unknown**, because the price book is not wired to
   the catalogue yet.
4. There is no Custom mode and no per-role model picker. That is by design.

## Getting there

Open Arcelle, unlock a room, then **Settings → AI & behavior → Models & Spend**.
If you cannot find it, that is finding #1 — report it and stop.

---

## The checks

### 1. It opens at all
Open the section. It should render without an error banner. Note how long it
takes: it makes a network call to OpenRouter if a key is connected, and the
screen must not hang blank while that happens.

### 2. An empty room says so honestly
On a room where no AI call has been made, the chart area must say something like
"No calls recorded in this period yet." **FAIL if it shows `$0` in a way that
reads as "you have spent nothing" without qualification**, or shows an empty
chart with no explanation.

### 3. A real call actually lands
Go to a chat, ask the AI anything, and wait for the answer. Return to Models &
Spend. **A row must appear** — the call count for "chat" should go up by at least
one. FAIL if nothing changes after a completed answer.

### 4. Tokens are counted in both directions
After a few chat turns, look at the "Tokens in / out" column. **Both numbers must
be non-zero.** The output side is the expensive half and was historically not
recorded at all, so an out-column stuck at 0 is a real failure.

### 5. The local model is free, and says so
If the room runs a local (Ollama) model, its calls must show a cost of `$0` and
the local wallet card must carry a "free" badge. FAIL if a local call shows a
made-up dollar amount.

### 6. An unmeasured wallet shows words, not an empty gauge
Look at the wallet cards. Claude's card must **not** show a progress bar — Claude
publishes no quota API, so it should say something like "Not measurable" plus a
note explaining why. **FAIL if any provider shows a gauge sitting at 0% when the
app has no way to know the real figure** — that is the exact lie this feature was
built to stop.

### 7. Plan value is never added to real money
If Claude has been used, there may be a second total labelled roughly "plan value
used — not billed". **It must be a separate figure from the "charged" total, and
the two must never be summed anywhere on screen.** Read the numbers and check the
arithmetic yourself.

### 8. The dial states what it buys
Switch to Economy. The dial should read something like "Level 5 · up to $13.00
per million words out". Drag it across the whole range 0→10.
- The dollar figure must change at **every** notch — no two adjacent levels
  showing the same ceiling.
- At **level 10** it must say something like "no ceiling — best available".
  **FAIL if it shows a number like `$Infinity/M` or a blank.**
- Move the dial, leave Settings, come back. **The level must have been saved.**

### 9. It admits what it does not count
In Economy mode or out of it, the section must display a line naming the features
it does not yet record — summaries, AI actions, file passes, studio, workflow
generation, image/video. **FAIL if no such line appears anywhere**: without it the
totals silently understate spending, which is worse than showing nothing.

### 10. The privacy consequence is stated before the switch, not after
Switch to Economy mode. There must be a clearly readable sentence saying economy
mode does **not** use the model on your Mac, and that work which stays local
today would be sent to a paid provider. **FAIL if this is absent, or if it is
rendered smaller/fainter than the control it qualifies.** Screenshot it at normal
zoom so the relative size is visible.

### 11. Mode switching survives a restart
Set Economy, level 3. Quit Arcelle completely (⌘Q). Reopen, unlock, return to the
section. Mode and level must both be as you left them.

### 12. Nothing scrolls sideways
Resize the window narrow (about 900px, then as narrow as it goes). The tables may
scroll horizontally **inside their own box**, but the Settings pane itself must
never scroll sideways. Screenshot at the narrowest width.

### 13. Both themes
Switch the app between light and dark (Settings → Interface, or the system
theme). Every element in this section must stay legible — particularly the chart
bars, the gauge fills, and the "Not measurable" text. Screenshot both.

### 14. Keyboard and screen reader
Tab through the section. The two mode cards must be reachable and operable by
keyboard, and the dial must move with arrow keys. Turn on VoiceOver briefly: the
wallet gauges should announce as meters with a value, and the mode cards as radio
buttons.

### 15. Numbers that should look wrong
Look hard at every figure on screen and sanity-check it against reality:
- Does a total look absurdly large or small versus how much you actually used?
- Does any cost show more than 4 decimal places, or scientific notation?
- Does any row show a cost with no calls, or calls with a blank cost and no
  explanation?
- Does the "unpriced" annotation appear anywhere, and if so does it make sense?

Report anything that looks numerically implausible even if you cannot prove it.

### 16. Try to break it
- Open Models & Spend with no room unlocked. What happens?
- Drag the dial rapidly back and forth 20 times. Does it desync from the label,
  or spam errors?
- Open Settings, start a chat in another window/tab if possible, and watch
  whether the section updates or goes stale.
- Leave the section open for two minutes. Does anything flicker, reload, or
  reset?

---

## What to send back

1. The PASS / FAIL / BLOCKED table for checks 1–16.
2. Every screenshot, labelled with its check number.
3. A short list of anything you saw that no check above covers — especially
   anything that made you distrust a number on screen.
4. If you hit something that made the app unusable, put it first.
