/**
 * The Studios feature's TOP-LEVEL DISPATCHER and shared plumbing — flashcards,
 * mind map, podcast script. Ported from `src-tauri/src/commands/studios.rs`
 * (844 lines, read in full, including its `#[cfg(test)] mod tests`): every
 * function and constant declared directly in that file. `run_studio`/
 * `run_studio_core` are the ONE pipeline all three artifact generators share
 * (gather scope text, resolve a model, author a whole HTML page, fall back to
 * a structured extraction rendered by a built-in template, save and open);
 * `spec: StudioSpec` is the only thing that varies between them.
 *
 * NOT PORTED HERE, and why: `studios.rs`'s own `mod` declarations pull in four
 * sibling files — `studios/flashcards.rs` (309 lines), `studios/mindmap.rs`
 * (240 lines), `studios/podcast.rs` (355 lines) and `studios/podcast_audio.rs`
 * (561 lines, "a different act... split from podcast" per its own module
 * header) — each its own `flashcards_spec()`/`mindmap_spec()`/`podcast_spec()`
 * factory plus that artifact's own `#[tauri::command]` entry point and (for
 * podcast_audio) TTS rendering. None of those four files are part of THIS
 * batch's 844-line scope.
 *
 * DISCOVERED MID-BATCH, not assumed at the start: FOUR other, concurrent
 * batches ported `flashcards.rs`/`mindmap.rs`/`podcast.rs`/`podcast_audio.rs`
 * in parallel with this one (`studiosFlashcards.ts`, `studiosMindmap.ts`,
 * `studiosPodcast.ts`, `studiosPodcastAudio.ts` — the last one genuinely
 * real end-to-end against the sidecar's `/tts`/`/tts/podcast` routes, per its
 * own module doc). Three of the four (everything but `podcast_audio.rs`,
 * which never called into `studios.rs`'s shared pipeline — it works from an
 * already-saved podcast row, not a fresh `run_studio` call) independently hit
 * the exact gap this file fills and built the same injectable-seam prediction
 * for it — their own module docs call it "this port's best-effort prediction of that
 * future shared type's shape, so a `studios.rs` port can adopt [a spec's]
 * return value with no changes to this file." {@link StudioSpec}/
 * {@link RunStudioFn}/{@link fillTemplate}/the three `STUDIO_*_PROMPT`
 * constants now live HERE, canonically, exactly matching what those three
 * predictions already converged on (down to the curried `(spec, scope,
 * instructions, refs, opId, parentRun) => Promise<FileMeta>` calling
 * convention — see {@link makeRunStudio}); the three sibling files were
 * updated ADDITIVELY (per this migration's stated rule for concurrent-batch
 * overlap) to import and re-export these rather than keep their own local
 * copies, removing the one real type-drift risk that had already opened up
 * between `studiosMindmap.ts`'s `afterSave` (typed `db: unknown`, since
 * mindmap never sets it) and `studiosPodcast.ts`'s (typed `db:
 * Database.Database`, since podcast's `storePodcast` genuinely does) — this
 * file keeps the latter, more precise type. {@link runStudio}/
 * {@link runStudioCore} are fully real and tested here; {@link studioSpecFor}
 * (Rust's own reconstruction of a spec from a durable job's `kind` string)
 * can now be handed the three REAL factories (`flashcardsSpec`/`mindmapSpec`/
 * `podcastSpec`) — see its own doc.
 *
 * `exec_tool`'s STUDIO ARM LIVES HERE, once — {@link resolveStudioRefs} and
 * {@link execStudio}. `agent.rs` ~4299 dispatches `"studio_flashcards" |
 * "studio_mindmap" | "generate_podcast_script"` through ONE match arm whose
 * only per-artifact difference is which `spec` it builds, and it does MORE
 * than call `run_studio` verbatim: it resolves the schema's file-NAME `refs`
 * to ids itself and passes `parent_run: turn.map(TurnId::run_id)` (Owner
 * replacement #3) rather than the three `#[tauri::command]` wrappers' own
 * hard-coded `None`.
 *
 * AN AUDIT OF THIS BATCH (2026-08-23) FOUND THAT ARM FORKED: a
 * flashcards-only copy lived in `studiosFlashcards.ts`, `execTool.ts`'s
 * `studio_flashcards` case ran it when `ExecToolDeps.runStudioDeps` was
 * supplied, and the `studio_mindmap`/`generate_podcast_script` cases refused
 * UNCONDITIONALLY — so a fully-bootstrapped app could build a deck and could
 * not build a mind map or a podcast script, from one Rust arm. One function
 * taking `spec` now, mirroring the one Rust arm; `studiosFlashcards.ts`
 * re-exports `resolveStudioRefs` under its original
 * `resolveFlashcardsRefs` name and `execStudioFlashcards` is
 * `execStudio(deps, flashcardsSpec(), ...)`.
 *
 * What stays genuinely missing, and is NOT invented here: {@link
 * RunStudioDeps} needs a live `RoomSource`/`CancelState`, which no host
 * bootstrap constructs yet — the same gap `ExecToolDeps.downloadJob`/
 * `.workflowRun` already document for their own job-queue-backed arms. All
 * three `execTool.ts` cases therefore still refuse with their own gap
 * sentence when `deps.runStudioDeps === undefined`, and run for real the
 * moment it is supplied.
 *
 * REUSED, not re-declared — verified against each file's own exports:
 *  - {@link Artifact}/{@link Written} (`artifactBuilder.ts`) — the ART-1 write
 *    funnel `run_studio_core` commits through.
 *  - `chatStructured`/`StructuredOpts` (`ollamaGenerate.ts`) — that file's own
 *    module doc names `commands/studios.rs:387,565` as one of the real call
 *    sites that justified porting it; this is that call site.
 *  - {@link CancelFlag}/`childOfRun`/`remember`/`forget`/`guardCommit`/
 *    `type CancelState`/`type Node` (`cancel.ts`) — the run-id cancel tree.
 *  - `jsonStrField` (`jsonTools.ts`) — that file's own doc names
 *    `jsonStrField(reply, "html")` as written for exactly this call site.
 *  - `titleFromName` (`docsHtml.ts`), `clampBytes` (`textClamp.ts`),
 *    `byteLength` (`extractionWindow.ts`), `getFileName`/
 *    `getFileExtractedText`/`listFiles`/`type FileMeta` (`db-host/files.ts`).
 *  - `modelSetting` (`gatherContext.ts`), `isExternalEngine`/`ROLLBACK_BUSY`
 *    (`turnContext.ts`), `listModels` (`engineRouting.ts`), `bestLocalDefault`/
 *    `KEEP_ALIVE_WARM` (`ollamaModels.ts`) — {@link resolveStructuredModel}'s
 *    real, composed pieces; see that function's own doc.
 *  - `obs.warn`/`obs.id`/`obs.errKind`, via the `{warn: typeof obs.warn}` log
 *    seam `recRead.ts`'s own `RecReadLog`/`REAL_LOG` already establishes —
 *    same shape, duplicated per that file's own convention rather than
 *    exported from one place no other file has claimed yet.
 *
 * DUPLICATED HERE, deliberately and in a few lines, following this rewrite's
 * established "too small to justify a shared port" precedent
 * (`chatCommandsGenerate.ts`'s own doc lists `mediaKind`/`safeFileStem` as
 * exactly this):
 *  - `saveAndOpen`/`requireRoom`/`emitSafely` — `docs_html.rs::save_and_open`
 *    is ALREADY ported, privately, inside `chatCommandsKnowledge.ts`, whose own
 *    doc explains why it lives there rather than in `docsHtml.ts` (an import
 *    cycle) and is not exported. `chatCommandsGenerate.ts` already duplicates
 *    `requireRoom` for the identical reason ("unexported there, and every one
 *    of this file's eight commands needs it"); this file is a second such
 *    caller.
 *  - {@link resolveStructuredModel} — `commands/moonshot.rs::resolve_structured_model`.
 *    DISCOVERED MID-BATCH (same as the studio siblings above): a CONCURRENT
 *    batch also ported `moonshot.rs` (`moonshotCmds.ts`), including this
 *    exact function — checked, not assumed. NOT imported from there, for one
 *    real reason: `moonshotCmds.ts`'s own `RoomSource.currentRoom(): OpenRoom
 *    | null` (`turnEngine.ts`'s `OpenRoom`, `{db, path}`) has no `name` field,
 *    which {@link gatherScopeText}'s whole-room scope genuinely needs — this
 *    file's {@link RoomSource}/{@link RoomHandle} were built specifically to
 *    carry it (see this module's own "room access" section). Adapting one
 *    shape to the other at every room-touching call site in this file would
 *    be a larger, riskier change than the four-line function this note is
 *    attached to. Composed ENTIRELY from already-real pieces (see the REUSED
 *    list above) either way — genuinely working, not a stub — and exported
 *    so a future integration pass can reconcile the two `RoomSource` shapes
 *    (or thread a `name` through `moonshotCmds.ts`'s) and drop whichever copy
 *    instead of re-deriving a third one (`ollamaModels.ts`'s own
 *    `bestLocalDefault` already exists alongside an OLDER, independently
 *    duplicated copy in `feedbackTools.ts` — the exact drift this note is
 *    trying to prevent a third instance of).
 *
 * ONE DELIBERATE STRUCTURAL ADDITION beyond the Rust source, required by
 * `cancel.ts`'s own documented port deviation: Rust's cancel tree self-prunes
 * (`Weak<Node>` decays when the owning `Arc` drops); this port's tree uses
 * STRONG references and needs an explicit {@link CancelNode.dispose} call when
 * a child's work finishes, in a `finally` — `cancel.ts`'s module doc names
 * "studio builds" BY NAME as a future caller that must remember this.
 * {@link runStudio} is that caller: {@link registerStudioCancel} always
 * creates a node (a child of the parent run when one exists, else a root), and
 * without disposing it a Studio started by the agent's `studio_flashcards`
 * tool (`op_id: None`, a real `parent_run`) would leave a finished node linked
 * into its parent's `kids` list forever — the "phantom still-live child"
 * `cancel.ts`'s own doc warns a leak like this fabricates.
 *
 * `stage_preview_html`/`open_html_in_browser` port only their `_core`/testable
 * bodies, per this rewrite's "no ipcMain wiring in this batch" convention
 * (`recIpc.ts`, `previewTools.ts`): both are `#[tauri::command]`s whose Tauri
 * `State<'_, HtmlPreviews>` extraction has no Electron IPC equivalent to wire
 * without an explicit owner go-ahead (rule 4). {@link HtmlPreviews} is a plain,
 * directly-testable store — no `Mutex`/`AtomicU64` needed, Node is
 * single-threaded, the same reasoning `cancel.ts`'s own registries give.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { Artifact, type Written } from "./artifactBuilder.js";
import {
  childOfRun,
  forget,
  guardCommit,
  remember,
  type CancelFlag,
  type CancelState,
  type GuardResult,
  type Node as CancelNode,
} from "./cancel.js";
import {
  fileNamesHint,
  findFileLike,
  getFileExtractedText,
  getFileName,
  listFiles,
  type FileMeta,
} from "./db-host/files.js";
import { titleFromName } from "./docsHtml.js";
import { byteLength } from "./extractionWindow.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { jsonStrField } from "./jsonTools.js";
import * as obs from "./obs.js";
import { chatStructured as chatStructuredReal } from "./ollamaGenerate.js";
import { bestLocalDefault, KEEP_ALIVE_WARM } from "./ollamaModels.js";
import type { SidecarChatMessage } from "./sidecar.js";
import { clampBytes } from "./textClamp.js";
import { declaredFor } from "./capabilities.js";
import { isExternalEngine, ROLLBACK_BUSY } from "./turnContext.js";
import { isSummaryFile } from "./summarizeTools.js";

// ============================================================================
// room access — this file's own minimal slice of the (not-yet-ported)
// AppState/Room, extended with the one field no other ported file has needed
// yet: the room's display NAME (gather_scope_text's whole-room scope reads
// `room.name`; every other ported runner only ever needed `db`/`path`).
// ============================================================================

/** `commands.rs::Room`, as much of it as this file's runners use. */
export interface RoomHandle {
  db: Database.Database;
  path: string;
  name: string;
}

