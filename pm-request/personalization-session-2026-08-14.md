# Personalization session — spoken, drawn, and built by the fleet

**Date:** 2026-08-14 · **Status:** design + plan. Nothing built, nothing green-lit.
**Ask:** one button. The room walks the user through the files it already holds, talks and draws
on a canvas *at the same time*, keeps a real back-and-forth (say "wait, stop" and it stops), and
at the end saves a personalization that reshapes the app around what that person actually wants.

**Supersedes the first pass of this document.** What changed, and why:

| First pass said | This says | Because |
|---|---|---|
| The Web/Main agent leads; the tour is a browse | **`creator.draw` leads** — the Drawing agent, tag `*sketch`. The session is a drawing act with a voice. | Owner correction. It is also the right worker: `react_verify` + a `read_drawing` probe means it already draws, *measures its own work, and corrects it* (`agents.py:1050-1090`). |
| Barge-in is architecturally blocked; ship a Stop button | **Barge-in is solvable now, with no native engine** — exclude the echo by TIME, not by filtering. §4.1 | We control exactly when we speak. That makes AEC unnecessary rather than missing — and lets us turn `echoCancellation` off, which kills the system-wide ducking bug at the same time. |
| Speech and drawing fight over the round boundary | **One structured call per beat returns `{say, draw, expect}`** — two outputs, two lanes, neither of which touches the model. §4.2 | TTS runs in the sidecar and `draw` is a pure Rust parse + write. The only scarce resource is the model, and this uses it once per beat instead of twice. |
| A skill + a chat carries the session | **A conductor with two clocks**, driving the hub's specialists. §3 | The whole sub-domain roster is the point — and the human's thinking time is the fleet's compute budget. |

**One reading I had to fix in the ask:** "what kind of *Nintendo* they're looking for" is taken here
as **connections**. If it meant something else, §6.3's ladder is the part to rewrite.

---

## 0. In plain English

*Added 2026-08-16. This section says the same things as the rest of the document, without the
jargon. Nothing below it changed. If you only read one section, read this one.*

### What we would build

You press one button. The app then talks to you, out loud, for maybe ten or fifteen minutes.

While it talks, it draws. A picture builds itself on the screen in time with the words — your
files, the people who keep coming up, the shape of what you do. You can interrupt it out loud
("wait, stop") and it stops, like a person would.

It asks you real questions: what you're actually here for, what a good day looks like, what you
want it to stop doing. And while you're busy answering, it quietly goes off and reads your files
in the background — so a minute later it can say something like *"while we were talking I read
your last three recordings, and you keep coming back to the same two people — are those the ones
you meant?"*

At the end it doesn't just save notes. It **rebuilds the app around you**: how the AI talks to
you, which pages are in your sidebar, what the home screen suggests, plus a couple of small
automations it noticed you'd want. It shows you all of that on one screen as a list of proposed
changes, and nothing happens until you tick the ones you want and press Apply.

### Why bother

The app is already made of pieces the user is allowed to change — instructions, a role, sidebar
choices, home-screen suggestions, skills, scheduled jobs. Almost nobody changes them, because
doing so means finding seven settings screens and knowing what to type.

So we don't need to build a new "make your own app" feature. We need a conversation that fills in
the settings that already exist. That is the whole idea: **the app interviews you, and then writes
its own settings for you to approve.**

### The three hard parts, and the answer to each

**1. "Talking and drawing at the same time" — is that real, or a trick?**

It's real. Speaking, listening, and drawing are handled by three different parts of the machine,
and none of them is the AI model. Only *deciding what to say and draw* needs the model. So the app
asks the model once — "what's the next thing to say, and what should appear on the canvas?" — gets
both answers back together, and then plays the voice and paints the picture side by side. Because
we know how long the sentence takes to say, the drawing can appear over exactly that stretch of
time. That is the effect the ask is picturing: the picture drawing itself while the room talks.

**2. "Say stop and it stops" — three earlier attempts at this failed.**

They failed because they all tried the same thing: listen non-stop, and then try to *filter out*
the app's own voice from what the microphone hears. That is genuinely hard, and we lost that fight
three times.

This design stops fighting it. The app speaks in **short bursts of a few seconds**, and after each
burst it goes quiet for about three-quarters of a second and listens. During the burst, the
microphone is switched off in software — so the app can't hear itself, ever. It only listens in the
quiet gaps.

That change fixes three things at once:

- It stops the app interrupting itself.
- Speech recognition gets easier, not harder, because it's handling one short answer at a time
  instead of an ever-growing recording.
