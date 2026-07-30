# Agent check — one prompt per agent

Live-QA sheet for the 14 workers + the hub. Every prompt below was verified
against `manager.resolve_worker` (2026-07-30), so if the hub picks the right
DOMAIN the sibling pick is guaranteed — a wrong agent means the hub mis-picked
the domain, which is the interesting failure.

Type these into the chat composer. Watch the **agent strip** for which agent
opened, and the **step chips** for which tools actually ran.

## Before you start

| Need | Why | Agents affected |
| --- | --- | --- |
| A room with a few files (a PDF/doc, a note) | most agents act on room content | File, Studio, Jobs, Transcription |
| Settings → Online features **on** | master internet switch | Web, Browser |
| Both lanes on ("Search the web" + "Use the private browser") | the two new toggles | Web, Browser |
| A **local** model (not claude-cli/codex-cli) | `include_ui_tools` is LocalEngine-only | **App agent** |
| An audio/video file in the room | something to transcribe / watch | Transcription, Video |
| A `.py` or `.js` in the room | something to run | Scripts |
| One connector configured | something to call | Connector |
| Whisper model installed | `stt_status` gates the lane | Transcription |

---

## 1. Main agent (hub) — `chat.answer`

```
hi, what can you do in this room?
```
Answers directly, delegates nothing. Its whole catalog is the ≤6 `ask_*_agent`
doors + `ask_agents`.

**Watch for:** it must describe only lanes this room actually has. A web-off
room must not offer "the internet" — that's the capability-truth invariant.

## 2. File agent — `files.read`

```
what does the contract say about the rent increase?
```
Should `search_room` / `open_file`, then answer with the passage on screen.

**Watch for:** an answer with no step chips = answering from memory about your
own files. That's the failure this agent's `react_verify` gate exists for.

## 3. Scripts agent — `scripts.run`

```
run the stocks.py script in this room
```
Fires `list_scripts` free (probe), then `run_script` → **approval prompt**.

**Watch for:** approve it; it must report the real stdout, not a summary of what
the script probably does.

## 4. Transcription agent — `media.transcribe`

```
re-transcribe the meeting recording, the speakers are wrong
```
`stt_status` fires free. If Whisper isn't installed you get a fixed honest
sentence and **zero model calls** — that's the `probe_gate_act` gate working,
not a bug.

## 5. Video agent — `media.video`

```
watch lecture.mp4 and tell me what is on screen at 12:30
```
`view_media_frame` grabs the frame and actually looks at it.

**Watch for:** a description that matches the frame. Hardware-composited video
renders blank in native snapshots — this path uses the driver's canvas instead.

## 6. Studio agent — `creator.studio`

```
make flashcards from my biology notes
```
Deterministic verb pick (`route_act`), so exactly one of
`studio_flashcards` / `studio_mindmap` / `generate_podcast_script` runs. Swap
"flashcards" for "a mind map" / "a podcast script" to check the other two.

## 7. Web agent — `chat.web`

```
what is the latest news about the election?
```
`chain_stage`: `web_search` **then** `fetch_page` — the fetch is structural, not
a suggestion.

**Watch for:** an answer citing a page it never fetched (search-snippet answer).

## 8. Browser agent — `chat.browse`

```
go to en.wikipedia.org and find Ada Lovelace's birth year
```
Should `browse_open` → then the free `browse_snapshot`/`browse_read`.

**Watch for (today's fixes):**
- The **first** step must be `browse_open`, *not* a failed `browse_snapshot`.
  Check the Journal — no `error` line at the start of the task.
- Then ask something unrelated (`list my files`). It must work. Before today's
  fix every tool after the first page open died with "main window is gone".

## 9. App agent — `app.ui`

```
open the Memory panel and show me around the app
```
`ui_snapshot` fires free each round, then one `ui_act` per round. You'll see the
ghost ring flash on each control it touches.

**Watch for:** settings/approval surfaces are fenced (`data-agent-blocked`) — it
must refuse those rather than click them. Needs a **local** model.

## 10. Jobs agent — `jobs.run`

```
translate the entire book into Hebrew
```
`start_file_pass` — a durable background job. Then:
```
how is it going?
```
→ `job_status`. Two exclusive verbs, picked deterministically.

## 11. Workflow agent — `jobs.workflows`

```
create a workflow that digests new files every morning at 8
```
`list_workflows` fires free (and carries the node grammar), then
`save_workflow` → a **draft** you activate on the Workflows page.

**Watch for:** it must call `test_workflow` and keep fixing until
`VALIDATED: yes` before telling you it's ready. Claiming "it works" without a
green test is the failure mode.

## 12. Skills agent — `skills.use`

```
use the invoice skill on this month's receipts
```
`list_skills` free, then `read_skill` and follow it.

## 13. Skill-builder agent — `skills.author`

```
create a new skill that teaches you how I format meeting notes
```
`save_skill` → a draft. Sibling discrimination is "use" vs "create/edit".

## 14. Connector agent — `connectors.use`

```
send my sister an email saying I'll be late
```
`search_mcp_tools` → `run_mcp_tool`, through the consent door with **real**
argument values.

**Watch for:** a failed send must NOT read as sent — that's this agent's
`react_verify` gate.

## 15. Connector setup agent — `connectors.admin`

```
what connectors are set up in this room?
```
`list_mcps` / `read_mcp`. Writes only produce **disabled** drafts.

---

## Cross-cutting checks (today's changes)

### The navigation override
With the browser lane **on**, all of these must open a page, never search:
```
go to Google and search for the best espresso machine
browse to google.com
navigate to google and look up the weather
visit nytimes.com
take me to my bank
pull up the wikipedia page for Ada Lovelace
לך לגוגל ותחפש מסעדות
כנס לאתר של הבנק
```
And the line it must not cross — these still **search**:
```
google the tallest building
what's the latest news
look up the current price of gold
```

### The two new lane toggles
| Setting | Prompt | Expected |
| --- | --- | --- |
| "Search the web" **off** | `what's the latest news?` | says it can't search — does **not** answer from memory |
| "Use the private browser" **off** | `go to example.com` | falls back to searching; Browser area still opens and its address bar still works |
| **both off** | `what's on the web about X?` | no web lane at all; still usable room |
| both back on | any prompt above | normal behaviour returns |

### Parallel delegation
```
summarize my newest file and also tell me today's weather
```
Two domains in one turn — should run as one round of parallel children, not two
sequential turns.

### Honest refusal
```
what's in my Dropbox folder?
```
Must say it can't, not invent contents.

---

## Reading the result

| Signal | Meaning |
| --- | --- |
| Agent strip | which agent opened |
| Step chips | which tools actually ran (green = ok, red = failed) |
| No chips + confident answer | **answered from memory** — the failure class to hunt |
| Journal (Browser area) | every browse action, and every browse failure |
| Token bar | context spend; a stalled bar with rounds passing = something looping |