/** Mirrors `jobs.ts`'s own `RoomSource` (and is structurally compatible with
 * it), plus the same optional `rollingBack` probe `turnEngine.ts`'s
 * `TurnRoomSource` carries — `run_studio`'s own Wave-3 guard. */
export interface RoomSource {
  current(): RoomHandle | null;
  rollingBack?: () => boolean;
}

const NO_ROOM_OPEN = "No room is open.";
/** Ported verbatim (both room-pin checkpoints in `run_studio_core` throw this
 * exact sentence). */
const ROOM_CLOSED = "the room this job belongs to was closed";

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful room mutation, or a merely cosmetic progress step, into a
 * failed run. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}

/**
 * `docs_html.rs`'s `save_and_open`, duplicated (unexported where it already
 * lives, `chatCommandsKnowledge.ts` — see this module's own doc): commit a
 * fresh artifact, then tell the Files list to reload and the viewer to open
 * it.
 */
function saveAndOpen(rooms: RoomSource, emit: EmitFn | undefined, art: Artifact): Written {
  const room = rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const written = art.commit(room.db);
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "agent-open-file", { id: written.meta.id });
  return written;
}

// `is_summary_file` (commands/summarize.rs) is now REAL, ported verbatim and
// exported by the concurrent `summarize.rs` batch (`summarizeTools.ts`) —
// imported above rather than duplicated a second time.

