/**
 * The Create page's story surface: a room's cast, its shot lists, and the thin
 * command layer around them. Ported from `src-tauri/src/commands/story.rs`
 * (930 lines, read in full, including its `#[cfg(test)] mod tests` — all nine
 * are reproduced in `storyTools.test.ts`).
 *
 * NO EXEC_TOOL ARM: unlike `organizeTools.ts`/`fileTools.ts`, nothing here is
 * dispatched through the LLM tool router. `exec_tool`'s full match-arm list
 * (`agent.rs`) was read end to end for this batch and contains no `"story_*"`
 * arm; every `story_*` name is registered ONLY in `lib.rs`'s
 * `tauri::generate_handler!` list. The Story tab is a page a person clicks
 * around in, not a tool a model can call — so `execTool.ts` needed no change.
 *
 * WHAT THIS FILE IS: the thin `#[tauri::command]` layer this port's house style
 * already establishes — plain functions taking `db: Database.Database`
 * directly, throwing a plain `Error` where the Rust source returns
 * `Err(String)` (see `util.ts`'s own "DEVIATION — errors, not `Result`" note),
 * plus a {@link registerStoryIpc} at the bottom that is NOT wired into any
 * bootstrap file — the same posture as `recIpc.ts` and `libraryTools.ts`.
 * Channel names and argument shapes are the pre-migration frontend's real
 * contract (`src/api.ts:478-555`, `src/apiTypes.ts:915-1098`), not invented, so
 * a future preload/renderer batch needs no renaming on either side.
 *
 * OUT OF SCOPE, NOTED SO NOBODY GOES LOOKING FOR THEM HERE: `story_film_plan`
 * and `start_shot_list_job`, registered in `lib.rs` right next to this file's
 * commands, actually live in `src-tauri/src/commands/jobs/create.rs` — a
 * different Rust file. Neither is ported here.
 *
 * FOUR DEPENDENCIES, FOUR ANSWERS:
 *
 *   1. `commands::castparse` (399 lines) — PORTED IN FULL this batch as
 *      `castparse.ts`. Small, entirely self-contained pure text parsing with
 *      no dependency of its own, and porting it makes
 *      {@link storyReadCastFile}'s fallback path genuinely real rather than a
 *      second gap.
 *
 *   2. `commands::shotsplit` (689 lines: sentence/word-boundary packing with
 *      its own round-trip invariant — "put the parts back together and you
 *      have every word you started with") — NOW PORTED, as `shotsplitTools.ts`
 *      (a later batch in this same migration). {@link storyPlanSplit} is the
 *      real `story_plan_split` again: the script's own declared chunks win
 *      when it has any ({@link scriptChunks}), otherwise the room cuts it by
 *      length ({@link splitScript}/{@link partsFor}). `MAX_PARTS` is imported
 *      from `shotsplitTools.ts` rather than mirrored a second time, now that
 *      the real module exists — {@link storyApplySplit} still enforces it
 *      directly, same as before.
 *
 *   3. `commands::media_limits` (453 lines: the per-model legal-duration
 *      catalogue) — PORTED as `mediaLimits.ts` in a later batch, so
 *      {@link snapSeconds} now does the real lookup rather than the
 *      documented always-taken pass-through this file shipped with
 *      originally. A model the catalogue has never reported on (nothing
 *      fetched yet, or an unrecognized slug) still reads as "no duration
 *      data" — that is the real Rust branch too, not a gap — but a KNOWN
 *      model's illegal duration is now actually snapped to its nearest legal
 *      length, matching `snap_seconds` exactly. See {@link snapSeconds}.
 *
 *   4. `image` (the Rust crate behind `shrink`) — `sharp` stands in. It is
 *      already an `electron-app/package.json` dependency (`^0.34.2`), just not
 *      previously used anywhere under `src/main`; this batch is its
 *      deliberate first use, so `story_pictures` is real rather than stubbed.
 *      One consequence: {@link storyPictures} is `async` where the Rust command
 *      is sync — `sharp` has no synchronous pipeline API.
 *
 * SIDECAR CALL: {@link storyReadCastFile}'s model path reuses
 * `sidecarJsonCancellable.ts` — the closest ported POST helper — with a
 * `CancelFlag` that is never set, exactly the adaptation `webSearch.ts`'s
 * `searchPage` already makes for a Rust call site (`crate::sidecar::
 * sidecar_json`) that has no cancellation of its own. `KEEP_ALIVE_WARM` is a
 * plain local literal, matching `filePass.ts`/`recRead.ts`'s already-
 * established precedent for the same constant.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import sharp from "sharp";
import { CancelFlag } from "./cancel.js";
import { MAX_FOUND, parseCast, type ParsedMember } from "./castparse.js";
import { getFileBytes, getFileFull, getFileMeta, listFiles } from "./db-host/files.js";
import {
  addCastMember,
  addShot,
  createStoryList,
  deleteStoryList,
  listCast,
  listShots,
  listStoryLists,
  removeCastMember,
  removeShot,
  reorderShots,
  setCastFace,
  setStoryShape,
  updateCastMember,
  updateShot,
  updateStoryList,
  type CastMember,
  type StoryList,
  type StoryShot,
} from "./db-host/story.js";
import { queryRows } from "./db-host/util.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { allowsSeconds, limitsFor } from "./mediaLimits.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { MAX_PARTS, partsFor, scriptChunks, splitScript } from "./shotsplitTools.js";
import type { OpenRoom } from "./turnEngine.js";
import { readRoomFile } from "./workspace/roomContent.js";
// Every frontend-facing shape this file returns is NOT redeclared here. All six
// already exist, camelCased and field-for-field with the Rust structs, in
// `shared/apiTypes.ts` — and `shared/ipc-contract.ts` types each `story_*`
// channel against THOSE, so importing them is what makes the handlers below
// provably answer the contract the renderer already expects. Same choice
// `organize.ts`/`bulkReport.ts`/`webSearch.ts` made for their own result types.
import type {
  CastFromFile,
  PlannedShot,
  RoomDocument,
  RoomPicture,
  ShotPlan,
  StoryBoard,
} from "../shared/apiTypes.js";

// Re-exported so a caller of this module never needs a second import just for
// the shapes its own return types are built from.
export type {
  CastFromFile,
  CastMember,
  ParsedMember,
  PlannedShot,
  RoomDocument,
  RoomPicture,
  ShotPlan,
  StoryBoard,
  StoryList,
  StoryShot,
};

/** `commands::models::KEEP_ALIVE_WARM` — a plain literal, not a re-port of that
 * whole module; see the module doc. */