- It removes the reason we currently ask macOS for echo cancellation — which is the exact setting
  that makes **every other app on your Mac go quiet** while Arcelle's mic is open (that's the
  separate bug in `recording-call-audio-drop-2026-08-13.md`). This would be the first microphone
  feature in the app that doesn't duck your music or your call.

The honest catch: if you talk *over* the app mid-sentence, it won't hear you until the next gap,
so your first word or two can get clipped. The gaps come every few seconds, so the wait is short,
and there's still a Stop button on screen.

**3. "Many agents working at once" — on your Mac, that would be a lie.**

Your local setup runs **one AI model at a time**. Two separate parts of the code say so in their
own comments. Any design that claims five agents are thinking in parallel is describing a
cloud setup, or fibbing.

So this design does something better than pretending. The moment you start speaking your answer,
the app sends a specialist off to do real work — read your files, transcribe an old recording,
look something up on the web. Answering a question takes you five to twenty seconds. Right now
that time is dead air. Here it's the app's working time. The results come back and get worked into
the conversation a beat or two later.

That's why it *feels* like a team even though there's one model: the conversation never sits
waiting for the work, and the work happens in the pauses you were creating anyway.

### What you'd have when it finishes

Everything on this list is a setting that already exists in the app today. The session just fills
it in, based on what you said out loud:

| You said something like | The app proposes |
|---|---|
| "Keep it short, and never guess at someone's name" | a standing instruction the AI follows every time |
| "I'm here to build a professional network" | a role for the room |
| "I only really use Recordings, Sketch and Memory" | those pages pinned, in that order |
| "Show me who I owe a reply to" | that on the home screen |
| "A good intro is short and says why you're writing" | a reusable skill (saved switched off, for you to enable) |
| "Check that every Friday" | a scheduled job (also saved switched off) |
| "I'm a founder, my company is X" | a handful of facts it remembers |
| the whole conversation | a `Room profile.md` file and the drawing, both yours to keep |

### The rules this design refuses to break

- **The app never changes your settings by itself.** It can't, by design — settings are walled off
  from the AI in code, not just discouraged in a prompt. Everything it builds arrives as a draft
  for you to accept. We are not routing around that wall; we're using it. Seeing the app you're
  about to get, and choosing it, is the thing that makes this trustworthy rather than creepy.
- **If a piece breaks, the session keeps going and says what broke.** No microphone → you type. No
  voice → it writes instead of speaking, and says so once. Model crashed halfway → your answers
  are already saved to a file, so you resume instead of starting over.