// ============================================================================
// gather_scope_text / gather_files_text
// ============================================================================

/**
 * Gather the text a studio command works over. `scope` = a file id (that one
 * file) or `null` (a slice of the whole room). Ported verbatim from
 * `gather_scope_text`.
 */
export function gatherScopeText(
  db: Database.Database,
  scope: string | null,
  roomName: string
): [label: string, text: string] {
  if (scope !== null) {
    const name = getFileName(db, scope); // throws when the id names nothing, matching `?`
    const text = getFileExtractedText(db, scope) ?? "";
    if (text.trim() === "") {
      throw new Error(`"${name}" has no readable text to work with.`);
    }
    return [titleFromName(name), clampBytes(text, 12_000)];
  }
  const files = listFiles(db);
  let blob = "";
  for (const f of files) {
    if (isSummaryFile(f.name, f.source)) {
      continue; // the `.filter(...)` half of Rust's `files.iter().filter(...)`
    }
    if (byteLength(blob) >= 12_000) {
      break;
    }
    const t = getFileExtractedText(db, f.id);
    if (t === null || t.trim() === "") {
      continue;
    }
    blob += `## ${f.name}\n${clampBytes(t, 1500)}\n\n`;
  }
  if (blob.trim() === "") {
    throw new Error("This room has no readable text to work with yet.");
  }
  return [roomName, blob];
}

/**
 * Gather readable text from an explicit set of file ids — the files/folders
 * the user @-mentioned in the Studio prompt. Ported verbatim from
 * `gather_files_text`.
 */
export function gatherFilesText(
  db: Database.Database,
  fileIds: readonly string[]
): [label: string, text: string] {
  let blob = "";
  const names: string[] = [];
  for (const id of fileIds) {
    let name: string;
    try {
      name = getFileName(db, id);
    } catch {
      continue;
    }
    const text = getFileExtractedText(db, id);
    if (text === null || text.trim() === "") {
      continue;
    }
    if (byteLength(blob) >= 12_000) {
      break;
    }
    blob += `## ${name}\n${clampBytes(text, 3000)}\n\n`;
    names.push(titleFromName(name));
  }
  if (blob.trim() === "") {
    throw new Error("The files you mentioned have no readable text to work with.");
  }
  const label = names.length === 1 ? names[0]! : `${names.length} files`;
  return [label, blob];
}

// ============================================================================
// safe_scope_name / fill_template
// ============================================================================

const SCOPE_NAME_FOLD_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", "\n", "\r", "\t"]);

/** Rust's `str::split_whitespace()`: splits on runs of Unicode whitespace,
 * yields no empty tokens. Local copy — `chatCommandsGenerate.ts` carries an
 * identical, unexported one for the same reason. */
function splitWhitespaceUnicode(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

/** Fold a scope label into a file-name-safe fragment (no path/reserved
 * chars). Ported verbatim from `safe_scope_name`. `.take(60)` is CODE POINTS
 * (`chars()`), so truncation goes through `Array.from` rather than a UTF-16
 * `.slice()`, which would cut a surrogate pair in half. */
export function safeScopeName(label: string): string {
  const folded = Array.from(label)
    .map((c) => (SCOPE_NAME_FOLD_CHARS.has(c) ? " " : c))
    .join("");
  const cleaned = splitWhitespaceUnicode(folded).join(" ");
  const name = Array.from(cleaned).slice(0, 60).join("").trim();
  return name === "" ? "room" : name;
}

/**
 * Fill a built-in page template's `__SLOT__` placeholders in ONE
 * left-to-right pass — never rescanning substituted text (see the Rust
 * source's own doc: a file named `__CARDS__`, pasted in as the title by an
 * earlier slot, used to have the later slot's whole deck spliced into its own
 * `<title>` under chained `.replace()` calls). Ported verbatim from
 * `fill_template`. Ties (two slots' keys starting at the same position)
 * favor whichever slot appears EARLIER in `slots`, matching Rust's
 * `min_by_key`, which returns the first minimal element.
 */
export function fillTemplate(template: string, slots: ReadonlyArray<readonly [string, string]>): string {
  let out = "";
  let rest = template;
  for (;;) {
    let bestAt = -1;
    let bestKey = "";
    let bestValue = "";
    for (const [key, value] of slots) {
      const at = rest.indexOf(key);
      if (at !== -1 && (bestAt === -1 || at < bestAt)) {
        bestAt = at;
        bestKey = key;
        bestValue = value;
      }
    }
    if (bestAt === -1) {
      out += rest;
      return out;
    }
    out += rest.slice(0, bestAt);
    out += bestValue;
    rest = rest.slice(bestAt + bestKey.length);
  }
}

// ============================================================================
// open_html_in_browser
// ============================================================================

const PREVIEW_DIR_NAME = "arcelle-preview";

/** Where staged/opened preview HTML lives — `std::env::temp_dir().join(
 * "arcelle-preview")`. */
export function previewDir(): string {
  return path.join(os.tmpdir(), PREVIEW_DIR_NAME);
}

/** `std::process::Command::new("/usr/bin/open").arg(&path).spawn()` — waits
 * only long enough to know the OS accepted the launch (Node's `spawn` event),
 * matching Rust's synchronous `Result<Child, io::Error>`; never waits for the
 * browser itself to exit. */
async function realOpenPath(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [filePath]);
    child.once("error", (err: Error) => reject(err));
    child.once("spawn", () => resolve());
  });
}