const KEEP_ALIVE_WARM = "30m";

// ------------------------------------------------------------- story board

/**
 * Ported from `board`/`story_board`. Answers a {@link StoryBoard} — everything
 * the Story tab draws itself from, in one round trip. One command rather than
 * three, because the tab is useless with a partial answer: a shot naming two
 * heroes cannot be drawn without the cast, and a cast with no list has nothing
 * to appear in.
 *
 * Falls back to the most recently touched list rather than showing an empty
 * tab: the common case is one story per room, and asking the user to pick it
 * every time is a step that never earns itself. An id that names no list falls
 * back exactly as `null` does.
 */
export function storyBoard(db: Database.Database, listId: string | null): StoryBoard {
  const lists = listStoryLists(db);
  const selected =
    listId !== null && lists.some((l) => l.id === listId) ? listId : (lists[0]?.id ?? null);
  const shots = selected !== null ? listShots(db, selected) : [];
  return { cast: listCast(db), lists, shots, selected };
}

// --------------------------------------------------------------- pictures

/** The longest edge of a preview. Big enough to recognize a face, small enough
 * that a hundred of them cost less than one real picture. */
const THUMB_EDGE = 192;

/** How many pictures the picker offers. A cap rather than the whole room: the
 * list is for choosing a face or a starting frame, and decoding a thousand
 * images to fill a scroll nobody reaches is a page that takes seconds to open.
 * Newest first (matching `listFiles`'s own ordering), because a picture just
 * generated is the one being reached for. */
const PICKER_LIMIT = 150;

/** Mirrors the Rust `thumb_cache()` `OnceLock<RwLock<HashMap>>`: a
 * process-lifetime cache keyed by file id, since a picture's bytes never change
 * (an edit writes a new file). A plain `Map` — Node has no threads to race this
 * over, so there is nothing for the `RwLock` to protect. */
const thumbCache = new Map<string, string>();

/** Test-only escape hatch — same convention as `engineRouting.ts`'s
 * `resetBaseUrlOverrideForTests`/`scriptRun.ts`'s `resetBinCachesForTests`. The
 * Rust source has no equivalent (its `OnceLock` lives for the process), so this
 * exists purely so a test can start from a known-empty cache. */
export function resetThumbCacheForTests(): void {
  thumbCache.clear();
}

/**
 * Decode, downscale, re-encode as JPEG. `null` for anything unreadable.
 *
 * `fit: "inside"` with `withoutEnlargement: FALSE` is the match for Rust's
 * `DynamicImage::thumbnail`: despite its name, `thumbnail` computes its target
 * from `resize_dimensions(..., fill = false)`, which is `min(w_ratio, h_ratio)`
 * with no clamp at 1.0 — so a picture SMALLER than the box is scaled UP to fill
 * it. `withoutEnlargement: true` would leave a 40×20 avatar at 40×20 where the
 * shipped app returns 192×96, a difference visible in the picker.
 *
 * `removeAlpha()`, not a flatten-onto-a-background composite: Rust's
 * `to_rgb8()` simply DISCARDS the alpha channel, keeping the original RGB
 * values as stored — it does not blend a transparent pixel against any
 * particular color. `sharp`'s default JPEG encode would flatten onto black;
 * `removeAlpha()` is the operation that matches `to_rgb8()`'s actual behavior.
 */
async function shrink(bytes: Buffer): Promise<string | null> {
  try {
    const jpeg = await sharp(bytes)
      .resize(THUMB_EDGE, THUMB_EDGE, { fit: "inside", withoutEnlargement: false })
      .removeAlpha()
      .jpeg()
      .toBuffer();
    return jpeg.toString("base64");
  } catch {
    return null;
  }
}

