/**
 * Port of `src-tauri/src/commands/studios/mindmap.rs` (240 lines, read in
 * full, including its `#[cfg(test)] mod tests`): the D5 mind-map Studio
 * artifact — one central topic with a collapsible tree of branches, rendered
 * as STATIC nested `<details>`/`<summary>` (native disclosure, no JavaScript,
 * same sandbox reasoning as the flashcards artifact).
 *
 * WHAT IS REAL AND TESTED HERE: `MindNode`, {@link mindmapSpec} (the
 * artifact's `StudioSpec` — every field copied verbatim from `mindmap_spec`),
 * {@link fallbackMindmap} (parses the model's structured JSON, defaulting the
 * root to the scope label), and {@link renderMindmapHtml} (the recursive
 * `<details>` tree builder, including its depth cap and cycle guard) plus
 * {@link MINDMAP_TEMPLATE} (copied character-for-character from
 * `mindmap.rs`'s own `r####"…"####`).
 *
 * GENUINELY UNPORTED DEPENDENCY when this file was first written, since
 * REAL and imported from its canonical home as of the concurrent `studios.rs`
 * batch (`studiosCmds.ts`, read in full before this update): the shared
 * pipeline `mindmap.rs` itself calls into, `studios.rs`'s `run_studio`/
 * `run_studio_core` (845 lines — the Stop-flag/cancel-node registration
 * `register_studio_cancel`, room-locked `gather_scope_text`/
 * `gather_files_text`, `resolve_structured_model`, the HTML-authoring primary
 * path `generate_studio_html`/`clean_studio_html`, `safe_scope_name`, and the
 * room-pinned `save_and_open` commit) now lives in `studiosCmds.ts`, fully
 * tested there. {@link StudioSpec}/`RunStudioFn`/`fillTemplate`/
 * `STUDIO_MINDMAP_PROMPT` — this file's own best-effort PREDICTIONS of that
 * future shared shape — are now imported and re-exported from there instead
 * of declared locally, so every existing caller of this file (including
 * `studiosFlashcards.ts`, which imports these four names FROM this file) sees
 * no shape change. {@link studioMindmap}'s `runStudio` seam still defaults to
 * `runStudioNotImplemented`, deliberately: `studiosCmds.ts`'s `runStudio`
 * needs a live `RoomSource`/`CancelState` only an app-wide host bootstrap can
 * construct — see that file's own module doc for exactly what still blocks
 * wiring `makeRunStudio(realDeps)` in here and into `execTool.ts`'s
 * `studio_mindmap` arm.
 *
 * {@link studioMindmap} is still ported, as the injectable-seam shape this
 * codebase already established for exactly this situation
 * (`chatCommandsGenerate.ts`'s `transcribeAudio`/`layoutGraph`,
 * `recBridge.ts`'s `generate`): it mirrors the real `studio_mindmap`
 * `#[tauri::command]` (`run_studio(window, state, mindmap_spec(), scope,
 * instructions, refs, op_id, None)`) exactly, minus the two Tauri handles
 * (`window`/`state`) neither Electron nor this port has a replacement for
 * yet.
 *
 * `execTool.ts`'s `studio_mindmap` ARM IS LIVE, and does NOT go through
 * {@link studioMindmap}. The tool-calling entry point (`agent.rs`'s
 * `exec_tool`, ~4299) does MORE than call `studio_mindmap` verbatim: it
 * resolves the schema's file-NAME `refs` to ids itself and, critically,
 * passes `parent_run: turn.map(TurnId::run_id)` rather than
 * `studio_mindmap`'s own hard-coded `None` — the Owner-replacement-#3 fix
 * that makes a Stop on the asking run cancel a studio build it triggered.
 * That is ONE arm in Rust for all three studio tools, and it is one function
 * here too: `studiosCmds.ts`'s `execStudio(deps, mindmapSpec(), parentRun,
 * args)`, which `execTool.ts` calls once `ExecToolDeps.runStudioDeps` is
 * supplied. (An audit of this batch found this arm refusing unconditionally
 * even WITH live deps, while its flashcards sibling ran — see `execStudio`'s
 * own doc.) {@link RUN_STUDIO_PIPELINE_GAP} is what that arm answers while
 * no host bootstrap can build those live deps, and what
 * {@link studioMindmap}'s own unfilled seam still refuses with.
 */