/**
 * Write an HTML document to a temp file and open it in the user's real
 * browser, where interactive/JS pages render fully. Mac-only. Ported verbatim
 * from `open_html_in_browser`. `openPath` is a test seam over the real
 * `/usr/bin/open` spawn.
 */
export async function openHtmlInBrowser(
  name: string | null,
  html: string,
  openPath: (filePath: string) => Promise<void> = realOpenPath
): Promise<string> {
  const dir = previewDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Couldn't create the preview folder: ${errMessage(err)}`);
  }
  const stripped =
    name === null
      ? null
      : name.endsWith(".html")
        ? name.slice(0, -".html".length)
        : name.endsWith(".htm")
          ? name.slice(0, -".htm".length)
          : name;
  const folded = stripped === null ? "" : safeScopeName(stripped);
  const base = folded === "" ? "preview" : folded;
  const stamp = Date.now();
  const filePath = path.join(dir, `${base}-${stamp}.html`);
  try {
    await fsp.writeFile(filePath, html, "utf8");
  } catch (err) {
    throw new Error(`Couldn't write the preview file: ${errMessage(err)}`);
  }
  try {
    await openPath(filePath);
  } catch (err) {
    throw new Error(`Couldn't open your browser: ${errMessage(err)}`);
  }
  return filePath;
}

// ============================================================================
// cleanup_browser_previews / cleanup_browser_previews_older_than /
// sweep_previews_older_than
// ============================================================================

/** Sweep the browser-preview folder clean at startup (files from a
 * crashed/force-quit session). Ported verbatim from
 * `cleanup_browser_previews`. Best-effort: must never block startup/exit. */