/**
 * Every picture in this room, as thumbnails to choose from. Ported from
 * `story_pictures`; see the module doc for why this is `async` where the Rust
 * command is not.
 *
 * Thumbnails rather than the real bytes, and this is the whole reason the
 * command exists: the picker shows every picture at once, and streaming a
 * hundred full-size images through to draw them a hundred pixels wide would
 * cost hundreds of megabytes to display a few kilobytes of information. Cached
 * by file id. A picture that will not decode is skipped, not fatal — one
 * corrupt file must not empty the whole picker.
 */
async function storyPicturesWithLoader(
  db: Database.Database,
  loadBytes: (fileId: string) => Promise<Buffer | null>,
): Promise<RoomPicture[]> {
  const pictures = listFiles(db)
    .filter((f) => f.mimeType.startsWith("image/"))
    .slice(0, PICKER_LIMIT);

  const out: RoomPicture[] = [];
  for (const meta of pictures) {
    const cached = thumbCache.get(meta.id);
    if (cached !== undefined) {
      out.push({ fileId: meta.id, name: meta.name, thumbB64: cached });
      continue;
    }
    // Rust: `match state.with_room(|room| db::get_file_bytes(...)) {
    // Ok(Some(bytes)) => bytes, _ => continue }` — a row deleted between
    // `list_files` and here, a NULL bytes column, and a read error all fold to
    // the same "skip this one picture".
    let bytes: Buffer | null;
    try {
      bytes = await loadBytes(meta.id);
    } catch {
      continue;
    }
    if (bytes === null) {
      continue;
    }
    const thumb = await shrink(bytes);
    if (thumb === null) {
      continue;
    }
    thumbCache.set(meta.id, thumb);
    out.push({ fileId: meta.id, name: meta.name, thumbB64: thumb });
  }
  return out;
}

export async function storyPictures(db: Database.Database): Promise<RoomPicture[]> {
  return storyPicturesWithLoader(db, async (fileId) => getFileBytes(db, fileId));
}

export async function storyPicturesInRoom(room: OpenRoom): Promise<RoomPicture[]> {
  if (room.workspace === undefined) return storyPictures(room.db);
  return storyPicturesWithLoader(
    room.db,
    async (fileId) => (await readRoomFile(room, fileId)).bytes,
  );
}

// ------------------------------------------------------------------- cast

/** Ported from `story_add_cast`. */
export function storyAddCast(
  db: Database.Database,
  name: string,
  description: string,
  story: string
): CastMember {
  if (name.trim() === "") {
    throw new Error("Give them a name first.");
  }
  return addCastMember(db, name, description, story);
}

/** Ported from `story_update_cast`. */
export function storyUpdateCast(
  db: Database.Database,
  id: string,
  name: string,
  description: string,
  story: string
): void {
  if (name.trim() === "") {
    throw new Error("Give them a name first.");
  }
  updateCastMember(db, id, name, description, story);
}

/**
 * Pin a room picture as someone's face — or clear it with `null`. Ported from
 * `story_set_face`.
 *
 * The file is checked to be a picture here rather than at generation time. A
 * PDF pinned as a face fails only when the user presses Make it, minutes and
 * one paid call later, with an error from a provider that has no idea who this
 * person is.
 */
export function storySetFace(db: Database.Database, id: string, fileId: string | null): void {
  if (fileId !== null) {
    const meta = getFileMeta(db, fileId);
    if (!meta.mimeType.startsWith("image/")) {
      // Curly quotes, as in the Rust source's own format string.
      throw new Error(`“${meta.name}” is not a picture, so it cannot be a face.`);
    }
  }
  setCastFace(db, id, fileId);
}

/** Ported from `story_remove_cast`. */
export function storyRemoveCast(db: Database.Database, id: string): void {
  removeCastMember(db, id);
}

// ------------------------------------------------------------- shot lists

/** Ported from `story_create_list`. */
export function storyCreateList(db: Database.Database, title: string, logline: string): string {
  return createStoryList(db, title, logline);
}

/** Ported from `story_update_list`. */
export function storyUpdateList(
  db: Database.Database,
  id: string,
  title: string,
  logline: string
): void {
  updateStoryList(db, id, title, logline);
}

/**
 * The frame shape and output size for a whole list. Ported from
 * `story_set_shape`.
 *
 * Nothing is validated against a model here on purpose. Which sizes are legal
 * depends on the model each shot happens to be pointing at, and those change
 * after this is set — so the check belongs at the one place that knows the
 * model for certain (`check_media_shape`, out of this batch's scope), which
 * drops a size the model does not publish rather than refusing the generation
 * over it.
 */
export function storySetShape(
  db: Database.Database,
  id: string,
  aspectRatio: string,
  stillResolution: string,
  clipResolution: string
): void {
  setStoryShape(db, id, aspectRatio, stillResolution, clipResolution);
}

/** Ported from `story_delete_list`. */
export function storyDeleteList(db: Database.Database, id: string): void {
  deleteStoryList(db, id);
}

// ------------------------------------------------------------------ shots

/** How many characters may ride along in one generation. Ported verbatim from
 * `commands::story::MAX_SHOT_CAST`.
 *
 * A ceiling of our own, under every published one (the most generous image
 * model in the live catalogue takes 16; several take 4). References are billed
 * on some models and diluting a prompt with a dozen faces makes a worse
 * picture, not a fuller one. */