import { htmlEscape, NOTEBOOK_CSS } from "./docsHtml.js";
import { jsonArray, jsonStrField, valueStr } from "./jsonTools.js";
import type { FileMeta } from "./db-host/files.js";
import {
  fillTemplate,
  STUDIO_MINDMAP_PROMPT,
  type RunStudioFn,
  type StudioSpec,
} from "./studiosCmds.js";

export { fillTemplate, STUDIO_MINDMAP_PROMPT };
export type { RunStudioFn, StudioSpec };

// ============================================================================
// MindNode — `mindmap.rs`'s `MindNode`
// ============================================================================

/** `#[derive(Serialize, Deserialize, Clone)] pub struct MindNode`. `parent`
 * defaults to `""` (`#[serde(default)]`) — every construction site here
 * supplies it explicitly rather than relying on an optional field, so there
 * is nothing for that default to paper over on the TS side. */
export interface MindNode {
  label: string;
  parent: string;
}

// `fillTemplate` (`studios.rs`'s own small pure helper) is now imported from
// `studiosCmds.ts` and re-exported above — see this file's module doc.
// `studiosMindmap.test.ts`'s own `fillTemplate` describe block still ports
// `studios.rs`'s two unit tests directly against that re-export, so no
// coverage is lost by removing the local copy that used to live here.

// ============================================================================
// the mind-map template — copied character-for-character from mindmap.rs's
// own `r####"…"####` (lines 151-214)
// ============================================================================

export const MINDMAP_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__ — Mind map</title>
<style>
__NOTEBOOK__
/* ---- the map: inked nodes, pencil connectors ------------------------------
   Everything above comes from NOTEBOOK_CSS (docs_html.rs), the one inlined
   copy of src/styles/tokens.css. Nothing below restates a colour. */
.wrap{max-width:50rem;margin:0 auto;padding:2.5rem 1.25rem 3rem}
.eyebrow{display:inline-block;font-size:var(--fs-micro);font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin-bottom:.4rem}
h1{font-family:var(--sans);font-weight:700;font-size:var(--fs-page);line-height:1.15;letter-spacing:-.022em;color:var(--ink-strong);margin:.05rem 0 0}
.rule{height:3px;width:66px;border-radius:3px 2px 4px 2px / 2px 4px 2px 3px;background:linear-gradient(90deg,var(--accent-fill),color-mix(in srgb,var(--mk-berry) 30%,transparent));margin:1rem 0 2rem}
/* Connectors are PENCIL — a guide line drawn before the ink, not a frame. The
   spine runs down each branch and an elbow reaches out to every node. */
ul{list-style:none;margin:0;padding-left:1.5rem;border-left:var(--stroke-w) solid var(--rule)}
ul.tree{border-left:none;padding-left:0}
li{position:relative;margin:.4rem 0}
ul:not(.tree)>li::before{content:'';position:absolute;left:-1.5rem;top:1.2rem;width:1.1rem;border-top:var(--stroke-w) solid var(--rule);pointer-events:none}
details{display:block}
/* Nodes are FRAMES DRAWN ON THE SHEET: transparent, so the dotted grid runs
   under the whole map, with the pen as their outline. min-height keeps the
   smallest node a 24px target. */
summary,.leaf{display:inline-flex;align-items:center;gap:.5rem;min-height:24px;background:transparent;border:var(--stroke-w) solid var(--sketch);border-radius:var(--radius);padding:.4rem .7rem;list-style:none;margin:.1rem 0}
summary{cursor:pointer;transition:background var(--dur-fast) var(--ease-pen)}
summary:hover{background:color-mix(in srgb,var(--ink) 6%,transparent)}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
summary::-webkit-details-marker{display:none}
summary::before{content:'\\25B8';color:var(--ink-2);font-size:.85rem;transition:transform var(--dur-fast) var(--ease-pen)}
details[open]>summary::before{transform:rotate(90deg)}
/* The central topic is FILLED INK, the notebook's primary treatment. Reversing
   white out of the pink pen is the obvious move and it fails the contrast
   gate: white on the dark theme's pink is 3.1:1. Ink on paper is 14:1 in both
   themes, and the pen still marks the map through the rule and the branches. */
