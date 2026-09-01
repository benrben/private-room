/** Drawing file persistence, naming, and target resolution. */

import type Database from "better-sqlite3-multiple-ciphers";
import path from "node:path";
import {
  availableName,
  type FileMeta,
  getFileBytes,
  inTransaction,
  insertFile,
  listFiles,
  markSectionOnly,
  renameFile,
  updateFileContent,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { extensionOf } from "./editMatchExtraction.js";
import {
  defaultSketch,
  type Sketch,
  rustTrim,
  sketchExtractedText,
  sketchFromJson,
  sketchToJson,
} from "./sketchDoc.js";
import { createRoomFile, readRoomFile } from "./workspace/roomContent.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
export function trimEndMatches(s: string, suffix: string): string {
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

export function load(db: Database.Database, id: string): Sketch {
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
export function save(db: Database.Database, id: string, doc: Sketch, cause: string): void {
  storeFileBytes(db, id, Buffer.from(sketchToJson(doc), "utf8"), sketchExtractedText(doc), cause);
}

export function insertSketch(db: Database.Database, name: string, doc: Sketch, source: string): FileMeta {
  const unique = availableName(db, sketchName(name));
  const json = sketchToJson(doc);
  return insertFile(db, unique, SKETCH_MIME, Buffer.from(json, "utf8"), sketchExtractedText(doc), source);
}

export interface SketchRoom {
  db: Database.Database;
  path: string;
  workspace?: WorkspaceService;
}

interface WorkspaceSketchRoom extends SketchRoom {
  workspace: WorkspaceService;
}

export async function loadInRoom(room: SketchRoom, id: string): Promise<Sketch> {
  const bytes = (await readRoomFile(room, id)).bytes;
  return sketchFromJson(bytes === null ? "" : bytes.toString("utf8"));
}

export async function insertSketchInRoom(
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

type ActiveSketchRow = { relative_path: string | null; content_sha256: string | null };

function activeSketchPath(row: ActiveSketchRow | undefined): {
  relativePath: string;
  contentHash: string | undefined;
} {
  if (row === undefined || row.relative_path == null) {
    throw new Error("That drawing is no longer in this room.");
  }
  return { relativePath: row.relative_path, contentHash: row.content_sha256 ?? undefined };
}

function renamedSketchPath(relativePath: string, name: string): string {
  const parent = path.posix.dirname(relativePath);
  return parent === "." ? name : path.posix.join(parent, name);
}

async function renameSketchInRoom(room: WorkspaceSketchRoom, id: string, name: string): Promise<void> {
  const row = room.db.prepare(
    "SELECT relative_path, content_sha256 FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(id) as ActiveSketchRow | undefined;
  const { relativePath, contentHash } = activeSketchPath(row);
  await room.workspace.move(
    id,
    renamedSketchPath(relativePath, name),
    contentHash,
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

function resolvedSketch([id, name]: readonly [string, string]): ResolveResult {
  return { ok: true, id, name };
}

function resolveUnnamedSketch(all: ReadonlyArray<readonly [string, string]>): ResolveResult {
  if (all.length === 1) return resolvedSketch(all[0] as [string, string]);
  return { ok: false, kind: "ambiguous", message: `Which drawing? This room has ${all.length}: ${nameList(all)}.` };
}

function resolveSketchName(all: ReadonlyArray<readonly [string, string]>, want: string): ResolveResult {
  // Full Unicode lowercasing here, matching the Rust source's own
  // `to_lowercase()` — unlike the script parser, which is ASCII-only.
  const lower = want.toLowerCase();
  const stem = rustTrim(trimEndMatches(lower, `.${SKETCH_EXT}`));
  const exact = all.find(([, n]) => n.toLowerCase() === lower);
  if (exact !== undefined) return resolvedSketch(exact);
  const stemHit = all.find(([, n]) => trimEndMatches(n.toLowerCase(), `.${SKETCH_EXT}`) === stem);
  if (stemHit !== undefined) return resolvedSketch(stemHit);
  const hits = all.filter(([, n]) => n.toLowerCase().includes(stem));
  if (hits.length === 1) return resolvedSketch(hits[0] as [string, string]);
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
    return resolveUnnamedSketch(all);
  }
  return resolveSketchName(all, want);
}

/** The same lookup, throwing on any failure — the shape every caller but
 * `draw` wants. Ported from `resolve`. */
export function resolve(db: Database.Database, name: string): [string, string] {
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
export function drawTarget(db: Database.Database, name: string): [string, string, boolean] {
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

async function takeEmptySketchInRoom(room: WorkspaceSketchRoom, name: string): Promise<[string, string] | null> {
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

async function drawTargetInWorkspace(
  room: WorkspaceSketchRoom,
  name: string,
): Promise<[string, string, boolean]> {
  const resolved = resolveNamed(room.db, name);
  if (resolved.ok) return [resolved.id, resolved.name, false];
  if (resolved.kind !== "not_found") throw new Error(resolved.message);
  const taken = await takeEmptySketchInRoom(room, name);
  if (taken !== null) return [taken[0], taken[1], false];
  const meta = await insertSketchInRoom(room, name, defaultSketch(), "generated");
  markSectionOnly(room.db, meta.id, "sketch");
  return [meta.id, meta.name, true];
}

export async function drawTargetInRoom(room: SketchRoom, name: string): Promise<[string, string, boolean]> {
  if (room.workspace === undefined) return drawTarget(room.db, name);
  return drawTargetInWorkspace({ ...room, workspace: room.workspace }, name);
}
