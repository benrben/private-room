/**
 * Port of `src-tauri/src/commands/studios/podcast.rs` (355 lines, read in
 * full, including its `#[cfg(test)] mod tests`): the D12 podcast-SCRIPT
 * Studio artifact — a two-host conversation script, STRUCTURED-FIRST unlike
 * its `flashcards`/`mindmap` siblings (see {@link podcastSpec}'s own doc for
 * why: its turns must survive as DATA, because voices are assigned per
 * speaker and audio is later synthesized per line).
 *
 * WHAT IS REAL AND TESTED HERE: {@link podcastSpec} (the artifact's
 * `StudioSpec`, every field copied verbatim from `podcast_spec`),
 * {@link fallbackPodcast} (parses the model's structured JSON, defaulting the
 * title to the scope label), {@link renderPodcastHtml} (the ruled two-voice
 * transcript renderer, including the alternating-side rule) plus
 * {@link PODCAST_TEMPLATE} (copied character-for-character from
 * `podcast.rs`'s own `r####"…"####`) — AND {@link storePodcast}, the
 * `after_save` hook that persists the script's turns/cast as DATA (not just
 * markup) into the `podcasts` table, genuinely real end-to-end against the
 * now-committed `db-host/podcasts.ts` (`castFromTurns`/
 * `normalizeTurnSpeakers`/`savePodcast`/`stripSpeakerLabel` — a separate Rust
 * file, `db/podcasts.rs`, ported alongside this one because `store_podcast`
 * cannot be real without it). This is the one Studio generator whose
 * `after_save` hook is anything other than `undefined` — see
 * {@link StudioSpec.afterSave}'s own doc.
 *
 * GENUINELY UNPORTED DEPENDENCY when this file was first written, since REAL
 * and imported from its canonical home as of the concurrent `studios.rs`
 * batch (`studiosCmds.ts`, read in full before this update): the shared
 * pipeline `podcast.rs` itself is invoked through, `studios.rs`'s
 * `run_studio`/`run_studio_core` (845 lines — the Stop-flag/cancel-node
 * registration `register_studio_cancel`, room-locked `gather_scope_text`/
 * `gather_files_text`, `resolve_structured_model`, the HTML-authoring primary
 * path `generate_studio_html`/`clean_studio_html`, `safe_scope_name`, and the
 * room-pinned `save_and_open` commit) now lives in `studiosCmds.ts`, fully
 * tested there. {@link StudioSpec}/`RunStudioFn`/`fillTemplate`/
 * `STUDIO_PODCAST_PROMPT` — this file's own best-effort PREDICTIONS of that
 * future shared shape — are now imported and re-exported from there instead
 * of declared locally (unifying with `studiosMindmap.ts`'s independently
 * converged, near-identical prediction — see `studiosCmds.ts`'s own module
 * doc for the one real drift this removes: `afterSave`'s `db` parameter,
 * `unknown` there vs `Database.Database` here, now settled on the latter,
 * more precise type this file always needed for real). {@link
 * generatePodcastScript}'s `runStudio` seam still defaults to
 * `runStudioNotImplemented`, deliberately: `studiosCmds.ts`'s `runStudio`
 * needs a live `RoomSource`/`CancelState` only an app-wide host bootstrap can
 * construct — see that file's own module doc for exactly what still blocks
 * wiring `makeRunStudio(realDeps)` in here and into `execTool.ts`'s
 * `generate_podcast_script` arm. The Electron IPC contract
 * (`ipc-contract.ts`'s `start_studio_job`) also shows the eventual real shape
 * will run a studio build as a QUEUED JOB (`kind: "podcast"`, returning a job
 * id) rather than a blocking `FileMeta` return — a design choice for whoever
 * wires that bootstrap, not something this file anticipates.
 *
 * {@link generatePodcastScript} is still ported, as the injectable-seam shape
 * this codebase already established for exactly this situation
 * (`chatCommandsGenerate.ts`'s `transcribeAudio`/`layoutGraph`,
 * `studiosMindmap.ts`'s `studioMindmap`): it mirrors the real
 * `generate_podcast_script` `#[tauri::command]` (`run_studio(window, state,
 * podcast_spec(), scope, instructions, refs, op_id, None)`) exactly, minus
 * the two Tauri handles neither Electron nor this port has a replacement for
 * yet.
 *
 * `execTool.ts`'s `generate_podcast_script` ARM IS LIVE, and does NOT go
 * through {@link generatePodcastScript}, for the same reason
 * `studiosMindmap.ts`'s doc gives: the tool-calling entry point (`agent.rs`'s
 * `exec_tool`, ~4299) resolves the schema's file-NAME `refs` to ids itself
 * and passes `parent_run: turn.map(TurnId::run_id)` rather than this
 * wrapper's hard-coded `None` (the Owner-replacement-#3 fix that makes a Stop
 * on the asking run cancel a studio build it triggered). ONE Rust arm covers
 * all three studio tools, and one function covers it here:
 * `studiosCmds.ts`'s `execStudio(deps, podcastSpec(), parentRun, args)`,
 * which `execTool.ts` calls once `ExecToolDeps.runStudioDeps` is supplied.
 * (An audit of this batch found this arm refusing unconditionally even WITH
 * live deps, while its flashcards sibling ran — see `execStudio`'s own doc.)
 * {@link RUN_STUDIO_PIPELINE_GAP} is what that arm answers while no host
 * bootstrap can build those live deps, and what
 * {@link generatePodcastScript}'s own unfilled seam still refuses with.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { htmlEscape, NOTEBOOK_CSS } from "./docsHtml.js";
import { jsonArray, jsonStrField, valueStr } from "./jsonTools.js";
import type { FileMeta } from "./db-host/files.js";
import { getSetting } from "./db-host/settings.js";
import {
  castFromTurns,
  normalizeTurnSpeakers,
  savePodcast,
  stripSpeakerLabel,
  type PodcastHost,
  type PodcastTurn,
} from "./db-host/podcasts.js";
import {
  fillTemplate,
  STUDIO_PODCAST_PROMPT,
  type RunStudioFn,
  type StudioSpec,
} from "./studiosCmds.js";

export type { PodcastTurn };
export { STUDIO_PODCAST_PROMPT };
export type { RunStudioFn, StudioSpec };

// `fillTemplate` (`studios.rs`'s own small pure helper) is now imported from
// `studiosCmds.ts` — see this file's module doc. Not re-exported: unlike
// `studiosMindmap.ts`'s copy, this file's own local `fillTemplate` was never
// exported either, so there is no existing consumer to preserve a binding
// for.

// ============================================================================
// the podcast template — copied character-for-character from podcast.rs's
// own `r####"…"####` (lines 225-291)
// ============================================================================

export const PODCAST_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Podcast script</title>
<style>
__NOTEBOOK__
/* ---- the script: a ruled two-voice transcript -----------------------------
   Everything above comes from NOTEBOOK_CSS (docs_html.rs), the one inlined
   copy of src/styles/tokens.css. Nothing below restates a colour. */