- **The voice goes over the internet, and that has a consequence worth knowing.** Text sent to the
  speech service is redacted first, so the app would say *"[Person A] told me…"* out loud while the
  screen shows the real name. The fix is to design the spoken parts to talk about shapes and roles
  and leave the specifics on the canvas — and to disclose it up front. (A voice that runs on your
  Mac would remove the problem entirely; that's separate, unbuilt research.)

### How long, and what to do first

Six build phases, each one shippable on its own — but **do not start with phase 1.**

Start with the experiment in §5. It takes an afternoon and answers the one question the whole
design stands on: can the app hear "stop" in those quiet gaps, without hearing itself? We write
down the pass/fail numbers *before* running it, and we run the old broken way as a control so we
can see it fail. If the experiment fails, we lose one afternoon instead of six phases — and we
fall back to "works properly with headphones, plus a Stop button", which needs no change to
anything else in the design.

### Words this document uses

| Word | What it means here |
|---|---|
| **beat** | one short burst of speech, a few seconds long, plus whatever gets drawn during it |
| **gap** | the short silence after a beat, when the app is listening to you |
| **barge-in** | you talking over the app to interrupt it |
| **conductor** | the plain code that runs the session — decides the order, keeps the clocks, is not itself an AI |
| **specialist / worker** | one of the app's 16 existing background agents (file reader, transcriber, web searcher…) |
| **the fleet / the hub** | those workers as a group, plus the thing that hands out their work |
| **ducking** | macOS turning every other app's sound down while a mic is open |
| **AEC / echo cancellation** | the mic feature that causes the ducking above |
| **TTS / STT** | text-to-speech (the app talking) / speech-to-text (the app listening) |
| **4B** | the small AI model that runs on your Mac — fast and private, but it needs simple, one-shot jobs |
| **draft** | something the app built but did not switch on, waiting for you |

### One gap in this document

It refers several times to the **"ladders"** — the five directions a session can take, and the
ordered questions asked in each. Open question 1 and phase 4 both depend on them. **They are not
written down anywhere in this document.** Whoever picks this up needs to write them before phase 4,
and that work should start from the answer to open question 1 (whether "connections" is the right
reading of the ask).

---

## 1. Decisions at a glance

| Question | Decision | Why |
|---|---|---|
| Who leads? | **`creator.draw`** (`*sketch`), a sibling in the `file` domain | Owner's call, and the only worker whose template already closes a draw → measure → correct loop |
| How is "talk and draw at once" real? | **One model call per beat → `{say, draw, expect}`.** Speech goes to the TTS lane, the script to the `draw` lane. Neither is the model. | §4.2 |
| How is "wait, stop" real? | **Beat-gapped listening.** Short beats, a listening gap after each, mic audio fed to STT only during gaps. | The room's own voice is excluded by *time*. No AEC needed, therefore no VoiceProcessingIO, therefore **no ducking**. §4.1 |
| What does multi-agent buy on a one-model room? | **Not wall-clock parallelism — coverage and reliability.** Deep work is scheduled into the gaps *while the human is talking*. | `worker_parallel = 1` locally (`server.py:400-404`); one job slot (`jobs/queue.rs:4-6`). Honest constraint, designed around. §3.2 |
| How do specialists reach the conversation? | **A findings queue** the conductor drains at beat boundaries. | The conversation never blocks on an agent; agents feed the conversation. §3.3 |
| Who applies the result? | **The human, in a review sheet.** The fleet builds; the human accepts. | Settings is `data-agent-blocked` by design (`driver.ts:8-13`); there is no `set_setting` tool. §4.5 |
| New tables? | **None.** Chat + `.sketch` + a draft file + jobs rows. | The Sketch precedent (`sketch.rs:1-8`) |

---

## 2. The one constraint everything bends around

> **In plain words:** your Mac can only run one AI model at a time, so nothing here may pretend
> otherwise. But speaking, listening, drawing and reading your files don't need the model at all —
> only *deciding what to say* does. Three of the four things happening "at once" already can. The
> design's whole job is to spend that single model turn well, and the best time to spend it is
> while you're talking.

Two independent subsystems say the same thing, in their own comments:

- **The sidecar**: `worker_parallel = 1` on a local room, `CLOUD_WORKER_PARALLEL` otherwise
  (`server.py:400-404`). The batch tool's own description was *rewritten* to stop promising
  wall-clock parallelism, because "the model was planning against a promise the room cannot keep"
  (`agents.py:1636-1643`).
- **The job queue**: one running slot, a serialized FIFO, `MAX_QUEUED = 10`
  (`jobs/queue.rs:1-16`). Comment: *"no parallelism (one resident local model makes concurrent
  heavy work strictly slower), just no collision."*

So on a local room there is **exactly one model lane**. Any design that says "five agents talk
while it draws" is describing a cloud room, or lying.

**But the model is not the only lane.** Look at what the session actually needs:

| Lane | Runs where | Contends with the model? |
|---|---|---|
| Speaking | sidecar → Edge TTS (`tts.py`) | **No** |
| Listening | whisper.cpp, own thread, Metal (`stt_cmds.rs`) | **No** |
| Drawing | `sketchdoc.rs` — a Rust parser and a DB write | **No** |
| Reading the room | SQLite | **No** |
| Composing what to say and draw | Ollama | **Yes — and it is the only one** |

Three of the four things the user wants happening "at the same time" already are. The design's
whole job is to spend the single model lane well.

**And the best-spent model time is the time the human is talking.** A person answering "what would
count as this working for you?" takes five to twenty seconds. Today that is idle. In this design it
is the fleet's runway.

---

## 3. Architecture: a conductor and two clocks

> **In plain words:** two speeds running side by side. The **fast** one is the conversation — every
> few seconds, ask the model one question and get back three things: what to say, what to draw, and
> what to listen for. The **slow** one is the background research, handed out while you're talking
> and collected whenever it's ready. A finished piece of research becomes a note in a queue; at the
> next natural pause the app picks it up and mentions it out loud. The conversation never waits for
> the research — that's the whole trick.

### 3.1 The conversation clock (fast — one beat, 2–5 s)

A **beat** is the session's unit. One beat = one structured model call whose result is executed on
three lanes at once:

```
                 ┌─ say   → TTS lane      → speaks (2–5 s)
beat call ───────┼─ draw  → sketch lane   → elements reveal, synced to the audio clock
                 └─ expect→ listen lane   → what the following gap is listening for
```

