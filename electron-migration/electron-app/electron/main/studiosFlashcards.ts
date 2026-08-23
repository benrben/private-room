/**
 * Port of `src-tauri/src/commands/studios/flashcards.rs` (309 lines, read in
 * full, including its `#[cfg(test)] mod tests`): the D5 flashcards Studio
 * artifact — a self-contained, CSS-only flip-card deck (no `<script>` at all,
 * so it renders inside WKWebView's network-blocked HtmlView iframe, which
 * refuses to run a model-authored page's inline scripts).
 *
 * WHAT IS REAL AND TESTED HERE: {@link StudioCard}, {@link flashcardsSpec}
 * (the artifact's `StudioSpec` — every field copied verbatim from
 * `flashcards_spec`), {@link fallbackFlashcards} (parses the model's
 * structured JSON, filtering any card missing a question or an answer),
 * {@link renderFlashcardsHtml} (the static flip-card grid — a hidden-but-
 * focusable checkbox drives a CSS-only 3D flip, reachable from the keyboard,
 * per the Rust source's own accessibility comments) plus
 * {@link FLASHCARDS_TEMPLATE} (copied character-for-character from
 * `flashcards.rs`'s own `r####"…"####`, lines 147-232) — AND, because the
 * dependency below turned out to be real rather than genuinely missing,
 * {@link studioFlashcards} (`#[tauri::command] studio_flashcards`) and
 * {@link execStudioFlashcards} (`agent.rs`'s `exec_tool` arm for it), both
 * driving the actual shared pipeline end to end.
 *
 * `studios.rs`'s shared `run_studio`/`run_studio_core` pipeline (845 lines —
 * Stop-flag/cancel-node registration, room-locked `gather_scope_text`/
 * `gather_files_text`, `resolve_structured_model`, the HTML-authoring primary
 * path, the JSON fallback, and the room-pinned `save_and_open` commit) is NOT
 * re-derived here. It is REAL, tested, and canonical in `studiosCmds.ts`
 * (read in full before writing this revision) — `runStudio`, `StudioSpec`,
 * `RunStudioDeps`, `RoomSource`/`RoomHandle`, `EmitFn`, `fillTemplate`, and
 * `STUDIO_FLASHCARDS_PROMPT` are all IMPORTED from there, never redeclared.
 * (An earlier revision of this file, written before `studiosCmds.ts` existed,
 * predicted this exact shape independently — as did the concurrent sibling
 * batch that ported `mindmap.rs` — and both have since converged on the one
 * real copy, matching `studiosMindmap.ts`'s own updated module doc: "REUSED
 * FROM THERE, not re-declared... which is precisely the 'second X shape'
 * this migration's own rules warn against.")
 *
 * WHY `deps: RunStudioDeps` IS A REQUIRED PARAMETER, not an optional seam
 * defaulting to a stub (the shape `studiosMindmap.ts`'s `studioMindmap` still
 * uses, written before `runStudio` was real): `runStudio` itself needs no
 * further port — it is `studiosCmds.ts`'s job, done. What only a live running
 * app can supply is a *live* `RoomSource`/`CancelState` (the open room, the
 * app-wide cancel-tree registry) — the exact same thing Rust's own
 * `state: State<'_, AppState>` is, which `studio_flashcards` ALSO never
 * defaults or stubs. Making `deps` required here is the more faithful port,
 * not a less cautious one: nobody calls `studio_flashcards(window, state,
 * ...)` in Rust without a real `state` either. A caller with no live
 * `RoomSource` (a unit test, today's absent host bootstrap) supplies a FAKE
 * one built from a real fixture room instead — which is exactly what this
 * file's own test does, and the honest thing rule 3 asks for: a real result
 * from real inputs, never a fabricated one from none.
 *
 * THE `exec_tool` ARM IS SHARED, AND IS NOT THIS FILE'S. `agent.rs` ~4299
 * dispatches `"studio_flashcards" | "studio_mindmap" |
 * "generate_podcast_script"` through ONE match arm differing only by `spec`.
 * This file used to carry a private, flashcards-shaped copy of that arm's
 * refs resolution, which is how `execTool.ts` ended up running the flashcards
 * tool and refusing the other two unconditionally (audit, 2026-08-23). The
 * arm now lives once, in `studiosCmds.ts`, as `resolveStudioRefs`/
 * `execStudio`; {@link resolveFlashcardsRefs} is a re-export of the former
 * under its original name and {@link execStudioFlashcards} is
 * `execStudio(deps, flashcardsSpec(), ...)`.
 *
 * `execTool.ts`'s three studio cases all call it, and all three refuse with
 * their own gap sentence ({@link EXEC_STUDIO_FLASHCARDS_GAP} for this one)
 * only while `ExecToolDeps.runStudioDeps` is `undefined` — no host bootstrap
 * builds a live `RoomSource`/`CancelState` yet, the same gap
 * `ExecToolDeps.downloadJob`/`.workflowRun` already document.
 */

