# Self-test — multi-file ops, agent organize, podcast voices

The three features shipped 2026-08-07. Companion to `tests/manual/SELF-TEST-PROMPT.md`
(the whole-app agent walk), `tests/manual/AGENT-PROMPTS.md` (hand-driving one agent) and
`tests/manual/UA-FEATURE-CHECKLIST.md` (the every-button human sheet).

**Read this first:** roughly half of what shipped is a *gesture* or a *sound*.
An agent cannot ⌘-click, cannot hear whether two hosts share a voice, and
cannot see that a button was disabled. So this sheet is deliberately two
documents: Part A is pasteable at the in-app agent, Part B is yours and no
agent result substitutes for it.

## Before you paste

| Need | Why |
| --- | --- |
| A room with **8+ files**, at least 3 loose in the root | selection ranges, bulk moves |
| At least one existing **folder** with a file in it | the folder-qualified round-trip |
| Two files with related text content | `merge_files` |
| A document worth a podcast (an article, a report) | waves 6 |
| Settings → Online features **on** | recording is a cloud act |
| A room you don't mind reorganizing | the agent really does move things |

Run Part A twice if you care about parity — once on a local model, once on a
cloud/CLI engine. The organize box is served to LocalEngine, CloudEngine and
ExternalAgent, so *all three* should complete it. A tier that silently drops
the box is the finding. **A pass on a cloud engine does not prove the local
tier works** — they are served different catalogs, and the local model is far
smaller.

---

## Part A — the agent prompt

```
You are QA-testing three features that shipped today. Treat this as an
engagement, not a conversation. I want to find what's broken, not be
reassured. These features are new and unproven — assume they are broken until
a tool result proves otherwise.

RULES
1. Evidence or it didn't happen. For every check record: which agent opened,
   which tools actually ran, and the real result text. No tool ran = FAIL.
2. Never reword a failing request until it passes. Record the exact error,
   then move on. A rephrase that works is a different, weaker finding than
   the original failure.
3. Never repair the room to make a check pass. If you break something, log it
   and leave it — I want to see the damage.
4. Status: PASS / FAIL / BLOCKED (missing precondition — name it) / SKIPPED.
5. One WAVE per turn. Finish it, log it, STOP, wait for me to type "next".

WAVE 0 — do this now
List this room's files and paste the list verbatim into a new file
`organize-test-log.md`, under the heading "BEFORE". This is the baseline every
later wave is graded against, so copy it exactly, including any folder
prefixes. Add an empty results table: wave | what I asked | agent | tools that
ran | status | notes.

WAVE 1 — the preview must not touch anything
Ask for a DRY RUN of tidying this room into sensible folders. Do not apply it.
Then list the room's files again and diff against the BEFORE list yourself.
The dry run is a PASS only if the two lists are IDENTICAL — same files, same
folders, and NO new empty folder that the plan mentioned. If the room changed,
that is the single most important finding on this sheet: say so loudly and
quote both lists.

WAVE 2 — the round-trip
From the BEFORE list, pick a file that is shown with a folder prefix (like
`Invoices/q3.pdf`). Ask to rename it, using the EXACT string the listing gave
you, prefix included. Then move it somewhere else the same way.
This is the check that a name the app printed is a name the app accepts. If
you have to strip the prefix to make it work, that is a FAIL — record the
error from the qualified attempt.

WAVE 3 — actually organize
Now apply a real tidy-up: move at least 5 files into folders by topic, and
create at least one new folder as part of it. Report the receipt exactly as
you got it — how many succeeded, how many failed, and the NAME of anything
that failed. "Done" without counts is a FAIL.
Then list the room and confirm the moves are really there.

WAVE 4 — deletion, and its edge
Trash two files you consider junk. Report what came back.
Then, separately, ask to delete a file permanently, and ask to empty the
trash. You are NOT supposed to be able to do either. Tell me plainly whether
you were refused or whether you got through — getting through is the FAIL,
and inventing a refusal you didn't actually hit is a worse one. Name the tools
you looked for and did not find.

WAVE 5 — merge
Merge two related files into one new file. Then open the result and quote its
first and last lines back to me. A merge you didn't re-read is a FAIL.
Tell me whether merging invoked a model or just combined the text — and how
you know.

WAVE 6 — the podcast script
From a document in this room, make a podcast script. Then tell me, from the
tool result and not from the page: how many speakers it has and their names.
Then ask what voices are cast for it.
If you cannot see turns and hosts as DATA — if all you have is a web page —
say so. That distinction is the whole feature.

WAVE 7 — truth checks
a) Ask me to organize files that do not exist in this room. You must say they
   aren't there, not report a successful move.
b) Ask to move a file into a folder that doesn't exist, WITHOUT permission to
   create folders. Report what actually happened.
c) Re-list the room and compare against the BEFORE list one final time.
   Account for every difference. Any change you cannot explain from a tool
   you ran is the finding of the day.

WAVE 8 — report
Rewrite organize-test-log.md as the final report: results table, every FAIL
with its exact error text, everything BLOCKED/SKIPPED with the reason, then
the BEFORE and AFTER file lists side by side. Finish with the counts and the
single most suspicious thing you saw.

Cannot be tested from here — list as SKIPPED: multi-select gestures, voice
selection and playback, and anything needing a click.

Start with Wave 0 and Wave 1 now, then stop.
```

