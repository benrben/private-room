/**
 * Ported from `src-tauri/src/commands/sketch.rs` (1,014 lines, read in full)
 * — the Sketch page's four commands and the two tools the drawing agent
 * holds, over the pure engine in `sketchDoc.ts` and the one native seam in
 * `sketchRaster.ts`.
 *
 * A SKETCH IS AN ORDINARY ROOM FILE — `.sketch`, holding the JSON document
 * `sketchDoc.ts` defines — and that is the whole storage design. It buys
 * version history on every save, trash and restore, provenance, the tab
 * strip, the Library listing and full-text search of its labels without a
 * line of code here, over the already-real `db-host/files.ts` and
 * `db-host/versions.ts` primitives — and it means the agent's drawings and
 * the user's are the same objects.
 *
 * WHY TWO TOOLS AND NOT SEVEN. The obvious shape for a drawing API is one
 * verb per operation, and that shape is wrong for a model: each call is a
 * full round trip, so a nine-box diagram costs nine turns and a small model
 * loses the thread around the fourth. So {@link execDraw} takes a WHOLE
 * SCRIPT in one call and {@link execReadDrawing} gives the page back as that
 * same script plus its measured layout problems — a complete draw → look →
 * fix loop in two round trips instead of thirty, with every argument a flat
 * string.
 *
 * TOOL SPECS ARE NOT RE-PORTED HERE: `toolSpecs.ts` already carries
 * `draw_tools_specs()`/`DRAW_TOOL_NAMES` verbatim from a prior batch. This
 * file supplies the two tools' real logic, which `execTool.ts`'s
 * `"draw"`/`"read_drawing"` arms dispatch to.
 *
 * PRIVACY/VISION WIRING IS REAL, not injected: `read_drawing`'s decision
 * about whether to attach the rendered picture goes through the already-
 * committed `modelSetting` (`gatherContext.ts`), `runsOnThisMac`
 * (`capabilities.ts`) and `activePolicy` (`privacy.ts`) — the same three
 * functions the Rust source calls for this exact question.
 *
 * ERROR CONVENTION. Rust's `Result<T, String>` becomes a THROWN `Error`
 * here (this port's db-host convention), except for {@link resolveNamed},
 * which keeps a DISCRIMINATED-UNION return because {@link drawTarget}
 * branches on WHICH of the three ways a name search can end — the exact
 * distinction Rust's `Unresolved` enum exists to preserve, and whose loss
 * once made an ambiguous name start a third drawing.
 *
 * IPC lives in `sketchIpc.ts`, unwired, per `recIpc.ts`'s precedent.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import path from "node:path";
import { Readable } from "node:stream";
import {
  availableName,
  type FileMeta,
  getFileBytes,
  getFileMeta,
  getFileName,
  inTransaction,
  insertFile,
  listFiles,
  markSectionOnly,
  renameFile,
  setFileExtractedText,
  updateFileContent,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { extensionOf } from "./editMatchExtraction.js";
import { extractText } from "./editMatch.js";
import { runsOnThisMac } from "./capabilities.js";
import { modelSetting } from "./gatherContext.js";
import { activePolicy } from "./privacy.js";
import {
  applyScript,
  defaultSketch,
  layoutReport,
  type ScriptOutcome,
  scriptOutcomeIsEmpty,
  scriptOutcomeSummary,
  type Sketch,
  sketchExtractedText,
  sketchFromJson,
  sketchToJson,
  rustTrim,
  toScript,
  toSvg,
} from "./sketchDoc.js";
import { toPng } from "./sketchRaster.js";
import { createRoomFile, readRoomFile, writeRoomFile } from "./workspace/roomContent.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

// ------------------------------------------------------------------- shell

/** Structurally-identical sibling of `execTool.ts`'s own `ToolOutcome` /
 * `fileTools.ts`'s `FileToolOutcome` — this module has no dependency, type
 * or value, on either, matching the convention those files' own docs
 * establish. */
export type SketchToolOutcome = { ok: true; text: string } | { ok: false; error: string };

function ok(text: string): SketchToolOutcome {
  return { ok: true, text };
}