import { htmlEscape, NOTEBOOK_CSS } from "./docsHtml.js";
import { jsonArray, valueStr } from "./jsonTools.js";
import type { FileMeta } from "./db-host/files.js";
import {
  execStudio,
  fillTemplate,
  resolveStudioRefs,
  runStudio,
  STUDIO_FLASHCARDS_PROMPT,
  type RoomHandle,
  type RoomSource,
  type RunStudioDeps,
  type StudioSpec,
} from "./studiosCmds.js";

export type { RoomHandle, RoomSource, RunStudioDeps };
export { STUDIO_FLASHCARDS_PROMPT };

// ============================================================================
// StudioCard — flashcards.rs's `StudioCard`
// ============================================================================

/** `#[derive(Serialize, Deserialize, Clone)] pub struct StudioCard`. `hint`
 * defaults to `""` (`#[serde(default)]`) — every construction site here
 * supplies it explicitly rather than relying on an optional field, matching
 * `studiosMindmap.ts`'s identical convention for `MindNode.parent`. */
export interface StudioCard {
  q: string;
  a: string;
  hint: string;
}

// ============================================================================
// the flashcards template — copied character-for-character from flashcards.rs's
// own `r####"…"####` (lines 147-232)
// ============================================================================

export const FLASHCARDS_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Flashcards</title>
<style>
__NOTEBOOK__
/* ---- the deck: index cards laid on the sheet ------------------------------
   Everything above comes from NOTEBOOK_CSS (docs_html.rs), which is the one
   inlined copy of src/styles/tokens.css. Nothing below may restate a colour;
   if a value is missing there, add it there. */
.wrap{max-width:52rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.eyebrow{display:inline-block;font-size:var(--fs-micro);font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.4rem}
h1{font-family:var(--sans);font-weight:700;font-size:var(--fs-page);line-height:1.15;letter-spacing:-.022em;color:var(--ink-strong);margin:.05rem 0 .3rem}
/* The standfirst carries the deck's only instruction, so it is set at reading
   size rather than at the metadata rung — an instruction is never set small. */
.sub{color:var(--ink-2);font-size:var(--fs-body);margin:0}
.rule{height:3px;width:66px;border-radius:3px 2px 4px 2px / 2px 4px 2px 3px;background:linear-gradient(90deg,var(--accent-fill),color-mix(in srgb,var(--mk-berry) 30%,transparent));margin:1rem 0 1.9rem}
/* \`min(15rem,100%)\`, not a bare 15rem: an auto-fill floor wider than the deck
   still lays out ONE 15rem column, which then runs past the right edge instead
   of collapsing to a single readable column. The deck is read inside the
   viewer's iframe, which in a split pane is routinely narrower than that. */
.deck{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(15rem,100%),1fr));gap:1rem}
.card{position:relative;display:block;height:12rem;perspective:1200px;cursor:pointer;transition:transform var(--dur) var(--ease-pen)}
.card:hover{transform:translateY(-2px)}
.card:active{transform:translateY(1px)}
/* The flip control, off-screen but reachable. \`hidden\` (display:none) took it
   out of the tab order, so the deck could only be used with a mouse; opacity
   leaves it focusable. The ring is drawn on the CARD, which is the thing the
   user is actually aiming at, and pointer-events stay off it so a click still
   lands on the label. */