It is **one call, not a tool loop**, which is why this works on a 4B: the model does the thing it
is reliable at (one structured emission), and everything else is executed by code. It also never
touches `ask-round`, so `voice.roundBoundary()` (`voice.ts:193-203`) — the thing that guillotines
narration mid-word today — is not in the path at all.

### 3.2 The deep clock (slow — the hub, in the background)

Everything that needs real agent work is dispatched to the specialist roster and **never blocks a
beat**. Dispatch happens at the start of a gap; results are collected whenever they land.

The roster, and where each member earns its place in this session (all 16 workers exist today,
`agents.py:433-1090`):

| When | Worker | What it does for the session |
|---|---|---|
| Opening | `files.read` | Survey: kinds, clusters, what is unfinished |
| Opening | `media.transcribe` | Any recording not yet transcribed — the richest material about *this person* |
| Opening | `media.video` | What is actually on screen in their videos |
| During | `chat.web` | "What does a good introduction look like in my field" — real research, arriving as a later beat |
| During | `chat.browse` | Open a specific page they named and read it |
| During | `jobs.run` | A whole-file pass over a long document they point at |
| During | `scripts.run` | Run a room script they say they rely on, to see what it produces |
| During | `connectors.use` | With consent: calendar and mail — the networking direction's raw material (gated, see §7) |
| After | `skills.author` | Write the skills the profile implies |
| After | `jobs.workflows` | Write and schedule the recurring run they asked for |
| After | `creator.studio` | A mind map of the profile |
| After | `creator.draw` | The final, clean version of the map |
| After | `files.read` | Write `Room profile.md` |
| Never | `app.ui` | Deliberately unused — the review sheet changes settings, not the agent (§4.5) |

The after-phase is one `ask_agents` call carrying the whole build as a task list with `depends_on`
— the exact shape that tool exists for (`agents.py:1611-1665`), and the graph already groups the
tasks into waves and runs each wave with `asyncio.gather` (`graph.py:1576-1610, 2014`).

### 3.3 The seam between the clocks: a findings queue

A finished deep-lane task appends a **finding** — one short paragraph, its worker's name, and any
files it produced. The conductor drains the queue at the next beat boundary and passes it into the
beat call as *"new since we last spoke"*. The room then says it out loud:

> "While we were talking I went and read your last three recordings — you keep coming back to the
> same two people. Are they the ones you meant?"

That sentence is the entire point of the multi-agent design, and it is only possible because the
conversation is not waiting on the work.

**Optionally, a second voice.** `api.speakTextNeural(text, voiceId)` already takes a per-call voice
and the roster is live (`list_neural_voices`). A finding could be spoken in a distinguishable voice
— which is how the app already thinks (the agent strip exists to make delegation *legible*). Flagged
as an option, not a decision: it may read as gimmick. The plain alternative is one voice that names
who reported.

---

## 4. The research, solved

Ordered by what it costs the wish. Each: the mechanism, why it works, and what would prove it wrong.

> **In plain words — the seven problems, and the answer to each:**
>
> | § | The problem | The answer |
> |---|---|---|
> | 4.1 | Interrupting it out loud has failed three times | Stop trying to filter the app's own voice out; just switch the mic off while it speaks and listen in the gaps |
> | 4.2 | Can it really talk and draw together? | Yes — drawing and speaking don't use the AI model, so both run off one model answer, and the drawing is paced to the length of the sentence |
> | 4.3 | "Many agents at once" isn't true locally | Don't claim it. Send background work off while the human is talking; never let the conversation wait on it |
> | 4.4 | Saving this as "memories" wouldn't stick | Memories are picked per question and capped, so a profile stored there applies on and off — which reads as *it forgot me*. Split it: behaviour into the standing instructions, the record into a file, a few odd facts into memories |
> | 4.5 | Who actually changes the settings? | You do. The AI is walled out of settings in code; it builds drafts, you approve them on one screen |
> | 4.6 | The voice is an internet service, and names get redacted | It would say "[Person A]" out loud while the screen shows the real name. Disclose it, and write the spoken lines to talk about roles rather than names |
> | 4.7 | Which files does the tour actually visit? | Ordinary code picks the route from what the app already knows. The model does the one thing only it can — talk about them, and listen |

### 4.1 "Wait, stop" — exclude the echo by time, not by filtering

**The reframe.** Three attempts failed trying to *filter* the room's own voice out of the mic
([[private-room-hands-free-voice-interrupt]]). But we do not need to filter what we can schedule
around: **we know exactly when we are speaking, to the sample.**

**The mechanism — beat-gapped listening.**

