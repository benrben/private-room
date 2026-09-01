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
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  availableName,
  type FileMeta,
  getFileMeta,
  getFileName,
  insertFile,
  markSectionOnly,
  setFileExtractedText,
  updateFileContent,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
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
import {
  drawTarget,
  drawTargetInRoom,
  errMessage,
  insertSketch,
  insertSketchInRoom,
  load,
  loadInRoom,
  resolve,
  save,
  SKETCH_EXT,
  trimEndMatches,
  type SketchRoom,
} from "./sketchStore.js";
import { createRoomFile, writeRoomFile } from "./workspace/roomContent.js";

export { SKETCH_EXT, type SketchRoom } from "./sketchStore.js";

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
  expectedDoc?: string,
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
  // The editor sends the exact document it originally read (then advances it
  // after each successful save). Using the database's hash at save time would
  // silently bless an external Finder/editor change that happened while this
  // canvas was open, and overwrite it. The normal file remains the truth: its
  // bytes must still match the canvas's last-known document.
  const expectedHash = expectedDoc === undefined
    ? row.content_sha256 ?? undefined
    : createHash("sha256").update(expectedDoc, "utf8").digest("hex");
  await room.workspace.writeAtomic(
    id,
    Readable.from([Buffer.from(doc, "utf8")]),
    expectedHash,
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

function describedDrawing(doc: Sketch, name: string): string {
  let out = describe(doc, name);
  if (doc.elements.length > 0 && layoutReport(doc).length === 0) {
    out += "\nNothing measures wrong: no overlaps, nothing off the page, every shape labelled.\n";
  }
  return out;
}

function shouldAttachDrawing(effects: SketchToolEffects, doc: Sketch): boolean {
  return effects.visionChat && doc.elements.length > 0;
}

function pictureIsBlocked(model: string | null): boolean {
  if (model === null) return false;
  if (runsOnThisMac(model)) return false;
  return activePolicy() !== null;
}

async function readDrawingResult(
  doc: Sketch,
  name: string,
  model: string | null,
  effects: SketchToolEffects,
): Promise<SketchToolOutcome> {
  let out = describedDrawing(doc, name);
  if (!shouldAttachDrawing(effects, doc)) return ok(out);
  if (pictureIsBlocked(model)) {
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
  return readDrawingResult(doc, real, model, effects);
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
  return readDrawingResult(doc, real, model, effects);
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
function emitDrawingEvents(
  emit: EmitFn | undefined,
  id: string,
  name: string,
  outcome: ScriptOutcome,
  doc: Sketch,
): void {
  emitSafely(emit, "agent-open-file", { id });
  emitSafely(emit, "sketch-drawn", {
    fileId: id,
    name,
    added: outcome.added,
    changed: outcome.changed,
    removed: outcome.removed,
    steps: outcome.steps,
    doc: sketchToJson(doc),
  });
  emitSafely(emit, "room-files-changed", undefined);
}

function drawResultText(created: boolean, name: string, outcome: ScriptOutcome, doc: Sketch): string {
  const opened = created ? `Started "${name}" and ` : "";
  let message = `${opened}${scriptOutcomeSummary(outcome)} on "${name}". The page now holds ${doc.elements.length} thing(s).`;
  const notes = layoutReport(doc);
  if (notes.length > 0) {
    message += "\n\nWorth fixing:\n";
    for (const note of notes.slice(0, 8)) message += `- ${note}\n`;
    message += DRAW_FOLLOWUP;
  }
  return message;
}

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
  emitDrawingEvents(emit, id, real, outcome, doc);
  return ok(drawResultText(created, real, outcome, doc));
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
  emitDrawingEvents(emit, id, real, outcome, doc);
  return ok(drawResultText(created, real, outcome, doc));
}