.card .flip{position:absolute;top:0;left:0;width:1px;height:1px;margin:0;padding:0;opacity:0;pointer-events:none}
.card:focus-within{transform:translateY(-2px)}
.card:focus-within .face{outline:2px solid var(--accent);outline-offset:2px}
.card .inner{position:relative;display:block;width:100%;height:100%;transition:transform var(--dur-slow) var(--ease-pen);transform-style:preserve-3d}
.card input:checked + .inner{transform:rotateY(180deg)}
/* An index card is a physical object laid on the sheet, and it is the one
   thing in this document system that earns an opaque fill and a lift: a
   transparent front would show its own mirrored back through it mid-flip.
   \`overflow-wrap:anywhere\`: a card can hold a URL, a formula or a German
   compound, and an unbreakable run wider than the card used to push straight
   out of it — the face scrolls sideways rather than wrapping, and on the back
   of a flipped card that text is simply lost. */
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border:var(--stroke-w) solid var(--sketch);border-radius:var(--radius-lg);background:var(--surface);box-shadow:0 2px 10px var(--shadow-lift);padding:1.25rem;display:flex;flex-direction:column;text-align:center;overflow:auto;overflow-wrap:anywhere}
/* Centred with auto margins rather than by centring \`justify-content\`. A
   centred flex column puts half of any overflow ABOVE the scroll origin, where no
   scrollbar reaches it: the opening lines of a long answer were clipped and
   unrecoverable. Auto margins resolve to 0 as soon as the text outgrows the
   card, so it starts at the top and scrolls the whole way. */
.face>:first-child{margin-top:auto}
.face>:last-child{margin-bottom:auto}
/* The index-card tab: yellow is PENDING (a question you have not answered
   yet), green is DONE (the answer). The words "Q1" and "Answer" carry the
   same distinction, so the marker is never the only signal. */