1. The session speaks in **short beats** (2–5 s) with a **listening gap** after each (~700 ms,
   tunable). Beat length is ours to choose: the chunker's cut sizes are constants
   (`MIN_CHUNK_CHARS`, `FORCE_FLUSH_CHARS` — `voice.ts:111-112`), and the session composes to fit.
2. **One mic session for the whole session**, opened once under the button's gesture, with
   `echoCancellation: false, noiseSuppression: false, autoGainControl: false`.
3. **Mic audio reaches the recognizer only during gaps.** The tap's push callback is ours, so a
   gate wraps it exactly the way `withSilenceGate` already does (`recordingActions.ts:38-60`).
   During a beat, frames are dropped at the tap; the room's own voice never reaches STT.
4. The gap ends early the moment speech is detected, or on a short timeout. A gap's audio is one
   short utterance — a fast, whole-buffer decode.
5. A gap transcript is classified in **code first** (a small interrupt vocabulary, "stop", "wait",
   "hold on", plus the Hebrew equivalents the codebase already carries elsewhere), and only
   ambiguous ones ride into the next beat call.

**Why this works where the other three did not.**

| Old failure | Why it does not apply |
|---|---|
| Whisper re-decodes the whole growing buffer, so a "stop" lands anywhere and gets slower (`stt_cmds.rs:600-617`) | A gap is ~1 s of audio, decoded on its own. The buffer never grows. |
| Whisper is unreliable on short isolated interjections | The gap decode is a whole utterance in a known slot, not an interjection hunted inside a stream. |
| A VAD fires on the room's own voice | During a beat the VAD is not listening. The gap is genuinely silent. |
| Sharing an `AudioContext` gives no AEC | No AEC is required. |

**Three problems it fixes at once.** The room's mic constraints today engage WebKit's
VoiceProcessingIO, which **ducks every other app on the Mac** for as long as the mic is open, and
our mute does not release it ([[private-room-recording-ducking-root-cause]]). Plain
`echoCancellation: false` takes the HAL path with no duck (never `{exact: false}` — WebKit
OverConstrained until Jan 2025). So this session becomes the app's **first mic feature that does
not duck the user's music or their call.** It also removes the growing-latency problem and the
self-interrupt problem in the same stroke.

**The honest limitation.** An interrupt spoken *over* a beat is only heard from the next gap on, so
the first word or two can be clipped. Bounded by beat length, which is a tunable constant. The
visible Stop control stays for the impatient case.

**The upgrade, cheap and already half-paid-for.** With **headphones there is no acoustic path**, so
the mic can be fed continuously and barge-in becomes true duplex. Detecting headphones is one
CoreAudio transport-type read — the *same* read the ducking fix wants (option B of that report), so
the two features split the cost.

**What would falsify this** — the Phase 0 experiment, §5:
- Per-gap `dict_start`/`dict_stop` costs more than ~150 ms, making gaps feel like stalls.
- STT accuracy collapses without `noiseSuppression` on a laptop mic.
- Reverb tails bleed into the gap (mitigated by forcing the clean archetype — the session's voice
  should be plain anyway; the ghost/wraith presets schedule up to 6 s of tail, `voice.ts:624`).

**One refactor this needs, named now.** `micConstraints()` reads module-global `voiceProcessing`
(`liveRec.ts:21, 80-92`), shared with recordings. The session must not flip the room's recording
setting to get its own constraints. The constraint set has to become an argument of the acquisition,
not a property of the module — small, contained, and a strict improvement on its own.

### 4.2 Talk *and* draw — one call, two lanes, one clock

`draw` is a Rust parser and a versioned DB write (`sketchdoc.rs:698-706`); TTS is a sidecar HTTP
call. **Neither uses the model.** So a beat that returns both `say` and `draw` executes them
concurrently, for free, and the model is spent once.

**The reveal is synced to the audio clock.** After decode, the chunk's duration is known
(`buf.duration`, used already at `voice.ts:591-595`), so the canvas can reveal the beat's new
elements across exactly the span of the sentence being spoken. That is the thing the ask is
picturing: the picture drawing itself while the room talks.

Storage stays one write — splitting a diagram into many `draw` calls is wrong twice over: each is a
model round trip (the stated reason there are two tools and not seven, `sketch.rs:9-23`) and each
snapshots into `file_versions`. Only the *paint* is staged.

The agent-edit merge path already exists and already preserves the user's in-progress strokes
(`mergeAgentDoc`, `viewers/sketch/model.ts:467-483`), so the user can draw on the same canvas
mid-session without losing work.