ul.tree>li>details>summary,ul.tree>li>.leaf{background:var(--btn-ink);color:var(--btn-ink-text);border-color:var(--btn-ink);font-weight:650;font-size:var(--fs-lead)}
ul.tree>li>details>summary:hover{background:var(--btn-ink)}
ul.tree>li>details>summary::before{color:var(--btn-ink-text)}
/* The first ring off the centre carries the pen as a marker edge, so the main
   branches read at a glance without inventing a second colour scheme. The <ul>
   is a child of the root's <details>, not of its <li> — render_mindmap_html
   emits <li><details><summary>…</summary><ul>…</ul></details></li>, so a
   \`ul.tree>li>ul\` selector matches nothing at all. */
ul.tree>li>details>ul>li>details>summary,
ul.tree>li>details>ul>li>.leaf{border-left:3px solid var(--accent-fill)}
@media print{
  /* A collapsed branch prints collapsed — CSS cannot open a <details> the
     reader left shut, and faking it would print something the page is not
     showing. Expand what you want before you print. */
  li,summary,.leaf{break-inside:avoid;page-break-inside:avoid}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="eyebrow">Mind map</div>
  <h1>__TITLE__</h1>
  <div class="rule"></div>
  __TREE__
</main>
</body>
</html>
`;

// ============================================================================
// render_mindmap_html — the recursive <details> tree builder
// ============================================================================

/**
 * D5: render a collapsible mind-map tree as a self-contained HTML page. Built
 * as STATIC nested `<details>` (native disclosure, no JavaScript) for the
 * same sandbox reason as the flashcards artifact. Ported verbatim from
 * `render_mindmap_html`.
 */
export function renderMindmapHtml(title: string, root: string, nodes: readonly MindNode[]): string {
  const kids = new Map<string, string[]>();
  for (const n of nodes) {
    const parent = n.parent.trim() === "" ? root : n.parent;
    // A self-referential entry (label === parent, e.g. a cyclic "Loop") is
    // simply never wired as anyone's child, matching Rust's `if n.label !=
    // parent` guard — not a cycle the traversal below has to break, a node
    // that was never added to the tree it would have cycled in.
    if (n.label !== parent) {
      const list = kids.get(parent);
      if (list) {
        list.push(n.label);
      } else {
        kids.set(parent, [n.label]);
      }
    }
  }

  // Guard against runaway depth and parent/child cycles from a bad tree.
  // `seen` tracks the CURRENT DFS path (ancestors still on the call stack),
  // not every label ever visited — a label is added on the way down and
  // removed on the way back up, so two different branches may reuse the same
  // label freely; only a label reappearing among its OWN ancestors is a
  // cycle.
  function nodeHtml(label: string, depth: number, seen: Set<string>): string {
    const esc = htmlEscape(label);
    if (depth > 8 || seen.has(label)) {
      return `<span class="leaf">${esc}</span>`;
    }
    seen.add(label);
    const children = kids.get(label) ?? [];
    let out: string;
    if (children.length === 0) {
      out = `<span class="leaf">${esc}</span>`;
    } else {
      const open = depth < 2 ? " open" : "";
      let inner = "";
      for (const c of children) {
        inner += "<li>";
        inner += nodeHtml(c, depth + 1, seen);
        inner += "</li>";
      }
      out = `<details${open}><summary>${esc}</summary><ul>${inner}</ul></details>`;
    }
    seen.delete(label);
    return out;
  }

  const tree = `<ul class="tree"><li>${nodeHtml(root, 0, new Set<string>())}</li></ul>`;
  return fillTemplate(MINDMAP_TEMPLATE, [
    ["__NOTEBOOK__", NOTEBOOK_CSS],
    ["__TITLE__", htmlEscape(title)],
    ["__TREE__", tree],
  ]);
}

// ============================================================================
// fallback_mindmap — parse the model's structured JSON, render the template
// ============================================================================

/**
 * Fallback: parse the extracted topic tree and render the built-in mind-map
 * template. The root defaults to the scope label when the model omits it.
 * Ported verbatim from `fallback_mindmap`. Throws (Rust's `Err(String)`) when
 * the model returned no usable nodes, exactly like every other `Result<String,
 * String>`-returning render function ported so far in this tree.
 */
export function fallbackMindmap(raw: string, label: string): string {
  const rootField = jsonStrField(raw, "root");
  const root = rootField !== null && rootField !== "" ? rootField : label.trim();
  const nodes: MindNode[] = [];
  for (const n of jsonArray(raw, "nodes")) {
    const l = valueStr(n, "label");
    if (l !== "") {
      nodes.push({ label: l, parent: valueStr(n, "parent") });
    }
  }
  if (nodes.length === 0) {
    throw new Error("The model didn't return a usable mind map — try a different file.");
  }
  return renderMindmapHtml(label, root, nodes);
}