.front{border-top:3px solid var(--sem-pending-fill)}
.back{transform:rotateY(180deg);border-top:3px solid var(--sem-done-fill)}
.tag{font-family:var(--sans);font-size:var(--fs-micro);font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-variant-numeric:tabular-nums;margin-bottom:.5rem}
.front .tag{color:var(--sem-pending)}
.back .tag{color:var(--sem-done)}
.txt{font-size:var(--fs-card);line-height:1.5}
.hint{margin:.6rem 0 0;font-size:var(--fs-meta);color:var(--ink-2)}
.tip{text-align:center;color:var(--ink-2);font-family:var(--hand);font-size:var(--fs-hand);line-height:var(--lh-hand);margin:1.7rem 0 0}
.empty{text-align:center;color:var(--ink-2);padding:3rem 0}
@media print{
  /* A printed card cannot be flipped, so print BOTH faces stacked: the deck
     becomes a study sheet instead of a page of unanswered questions. */
  .card{height:auto;perspective:none;transform:none;cursor:auto;break-inside:avoid;page-break-inside:avoid}
  .card .inner{transform:none!important;transform-style:flat}
  .face{position:static;transform:none!important;backface-visibility:visible;-webkit-backface-visibility:visible;box-shadow:none;overflow:visible}
  .back{margin-top:.4rem}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Flashcards</div>
  <h1>__TITLE__</h1>
  <p class="sub">__COUNT__ · click a card, or tab to it and press Space, to flip it</p>
  <div class="rule"></div>
  <div class="deck">__CARDS__</div>
  <p class="tip">Every answer is grounded in this room's files.</p>
</main>
</body>
</html>
`;

// ============================================================================
// render_flashcards_html — the static, script-free flip-card grid
// ============================================================================

/**
 * D5: render a flashcard deck as a self-contained HTML page. The cards are
 * built into STATIC markup (CSS-only flip, no JavaScript) so they render in
 * any sandbox — WKWebView refuses to run inline scripts inside the
 * network-blocked HtmlView iframe, which left a JS-built deck blank. Ported
 * verbatim from `render_flashcards_html`.
 *
 * The flip checkbox is off-screen but NOT `hidden` — `hidden` is
 * `display:none`, which takes it out of the tab order as well as off the
 * screen, so the deck would be mouse-only with no way to flip a card from the
 * keyboard and nothing for a screen reader to operate. The label wraps both
 * faces, so the control's accessible name still reads the whole card.
 */
export function renderFlashcardsHtml(title: string, cards: readonly StudioCard[]): string {
  let cardsHtml: string;
  if (cards.length === 0) {
    cardsHtml = '<p class="empty">No cards were generated.</p>';
  } else {
    let out = "";
    cards.forEach((c, i) => {
      const hint = c.hint.trim() === "" ? "" : `<p class="hint">Hint: ${htmlEscape(c.hint)}</p>`;
      out +=
        `<label class="card"><input type="checkbox" class="flip">` +
        `<span class="inner">` +
        `<span class="face front"><span class="tag">Q${i + 1}</span>` +
        `<span class="txt">${htmlEscape(c.q)}</span>${hint}</span>` +
        `<span class="face back"><span class="tag">Answer</span>` +
        `<span class="txt">${htmlEscape(c.a)}</span></span></span></label>`;
    });
    cardsHtml = out;
  }
  const count = `${cards.length} card${cards.length === 1 ? "" : "s"}`;
  return fillTemplate(FLASHCARDS_TEMPLATE, [
    // The notebook's palette, type and paper, spliced in from the one copy
    // in `docsHtml.ts` rather than restated here — see `NOTEBOOK_CSS`'s own
    // doc for why a standalone page has to inline it at all.
    ["__NOTEBOOK__", NOTEBOOK_CSS],
    ["__TITLE__", htmlEscape(title)],
    ["__COUNT__", count],
    ["__CARDS__", cardsHtml],
  ]);
}

// ============================================================================
// fallback_flashcards — parse the model's structured JSON, render the template
// ============================================================================

/**
 * Fallback: parse extracted cards and render the built-in flashcards
 * template. Ported verbatim from `fallback_flashcards`. Throws (Rust's
 * `Err(String)`) when the model returned no usable cards, matching
 * `studiosMindmap.ts`'s `fallbackMindmap` and every other `Result<String,
 * String>`-returning render function ported so far in this tree.
 */
export function fallbackFlashcards(raw: string, label: string): string {
  const cards: StudioCard[] = [];
  for (const c of jsonArray(raw, "cards")) {
    const q = valueStr(c, "q");
    const a = valueStr(c, "a");
    if (q !== "" && a !== "") {
      cards.push({ q, a, hint: valueStr(c, "hint") });
    }
  }
  if (cards.length === 0) {
    throw new Error("The model didn't return any usable flashcards — try a different file.");
  }
  return renderFlashcardsHtml(label, cards);
}

// ============================================================================
// flashcards_spec — the artifact spec for the shared run_studio pipeline
// ============================================================================

/** The flashcards artifact spec for the shared `run_studio` pipeline. Ported
 * verbatim from `flashcards_spec` — every field copied from the Rust
 * literal, field for field. `StudioSpec` is `studiosCmds.ts`'s canonical type
 * (see this file's own module doc for why it is imported rather than
 * re-declared); {@link STUDIO_FLASHCARDS_PROMPT} is that same file's real,
 * already-ported `STUDIO_FLASHCARDS_PROMPT` constant, re-exported above. */
export function flashcardsSpec(): StudioSpec {
  return {
    defaultPrompt: STUDIO_FLASHCARDS_PROMPT,
    pageRole: "You are a front-end developer building an interactive flashcards study page. Show a deck of cards the reader flips (click, or Space/Enter, or the arrow keys) to reveal the answer, with an optional hint, a card counter, and next/previous controls. Base every card only on the provided material — test real understanding, not formatting trivia.",
    workingLabel: "Designing your deck",
    fallbackStep: "Extracting question/answer pairs…",
    fallbackSchema: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              q: { type: "string" },
              a: { type: "string" },
              hint: { type: "string" },
            },
            required: ["q", "a"],
          },
        },
      },
      required: ["cards"],
    },
    fallbackSystem: "You turn study material into flashcards. Write clear question/answer pairs (and a short optional hint) that test understanding of the material — not trivia about its formatting. Base every card only on the provided text.",
    fallbackIntro: "Base every card only on this material about",
    fallbackTemp: 0.3,
    render: fallbackFlashcards,
    filenamePrefix: "Flashcards",
    // HTML-authoring stays primary here: this artifact is a PAGE, and
    // nothing downstream needs to read its parts back as data.
    structuredFirst: false,
    afterSave: undefined,
  };
}

// ============================================================================
// studio_flashcards — the Tauri command, driving the REAL shared pipeline
// ============================================================================

/**
 * `#[tauri::command] pub async fn studio_flashcards` — a Studio button in the
 * UI: its own root, nobody's child (`parent_run: None`, always — an
 * agent-triggered build passes its own `parent_run` instead; see
 * {@link execStudioFlashcards}). Ported verbatim from `studio_flashcards`,
 * minus the `window`/`state` Tauri handles `deps: RunStudioDeps` stands in
 * for. See this file's module doc for why `deps` is REQUIRED rather than an
 * optional seam defaulting to a stub.
 */