### 4.3 Multi-agent that is honest about one model lane

Three rules, and they are the difference between this feeling alive and feeling stuck:

1. **A beat never waits on a specialist.** Dispatch is fire-and-collect.
2. **Deep work is scheduled into the human's turn** — the gap where they are answering. That is the
   only genuinely free model time on a local room, and it is currently thrown away.
3. **At most two outstanding deep tasks**, because the queue has one slot and a cap of ten
   (`jobs/queue.rs:14-16`). Over the cap, the session drops the least valuable task **and says so**
   rather than silently thinning the fleet.

On a cloud engine the same design fans out for real (`CLOUD_WORKER_PARALLEL`) with no change — the
conductor does not care how fast the deep lane is, only that it is not in the way.

### 4.4 Memory cannot hold a personalization

`memories` is flat text rows (`schema.rs:140-153`); injection is capped at **1,500 characters**
(`commands.rs:246`) and keyword-selected *per question* (`agent.rs:1015`). A profile stored there
applies intermittently — which reads as "it forgot me". Split by how each part is used:

| Part | Goes to | Why |
|---|---|---|
| How the AI should behave for this person | `custom_instructions` | System prompt, **every** turn (`agent.rs:955-962`) |
| A named stance | `room_role` | Already first-class (`roles.rs:35`, injected `agent.rs:935-941`) |
| The full record | `Room profile.md` | Searchable, versioned, editable, re-readable by the agents |
| Facts that should surface opportunistically | 3–6 one-line memories | Exactly what the 1,500-char selector is good at |

**The trap:** `agent.rs:965-968` keeps the system prompt byte-stable so Ollama reuses the cached
prefix (40–65 % faster first token). Writing `custom_instructions` mid-session invalidates it.
Apply at the end — which is where it belongs anyway. Cap the operative block and say so in the
sheet; an unbounded blob taxes every future turn in the room.

### 4.5 The fleet builds; the human accepts

There is no `set_setting` tool in the catalog (`agent.rs:1639-1706` — the full reserved list, and
it is not there). Settings is `data-agent-blocked`, enforced in `driver.ts:8-13` rather than
trusted to a prompt, and nav prefs are not even in the database (`localStorage["prNav:v1"]`,
`navPrefs.tsx:78-140`).

Do not route around it — the precedent is already in the tree: `save_skill` deliberately saves a
skill **disabled, as a draft for human review** (`agent.rs:2317`). The session does the same at
scale. The after-phase fan-out *builds* everything — skills, workflows, the profile file, the map —
and every one of them lands as a **draft**. The review sheet turns drafts into the running room, one
row at a time, one click.

This is the moment that makes the feature trustworthy: the user sees the app they are about to get,
and chooses it.

### 4.6 The voice is an online, redacted seam

`speak_text_neural` refuses when the room's internet switch is off and redacts every sentence at
the seam (`speech_cmds.rs:12, 38, 45-49`). In a session about *this person*, the room would say
"**[Person A]** told me…" out loud while the screen shows the real name. Constantly.

Three parts, all cheap: disclose the seam in the consent step; **compose beats to speak roles and
shapes** while specifics live on the canvas (better session design regardless); and treat
offline as a **decided degrade** — text-and-canvas, said once, never half-spoken. No bypass. A local
voice would remove the seam entirely ([[private-room-kokoro-tts-research]], not built).

### 4.7 The tour needs a route, and the route is code

`list_room_files` / `search_room` / `open_file` exist, and `draw` already emits `agent-open-file`
(`sketch.rs:461`) so the canvas comes forward by itself. What is missing is *which files, in what
order, and why* — and a 4B asked to both choose and narrate will wander. The itinerary is built by
plain Rust from what the room already computes: kinds and counts, recency, the room map's clusters
(`moonshot/graph.rs`), the front page's recent set (`moonshot/front_page.rs`). The model does the
one thing only it can: talk about them, and listen.

---

## 5. Phase 0 — the experiment, before any of it is built

> **In plain words:** one afternoon, before anyone builds anything. Set the microphone up the new
> way, have the app speak twenty short bursts, and try to interrupt it each time. We write down
> what counts as failure *first*, so we can't talk ourselves into a pass afterwards: it has to hear
> you at least 9 times out of 10, never interrupt itself even once, never make other apps go quiet,
> and the gaps must not feel like the app is stalling. Then we run the same twenty tries the old
> broken way, and watch it fail — a test that can't fail proves nothing.

The whole design rests on one unproven claim. Prove it in an afternoon, on the real stack, before
writing a feature.