// ============================================================================
// mindmap_spec — the artifact spec for the (unported) shared run_studio
// pipeline
// ============================================================================

// `STUDIO_MINDMAP_PROMPT` and `StudioSpec` (`studios.rs`'s own default
// instruction and per-artifact-spec shape) are now imported from
// `studiosCmds.ts` and re-exported above — see this file's module doc.

/** The mind-map artifact spec for the shared `run_studio` pipeline. Ported
 * verbatim from `mindmap_spec` — every field copied from the Rust literal,
 * field for field. */
export function mindmapSpec(): StudioSpec {
  return {
    defaultPrompt: STUDIO_MINDMAP_PROMPT,
    pageRole:
      "You are a front-end developer building an interactive mind-map page. Draw one " +
      "central topic with a tree of branches; let the reader expand and collapse nodes by clicking, " +
      "and gently pan the canvas if you can. Keep labels short. Base it only on the provided material.",
    workingLabel: "Drawing your mind map",
    fallbackStep: "Extracting the topic tree…",
    fallbackSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              parent: { type: "string" },
            },
            required: ["label", "parent"],
          },
        },
      },
      required: ["root", "nodes"],
    },
    fallbackSystem:
      "You organize material into a mind map: one central root topic and a tree of nodes, " +
      "each naming its parent (the root, or another node's exact label). Keep labels short. " +
      "Base it only on the provided text.",
    fallbackIntro: "Base it only on this material about",
    fallbackTemp: 0.3,
    render: fallbackMindmap,
    filenamePrefix: "Mind map",
    // HTML-authoring stays primary here: this artifact is a PAGE, and
    // nothing downstream needs to read its parts back as data.
    structuredFirst: false,
    afterSave: undefined,
  };
}

// ============================================================================
// studio_mindmap — the Tauri command's shape, as an injectable seam
// ============================================================================

// `RunStudioFn` (`studios.rs`'s shared `run_studio` pipeline's calling shape)
// is now imported from `studiosCmds.ts` and re-exported above — see this
// file's module doc. Absent from {@link studioMindmap}'s default parameter
// means it refuses rather than fabricating a saved file.

export const RUN_STUDIO_PIPELINE_GAP =
  "studios.rs's shared run_studio pipeline (register_studio_cancel, gather_scope_text/" +
  "gather_files_text, resolve_structured_model, generate_studio_html/clean_studio_html, " +
  "safe_scope_name, and the room-pinned save_and_open commit) is now REAL and tested " +
  "(studiosCmds.ts's runStudio/makeRunStudio), but wiring it into studio_mindmap needs an " +
  "app-wide host bootstrap that can build a live RoomSource/CancelState for it (the same gap " +
  "ExecToolDeps.downloadJob/.workflowRun already document for their own job-queue-backed arms), " +
  "so studio_mindmap still cannot actually build and save a mind map through THIS wrapper. " +
  "mindmap.rs's own half — the StudioSpec, the structured-extraction fallback, and the " +
  "collapsible <details> HTML renderer — IS ported and tested (studiosMindmap.ts).";

export const RUN_STUDIO_NOT_IMPLEMENTED = `NOT_IMPLEMENTED: ${RUN_STUDIO_PIPELINE_GAP}`;

export const runStudioNotImplemented: RunStudioFn = () => Promise.reject(new Error(RUN_STUDIO_NOT_IMPLEMENTED));

/**
 * `#[tauri::command] pub async fn studio_mindmap` — a Studio button in the
 * UI: its own root, nobody's child (`parent_run: None`, always — an
 * agent-triggered build passes its own `parent_run` by calling `runStudio`
 * directly instead; see this file's module doc for why that path does not
 * go through this wrapper). Ported verbatim from `studio_mindmap`, minus the
 * `window`/`state` Tauri handles `runStudio` would need internally once it
 * is real.
 */
export async function studioMindmap(
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  opId: string | null,
  runStudio: RunStudioFn = runStudioNotImplemented
): Promise<FileMeta> {
  return runStudio(mindmapSpec(), scope, instructions, refs, opId, null);
}