export async function studioFlashcards(
  deps: RunStudioDeps,
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  opId: string | null
): Promise<FileMeta> {
  return runStudio(deps, flashcardsSpec(), scope, instructions, refs, opId, null);
}

// ============================================================================
// exec_tool's "studio_flashcards" arm — agent.rs ~4299-4372, ported verbatim
// ============================================================================

/**
 * The name this file shipped `agent.rs`'s refs-resolution block under, before
 * that block was recognised as belonging to a SHARED arm. `studio_flashcards`,
 * `studio_mindmap` and `generate_podcast_script` are ONE `exec_tool` match arm
 * in Rust (`agent.rs` ~4299), differing only by `spec`, so its refs resolution
 * now lives once in `studiosCmds.ts` as {@link resolveStudioRefs} and is
 * re-exported here under its original name rather than kept as a second copy.
 */
export const resolveFlashcardsRefs = resolveStudioRefs;

/**
 * `agent.rs`'s `exec_tool` arm, bound to the flashcards spec — see
 * {@link execStudio} for the arm itself (`scope` always `null`, `parentRun`
 * threaded through, the exact `Ok(format!("Saved \"{}\" into the room.",
 * meta.name))` reply). Kept as a named binding because `execTool.ts` and this
 * file's own tests already call it, and because it documents which of the
 * three specs the flashcards tool dispatches with.
 */
export async function execStudioFlashcards(
  deps: RunStudioDeps,
  parentRun: string | null,
  args: Record<string, unknown>
): Promise<string> {
  return execStudio(deps, flashcardsSpec(), parentRun, args);
}

// ============================================================================
// EXEC_STUDIO_FLASHCARDS_GAP — what execTool.ts's arm still cannot do, and why
// ============================================================================

/**
 * {@link execStudioFlashcards} above IS the real arm logic — but running it
 * needs a live `RunStudioDeps` (a `RoomSource` over the app's actually-open
 * room, and the app-wide `CancelState` tree), and `execTool.ts`'s
 * `ExecToolDeps` carries only a bare `db`/`cancel` pair today, built fresh per
 * call rather than from a live room/cancel-tree singleton. No host bootstrap
 * in this migration constructs one yet (the same gap `studiosMindmap.ts`'s
 * own `studioMindmap` seam and `execTool.ts`'s `runAdvisorCli`/
 * `confirmDestructive` seams document for their own live-state dependencies).
 * Setting `ExecToolDeps.runStudioDeps` installs the real thing, one line, the
 * moment such a bootstrap exists.
 */
export const EXEC_STUDIO_FLASHCARDS_GAP =
  "studio_flashcards's real logic (studiosFlashcards.ts's execStudioFlashcards, driving " +
  "studiosCmds.ts's real, tested runStudio pipeline) IS ported — this arm just has no live " +
  "RoomSource/CancelState to run it with yet; ExecToolDeps carries only a bare db/cancel pair, " +
  "built fresh per call. Setting ExecToolDeps.runStudioDeps installs the real thing once a host " +
  "bootstrap can supply one.";