**Hypothesis.** With `echoCancellation:false` and the mic gated to gaps, a user's "wait, stop"
spoken into the gap is recognized within one beat, with no self-interruption and no ducking.

**Falsifiers, pre-registered:**

| Measure | Fails if |
|---|---|
| Per-gap `dict_start` → first frame → `dict_stop` → text | > ~150 ms overhead, or a gap that feels like a stall |
| Self-interrupt rate over 20 beats with the speaker at normal volume | > 0 |
| Interrupt recognition rate, 20 tries, laptop speaker + laptop mic | < 90 % |
| Word error on gap utterances, `noiseSuppression` off vs on | materially worse with it off |
| Other-app ducking, measured the way the ducking report measured it | any duck at all |

**Control:** the same 20 tries with today's constraints (`echoCancellation: true`) and continuous
listening — the configuration that failed three times. It should fail again, visibly. *Red proves
the test.*

If beat-gapping fails, the fallback is the headphone-gated path (§4.1) plus a Stop control, and the
native duplex engine goes back on the roadmap as its own project. **Nothing else in this design
changes** — that is deliberate: the beat engine's interface (`speak`, `gap`, `onInterrupt`) is the
same either way.

---

## 6. The build plan

> **In plain words — the six phases, and what exists at the end of each:**
>
> 1. **The talking machine.** Speaks, pauses, hears you, stops when told. No AI in it at all — the
>    script is hard-coded. Prove the hard part works on its own.
> 2. **Words and picture together.** Now the model decides what to say and draw, and the drawing
>    appears in time with the voice.
> 3. **The background team.** Research gets sent off while you talk, and comes back as "while we
>    were talking, I read…".
> 4. **The actual interview.** The questions, in order, per direction — and every answer written to
>    a file as you go, so a crash resumes instead of restarting.
> 5. **The build-out.** All the pieces get made at once — skills, the scheduled job, the profile
>    file, the map. Every one of them switched off, waiting.
> 6. **The approval screen.** Every proposed change in plain words, each one on a switch, one
>    Apply button.
>
> Each phase works on its own and ships on its own; none needs a later one. Each also comes with a
> test proven to fail on today's code first — otherwise the test proves nothing — and a decided
> answer to "what does the user see when this breaks?"

Six phases. Each ships something that works, has one red test proven on the unfixed code, and a
decided failure behaviour. No phase depends on a later one.

### Phase 1 — The beat engine
One module: speak a beat, open a gap, report what was heard, stop on demand. **No model anywhere.**
Driven in tests by a scripted list of beats.
*Red test:* mic frames arriving during a beat never reach the recognizer — proven against a naive
always-on tap first.
*Fails to:* no mic → typed answers; no voice → text beats. Never half-spoken.

### Phase 2 — The beat call and the canvas
The `{say, draw, expect}` structured call, the reveal synced to the audio clock, the itinerary
built in Rust (§4.7).
*Red test:* a beat that both speaks and draws does not lose its speech — proven against today's
`roundBoundary` path, which cuts it mid-word.
*Fails to:* a rejected `draw` script leaves the last good canvas and the beat is still spoken.

### Phase 3 — The deep lane
Dispatch into the gap, the findings queue, the two-task cap, "while we were talking…" beats.
*Red test:* a slow specialist never delays a beat.
*Fails to:* queue full (`QUEUE_FULL`) → the enrichment is skipped, named, and the session continues.

### Phase 4 — The interview
The ladder per direction, the direction classifier, the draft file that carries phase and answers
so nothing depends on chat history surviving compaction.
*Red test:* each direction's ladder covers its questions — one test, one promise per direction.
*Fails to:* model down mid-session → the draft holds every answer; the session resumes, not restarts.

### Phase 5 — The build-out
One `ask_agents` DAG with `depends_on`: skills, workflow, profile file, mind map, final map. Every
artifact a draft.
*Red test:* nothing is enabled or applied by this phase — assert no setting is written before the sheet.
*Fails to:* one task fails → the others still land; the sheet says which one didn't, and why.

### Phase 6 — The review sheet
Every proposed change in plain words, each row switchable, one Apply. Writes `custom_instructions`,
`room_role`, nav prefs, `front_page_suggestions`, enables the skills and the workflow.
*Red test:* a row that fails to apply does not roll back the others, and is reported — never a
silent partial.

### What the user ends up with

Every row already exists and is already user-writable. The session fills them in.