export function cleanupBrowserPreviews(): void {
  try {
    fs.rmSync(previewDir(), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * The body of {@link cleanupBrowserPreviewsOlderThan}, over an explicit
 * directory so the age rule is testable without touching the shared temp dir
 * every other test and the running app share. Ported verbatim from
 * `sweep_previews_older_than`.
 */
export function sweepPreviewsOlderThan(dir: string, graceMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // nothing was ever opened this session
  }
  const now = Date.now();
  for (const name of names) {
    const p = path.join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      continue; // an unreadable timestamp leaves the file alone, matching Rust
    }
    if (now - mtimeMs >= graceMs) {
      try {
        fs.rmSync(p);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * The same sweep as {@link cleanupBrowserPreviews}, but only for files that
 * have had time to be read — called mid-session (room lock), where an eager
 * sweep could pull a page out from under the browser that just opened it.
 * Ported verbatim from `cleanup_browser_previews_older_than`.
 */
export function cleanupBrowserPreviewsOlderThan(graceMs: number): void {
  sweepPreviewsOlderThan(previewDir(), graceMs);
}

// ============================================================================
// stage_preview_html / stage_preview_html_core
// ============================================================================

/** How many staged preview pages the store holds. */
export const PREVIEW_MAX = 24;

/** `HtmlPreviews` — see this module's own doc for why a plain object (no
 * `Mutex`/`AtomicU64`) is the whole port. */
export interface HtmlPreviews {
  next: number;
  map: Map<string, string>;
}

export function createHtmlPreviews(): HtmlPreviews {
  return { next: 0, map: new Map() };
}

/**
 * Stage a self-contained HTML page for the isolated in-app preview and return
 * a token. Full store → the OLDEST entry (by token, tokens are a monotonic
 * counter) is evicted; clearing the whole map instead took the page the user
 * still had open down with it. Ported verbatim from `stage_preview_html_core`.
 */
export function stagePreviewHtmlCore(previews: HtmlPreviews, html: string): string {
  const token = String(previews.next);
  previews.next += 1;
  while (previews.map.size >= PREVIEW_MAX) {
    let oldestKey: string | undefined;
    let oldestVal = Number.POSITIVE_INFINITY;
    for (const k of previews.map.keys()) {
      const n = Number(k);
      const val = Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
      if (val < oldestVal) {
        oldestVal = val;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) {
      break;
    }
    previews.map.delete(oldestKey);
  }
  previews.map.set(token, html);
  return token;
}

// ============================================================================
// studio_instruction / studio_prompts
// ============================================================================

export const STUDIO_FLASHCARDS_PROMPT = "Make up to 12 flashcards that test real understanding of this material.";
export const STUDIO_MINDMAP_PROMPT = "Build a mind map: one central topic and a short tree of the key ideas.";
export const STUDIO_PODCAST_PROMPT =
  "Write a two-host podcast script that discusses the key points in a natural back-and-forth.";

/** The instruction to use: the user's edited prompt if they supplied one,
 * else the default. Ported verbatim from `studio_instruction`. */
export function studioInstruction(supplied: string | null, defaultPrompt: string): string {
  const trimmed = supplied?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : defaultPrompt;
}

export interface StudioPrompts {
  flashcards: string;
  mindmap: string;
  podcast: string;
}

/** The default prompts, so the UI can show them in an editable box before a
 * Studio action runs. Ported verbatim from `studio_prompts`. */
export function studioPrompts(): StudioPrompts {
  return {
    flashcards: STUDIO_FLASHCARDS_PROMPT,
    mindmap: STUDIO_MINDMAP_PROMPT,
    podcast: STUDIO_PODCAST_PROMPT,
  };
}

// ============================================================================
// SELF_CONTAINED_HTML_RULES
// ============================================================================

/** Ported verbatim (character-for-character) from `SELF_CONTAINED_HTML_RULES`
 * — see the Rust source's own extensive comment for why this is the ONE
 * prompt in the pipeline allowed to name a colour or a font, and why the six
 * hex values must stay in step with `src/styles/tokens.css` /
 * `docsHtml.ts`'s `NOTEBOOK_CSS`. Pinned by this file's own
 * `thePromptPaletteMatchesTheNotebook` test. */
export const SELF_CONTAINED_HTML_RULES =
  "Output ONE complete, self-contained HTML " +
  "document and nothing else — no explanation, no markdown code fences. Put ALL CSS " +
  "inside a <style> tag and ALL JavaScript inside a <script> tag in the same file. Use " +
  "NO external resources whatsoever: no <link>, no <script src>, no CDN, no web fonts, " +
  "no remote images, no fetch/XMLHttpRequest — the page runs offline in a sandbox and " +
  "any network request silently fails. For images use inline SVG or a data: URI only. " +
  "Make it a polished, responsive page: ink on warm paper, light by default " +
  '(#f4f1e8 paper, #20221f ink) with a dark palette under the html[data-theme="dark"] ' +
  "selector (#151716 paper, #f0eee5 ink) — never a prefers-color-scheme media query — " +
  "and a muted marker accent (#a82fad light, #cc7ecf dark). System font stack only. " +
  "Add a @media print rule that puts the page back on white with black text and drops " +
  "any background pattern, because these pages get saved and printed. Write correct " +
  "JavaScript that runs on load with no errors.";

// ============================================================================
// register_studio_cancel
// ============================================================================

/**
 * Create this operation's cancel node and, when the caller supplied an op id,
 * register it in the shared cancel registry — the same one chat's Stop uses —
 * so `cancelId(opId)` stops a Studio run too. Ported verbatim from
 * `register_studio_cancel`. The caller MUST `dispose()` the returned node when
 * the run finishes — see this module's own doc's "ONE DELIBERATE STRUCTURAL
 * ADDITION" section.
 */
export function registerStudioCancel(
  cancelState: CancelState,
  opId: string | null,
  parentRun: string | null,
  label: string
): CancelNode {
  const node = childOfRun(cancelState, parentRun, label);
  if (opId !== null) {
    cancelState.cancels.set(opId, node.flag());
    remember(cancelState, opId, node);
  }
  return node;
}

// ============================================================================
// resolve_structured_model (commands/moonshot.rs — unported; see module doc)
// ============================================================================

/**
 * Resolve the chat model for a structured side-call (studios, AI actions,
 * front page, feedback drafts), honoring the room's explicit `model` setting.
 * Returns `null` when Ollama is unreachable or has no models, so callers can
 * degrade to empty/partial output. Ported verbatim from
 * `resolve_structured_model`.
 *
 * `listModelsFn` defaults to the real, already-ported `engineRouting.ts`
 * implementation, which — per that file's own documented simplification —
 * never throws (folds every failure into `[]`), so the `try`/`catch` below is
 * dead code with the production default. Kept anyway (not collapsed away),
 * matching `feedbackTools.ts`'s identical, already-flagged fidelity note for
 * its own near-identical model-pick: it activates correctly the moment
 * `engineRouting.ts` grows a throwing variant, or a caller injects one — which
 * is exactly how {@link resolveStructuredModel}'s own "Ollama isn't running"
 * branch is unit-tested here.
 */
export async function resolveStructuredModel(
  rooms: RoomSource,
  listModelsFn: () => Promise<string[]> = listModelsReal
): Promise<string | null> {
  const room = rooms.current();
  const explicit = room !== null ? modelSetting(room.db) : null;
  if (explicit !== null && isExternalEngine(explicit)) {
    return explicit;
  }
  let models: string[];
  try {
    models = await listModelsFn();
  } catch {
    return null;
  }
  if (models.length === 0) {
    return null;
  }
  return explicit ?? bestLocalDefault(models);
}

// ============================================================================
// generate_studio_html / clean_studio_html
// ============================================================================

/**
 * Ask the model to author a complete interactive HTML page for a Studio
 * artifact. Returns cleaned HTML, or `null` when the output isn't usable HTML
 * — the caller then falls back to a built-in template. Ported verbatim from
 * `generate_studio_html`.
 */
export async function generateStudioHtml(
  model: string,
  pageRole: string,
  instr: string,
  label: string,
  text: string,
  cancel: CancelFlag,
  chatStructuredFn: typeof chatStructuredReal = chatStructuredReal
): Promise<string | null> {
  const schema = { type: "object", properties: { html: { type: "string" } }, required: ["html"] };
  const messages: SidecarChatMessage[] = [
    { role: "system", content: `${pageRole}\n\n${SELF_CONTAINED_HTML_RULES}` },
    { role: "user", content: `${instr}\n\nBuild it only from this material about "${label}":\n\n${text}` },
  ];
  const raw = await chatStructuredFn(model, messages, 0.4, KEEP_ALIVE_WARM, schema, { cancel });
  return cleanStudioHtml(jsonStrField(raw, "html") ?? "");
}

/** Normalize model-authored HTML; `null` if it isn't a real HTML page (so the
 * caller can fall back to the built-in template). Ported verbatim from
 * `clean_studio_html`. `h.len() < 60` is BYTES in Rust, so the length check
 * goes through {@link byteLength} rather than `.length`. */
export function cleanStudioHtml(html: string): string | null {
  let h = html.trim();
  if (h.startsWith("```")) {
    let rest = h.slice(3);
    if (rest.startsWith("html")) {
      rest = rest.slice(4);
    }
    h = rest.trimStart();
    const idx = h.lastIndexOf("```");
    if (idx !== -1) {
      h = h.slice(0, idx);
    }
    h = h.trim();
  }
  const low = h.toLowerCase();
  const looksHtml =
    low.includes("<html") ||
    low.includes("<!doctype") ||
    low.includes("<body") ||
    low.includes("<style") ||
    low.includes("<div");
  if (byteLength(h) < 60 || !looksHtml) {
    return null;
  }
  if (!low.includes("<html")) {
    h =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${h}</body></html>`;
  }
  return h;
}

// ============================================================================
// the shared studio pipeline
// ============================================================================

/**
 * The per-artifact differences between the Studio generators (flashcards,
 * mind map, podcast script). Everything else — cancel wiring, room-locked
 * text gathering, model resolution, the HTML-authoring primary path, the JSON
 * fallback, and save/open — is identical and lives in {@link runStudio}.
 * Field-for-field port of the Rust `StudioSpec` struct; see its own doc
 * comments there for what each carries.
 */
export interface StudioSpec {
  defaultPrompt: string;
  pageRole: string;
  workingLabel: string;
  fallbackStep: string | null;
  fallbackSchema: Record<string, unknown>;
  fallbackSystem: string;
  fallbackIntro: string;
  fallbackTemp: number;
  /** Parse the fallback JSON and render the built-in template. THROWS
   * (mirrors `Result<String,String>`) when the model returned nothing
   * usable. */
  render: (raw: string, label: string) => string;
  filenamePrefix: string;
  /** Only the podcast sets this — see the Rust source's own long comment on
   * why (turns must survive as DATA, and it is also the more reliable path
   * on a small model). */
  structuredFirst: boolean;
  /** Called after the artifact is saved, with (db, new file id, raw model
   * JSON). THROWS on failure — the caller treats that as best-effort and
   * only logs it. Only ever set together with `structuredFirst`. */
  afterSave?: (db: Database.Database, fileId: string, raw: string) => void;
}

/** `{warn: typeof obs.warn}` — `recRead.ts`'s own `RecReadLog`/`REAL_LOG`
 * shape, duplicated per that file's convention. */
export interface StudioLog {
  warn: typeof obs.warn;
}
const REAL_LOG: StudioLog = obs;

/** Ask the model for this artifact's STRUCTURED shape (`spec.fallbackSchema`).
 * Ported verbatim from `studio_structured`. */
async function studioStructured(
  model: string,
  spec: StudioSpec,
  instr: string,
  label: string,
  text: string,
  cancel: CancelFlag,
  chatStructuredFn: typeof chatStructuredReal
): Promise<string> {
  const messages: SidecarChatMessage[] = [
    { role: "system", content: spec.fallbackSystem },
    { role: "user", content: `${instr}\n\n${spec.fallbackIntro} "${label}":\n\n${text}` },
  ];
  return chatStructuredFn(model, messages, spec.fallbackTemp, KEEP_ALIVE_WARM, spec.fallbackSchema, { cancel });
}

function checkGuard(g: GuardResult): void {
  if (!g.ok) {
    throw new Error(g.error);
  }
}

/** Everything {@link runStudio}/{@link runStudioCore} need beyond their own
 * arguments. */
export interface RunStudioDeps {
  rooms: RoomSource;
  cancelState: CancelState;
  emit?: EmitFn;
  /** Test seam for {@link resolveStructuredModel}'s underlying `list_models`
   * call. Defaults to the real `engineRouting.ts` implementation. */
  listModels?: () => Promise<string[]>;
  /** Test seam for the underlying structured model call — both the
   * HTML-authoring primary path and the JSON fallback/structured-first path
   * use it. Defaults to the real `chatStructured` (`ollamaGenerate.ts`). */
  chatStructured?: typeof chatStructuredReal;
  /** Best-effort structured-storage failure log. Defaults to the real `obs`
   * sink (a no-op until `obs.init` has installed one). */
  log?: StudioLog;
}

/**
 * ADD-31/Owner replacement #3: register this operation's Stop flag as a CHILD
 * of `parentRun` (when one asked for this build), run the shared pipeline, and
 * dispose the node on every return path. Ported from `run_studio`, plus the
 * `dispose()` call this port's cancel-tree deviation requires — see this
 * module's own doc.
 */
export async function runStudio(
  deps: RunStudioDeps,
  spec: StudioSpec,
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  opId: string | null,
  parentRun: string | null
): Promise<FileMeta> {
  // Wave 3 (Idea 9): a Studio run writes a file at the end — don't start one
  // while a rollback is swapping the DB.
  if (deps.rooms.rollingBack?.() ?? false) {
    throw new Error(ROLLBACK_BUSY);
  }
  const node = registerStudioCancel(deps.cancelState, opId, parentRun, spec.filenamePrefix);
  try {
    return await runStudioCore(deps, spec, scope, instructions, refs, node.flag(), null);
  } finally {
    // `CancelGuard::drop` (commands.rs:481-495): remove the flat registration
    // on every exit path.
    if (opId !== null) {
      deps.cancelState.cancels.delete(opId);
      forget(deps.cancelState, opId);
    }
    // The cancel-tree deviation this module's own doc names: unlink the node
    // from its parent NOW, deterministically — Rust's `Weak` link decays on
    // its own once `_done`'s `Arc` drops; this port's strong link does not.
    node.dispose();
  }
}

/**
 * `run_studio`'s Tauri-command shape, curried over its `window`/`state`
 * equivalent — the ONE calling convention `studiosMindmap.ts`, `studiosPodcast
 * .ts` (and, transitively, `studiosFlashcards.ts`) each independently
 * predicted and built their own `studioMindmap`/`generatePodcastScript`/
 * `studioFlashcards` wrappers against, before this file existed (each one's
 * own module doc calls it "this port's best-effort prediction of that future
 * shared type's shape, so a `studios.rs` port can adopt [a spec's] return
 * value with no changes to this file"). {@link StudioSpec}/{@link
 * RunStudioFn}/{@link fillTemplate}/the three `STUDIO_*_PROMPT` constants now
 * live HERE, canonically — `studiosMindmap.ts`/`studiosPodcast.ts` import and
 * re-export them rather than keeping their own local predictions (see each
 * file's own updated module doc).
 */
export type RunStudioFn = (
  spec: StudioSpec,
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  opId: string | null,
  parentRun: string | null
) => Promise<FileMeta>;

/** Bind {@link runStudio} to one fixed `deps`, producing the curried
 * {@link RunStudioFn} shape `studioFlashcards`/`studioMindmap`/
 * `generatePodcastScript`'s own `runStudio` seam expects. The three still
 * default that seam to their own `runStudioNotImplemented` — deliberately
 * unchanged by this file: `deps` needs a real, live `RoomSource`/
 * `CancelState`, which only an app-wide host bootstrap can construct, exactly
 * like `execTool.ts`'s already-established `downloadJob`/`workflowRun` seams
 * for other job-queue-backed arms. Wiring `makeRunStudio(realDeps)` into
 * those three defaults is that future bootstrap's one-line job. */
export function makeRunStudio(deps: RunStudioDeps): RunStudioFn {
  return (spec, scope, instructions, refs, opId, parentRun) =>
    runStudio(deps, spec, scope, instructions, refs, opId, parentRun);
}

/**
 * The shared Studio pipeline, driven by an explicit `cancel` flag so a
 * background job's own flag can Stop it (a future job-runner batch's
 * territory; the foreground path above passes its chat-registry flag
 * instead). `roomPath`, when set, pins every room access: a job that runs for
 * minutes must not gather from — or write its result into — a room the user
 * swapped away from mid-run. Ported verbatim from `run_studio_core`.
 */
export async function runStudioCore(
  deps: RunStudioDeps,
  spec: StudioSpec,
  scope: string | null,
  instructions: string | null,
  refs: readonly string[] | null,
  cancel: CancelFlag,
  roomPath: string | null
): Promise<FileMeta> {
  const instr = studioInstruction(instructions, spec.defaultPrompt);
  emitSafely(deps.emit, "studio-step", { step: "Reading the material…", local: true });

  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  if (roomPath !== null && room.path !== roomPath) {
    throw new Error(ROOM_CLOSED);
  }
  const hasRefs = refs !== null && refs.length > 0;
  const [label, text] = hasRefs ? gatherFilesText(room.db, refs) : gatherScopeText(room.db, scope, room.name);

  const model = await resolveStructuredModel(deps.rooms, deps.listModels ?? listModelsReal);
  if (model === null) {
    throw new Error("The local AI (Ollama) isn't running — start it and try again.");
  }

  // "Does this leave the Mac?" is the DECLARED `local` field, never a name
  // test — see the Rust source's own comment on the `<size>-cloud` gap that
  // used to under-warn a room.
  const local = declaredFor(model).local;
  emitSafely(deps.emit, "studio-step", {
    step: local
      ? `${spec.workingLabel} — a local model can take a few minutes…`
      : `${spec.workingLabel} — your cloud AI is writing (content leaves this Mac)…`,
    local,
  });

  const chatStructuredFn = deps.chatStructured ?? chatStructuredReal;
  let structuredRaw: string | null = null;
  let content: string;
  if (spec.structuredFirst) {
    const raw = await studioStructured(model, spec, instr, label, text, cancel, chatStructuredFn);
    checkGuard(guardCommit(cancel, "the studio page"));
    content = spec.render(raw, label);
    structuredRaw = raw;
  } else {
    const generated = await generateStudioHtml(model, spec.pageRole, instr, label, text, cancel, chatStructuredFn);
    if (generated !== null && !cancel.load()) {
      content = generated;
    } else if (cancel.load()) {
      throw new Error("Stopped.");
    } else {
      if (spec.fallbackStep !== null) {
        emitSafely(deps.emit, "studio-step", { step: spec.fallbackStep, local: true });
      }
      const raw = await studioStructured(model, spec, instr, label, text, cancel, chatStructuredFn);
      if (cancel.load()) {
        throw new Error("Stopped.");
      }
      content = spec.render(raw, label);
    }
  }

  // Pin the write too: bail if the room was swapped between gather and save.
  if (roomPath !== null) {
    const cur = deps.rooms.current();
    if (cur === null || cur.path !== roomPath) {
      throw new Error(ROOM_CLOSED);
    }
  }
  // LAST look before the side effect — see the Rust source's own extensive
  // comment on why this is checked again here rather than only earlier.
  checkGuard(guardCommit(cancel, "the studio page"));

  const name = `${spec.filenamePrefix} - ${safeScopeName(label)}.html`;
  let art = Artifact.new(name, "text/html", content).by(spec.filenamePrefix).cancelWith(cancel);
  if (hasRefs) {
    art = art.fromFiles(refs);
  }
  const written = saveAndOpen(deps.rooms, deps.emit, art);
  const meta = written.meta;

  // Persist the artifact's STRUCTURE beside its page (the podcast's cast and
  // turns). Deliberately non-fatal: the page is already in the room and
  // useful, so a failure here degrades the extras rather than reporting a
  // build that visibly succeeded as failed.
  if (spec.afterSave !== undefined && structuredRaw !== null) {
    try {
      const afterRoom = deps.rooms.current();
      if (afterRoom === null) {
        throw new Error(NO_ROOM_OPEN);
      }
      spec.afterSave(afterRoom.db, meta.id, structuredRaw);
    } catch (e) {
      (deps.log ?? REAL_LOG).warn("studio.structure_not_stored", [
        ["artifact", obs.id(spec.filenamePrefix)],
        ["error", obs.errKind(errMessage(e))],
      ]);
    }
  }
  return meta;
}

// ============================================================================
// exec_tool's shared studio arm — agent.rs ~4299-4370
// ============================================================================

/**
 * Resolve the schema's file-NAME `refs` (a model has names, from
 * `list_room_files`/`search_room`, never ids) to file ids — an id slipped
 * through untouched, a name resolved via {@link findFileLike}. Missing names
 * are collected and only refused if EVERY one missed (a partial match still
 * proceeds with what resolved); an empty/absent list is `null` (whole room).
 * Ported verbatim from `agent.rs`'s `exec_tool` refs-resolution block.
 *
 * `findFileLike` already throws its OWN "No file matching..." sentence on a
 * miss — NOT reused for the final refusal here, because the Rust arm builds a
 * DIFFERENT one that names every name that missed, joined with " or ", once
 * all `wanted` names have been tried; `findFileLike`'s per-fragment message
 * would report only the FIRST miss and silently drop the rest.
 *
 * Lives HERE, not beside one artifact, because the Rust source resolves refs
 * ONCE for all three studio tools — `"studio_flashcards" | "studio_mindmap" |
 * "generate_podcast_script"` share a single match arm whose only per-artifact
 * difference is `spec`. `studiosFlashcards.ts` re-exports it as
 * `resolveFlashcardsRefs`, the name it shipped under before that arm was
 * shared.
 */
export function resolveStudioRefs(db: Database.Database, rawRefs: unknown): string[] | null {
  if (!Array.isArray(rawRefs)) {
    return null;
  }
  const wanted = rawRefs
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const ids: string[] = [];
  const missing: string[] = [];
  for (const want of wanted) {
    let isId = true;
    try {
      getFileName(db, want); // already an id — probe only, name unused
    } catch {
      isId = false;
    }
    if (isId) {
      ids.push(want);
      continue;
    }
    try {
      const [id] = findFileLike(db, want);
      ids.push(id);
    } catch {
      missing.push(want);
    }
  }
  if (missing.length > 0 && ids.length === 0) {
    throw new Error(
      `No file matching ${missing.map((m) => `"${m}"`).join(" or ")} in this room.${fileNamesHint(db)}`
    );
  }
  return ids.length === 0 ? null : ids;
}

/**
 * `agent.rs`'s ONE `exec_tool` arm for `"studio_flashcards" | "studio_mindmap"
 * | "generate_podcast_script"` (~4299-4370) — the tool-calling entry point,
 * distinct from the three `#[tauri::command]` wrappers in exactly the two ways
 * that arm's own comments call out: `scope` is always `null` (an agent has no
 * file-id scope, only `refs`/whole-room), and `parentRun` is threaded through
 * (`turn.map(TurnId::run_id)`) rather than hard-coded `null` — the
 * Owner-replacement-#3 fix that makes a Stop on the asking run cancel a studio
 * build it triggered. Returns the exact reply text Rust's arm does:
 * `Ok(format!("Saved \"{}\" into the room.", meta.name))`.
 *
 * ONE function taking `spec`, exactly as Rust has ONE arm taking `spec`: the
 * previous shape (a flashcards-only `execStudioFlashcards`, with the mind-map
 * and podcast arms refusing unconditionally) meant two of the three
 * model-invocable Studio tools stayed dead even once a host bootstrap supplied
 * a live {@link RunStudioDeps} — a divergence from a single Rust arm that no
 * per-artifact test could see.
 */
export async function execStudio(
  deps: RunStudioDeps,
  spec: StudioSpec,
  parentRun: string | null,
  args: Record<string, unknown>
): Promise<string> {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const refs = resolveStudioRefs(room.db, (args as { refs?: unknown }).refs);
  const instructions = typeof args.instructions === "string" ? args.instructions : null;
  const meta = await runStudio(deps, spec, null, instructions, refs, null, parentRun);
  return `Saved "${meta.name}" into the room.`;
}

// ============================================================================
// studio_spec_for / studio_title
// ============================================================================

export type StudioKind = "flashcards" | "mindmap" | "podcast";

function isStudioKind(k: string): k is StudioKind {
  return k === "flashcards" || k === "mindmap" || k === "podcast";
}

/**
 * `flashcards_spec`/`mindmap_spec`/`podcast_spec` — all three now REAL and
 * tested (`studiosFlashcards.ts`'s `flashcardsSpec`, `studiosMindmap.ts`'s
 * `mindmapSpec`, `studiosPodcast.ts`'s `podcastSpec`), so a caller can pass
 * `{flashcards: flashcardsSpec, mindmap: mindmapSpec, podcast: podcastSpec}`
 * here today. This file does not import the three itself — `studios.rs`
 * genuinely never called them by name either (Rust's own `studio_spec_for`
 * match arm does, but that caller, `jobs.rs`'s `spawn_studio`/
 * `start_studio_job_inner`, is `jobs.ts`'s own documented future-batch gap,
 * not this file's) — so a THIRD copy of the wiring decision does not get
 * made here ahead of the job-runner batch that actually needs it. Each key
 * mirrors `studio_spec_for`'s own match arm.
 */
export interface StudioSpecFactories {
  readonly flashcards?: () => StudioSpec;
  readonly mindmap?: () => StudioSpec;
  readonly podcast?: () => StudioSpec;
}

/**
 * Reconstruct a studio's `StudioSpec` from a durable job's `kind` string.
 * `factories` defaults to empty, so this HONESTLY returns `null` for every
 * kind until a caller registers real factories — never a fabricated spec.
 * This is a deliberate signature deviation from Rust's `fn(kind: &str) ->
 * Option<StudioSpec>` (which needs no registry, because
 * `flashcards_spec`/`mindmap_spec`/`podcast_spec` are real in Rust): the
 * three factories are the one genuinely unported dependency in this file, and
 * a registry — not a thrown `NOT_IMPLEMENTED:` — keeps `studio_spec_for`'s
 * own `Option`-returning shape intact for whichever future batch ports its
 * caller (`jobs.rs`'s `match studio_spec_for(&kind) { Some(spec) => ...,
 * None => fail() }`, itself still out of scope — see `jobs.ts`'s own module
 * doc).
 */
export function studioSpecFor(kind: string, factories: StudioSpecFactories = {}): StudioSpec | null {
  if (!isStudioKind(kind)) {
    return null;
  }
  // `factories[kind]` is a plain member read on a caller-supplied object
  // literal (the default is `{}`), and `kind` comes from a durable job plan's
  // stored string. A polluted `Object.prototype.mindmap` therefore used to be
  // returned as if a caller had registered it — a FABRICATED spec on a
  // registry that genuinely had none, which is precisely the read-side hole
  // `jsonTools.ts`'s own `ownValue` doc describes ("with `Object.prototype
  // .html` set to a string, `jsonStrField(reply, "html")` used to hand a
  // studio generator that string as if the model had produced it"). Rust's
  // `match kind { "mindmap" => Some(mindmap_spec()), ... }` has no such
  // surface at all.
  const factory = Object.prototype.hasOwnProperty.call(factories, kind)
    ? (factories[kind] as (() => StudioSpec) | undefined)
    : undefined;
  return factory !== undefined ? factory() : null;
}

/** Human title for a studio job card. Ported verbatim from `studio_title` —
 * pure string mapping, real regardless of whether the three specs exist. */
export function studioTitle(kind: string): string {
  switch (kind) {
    case "flashcards":
      return "Flashcards";
    case "mindmap":
      return "Mind map";
    case "podcast":
      return "Podcast script";
    default:
      return "Studio";
  }
}