function fail(error: string): SketchToolOutcome {
  return { ok: false, error };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful room mutation into a failed call. */
export type EmitFn = (event: string, payload: unknown) => void;

export function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ------------------------------------------------------------------ naming

/** The extension that makes a room file a drawing. */
export const SKETCH_EXT = "sketch";

function isSketch(name: string): boolean {
  return extensionOf(name) === SKETCH_EXT;
}

/** The MIME a drawing carries. The viewer is picked by EXTENSION, so this is
 * only what the Library shows and what an export would carry — but naming it
 * honestly is what stops a `.sketch` being treated as arbitrary JSON by
 * anything that reads the column instead of the name. */
const SKETCH_MIME = "application/json";

/** Rust's `str::trim_end_matches` strips the pattern REPEATEDLY
 * (`"a.sketch.sketch".trim_end_matches(".sketch")` is `"a"`, not
 * `"a.sketch"`); `endsWith`/`slice` alone would strip one. */
function trimEndMatches(s: string, suffix: string): string {
  let out = s;
  while (suffix !== "" && out.endsWith(suffix)) {
    out = out.slice(0, out.length - suffix.length);
  }
  return out;
}

function sketchName(nameRaw: string): string {
  const trimmed = rustTrim(nameRaw);
  const n = trimmed === "" ? "Sketch" : trimmed;
  return isSketch(n) ? n : `${n}.${SKETCH_EXT}`;
}

function nameList(all: ReadonlyArray<readonly [string, string]>): string {
  return all.map(([, n]) => n).join(", ");
}

// ------------------------------------------------------- room file access

/** Every drawing in the room, NEWEST FIRST — `listFiles` orders by
 * `created_at DESC` (as Rust's `db::list_files` does), and
 * {@link takeEmptySketch} depends on that being true. */
function listSketches(db: Database.Database): Array<[string, string]> {
  return listFiles(db)
    .filter((f) => isSketch(f.name))
    .map((f): [string, string] => [f.id, f.name]);
}

function load(db: Database.Database, id: string): Sketch {
  const bytes = getFileBytes(db, id);
  return sketchFromJson(bytes === null ? "" : bytes.toString("utf8"));
}

/** `commands::files::store_file_bytes` — the single write path for changing
 * an existing file's bytes: snapshot the CURRENT bytes into version history
 * tagged with `cause`, then overwrite, in ONE transaction. */
function storeFileBytes(db: Database.Database, id: string, bytes: Uint8Array, text: string | null, cause: string): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

/** Write a drawing back. Goes through `storeFileBytes` like every other
 * content write in the app, so a drawing the agent changed can be recovered
 * from version history exactly like one the user typed over. */
function save(db: Database.Database, id: string, doc: Sketch, cause: string): void {
  storeFileBytes(db, id, Buffer.from(sketchToJson(doc), "utf8"), sketchExtractedText(doc), cause);
}

function insertSketch(db: Database.Database, name: string, doc: Sketch, source: string): FileMeta {
  const unique = availableName(db, sketchName(name));
  const json = sketchToJson(doc);
  return insertFile(db, unique, SKETCH_MIME, Buffer.from(json, "utf8"), sketchExtractedText(doc), source);
}

export interface SketchRoom {
  db: Database.Database;
  path: string;
  workspace?: WorkspaceService;
}

async function loadInRoom(room: SketchRoom, id: string): Promise<Sketch> {
  const bytes = (await readRoomFile(room, id)).bytes;
  return sketchFromJson(bytes === null ? "" : bytes.toString("utf8"));
}

async function insertSketchInRoom(
  room: SketchRoom,
  name: string,
  doc: Sketch,
  source: string,
): Promise<FileMeta> {
  const unique = availableName(room.db, sketchName(name));
  const json = sketchToJson(doc);
  return createRoomFile(
    room,
    unique,
    SKETCH_MIME,
    Buffer.from(json, "utf8"),
    sketchExtractedText(doc),
    source,
  );
}

async function renameSketchInRoom(room: SketchRoom, id: string, name: string): Promise<void> {
  if (room.workspace === undefined) {
    renameFile(room.db, id, name);
    return;
  }
  const row = room.db.prepare(
    "SELECT relative_path, content_sha256 FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(id) as { relative_path: string | null; content_sha256: string | null } | undefined;
  if (row?.relative_path === null || row?.relative_path === undefined) {
    throw new Error("That drawing is no longer in this room.");
  }
  const parent = path.posix.dirname(row.relative_path);
  await room.workspace.move(
    id,
    parent === "." ? name : path.posix.join(parent, name),
    row.content_sha256 ?? undefined,
  );
}

// --------------------------------------------------------------- resolving

/**
 * Why a name did not land on a drawing — Rust's `Unresolved`, collapsed into
 * one discriminated return.
 *
 * The three answers lead different ways, and the difference was being thrown
 * away: an unknown name may be created, an ambiguous one must go back to the
 * model. `tool_draw` matched on `Err(_)` and so answered an ambiguity by
 * starting a THIRD drawing — or by renaming a blank one — while the diagram
 * the user meant sat untouched under a name they never chose.
 */
type ResolveResult =
  | { ok: true; id: string; name: string }
  | { ok: false; kind: "not_found" | "ambiguous" | "failed"; message: string };

/**
 * Find the drawing the model means.
 *
 * Exact name, then a fragment, then — if the room holds exactly one drawing —
 * that one. The last rule is what makes `name` effectively optional in
 * practice: the overwhelmingly common case is a room with one sketch open,
 * and making the model repeat its name is a turn spent on bookkeeping.
 *
 * Ambiguity is reported rather than guessed. The room's generic
 * `findFileLike` resolves a fragment to the NEWEST match, which for files the
 * agent itself just created means a typo silently retargets the wrong
 * drawing — so this does not use it.
 */
function resolveNamed(db: Database.Database, nameRaw: string): ResolveResult {
  let all: Array<[string, string]>;
  try {
    all = listSketches(db);
  } catch (e) {
    return { ok: false, kind: "failed", message: errMessage(e) };
  }
  if (all.length === 0) {
    return {
      ok: false,
      kind: "not_found",
      message: "This room has no drawings yet. Use `draw` with a new name to start one.",
    };
  }
  const want = rustTrim(nameRaw);
  if (want === "") {
    if (all.length === 1) {
      const only = all[0] as [string, string];
      return { ok: true, id: only[0], name: only[1] };
    }
    return { ok: false, kind: "ambiguous", message: `Which drawing? This room has ${all.length}: ${nameList(all)}.` };
  }
  // Full Unicode lowercasing here, matching the Rust source's own
  // `to_lowercase()` — unlike the script parser, which is ASCII-only.
  const lower = want.toLowerCase();
  const stem = rustTrim(trimEndMatches(lower, `.${SKETCH_EXT}`));
  const exact = all.find(([, n]) => n.toLowerCase() === lower);
  if (exact !== undefined) {
    return { ok: true, id: exact[0], name: exact[1] };
  }
  const stemHit = all.find(([, n]) => trimEndMatches(n.toLowerCase(), `.${SKETCH_EXT}`) === stem);
  if (stemHit !== undefined) {
    return { ok: true, id: stemHit[0], name: stemHit[1] };
  }
  const hits = all.filter(([, n]) => n.toLowerCase().includes(stem));
  if (hits.length === 1) {
    const hit = hits[0] as [string, string];
    return { ok: true, id: hit[0], name: hit[1] };
  }
  if (hits.length === 0) {
    return {
      ok: false,
      kind: "not_found",
      message: `There is no drawing called "${want}". This room has: ${nameList(all)}.`,
    };
  }
  return {
    ok: false,
    kind: "ambiguous",
    message: `"${want}" matches ${hits.length} drawings: ${nameList(hits)}. Use the full name.`,
  };
}

/** The same lookup, throwing on any failure — the shape every caller but
 * `draw` wants. Ported from `resolve`. */
function resolve(db: Database.Database, name: string): [string, string] {
  const r = resolveNamed(db, name);
  if (r.ok) {
    return [r.id, r.name];
  }
  throw new Error(r.message);
}

/**
 * Claim a blank sketch and give it the name the drawing is about.
 *
 * Returns `null` when every sketch in the room has something on it.
 * Deliberately picks the NEWEST blank one: it is the one the user most likely
 * just made and is looking at.
 */
function takeEmptySketch(db: Database.Database, name: string): [string, string] | null {
  const blank = listSketches(db).find(([id]) => {
    try {
      return load(db, id).elements.length === 0;
    } catch {
      // A drawing whose bytes will not parse is not a blank page to claim.
      return false;
    }
  });
  if (blank === undefined) {
    return null;
  }
  const [id] = blank;
  const wanted = availableName(db, sketchName(name));
  renameFile(db, id, wanted);
  return [id, wanted];
}

/**
 * The drawing a `draw` call is about: an existing one, an empty one claimed,
 * or a new file — and which of the three it was.
 *
 * An unknown name is a NEW drawing rather than an error. The result says
 * which happened, because a typo that quietly created "Login flwo" beside the
 * real drawing is otherwise invisible until the user opens the Library.
 *
 * An unknown name is a new drawing — but not necessarily a new FILE. The
 * common way this feature is used is: press "New sketch", look at the blank
 * page, ask for a diagram. Creating a second file there is correct by the
 * letter and wrong by every other measure — the user watches a blank canvas
 * while their diagram lands somewhere they have to go and find, and the page
 * they started is left behind as litter (live QA 2026-08-13). So an EMPTY
 * sketch is claimed and renamed rather than orphaned. Only an empty one: a
 * drawing with anything on it is work, and work is never silently
 * repurposed. And an AMBIGUOUS name claims nothing at all — it goes back to
 * the model, which is the only place the answer is.
 */
function drawTarget(db: Database.Database, name: string): [string, string, boolean] {
  const r = resolveNamed(db, name);
  if (r.ok) {
    return [r.id, r.name, false];
  }
  if (r.kind === "not_found") {
    const taken = takeEmptySketch(db, name);
    if (taken !== null) {
      return [taken[0], taken[1], false];
    }
    const meta = insertSketch(db, name, defaultSketch(), "generated");
    // Section-only, exactly like one the user starts. A drawing is a drawing
    // whoever made it: filing the assistant's in Home while the user's own
    // stays in Sketches would make the rule depend on who held the pen.
    markSectionOnly(db, meta.id, "sketch");
    return [meta.id, meta.name, true];
  }
  throw new Error(r.message);
}

async function takeEmptySketchInRoom(room: SketchRoom, name: string): Promise<[string, string] | null> {
  for (const [id] of listSketches(room.db)) {
    try {
      if ((await loadInRoom(room, id)).elements.length !== 0) continue;
      const wanted = availableName(room.db, sketchName(name));
      await renameSketchInRoom(room, id, wanted);
      return [id, wanted];
    } catch {
      // A drawing that cannot be read is not a blank page to claim.
    }
  }
  return null;
}

async function drawTargetInRoom(room: SketchRoom, name: string): Promise<[string, string, boolean]> {
  if (room.workspace === undefined) return drawTarget(room.db, name);
  const resolved = resolveNamed(room.db, name);
  if (resolved.ok) return [resolved.id, resolved.name, false];
  if (resolved.kind !== "not_found") throw new Error(resolved.message);
  const taken = await takeEmptySketchInRoom(room, name);
  if (taken !== null) return [taken[0], taken[1], false];
  const meta = await insertSketchInRoom(room, name, defaultSketch(), "generated");
  markSectionOnly(room.db, meta.id, "sketch");
  return [meta.id, meta.name, true];
}

// ---------------------------------------------------------------------------
// Commands the page calls
// ---------------------------------------------------------------------------

/**
 * Start a new drawing. Loading and saving ride the ordinary file commands, so
 * this is the only command the page needs that does not already exist.
 *
 * Section-only: a new drawing belongs to Sketches, and appears in Home only
 * when the person who made it says so ("Add to Library"). Same encrypted room
 * file either way.
 *
 * The `room-files-changed` broadcast Rust's `#[tauri::command]` wrapper sends
 * is `sketchIpc.ts`'s, not this function's — the IPC registration is this
 * port's equivalent of that wrapper, and keeping the emit there leaves the
 * rule this function enforces testable without one.
 */
export function createSketch(db: Database.Database, name: string): FileMeta {
  const meta = insertSketch(db, name, defaultSketch(), "upload");
  markSectionOnly(db, meta.id, "sketch");
  return getFileMeta(db, meta.id);
}

export async function createSketchInRoom(room: SketchRoom, name: string): Promise<FileMeta> {
  if (room.workspace === undefined) return createSketch(room.db, name);
  const meta = await insertSketchInRoom(room, name, defaultSketch(), "upload");
  markSectionOnly(room.db, meta.id, "sketch");
  return getFileMeta(room.db, meta.id);
}

/**
 * Save a drawing. The path a person's own drawing takes, several times a
 * minute, for as long as they are drawing — `save_sketch`'s body.
 *
 * PARSE BEFORE WRITING: a save is the one moment a malformed document can
 * become the file itself, and a drawing that will not open is worse than a
 * save that refused.
 *
 * This is deliberately NOT the ordinary `update_file_content` path, which is
 * three things a drawing cannot afford on every stroke: it copies the WHOLE
 * file into version history (two minutes of drawing left a hundred
 * near-identical versions), it rebuilds the search index, and it broadcasts
 * `room-files-changed`, which makes the Library, the gallery and the viewer
 * all re-read while the pointer is still down. Together those made the canvas
 * stutter and, with a big drawing, stall outright (live QA 2026-08-13: "its
 * saved each change its not good, this is why its stucks"). So the autosave
 * is a plain content write, and history is taken ONCE per editing session —
 * `snapshot` is true on the editor's first save after opening the file.
 * Fine-grained undo is ⌘Z, which never needed the database.
 */
export function writeSketch(db: Database.Database, id: string, doc: string, snapshot: boolean): void {
  const parsed = sketchFromJson(doc);
  if (snapshot) {
    snapshotFileVersion(db, id, "Before you drew");
  }
  updateFileContent(db, id, Buffer.from(doc, "utf8"), sketchExtractedText(parsed));
}

export async function writeSketchInRoom(
  room: SketchRoom,
  id: string,
  doc: string,
  snapshot: boolean,
): Promise<void> {
  if (room.workspace === undefined) {
    writeSketch(room.db, id, doc, snapshot);
    return;
  }
  const parsed = sketchFromJson(doc);
  const row = room.db.prepare(
    "SELECT content_sha256 FROM files WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL",
  ).get(id) as { content_sha256: string | null } | undefined;
  if (row === undefined) throw new Error("That drawing is no longer in this room.");
  if (snapshot) await room.workspace.snapshotVersion(id, "Before you drew");
  await room.workspace.writeAtomic(
    id,
    Readable.from([Buffer.from(doc, "utf8")]),
    row.content_sha256 ?? undefined,
  );
  setFileExtractedText(room.db, id, sketchExtractedText(parsed));
}

/**
 * Flatten a drawing into a standalone `.svg` room file.
 *
 * The SVG kind already exists in this app, with its own viewer, source view
 * and label extraction, so an exported drawing is immediately a first-class
 * document rather than a dead end.
 *
 * KNOWN GAP, INHERITED NOT INTRODUCED: the index text comes from the shared
 * `extractText`, exactly as Rust's `extraction::extract_text(&unique, …)`
 * does — but this port's `editMatch.ts` has no `.svg` branch yet
 * (`extraction/data.rs`'s `extract_svg`, which reads `<title>/<desc>/<text>/
 * <tspan>/<textPath>` bodies, belongs to that module and is unported), so an
 * exported SVG currently indexes as NOTHING where the Rust build indexes its
 * labels. Deliberately still routed through `extractText` rather than given a
 * local look-alike: when that branch lands, this export becomes searchable
 * with no change here. `exportSketchPng` is unaffected — Rust hands it the
 * drawing's own `extracted_text()` explicitly, and so does this.
 */
export function exportSketchSvg(db: Database.Database, id: string): FileMeta {
  const name = getFileName(db, id);
  const doc = load(db, id);
  const stem = trimEndMatches(name, `.${SKETCH_EXT}`);
  const svgBytes = Buffer.from(toSvg(doc), "utf8");
  const unique = availableName(db, `${stem}.svg`);
  return insertFile(db, unique, "image/svg+xml", svgBytes, extractText(unique, svgBytes), "generated");
}

export async function exportSketchSvgInRoom(room: SketchRoom, id: string): Promise<FileMeta> {
  if (room.workspace === undefined) return exportSketchSvg(room.db, id);
  const name = getFileName(room.db, id);
  const doc = await loadInRoom(room, id);
  const stem = trimEndMatches(name, `.${SKETCH_EXT}`);
  const svgBytes = Buffer.from(toSvg(doc), "utf8");
  const unique = availableName(room.db, `${stem}.svg`);
  return createRoomFile(
    room,
    unique,
    "image/svg+xml",
    svgBytes,
    extractText(unique, svgBytes),
    "generated",
  );
}

/**
 * Flatten a drawing into a standalone `.png` room file.
 *
 * The same rasteriser the agent looks through, so what someone exports and
 * what the model sees are one picture. SVG stays the better export — it is
 * the one that can be reopened and edited — but a PNG is what goes into a
 * message, a document, or anywhere that will not take a vector.
 *
 * `async` where Rust is sync: see `sketchRaster.ts`'s module doc.
 */
export async function exportSketchPng(db: Database.Database, id: string): Promise<FileMeta> {
  const name = getFileName(db, id);
  const doc = load(db, id);
  const stem = trimEndMatches(name, `.${SKETCH_EXT}`);
  const png = await toPng(doc);
  const unique = availableName(db, `${stem}.png`);
  // The labels, so an exported picture is still searchable in the room it
  // came from — a flat image nobody can find again is a dead end.
  const text = sketchExtractedText(doc);
  return insertFile(db, unique, "image/png", png, rustTrim(text) === "" ? null : text, "generated");
}

export async function exportSketchPngInRoom(room: SketchRoom, id: string): Promise<FileMeta> {
  if (room.workspace === undefined) return exportSketchPng(room.db, id);
  const name = getFileName(room.db, id);
  const doc = await loadInRoom(room, id);
  const stem = trimEndMatches(name, `.${SKETCH_EXT}`);
  const png = await toPng(doc);
  const unique = availableName(room.db, `${stem}.png`);
  const text = sketchExtractedText(doc);
  return createRoomFile(
    room,
    unique,
    "image/png",
    png,
    rustTrim(text) === "" ? null : text,
    "generated",
  );
}

// ---------------------------------------------------------------------------
// The agent's tools
// ---------------------------------------------------------------------------

/** How a drawing that measures wrong ends, in the tool result the model
 * reads. Held next to the tool names it mentions (`toolSpecs.ts`'s
 * `DRAW_TOOL_NAMES`): it sent the model after `see_drawing` for as long as
 * that tool had not existed, which costs a turn on a call the catalog cannot
 * accept. */
export const DRAW_FOLLOWUP = "Call read_drawing to look at it, then draw again to correct it.";

/** How a drawing reads to a model: the script, then what is wrong with it. */
function describe(doc: Sketch, name: string): string {
  let out = `Drawing "${name}":\n${toScript(doc)}`;
  if (doc.elements.length === 0) {
    out += "(the page is empty)\n";
  }
  const notes = layoutReport(doc);
  if (notes.length > 0) {
    out += "\nProblems with the layout:\n";
    for (const n of notes) {
      out += `- ${n}\n`;
    }
  }
  return out;
}

/** The `ToolEffects` slice `read_drawing` touches — structurally the same
 * fields `execTool.ts`'s own `ToolEffects` carries, declared locally so this
 * module has no dependency on that file. */
export interface SketchToolEffects {
  pendingImages: string[];
  visionChat: boolean;
}

/**
 * Look at a drawing.
 *
 * Two halves, and the TEXT half carries the weight. A raster only helps a
 * model that reads pictures well, and the small local models this app is
 * built around do not; the measured layout report is exact on every engine,
 * needs no vision model, and names the fix for each problem it finds.
 *
 * The picture is attached only when the chat model can already read images —
 * never by loading a separate local vision model to describe it, the way the
 * screen and video tools do. That fallback costs a multi-gigabyte model load
 * on a call the model may make after every edit, and what it returns for a
 * diagram ("a flowchart with several labelled boxes") is strictly less useful
 * than the measurements already above it.
 */
export async function execReadDrawing(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: SketchToolEffects
): Promise<SketchToolOutcome> {
  const name = asString(args.name);
  let real: string;
  let doc: Sketch;
  let model: string | null;
  try {
    const [id, resolvedName] = resolve(db, name);
    real = resolvedName;
    doc = load(db, id);
    model = modelSetting(db);
  } catch (e) {
    return fail(errMessage(e));
  }

  let out = describe(doc, real);
  if (doc.elements.length > 0 && layoutReport(doc).length === 0) {
    out += "\nNothing measures wrong: no overlaps, nothing off the page, every shape labelled.\n";
  }
  if (!effects.visionChat || doc.elements.length === 0) {
    return ok(out);
  }

  // The pixels are this room's own drawing, so the door that governs them is
  // the one that governs its documents. A cloud model gets the text — which
  // passes the redaction door like any other tool result — and is told
  // plainly that it is not being shown the picture, rather than being handed
  // an image the door will strip and then asked to describe it.
  const localChat = model === null || runsOnThisMac(model);
  if (!localChat && activePolicy() !== null) {
    out +=
      "\n(Not showing you the picture: this room's privacy door keeps images on this Mac. " +
      "The measurements above describe the same drawing.)";
    return ok(out);
  }

  try {
    const png = await toPng(doc);
    effects.pendingImages.push(png.toString("base64"));
    out += "\nThe drawing is attached as a picture — look at it before you change anything.";
  } catch (e) {
    // A rendering failure must not lose the report, which is the greater half
    // of the answer and is already built.
    out += `\n(The picture could not be drawn: ${errMessage(e)})`;
  }
  return ok(out);
}

export async function execReadDrawingInRoom(
  room: SketchRoom,
  args: Record<string, unknown>,
  effects: SketchToolEffects,
): Promise<SketchToolOutcome> {
  if (room.workspace === undefined) return execReadDrawing(room.db, args, effects);
  const name = asString(args.name);
  let real: string;
  let doc: Sketch;
  let model: string | null;
  try {
    const [id, resolvedName] = resolve(room.db, name);
    real = resolvedName;
    doc = await loadInRoom(room, id);
    model = modelSetting(room.db);
  } catch (e) {
    return fail(errMessage(e));
  }

  let out = describe(doc, real);
  if (doc.elements.length > 0 && layoutReport(doc).length === 0) {
    out += "\nNothing measures wrong: no overlaps, nothing off the page, every shape labelled.\n";
  }
  if (!effects.visionChat || doc.elements.length === 0) return ok(out);
  const localChat = model === null || runsOnThisMac(model);
  if (!localChat && activePolicy() !== null) {
    out +=
      "\n(Not showing you the picture: this room's privacy door keeps images on this Mac. " +
      "The measurements above describe the same drawing.)";
    return ok(out);
  }
  try {
    const png = await toPng(doc);
    effects.pendingImages.push(png.toString("base64"));
    out += "\nThe drawing is attached as a picture — look at it before you change anything.";
  } catch (e) {
    out += `\n(The picture could not be drawn: ${errMessage(e)})`;
  }
  return ok(out);
}

/**
 * Draw on a room sketch.
 *
 * `emit` carries the three window events the Rust source sends:
 *  - `agent-open-file`, because drawing on a sketch that is not the open one
 *    otherwise succeeds SILENTLY — the model reports a finished diagram, the
 *    canvas on screen is still blank, and the only way to find the work is to
 *    go looking in the Library (live QA 2026-08-13 hit exactly that on the
 *    first try);
 *  - `sketch-drawn`, carrying the WHOLE document rather than just the ids, so
 *    the editor need not re-read the file to find out what changed — between
 *    the write and that read the user can draw, which is exactly the window
 *    in which a reload silently throws their stroke away;
 *  - `room-files-changed`.
 *
 * NOT TRANSACTIONAL, faithfully: Rust's `with_room` takes a lock, not a
 * transaction, so a call whose script fails to parse can still leave
 * `drawTarget`'s file creation or rename committed. Reproduced rather than
 * "fixed", because the editor and the agent must agree about what a failed
 * draw leaves behind.
 */
export function execDraw(db: Database.Database, args: Record<string, unknown>, emit?: EmitFn): SketchToolOutcome {
  const name = rustTrim(asString(args.name));
  const script = asString(args.script);
  if (name === "") {
    return fail("Say which sketch to draw on — a new name starts a new drawing.");
  }

  let id: string;
  let real: string;
  let created: boolean;
  let outcome: ScriptOutcome;
  let doc: Sketch;
  try {
    [id, real, created] = drawTarget(db, name);
    doc = load(db, id);
    const applied = applyScript(doc, script);
    if (!applied.ok) {
      return fail(applied.error);
    }
    outcome = applied.value;
    if (!scriptOutcomeIsEmpty(outcome)) {
      save(db, id, doc, "The assistant drew");
    }
  } catch (e) {
    return fail(errMessage(e));
  }

  emitSafely(emit, "agent-open-file", { id });
  emitSafely(emit, "sketch-drawn", {
    fileId: id,
    name: real,
    added: outcome.added,
    changed: outcome.changed,
    removed: outcome.removed,
    steps: outcome.steps,
    doc: sketchToJson(doc),
  });
  emitSafely(emit, "room-files-changed", undefined);

  const opened = created ? `Started "${real}" and ` : "";
  let msg = `${opened}${scriptOutcomeSummary(outcome)} on "${real}". The page now holds ${doc.elements.length} thing(s).`;
  const notes = layoutReport(doc);
  if (notes.length > 0) {
    msg += "\n\nWorth fixing:\n";
    for (const n of notes.slice(0, 8)) {
      msg += `- ${n}\n`;
    }
    msg += DRAW_FOLLOWUP;
  }
  return ok(msg);
}

export async function execDrawInRoom(
  room: SketchRoom,
  args: Record<string, unknown>,
  emit?: EmitFn,
): Promise<SketchToolOutcome> {
  if (room.workspace === undefined) return execDraw(room.db, args, emit);
  const name = rustTrim(asString(args.name));
  const script = asString(args.script);
  if (name === "") return fail("Say which sketch to draw on — a new name starts a new drawing.");

  let id: string;
  let real: string;
  let created: boolean;
  let outcome: ScriptOutcome;
  let doc: Sketch;
  try {
    [id, real, created] = await drawTargetInRoom(room, name);
    doc = await loadInRoom(room, id);
    const applied = applyScript(doc, script);
    if (!applied.ok) return fail(applied.error);
    outcome = applied.value;
    if (!scriptOutcomeIsEmpty(outcome)) {
      const json = sketchToJson(doc);
      await writeRoomFile(
        room,
        id,
        Buffer.from(json, "utf8"),
        sketchExtractedText(doc),
        "The assistant drew",
      );
    }
  } catch (e) {
    return fail(errMessage(e));
  }

  emitSafely(emit, "agent-open-file", { id });
  emitSafely(emit, "sketch-drawn", {
    fileId: id,
    name: real,
    added: outcome.added,
    changed: outcome.changed,
    removed: outcome.removed,
    steps: outcome.steps,
    doc: sketchToJson(doc),
  });
  emitSafely(emit, "room-files-changed", undefined);

  const opened = created ? `Started "${real}" and ` : "";
  let msg = `${opened}${scriptOutcomeSummary(outcome)} on "${real}". The page now holds ${doc.elements.length} thing(s).`;
  const notes = layoutReport(doc);
  if (notes.length > 0) {
    msg += "\n\nWorth fixing:\n";
    for (const note of notes.slice(0, 8)) msg += `- ${note}\n`;
    msg += DRAW_FOLLOWUP;
  }
  return ok(msg);
}