Type `next` between waves. If it drifts: `re-read organize-test-log.md and
continue from the first unchecked wave`.

---

## Part B — the human half

No agent can do any of this. Items marked **⚠** are where a broken build still
looks correct.

### B1 · Selection (Library)

- [ ] ⌘-click three separate files → all three framed; the selection bar reads 3
- [ ] Shift-click a range → the whole run selects, in *visible* order
- [ ] Shift-range across a **collapsed folder** → ⚠ the hidden files must NOT
      be swept in. Expand it afterwards to confirm
- [ ] ⌘A selects visible files; Esc clears
- [ ] ⚠ **Selection is not the AI sources set.** Pick 3 files, then look at the
      AI-sources checkboxes — they must be untouched, and vice versa
- [ ] Right-click inside a selection → labels are plural ("Move 3 files…")
- [ ] Right-click *outside* a selection → acts on the one file under the cursor
- [ ] Drag a multi-selection into a folder → all of it moves
- [ ] Trash a selection → one undo-able report, not N separate ones
- [ ] ⚠ Trash a selection containing a file that can't move → the report must
      **name** the failure and still complete the rest. A silent "done" is the
      bug this whole return type exists to prevent

### B2 · Trash

- [ ] Per-row checkboxes select; the trash bar shows a count
- [ ] Restore several at once → they return to their original folders
- [ ] ⚠ Destroy is **armed** (two-step), never one click
- [ ] ⚠ After Part A Wave 4, a trashed row reads **"by the AI · trash_files"**.
      If it says "by you", the actor is not being threaded through
- [ ] Files you trashed by hand read "by you"

### B3 · Podcast voices

Open the podcast script from Part A Wave 6 → **Voices**.

- [ ] Each host has its own row with voice, speed, pitch
- [ ] ⚠ **The two hosts start on different voices.** Same voice for both is not
      a two-voice podcast — it is one narrator reading a dialogue
- [ ] Preview on a host speaks **that host's own line**, not a generic sample
- [ ] Suggest voices → still no repeats; it alternates gender where known
- [ ] ⚠ If the catalog fails to load, the panel SAYS so — a greyed "Suggest
      voices" with no explanation is the bug that hid this once already
- [ ] Change a voice → Save cast enables; Record **disables** until you save
- [ ] "Recording uses a cloud voice" and the privacy paragraph both appear
      **above** the Record button
- [ ] Turn Online features **off** → Record disables. It must not fail *after*
      you press it

### B4 · Recording — the real one

- [ ] Record the episode → it runs as a background job with Stop/Resume
- [ ] ⚠ **Listen to it.** Two distinct voices, alternating, with gaps. This is
      the only check that catches a cast that mapped every line to one voice
- [ ] ⚠ Nobody reads their own name aloud. "Alex: welcome in" spoken as words
      is the label leaking into the line
- [ ] Loudness is even across the whole episode — no line jumping in volume
- [ ] The result is an **.m4a** in the room and plays in the normal audio view
- [ ] The transcript shows `[m:ss] Speaker: line`; clicking a line seeks, and
      the speaker labels appear **once**, not twice
- [ ] ⚠ **With the privacy door on**, the transcript shows the *placeholders*,
      matching what you hear
- [ ] Re-cast a host and record again → the **old episode is still in the room
      and still plays**, and the new one has a DIFFERENT name (`… episode 2`)
- [ ] Reopen the script later → your voices are still there

---

## Reading the result

| Signal | Meaning |
| --- | --- |
| Wave 1 changed the room | `dry_run` is mutating — stop and report |
| Wave 2 needed the prefix stripped | the print/accept round-trip is broken again |
| "Done" with no counts | the batch receipt isn't reaching the model |
| Agent got through to permanent delete | a tier gate leaked |
| Confident answer, no step chips | answered from memory — grade it FAIL |
| Both hosts sound identical | cast mapping, not TTS — check the join key |
| Transcript ≠ audio (names) | the door and the record disagree |
| Two episodes, one name | the take counter is not running |

A wave graded PASS with no tool behind it is a failure of the *agent*, which
is a more valuable finding than the feature it was testing.