export const MAX_SHOT_CAST = 4;

/** Ported from `story_add_shot`. */
export function storyAddShot(db: Database.Database, listId: string, action: string): StoryShot {
  return addShot(db, listId, action);
}

/**
 * The cast a shot may be saved with — or the sentence to show instead. Ported
 * from `fit_shot_cast`.
 *
 * This used to `take(MAX_SHOT_CAST)` silently. The row does not know it was
 * cut: the fifth chip stays pressed, the review sheet lists four, and that
 * person's portrait and name are never sent — the shot on screen and the shot
 * in the room are two different shots. A refusal the caller can show is the
 * only version of this the user can act on.
 */
export function fitShotCast(castIds: readonly string[]): string[] {
  if (castIds.length > MAX_SHOT_CAST) {
    throw new Error(
      `A shot carries ${MAX_SHOT_CAST} people at most — take someone out of this one first.`
    );
  }
  return [...castIds];
}

/** Ported from `story_update_shot`. */
export function storyUpdateShot(
  db: Database.Database,
  id: string,
  action: string,
  castIds: readonly string[],
  seconds: number | null,
  imageModel: string,
  videoModel: string
): void {
  const fitted = fitShotCast(castIds);
  updateShot(db, id, action, fitted, seconds, imageModel, videoModel);
}

/** Ported from `story_remove_shot`. */
export function storyRemoveShot(db: Database.Database, id: string): void {
  removeShot(db, id);
}

/** Ported from `story_reorder_shots`. */
export function storyReorderShots(
  db: Database.Database,
  listId: string,
  ids: readonly string[]
): void {
  reorderShots(db, listId, ids);
}

// -------------------------------------------------------------- documents

/** How many documents the picker offers. Newest first, because a script just
 * imported is the one being reached for. */
const DOC_LIMIT = 200;

/** `str::split_whitespace()` — splits on Unicode whitespace, yields no empty
 * tokens. `\p{White_Space}`, not `\s`: the same divergence `files.ts`'s own
 * private copy of this helper documents. A local copy rather than an import —
 * that copy is not exported, matching this port's established convention of
 * duplicating a small pure predicate (`organizeTools.ts`'s `extensionOf`,
 * `sidecarJsonCancellable.ts`'s `isConnectionRefused`). */
function splitWhitespace(s: string): string[] {
  return s.split(/\p{White_Space}+/u).filter((t) => t !== "");
}

/**
 * Every room file with text in it — the ones a script or a cast can come from.
 * Ported from `story_documents`.
 *
 * This is the whole answer to "why am I retyping something I already have".
 * Files with no extracted text are left out rather than listed and then found
 * to be empty: a picture or a zip has nothing to offer here, and offering it
 * costs a click and a puzzled moment.
 *
 * A raw query rather than a `db-host/files.ts` export, matching the Rust
 * source's OWN structure: this SQL lives directly in `commands/story.rs`, not
 * in `db/story.rs` or `db/files.rs`.
 */
export function storyDocuments(db: Database.Database): RoomDocument[] {
  return queryRows(
    db,
    `SELECT id, name, substr(extracted_text, 1, 240),
            length(extracted_text)
       FROM files
      WHERE trashed_at IS NULL
        AND extracted_text IS NOT NULL
        AND trim(extracted_text) <> ''
      ORDER BY created_at DESC
      LIMIT ?`,
    [DOC_LIMIT],
    (r): RoomDocument => {
      const chars = r[3] as number;
      return {
        fileId: r[0] as string,
        name: r[1] as string,
        // A word estimate off the character count. Counting for real would mean
        // loading every document to draw a list.
        words: Math.floor(Math.max(0, chars) / 6),
        snippet: splitWhitespace(r[2] as string).join(" "),
      };
    }
  );
}

/**
 * The whole text of one room file, for the script box. Ported from
 * `story_text_from_file`.
 *
 * Whole, not clamped. A clamp here would be the `#minutes` bug again — that one
 * capped every file at 6 KB and turned an hour of transcript into its first
 * five minutes, silently. A five-minute script is about 4 KB, and the user
 * pasting it by hand would have pasted all of it.
 */
export function storyTextFromFile(db: Database.Database, fileId: string): string {
  const [name, , , rawText] = getFileFull(db, fileId);
  const text = rawText ?? "";
  if (text.trim() === "") {
    throw new Error(
      `“${name}” has no readable text in this room. If it is a PDF or a ` +
        "scan, open it once so the room can read it."
    );
  }
  return text;
}

// ------------------------------------------------------------ cast from a file

/** What the fallback reader is called on screen. Ported verbatim from
 * `commands::story::PATTERN_READER`. */
const PATTERN_READER = "pattern matching";

/** `str::trim_end_matches('.')` — strip ALL trailing periods, repeatedly, not
 * just one. */