.wrap{max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.eyebrow{display:inline-block;font-size:var(--fs-micro);font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.4rem}
h1{font-family:var(--sans);font-weight:700;font-size:var(--fs-page);line-height:1.15;letter-spacing:-.022em;color:var(--ink-strong);margin:.05rem 0 0}
.rule{height:3px;width:66px;border-radius:3px 2px 4px 2px / 2px 4px 2px 3px;background:linear-gradient(90deg,var(--accent-fill),color-mix(in srgb,var(--mk-berry) 30%,transparent));margin:1rem 0 1.6rem}
/* An INSTRUCTION — where to go to hear this — so it is set at reading size and
   in the "linked" blue rather than the pending yellow this note used to carry
   while audio was still unbuilt. Audio is a button now, and the note's only
   job is to say where that button is. */
.note{background:color-mix(in srgb,var(--mk-blue) 14%,transparent);border:var(--stroke-w) solid var(--sketch);border-left:3px solid var(--sem-linked-fill);border-radius:var(--radius);padding:.75rem .95rem;color:var(--ink);font-size:var(--fs-body);margin:0 0 2rem}
/* A ruled sheet: one pencil rule per turn, drawn across the page, with the
   transcript sitting on it rather than in a stack of bubbles. */
.script{counter-reset:cue;border-top:var(--stroke-w) solid var(--sketch)}
.turn{display:grid;grid-template-columns:2.6rem 7rem 1fr;column-gap:.9rem;padding:.9rem 0;border-bottom:1px solid var(--rule);counter-increment:cue}
/* The cue column is a pure CSS counter: deterministic, inert, and out of the
   accessibility tree, per the decoration rule. It is a TURN NUMBER and not a
   timecode — the model returns speakers and lines and no clock, so a printed
   timestamp would be a number this page invented. Mono with tabular figures,
   so the column rules straight down the sheet. */
.turn::before{content:counter(cue,decimal-leading-zero);font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:var(--fs-micro);color:var(--ink-muted);text-align:right;padding-top:.5rem;-webkit-user-select:none;user-select:none}
/* The speaker label is the one run of handwriting on the page: a name written
   in the margin is exactly the annotation the hand is for. Two voices are told
   apart by NAME first — it is always written out — so the hue is identity, the
   way tokens.css already gives each search engine a fixed marker ink, and
   never the only thing distinguishing them. */
.turn .who{font-family:var(--hand);font-size:var(--fs-hand);line-height:var(--lh-hand);text-align:right;padding-top:.15rem;overflow-wrap:anywhere}
.turn.a .who{color:var(--sem-saved)}
.turn.b .who{color:var(--sem-linked)}
/* \`min-width:0\`: a 1fr track floors at its content's min size, so one long
   unbreakable run in a line would widen the whole transcript rather than
   wrapping inside its column. */
.turn .line{padding-top:.15rem;min-width:0;overflow-wrap:anywhere}
/* Narrow frame (the viewer in a split pane): the margin column folds away and
   the name sits above its line rather than squeezing the transcript. */
@media (max-width:38rem){
  .turn{grid-template-columns:2.6rem 1fr;row-gap:.1rem}
  .turn .who{grid-column:2;text-align:left}
  .turn .line{grid-column:2}
}
@media print{
  .turn{break-inside:avoid;page-break-inside:avoid}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Podcast script</div>
  <h1>__TITLE__</h1>
  <div class="rule"></div>
  <div class="note">Open this file in Arcelle and use <b>Voices</b> to cast each host and record the episode as audio.</div>
  <div class="script">
__ROWS__
  </div>
</main>
</body>
</html>
`;

// ============================================================================
// render_podcast_html — the ruled two-voice transcript renderer
// ============================================================================

/**
 * D12: render a two-host podcast script as a self-contained HTML transcript,
 * with the visible "audio is coming later" note. Turns are escaped and built
 * into static markup (no script needed). Ported verbatim from
 * `render_podcast_html`.
 */
export function renderPodcastHtml(title: string, turns: readonly PodcastTurn[]): string {
  let rows = "";
  // The FIRST distinct speaker ever encountered gets side "a"; every other
  // speaker gets "b" — a two-host script has exactly one of each, and a
  // third speaker (a model error) still renders rather than crashing.
  const speakers: string[] = [];
  for (const t of turns) {
    if (!speakers.includes(t.speaker)) {
      speakers.push(t.speaker);
    }
    const side = speakers[0] === t.speaker ? "a" : "b";
    rows += `<div class="turn ${side}"><div class="who">${htmlEscape(t.speaker)}</div><div class="line">${htmlEscape(
      t.line
    )}</div></div>\n`;
  }
  return fillTemplate(PODCAST_TEMPLATE, [
    ["__NOTEBOOK__", NOTEBOOK_CSS],
    ["__TITLE__", htmlEscape(title)],
    ["__ROWS__", rows],
  ]);
}

// ============================================================================
// fallback_podcast — parse the model's structured JSON, render the template
// ============================================================================

/**
 * Parse structured turns and render the built-in podcast template. The title
 * defaults to the scope label when the model omits it. Ported verbatim from
 * `fallback_podcast`. Throws (Rust's `Err(String)`) when the model returned
 * no usable turns, exactly like every other `Result<String, String>`-
 * returning render function ported so far in this tree.
 */
export function fallbackPodcast(raw: string, label: string): string {
  const titleField = jsonStrField(raw, "title");
  const title = titleField !== null && titleField !== "" ? titleField : label.trim();
  const turns: PodcastTurn[] = [];
  for (const t of jsonArray(raw, "turns")) {
    const speakerRaw = valueStr(t, "speaker");
    const speaker = speakerRaw === "" ? "Host" : speakerRaw;
    // The model states the name twice — as the field and again inside the
    // text. Strip it here, or the page prints the speaker in its own margin
    // column AND again inside the sentence.
    const line = stripSpeakerLabel(valueStr(t, "line"), speaker);
    if (line !== "") {
      turns.push({ speaker, line });
    }
  }
  if (turns.length === 0) {
    throw new Error("The model didn't return a usable script — try a different file.");
  }
  return renderPodcastHtml(title, turns);
}

// ============================================================================
// podcast_spec — the artifact spec for the (unported) shared run_studio
// pipeline
// ============================================================================

// `STUDIO_PODCAST_PROMPT` and `StudioSpec` (`studios.rs`'s own default
// instruction and per-artifact-spec shape) are now imported from
// `studiosCmds.ts` and re-exported above — see this file's module doc for
// the one real drift this removed (`afterSave`'s `db` parameter type).

/**
 * The podcast-script artifact spec for the shared `run_studio` pipeline.
 *
 * STRUCTURED-FIRST, unlike its two siblings — see the Rust source's own doc
 * on `structured_first`. The other studios produce a page and are done; this
 * one produces a SCRIPT that voices are later assigned to and audio rendered
 * from, and turns that only exist as markup cannot be spoken. Ported verbatim
 * from `podcast_spec`, every field copied from the Rust literal, field for
 * field.
 */
export function podcastSpec(): StudioSpec {
  return {
    defaultPrompt: STUDIO_PODCAST_PROMPT,
    pageRole:
      "You are a front-end developer building a podcast transcript page for a warm, two-host " +
      "conversation that explains the material. Lay every turn out as its speaker's name beside " +
      "what they said, keep the two voices easy to tell apart by name. Base every line only on the " +
      "provided material.",
    workingLabel: "Writing the conversation",
    fallbackStep: null,
    fallbackSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        // The CAST, named explicitly rather than inferred from the turns. A
        // model that writes "Ada" in turn 1 and "Ada Lovelace" in turn 7
        // produces two hosts, one of which has no voice — asking for the
        // roster up front is what makes the speaker field a reliable join
        // key.
        hosts: {
          type: "array",
          description: "The two recurring hosts, exactly as they are named in every turn",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              persona: { type: "string" },
            },
            required: ["name"],
          },
        },
        turns: {
          type: "array",
          items: {
            type: "object",
            properties: {
              speaker: { type: "string", description: "Which host is talking — the name only" },
              // Said out loud by a voice, so the NAME MUST NOT BE IN IT.
              // `speaker` already carries it; repeating it here makes the
              // host announce themselves before every line.
              line: {
                type: "string",
                description: 'Only the words this host speaks. Do NOT prefix it with their name — no "Ada:"',
              },
            },
            required: ["speaker", "line"],
          },
        },
      },
      required: ["title", "hosts", "turns"],
    },
    fallbackSystem:
      "You write a short two-host podcast script that explains material in a warm, conversational " +
      "back-and-forth. Name the two hosts in `hosts`, then use those EXACT names as the speaker of " +
      "every turn — never a variation, a nickname or a title. Each turn is what one host actually " +
      "says out loud, so write it to be READ ALOUD: no stage directions, no markdown, no bracketed " +
      "asides, and NEVER begin a line with the speaker's own name — `line` holds only the spoken " +
      'words, never "Ada:". Keep each turn to a couple of sentences and alternate between the ' +
      "hosts. Base everything on the provided text.",
    fallbackIntro: "Base it only on this material about",
    fallbackTemp: 0.5,
    render: fallbackPodcast,
    filenamePrefix: "Podcast script",
    structuredFirst: true,
    afterSave: storePodcast,
  };
}

// ============================================================================
// default_voice_ids — speech_cmds.rs's cached_voice_ids, a small pure slice
// ============================================================================

/** `speech_cmds.rs`'s own `VOICE_CATALOG_KEY` const. */
const VOICE_CATALOG_KEY = "voice_catalog_ids";

/** `db::get_setting`'s key for the room's chosen neural voice (Settings →
 * Spoken voice). */
const VOICE_NEURAL_ID_KEY = "voice_neural_id";

/**
 * The ids `speech_cmds.rs`'s `remember_voice_ids` last cached, in order —
 * ported verbatim from `cached_voice_ids` (speech_cmds.rs:186-194). Ported
 * locally as a small pure helper rather than as a `speechCmds.ts` module:
 * `remember_voice_ids` itself (the network-calling half that POPULATES this
 * setting) has no Electron port, and {@link defaultVoiceIds} only ever reads
 * what a previous session already cached — matching this migration's
 * established convention for a small pure slice of an otherwise-unported
 * file (`chatCommandsGenerate.ts`'s local `mediaKind`, a slice of `stt.rs`).
 */
function cachedVoiceIds(db: Database.Database): string[] {
  const raw = getSetting(db, VOICE_CATALOG_KEY) ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Distinct voices to open a new cast with, best-first. Ported verbatim from
 * `default_voice_ids`.
 *
 * The room's OWN chosen voice leads the list, so the first host sounds like
 * the voice the user already decided they like. An empty list (a room that
 * has never opened Settings → Spoken voice) is fine and common —
 * {@link castFromTurns} then leaves every host's voice id blank, which
 * everywhere else means "the product default".
 */
export function defaultVoiceIds(db: Database.Database): string[] {
  const ids: string[] = [];
  const chosen = getSetting(db, VOICE_NEURAL_ID_KEY);
  if (chosen !== null && chosen !== "") {
    ids.push(chosen);
  }
  for (const v of cachedVoiceIds(db)) {
    if (!ids.includes(v)) {
      ids.push(v);
    }
  }
  return ids;
}

// ============================================================================
// store_podcast — the after_save hook: persist the script as DATA
// ============================================================================

/**
 * Persist the script as data once its page is saved: the turns, the cast,
 * and the voice each host will read in. Ported verbatim from `store_podcast`
 * — real end-to-end against `db-host/podcasts.ts` (a separate Rust file,
 * `db/podcasts.rs`, ported alongside this one specifically because this hook
 * needs it for real; see this file's module doc).
 *
 * Runs on the studio's `after_save` hook, so a failure here costs the extras
 * (voices, audio) and never the page — `run_studio_core`'s own caller
 * catches and logs rather than propagates (see the Rust source's own
 * comment); this function still THROWS on a genuine failure (empty turns),
 * matching the Rust `Result<(), String>` return, and the (unported) caller
 * is responsible for not letting that fail the whole build.
 *
 * Throws when the model's turns were entirely unusable — Rust's `Err(
 * "the script had no usable turns")`.
 */
export function storePodcast(db: Database.Database, fileId: string, raw: string): void {
  const titleField = jsonStrField(raw, "title");
  const title = titleField !== null && titleField !== "" ? titleField : "Podcast";

  const turns: PodcastTurn[] = [];
  for (const t of jsonArray(raw, "turns")) {
    const speakerRaw = valueStr(t, "speaker");
    const speaker = speakerRaw === "" ? "Host" : speakerRaw;
    // The model states the name twice — as the field and again inside the
    // text. Strip it here, or the host reads their own name aloud.
    const line = stripSpeakerLabel(valueStr(t, "line"), speaker);
    if (line !== "") {
      turns.push({ speaker, line });
    }
  }
  if (turns.length === 0) {
    throw new Error("the script had no usable turns");
  }

  // The model's own `hosts` roster leads, because it is the one place the
  // cast is stated rather than inferred; the turns fill in anyone it forgot
  // to list but did give lines to.
  const declared: PodcastTurn[] = [];
  for (const h of jsonArray(raw, "hosts")) {
    const name = valueStr(h, "name");
    if (name !== "") {
      declared.push({ speaker: name, line: "" });
    }
  }
  const ordered: PodcastTurn[] = [...declared, ...turns];
  const cast: PodcastHost[] = castFromTurns(ordered, defaultVoiceIds(db));
  // Fold every line's speaker onto the cast's spelling BEFORE storing, so the
  // voice lookup, the audio transcript and the panel all join on one string.
  normalizeTurnSpeakers(turns, cast);
  savePodcast(db, fileId, title, turns, cast);
}

// ============================================================================
// generate_podcast_script — the Tauri command's shape, as an injectable seam
// ============================================================================

// `RunStudioFn` (`studios.rs`'s shared `run_studio` pipeline's calling shape)
// is now imported from `studiosCmds.ts` and re-exported above — see this
// file's module doc. Absent from {@link generatePodcastScript}'s default
// parameter means it refuses rather than fabricating a saved file.

export const RUN_STUDIO_PIPELINE_GAP =
  "studios.rs's shared run_studio pipeline (register_studio_cancel, gather_scope_text/" +
  "gather_files_text, resolve_structured_model, generate_studio_html/clean_studio_html, " +
  "safe_scope_name, and the room-pinned save_and_open commit) is now REAL and tested " +
  "(studiosCmds.ts's runStudio/makeRunStudio), but wiring it into generate_podcast_script needs " +
  "an app-wide host bootstrap that can build a live RoomSource/CancelState for it (the same gap " +
  "ExecToolDeps.downloadJob/.workflowRun already document for their own job-queue-backed arms), " +
  "so generate_podcast_script still cannot actually build and save a podcast script through THIS " +
  "wrapper. podcast.rs's own half — the StudioSpec, the structured-extraction fallback, the ruled " +
  "two-voice transcript HTML renderer, AND the after_save hook that persists the script's turns/" +
  "cast as data (db/podcasts.rs, a separate Rust file also ported this batch) — IS ported and " +
  "tested (studiosPodcast.ts, db-host/podcasts.ts).";

export const RUN_STUDIO_NOT_IMPLEMENTED = `NOT_IMPLEMENTED: ${RUN_STUDIO_PIPELINE_GAP}`;

export const runStudioNotImplemented: RunStudioFn = () => Promise.reject(new Error(RUN_STUDIO_NOT_IMPLEMENTED));

/**
 * `#[tauri::command] pub async fn generate_podcast_script` — a Studio button
 * in the UI: its own root, nobody's child (`parent_run: None`, always — an
 * agent-triggered build passes its own `parent_run` by calling `runStudio`
 * directly instead; see this file's module doc for why that path does not go
 * through this wrapper). Ported verbatim from `generate_podcast_script`,
 * minus the `window`/`state` Tauri handles `runStudio` would need internally
 * once it is real.
 */
export async function generatePodcastScript(
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  opId: string | null,
  runStudio: RunStudioFn = runStudioNotImplemented
): Promise<FileMeta> {
  return runStudio(podcastSpec(), scope, instructions, refs, opId, null);
}