| They said | What gets written | Seam |
|---|---|---|
| "Keep it brief, never guess at a name" | `custom_instructions` | `agent.rs:955-962` |
| "I'm here to build a professional network" | `room_role` | `roles.rs:35` |
| "I only use Recordings, Sketch and Memory" | pinned nav areas + order | `navPrefs.tsx:78-140` |
| "Show me who I owe a reply" | `front_page_suggestions` | `front_page.rs:16` |
| "A good intro is short and names the reason" | a skill (draft) | `save_skill` |
| "Check that every Friday" | a workflow (draft) | `save_workflow` |
| "I'm a founder, my company is X" | 3–6 memories | `add_memory` |
| the whole conversation | `Room profile.md` + the `.sketch` | ordinary room files |

**This is the answer to "help them build a full app for themselves": the app is already made of
user-writable parts.** No app builder is needed. The static roles catalog is five hand-written
personas chosen from a list; this session writes the sixth one, out loud, with the fleet doing the
building.

---

## 7. Failure behaviour, per new I/O path

> **In plain words:** every new thing that can break has a decided answer to "what does the user
> see?" — written down now, not improvised later. The rule running through all of them: the session
> keeps going, degraded and honest, rather than stopping or pretending. Nothing is ever
> half-spoken, and nothing is silently skipped.

| Path | When it fails | What the user gets |
|---|---|---|
| TTS | offline, switch off, service refuses | text-and-canvas, one sentence saying why (the existing three-way wording already distinguishes the causes) |
| Mic | denied, busy, absent | typed answers; the existing three-way message names the real cause (`liveRec.ts:203-211`) |
| Gap decode | empty or noise | the gap simply ends; the session re-asks rather than guessing |
| `draw` | script rejected, element cap | last good canvas stands; the beat is spoken; the parse error is the agent's feedback loop, not the user's problem |
| Deep task | worker error, queue full | one finding saying so; the conversation is unaffected |
| Model | Ollama down | the draft file holds every answer so far; resume, don't restart |
| Apply | one row fails | the rest still apply; the sheet names the failure |
| Connectors | OAuth not authorized ([[private-room-connector-marketplace]]) | not offered at all — proposing a connector we cannot finish setting up is a broken promise |

---

## 8. Deliberately not in v1

- **Native duplex audio.** Only needed if Phase 0 fails, and it is its own project.
- **A local voice.** Would remove §4.6's seam entirely. Separate research.
- **Re-personalizing over time.** Watching how the room is actually used and offering to adjust is a
  real second feature, not a flag on this one.
- **`app.ui` driving Settings.** Never. The sheet does it.
- **Multi-room profiles.** Everything here is per-room, like every other setting.

---

## 9. Open questions for the owner

> **In plain words — what each answer actually changes:**
>
> | # | The question, plainly | If you don't answer |
> |---|---|---|
> | 1 | Your ask said "what kind of *Nintendo* they're looking for". I read that as **connections** — who they want to meet. Right? | The interview questions get written for the wrong goal. This one genuinely blocks the questions being written at all. |
> | 2 | Spend one afternoon proving the interrupt works before building anything? **Strongly recommended.** | We risk building six phases on top of an unproven guess. |
> | 3 | Should background findings be read out in a *different voice*, so you can tell them apart? | Falls back to one voice that names who found it. Nothing blocks. |
> | 4 | Calendar and mail are the richest material for the "connections" direction — and the biggest privacy step in the app. In, out, or ask each time? | Defaults to out, and the connections direction gets noticeably thinner. |
> | 5 | First build: one direction end to end (about a third of the work, proves the machine), or all five? | Defaults to one. Low risk either way. |
> | 6 | May the session save anything without asking? Today's answer is no — everything is a draft. The looser version saves notes and the profile as it goes, and only gates settings. | Stays strict. Safer, slightly more clicking. |
>
> Only **1** and **2** need answering before work can start. The rest have safe defaults.

1. **"Nintendo"** — read as *connections*. Confirm or correct; §6's ladder depends on it.
2. **Run Phase 0 first?** Recommended, strongly: one afternoon decides whether the headline
   requirement is buildable, and it is cheap to be wrong early.
3. **Second voice for specialist findings** (§3.3) — genuinely legible, or gimmick?
4. **Connectors in the session.** Calendar and mail are the networking direction's richest material
   and the biggest consent step in the app. In, out, or behind an explicit per-session yes?
5. **Scope of the first build**: one direction end-to-end (proves the machine, about a third of the
   work), or all five ladders?
6. **May the session write anything unattended?** This design says every artifact is a draft. The
   looser alternative — memories and the profile file save as you go, only settings gated — is
   defensible and faster to use.