function trimEndDots(s: string): string {
  let out = s;
  while (out.endsWith(".")) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * `serde_json::from_value::<Vec<ParsedMember>>(reply["cast"].clone())
 * .unwrap_or_default()` — ALL of the array or NONE of it.
 *
 * A `ParsedMember` has three required string fields with no
 * `#[serde(default)]`, so ANY element missing one fails the WHOLE deserialize
 * in Rust and `unwrap_or_default()` folds it to an empty vec. `reply["cast"]`
 * on a reply that is not an object, or has no `cast` key, indexes to
 * `Value::Null`, which fails the same way — so `undefined` here reads as `[]`
 * too. Same all-or-nothing rule `organizeTools.ts`'s `parseOrganizeEntries`
 * documents for the identical reason.
 */
function parseParsedMembers(value: unknown): ParsedMember[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ParsedMember[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const r = item as Record<string, unknown>;
    if (
      typeof r.name !== "string" ||
      typeof r.description !== "string" ||
      typeof r.story !== "string"
    ) {
      return [];
    }
    out.push({ name: r.name, description: r.description, story: r.story });
  }
  return out;
}

/**
 * Read a character sheet the room already holds. Ported from
 * `story_read_cast_file`.
 *
 * **The room's own model reads it**, when one is set and answers. The first
 * version of this matched headings and labels in code, and the reasoning was
 * sound — a pattern reader is free, instant, offline, and structurally
 * incapable of inventing a hero. It also broke on the first real document it
 * met. The invention risk that argued for patterns is answered a better way:
 * this writes NOTHING. Every person comes back to be looked at and edited.
 *
 * {@link parseCast}'s pattern reader stays the fallback for a room with no
 * model, or a model that is down, and the answer says which one read the file.
 */
export async function storyReadCastFile(
  db: Database.Database,
  fileId: string
): Promise<CastFromFile> {
  // Read out of the room BEFORE the model call: the Rust source drops the room
  // lock here so a generation does not block every other reader for its
  // duration; here it just keeps the read and the network call as separate,
  // sequential steps.
  const [name, , , rawText] = getFileFull(db, fileId);
  const text = rawText ?? "";
  if (text.trim() === "") {
    throw new Error(`“${name}” has no readable text in this room.`);
  }
  const model = modelSetting(db) ?? "";

  if (model.trim() === "") {
    return {
      found: parseCast(text),
      name,
      readBy: PATTERN_READER,
      fellBack:
        "This room has no AI model set, so the file was read by pattern " +
        "matching — headings, bold names and `Name:` lines. Set a model " +
        "in Settings for a messy sheet.",
    };
  }

  const request = {
    // `sidecar_json` attaches the room's privacy policy AND mints the provider
    // key off the back of this field — a body without it would be an outbound
    // seam the door never sees.
    model,
    base_url: resolvedBaseUrl(),
    mode: "cast",
    document: text,
    temperature: 0.0,
    keep_alive: KEEP_ALIVE_WARM,
  };
  const outcome = await sidecarJsonCancellable("/knowledge_extract", request, new CancelFlag());
  if (outcome.kind === "value") {
    const reply = outcome.value as Record<string, unknown> | null | undefined;
    return { found: parseParsedMembers(reply?.cast), name, readBy: model, fellBack: null };
  }
  if (outcome.kind === "stopped") {
    // A user-initiated Stop is NOT the model failing to read the file, and must
    // not be dressed up as one — a cancelled read that came back labelled "the
    // model could not read it" would have the user judging a model that was
    // never asked. Unreachable in practice (the flag above is never set), but
    // the union has to stay total and this is the honest arm for it.
    throw new Error(`Stopped before “${name}” could be read.`);
  }
  // The model was asked and could not answer. Falling back silently would
  // present pattern-matched rows as the model's reading, and the user would
  // judge the model by them.
  return {
    found: parseCast(text),
    name,
    readBy: PATTERN_READER,
    fellBack:
      `${model} could not read it (${trimEndDots(outcome.error.error)}), so this is pattern ` +
      "matching instead — headings, bold names and `Name:` lines. Check it closely.",
  };
}

/**
 * Keep the people that survived the preview. Ported from
 * `story_add_cast_many`.
 *
 * A face is not set here — a hero's picture is a separate, deliberate choice
 * from the room's own pictures, and guessing one from a filename would put the
 * wrong person's portrait into every shot they appear in.
 */
export function storyAddCastMany(
  db: Database.Database,
  members: readonly ParsedMember[]
): number {
  const filtered = members.filter((m) => m.name.trim() !== "").slice(0, MAX_FOUND);
  if (filtered.length === 0) {
    throw new Error("Nobody to add.");
  }
  let added = 0;
  for (const member of filtered) {
    addCastMember(db, member.name, member.description, member.story);
    added += 1;
  }
  return added;
}

// ----------------------------------------------------------- shot prompt

/**
 * The words one shot is drawn from. Ported verbatim from `shot_prompt`.
 *
 * Not called by anything else in this file, same as the Rust source: it is
 * `pub(crate)`, used from `commands/jobs/create.rs` — a different Rust file,
 * out of scope for this batch. Ported here anyway, with its own tests, because
 * it is part of the 930 lines this batch covers, and a future caller can import
 * it exactly where `jobs/create.rs`'s own port will need it.
 *
 * The cast is named and described here even though their portraits are also
 * attached, and that is deliberate: the picture holds the FACE together, the
 * text says what they are DOING. A reference with no words gets a portrait back
 * rather than a scene.
 */
export function shotPrompt(
  action: string,
  cast: readonly CastMember[],
  logline: string
): string {
  const parts: string[] = [];
  if (logline.trim() !== "") {
    parts.push(logline.trim());
  }
  for (const member of cast) {
    const described = member.description.trim();
    if (described === "") {
      parts.push(member.name.trim());
    } else {
      parts.push(`${member.name.trim()} — ${described}`);
    }
  }
  const trimmedAction = action.trim();
  if (trimmedAction !== "") {
    parts.push(trimmedAction);
  }
  return parts.filter((p) => p !== "").join(". ");
}

// ------------------------------------------------------ splitting a script

/**
 * Cut a script into shots of a fixed length — the whole point of the
 * feature. Ported from `story_plan_split`.
 *
 * No model is asked. See `shotsplitTools.ts`: it is free, it is instant,
 * nothing leaves the Mac, and — the part that matters — no word can go
 * missing, which is not a promise a model can make about a five-minute
 * script.
 *
 * THE SCRIPT'S OWN CHUNKS WIN. A script written as `**00:00–00:15** — …` has
 * already been broken into shots by its author, with the lengths they chose.
 * Re-cutting that by character count puts boundaries in the middle of their
 * beats and silently reflows their pacing — so the room only decides where
 * the cuts go when nobody has decided already ({@link scriptChunks}).
 */
export function storyPlanSplit(script: string, minutes: number, secondsEach: number): ShotPlan {
  const chunks = scriptChunks(script);
  if (chunks !== undefined) {
    const shots: PlannedShot[] = chunks
      .slice(0, MAX_PARTS)
      .map((c) => ({ action: c.action, seconds: c.seconds }));
    return {
      parts: shots.length,
      totalSeconds: shots.reduce((sum, s) => sum + s.seconds, 0),
      shots,
      fromScript: true,
    };
  }

  const clampedSecondsEach = clamp(secondsEach, 1, 60);
  // The runtime the user asked for, not one derived from the script's
  // length: how long the words take to say is a judgement only they can
  // make, and guessing it would silently change the shape of their episode.
  //
  // A runtime of ZERO is not a request for one shot — it is an empty or
  // half-typed field, and answering it with a single 15-second shot for a
  // five-minute script is the failure this `max` exists to prevent.
  const asked = Math.round(Math.max(minutes, 0) * 60);
  const total = asked === 0 ? clampedSecondsEach : Math.max(asked, clampedSecondsEach);
  const parts = partsFor(total, clampedSecondsEach);
  const shots: PlannedShot[] = splitScript(script, parts).map((action) => ({
    action,
    seconds: clampedSecondsEach,
  }));
  return {
    parts: shots.length,
    totalSeconds: shots.reduce((sum, s) => sum + s.seconds, 0),
    shots,
    fromScript: false,
  };
}

/**
 * The nearest length this model will actually film. Ported from
 * `snap_seconds`.
 *
 * A script's own timings are the author's, not the provider's: a 10-second
 * beat is perfectly reasonable and Veo will only make 4, 6 or 8. Snapping to
 * the nearest legal value keeps the pacing as close as the model allows,
 * where sending 10 would simply be refused after the wait.
 *
 * Reads `mediaLimits.ts`'s `limitsFor`, exactly as the Rust source reads
 * `commands::media_limits::limits_for`. A model the catalogue has no entry
 * for — nothing fetched yet this process, or a slug it never named — passes
 * `seconds` straight through unchanged, matching Rust's own behavior for the
 * same case: the catalogue is populated by `ensureMediaLimits`, called from
 * the Create page (not yet ported), so a room that has never opened it still
 * gets an honest pass-through rather than a guessed correction.
 */
export function snapSeconds(seconds: number, videoModel: string): number {
  // `model.split("::").nth(1).unwrap_or(model)` — the bare slug out of a
  // composite "<engine>::<slug>" selection, or the whole string when there is
  // no "::" at all.
  const parts = videoModel.split("::");
  const slug = parts.length > 1 ? parts[1]! : videoModel;
  const limits = limitsFor(slug);
  if (limits === undefined) return seconds;
  if (limits.durations.length === 0 || allowsSeconds(limits, seconds)) return seconds;
  // `durations.iter().copied().min_by_key(|d| d.abs_diff(seconds))`: the
  // first duration with the smallest distance to the asked-for length wins a
  // tie, matching `Iterator::min_by_key`'s documented "first element on a
  // tie" — a strict `<` below (never `<=`) is what keeps that.
  let best = limits.durations[0]!;
  let bestDiff = Math.abs(best - seconds);
  for (const d of limits.durations.slice(1)) {
    const diff = Math.abs(d - seconds);
    if (diff < bestDiff) {
      best = d;
      bestDiff = diff;
    }
  }
  return best;
}

/** `u32::clamp` for the one call site below. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** A precompiled `char::is_alphanumeric` — hoisted out of {@link namesAppear}
 * so the inner loop does not build a fresh `RegExp` per byte tested. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Is `needle` in `haystack` as a whole word? Ported from `names_appear`.
 *
 * Without the boundary test, a cast member called "Noa" is found inside "Noah",
 * inside "no answer" and inside "announce" — and every shot in the episode gets
 * her face whether she is in it or not.
 *
 * BYTE-LEVEL, matching the Rust source's own behavior exactly, quirks included:
 * Rust's boundary test casts a raw UTF-8 byte to `char` (`bytes[i] as char`),
 * which for a multi-byte sequence (Hebrew, an accented letter, an em dash) is
 * NOT the real character at that position but a synthetic Latin-1 code point
 * built from one byte of the encoding. For pure-ASCII names and action text —
 * the overwhelming real case, and every case the Rust tests cover — this is
 * exactly "is this a letter or digit". Reproducing it rather than substituting
 * a "more correct" Unicode-aware check is deliberate: the fixed version
 * DISAGREES with the shipped app on real input (Rust refuses to match "mira" in
 * "mira—she turns", because the em dash's first byte 0xE2 reads as `â`), and a
 * port that quietly changes who ends up in a shot is a port that cannot be
 * diffed against the original.
 *
 * Working in `Buffer`s throughout, not just at the boundary check, is what
 * makes this safe: UTF-8 has no false-positive substring matches across
 * character boundaries, so a byte search finds exactly the positions a
 * character search would.
 */
function namesAppear(haystack: string, needle: string): boolean {
  if (needle === "") {
    return false;
  }
  const hayBytes = Buffer.from(haystack, "utf8");
  const needleBytes = Buffer.from(needle, "utf8");
  let from = 0;
  for (;;) {
    const start = hayBytes.indexOf(needleBytes, from);
    if (start === -1) {
      break;
    }
    const end = start + needleBytes.length;
    const beforeOk = start === 0 || !isAlnumByte(hayBytes[start - 1]!);
    const afterOk = end >= hayBytes.length || !isAlnumByte(hayBytes[end]!);
    if (beforeOk && afterOk) {
      return true;
    }
    from = start + Math.max(needleBytes.length, 1);
    if (from >= hayBytes.length) {
      break;
    }
  }
  return false;
}

/** `(byte as char).is_alphanumeric()` — see {@link namesAppear} for why this
 * takes the raw byte value (0–255) rather than a decoded Unicode scalar. */
function isAlnumByte(byte: number): boolean {
  return ALPHANUMERIC.test(String.fromCodePoint(byte));
}

/**
 * Work out who is in each shot, from the shot's own words. Ported from
 * `assign_cast`.
 *
 * Two rules, and the second is the one that matters on a real script:
 *
 * 1. **A name in the text puts that person in the shot.** Matched on the full
 *    name and on the first name alone, because a cast sheet says "Mira
 *    Halloran" and the script says "Mira". Whole words only — otherwise "Noa"
 *    is found inside "Noah" and inside "no answer".
 * 2. **A shot that names nobody inherits the shot before it.** Screenplays name
 *    a character once and then write "she" for the next four beats, so literal
 *    matching alone would attach a face to a fifth of the shots and leave the
 *    rest to be re-imagined from scratch.
 *
 * Nothing is guessed beyond that. A shot before ANY name has appeared gets
 * nobody rather than the whole cast, because the opening of an episode is
 * usually a place, and pinning four faces to an establishing shot is worse than
 * pinning none.
 */
export function assignCast(
  shots: readonly PlannedShot[],
  cast: readonly CastMember[]
): string[][] {
  const out: string[][] = [];
  let carried: string[] = [];
  for (const shot of shots) {
    const haystack = shot.action.toLowerCase();
    const here: string[] = [];
    for (const member of cast) {
      if (here.length >= MAX_SHOT_CAST) {
        break;
      }
      const full = member.name.trim().toLowerCase();
      if (full === "") {
        continue;
      }
      const first = splitWhitespace(full)[0] ?? full;
      if (namesAppear(haystack, full) || namesAppear(haystack, first)) {
        here.push(member.id);
      }
    }
    if (here.length === 0) {
      out.push([...carried]);
    } else {
      carried = [...here];
      out.push(here);
    }
  }
  return out;
}

/**
 * Write a planned split into a list as real shots. Ported from
 * `story_apply_split`.
 *
 * APPENDS rather than replaces. A split is a big edit, and silently deleting
 * shots the user has already drawn pictures for — which are paid work — is not
 * something a button labelled "break into shots" is allowed to do.
 *
 * WHO IS IN EACH SHOT: this used to write `&[]` — nobody — for every shot a
 * split produced, and that one empty slice is the whole reason a five-minute
 * episode came back with a different lead in every scene. With no cast on a
 * shot, no portrait is attached, so the model gets words alone and re-imagines
 * the person on every call. See {@link assignCast}.
 *
 * Callable independently of {@link storyPlanSplit} (which is `NOT_IMPLEMENTED`
 * this batch): any caller that already has a `PlannedShot[]` — a hand-built
 * plan, or a future real `storyPlanSplit`'s output — can apply it through here.
 * Each shot's length is snapped to a legal one via {@link snapSeconds}, which
 * reads whatever `mediaLimits.ts` has cached for `videoModel` — read its doc
 * for what "no duration data" still means for a model never fetched.
 */
export function storyApplySplit(
  db: Database.Database,
  listId: string,
  shots: readonly PlannedShot[],
  imageModel: string,
  videoModel: string
): number {
  if (shots.length > MAX_PARTS) {
    throw new Error(
      `That is ${shots.length} shots. This room writes at most ${MAX_PARTS} in one go — each one ` +
        "is a paid generation."
    );
  }
  const cast = listCast(db);
  const assigned = assignCast(shots, cast);
  let written = 0;
  shots.forEach((planned, index) => {
    const seconds = snapSeconds(clamp(planned.seconds, 1, 60), videoModel);
    const shot = addShot(db, listId, planned.action);
    updateShot(
      db,
      shot.id,
      planned.action,
      assigned[index] ?? [],
      seconds,
      imageModel.trim(),
      videoModel.trim()
    );
    written += 1;
  });
  return written;
}

// -------------------------------------------------------------- IPC (unwired)

/** The slice of room state every story IPC handler needs: whichever room is
 * open RIGHT NOW, not whatever was open when {@link registerStoryIpc} ran.
 * Re-declared locally rather than imported (`recIpc.ts` does not export its
 * own), so this module's only dependency on `turnEngine.ts` is the `OpenRoom`
 * shape both already agree on. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

/** `AppState::with_room`'s own refusal, so an IPC call made between rooms says
 * what the shipped app says — the same string `recIpc.ts` uses. */
const NO_ROOM_OPEN = "No room is open.";

function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

function openRoom(room: RoomSource): OpenRoom {
  const open = room.currentRoom();
  if (open === null) throw new Error(NO_ROOM_OPEN);
  return open;
}

/**
 * Register every Story-tab channel on `ipcMain`. NOT wired into any bootstrap
 * file (rule 4) — it exists, ready to be wired, once a preload/renderer batch
 * needs it.
 *
 * `story_pictures`/`story_read_cast_file` are async; every other handler is a
 * thin synchronous forward to the exported functions above.
 */
export function registerStoryIpc(ipcMain: Pick<IpcMain, "handle">, room: RoomSource): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("story_board", (args: { listId?: string | null }) =>
    storyBoard(openDb(room), args.listId ?? null)
  );
  handle("story_pictures", () => storyPicturesInRoom(openRoom(room)));

  handle("story_add_cast", (args: { name: string; description: string; story: string }) =>
    storyAddCast(openDb(room), args.name, args.description, args.story)
  );
  handle(
    "story_update_cast",
    (args: { id: string; name: string; description: string; story: string }) =>
      storyUpdateCast(openDb(room), args.id, args.name, args.description, args.story)
  );
  handle("story_set_face", (args: { id: string; fileId: string | null }) =>
    storySetFace(openDb(room), args.id, args.fileId)
  );
  handle("story_remove_cast", (args: { id: string }) => storyRemoveCast(openDb(room), args.id));

  handle("story_create_list", (args: { title: string; logline: string }) =>
    storyCreateList(openDb(room), args.title, args.logline)
  );
  handle("story_update_list", (args: { id: string; title: string; logline: string }) =>
    storyUpdateList(openDb(room), args.id, args.title, args.logline)
  );
  handle(
    "story_set_shape",
    (args: {
      id: string;
      aspectRatio: string;
      stillResolution: string;
      clipResolution: string;
    }) =>
      storySetShape(
        openDb(room),
        args.id,
        args.aspectRatio,
        args.stillResolution,
        args.clipResolution
      )
  );
  handle("story_delete_list", (args: { id: string }) => storyDeleteList(openDb(room), args.id));

  handle("story_add_shot", (args: { listId: string; action: string }) =>
    storyAddShot(openDb(room), args.listId, args.action)
  );
  handle(
    "story_update_shot",
    (args: {
      id: string;
      action: string;
      castIds: string[];
      seconds: number | null;
      imageModel: string;
      videoModel: string;
    }) =>
      storyUpdateShot(
        openDb(room),
        args.id,
        args.action,
        args.castIds,
        args.seconds,
        args.imageModel,
        args.videoModel
      )
  );
  handle("story_remove_shot", (args: { id: string }) => storyRemoveShot(openDb(room), args.id));
  handle("story_reorder_shots", (args: { listId: string; ids: string[] }) =>
    storyReorderShots(openDb(room), args.listId, args.ids)
  );

  handle("story_documents", () => storyDocuments(openDb(room)));
  handle("story_text_from_file", (args: { fileId: string }) =>
    storyTextFromFile(openDb(room), args.fileId)
  );
  handle("story_read_cast_file", (args: { fileId: string }) =>
    storyReadCastFile(openDb(room), args.fileId)
  );
  handle("story_add_cast_many", (args: { members: ParsedMember[] }) =>
    storyAddCastMany(openDb(room), args.members)
  );

  handle("story_plan_split", (args: { script: string; minutes: number; secondsEach: number }) =>
    storyPlanSplit(args.script, args.minutes, args.secondsEach)
  );
  handle(
    "story_apply_split",
    (args: { listId: string; shots: PlannedShot[]; imageModel: string; videoModel: string }) =>
      storyApplySplit(openDb(room), args.listId, args.shots, args.imageModel, args.videoModel)
  );
}
