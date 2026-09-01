import type Database from "better-sqlite3-multiple-ciphers";
import sharp from "sharp";
import { CancelFlag } from "./cancel.js";
import { MAX_FOUND, parseCast, type ParsedMember } from "./castparse.js";
import { getFileBytes, getFileFull, getFileMeta, listFiles } from "./db-host/files.js";
import { addCastMember, addShot, createStoryList, deleteStoryList, listCast, listShots, listStoryLists, removeCastMember, removeShot, reorderShots, setCastFace, setStoryShape, updateCastMember, updateShot, updateStoryList, type CastMember, type StoryShot } from "./db-host/story.js";
import { queryRows } from "./db-host/util.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { sidecarJsonCancellable, type SidecarPostOutcome } from "./sidecarJsonCancellable.js";
import type { OpenRoom } from "./turnEngine.js";
import { readRoomFile } from "./workspace/roomContent.js";
import type { CastFromFile, RoomDocument, RoomPicture, StoryBoard } from "../shared/apiTypes.js";

export

/** `commands::models::KEEP_ALIVE_WARM` — a plain literal, not a re-port of that
 * whole module; see the module doc. */
const KEEP_ALIVE_WARM = "30m";
import { storyPictures, storyPicturesWithLoader } from "./storyPictureTools.js";
export { storyBoard, THUMB_EDGE, PICKER_LIMIT, thumbCache, resetThumbCacheForTests, shrink, storyPicturesWithLoader, storyPictures } from "./storyPictureTools.js";



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
export

// -------------------------------------------------------------- documents

/** How many documents the picker offers. Newest first, because a script just
 * imported is the one being reached for. */
const DOC_LIMIT = 200;
export

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
export

// ------------------------------------------------------------ cast from a file

/** What the fallback reader is called on screen. Ported verbatim from
 * `commands::story::PATTERN_READER`. */
const PATTERN_READER = "pattern matching";
export

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
export function parseParsedMembers(value: unknown): ParsedMember[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ParsedMember[] = [];
  for (const item of value) {
    const member = parsedMember(item);
    if (member === null) {
      return [];
    }
    out.push(member);
  }
  return out;
}
export function parsedMember(value: unknown): ParsedMember | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  const fields = parsedMemberFields(value);
  if (fields === null) {
    return null;
  }
  const [name, description, story] = fields;
  return { name, description, story };
}
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parsedMemberFields(value: Record<string, unknown>): [string, string, string] | null {
  const { name, description, story } = value;
  if (typeof name !== "string") return null;
  if (typeof description !== "string") return null;
  if (typeof story !== "string") return null;
  return [name, description, story];
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
  const { name, text } = readableCastFile(db, fileId);
  const model = modelSetting(db) ?? "";

  if (model.trim() === "") {
    return castReadWithoutModel(name, text);
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
  return castReadOutcome(outcome, name, text, model);
}
export function readableCastFile(db: Database.Database, fileId: string): { name: string; text: string } {
  const [name, , , rawText] = getFileFull(db, fileId);
  const text = rawText ?? "";
  if (text.trim() === "") {
    throw new Error(`“${name}” has no readable text in this room.`);
  }
  return { name, text };
}
export function castReadWithoutModel(name: string, text: string): CastFromFile {
  return patternCastRead(
    name,
    text,
    "This room has no AI model set, so the file was read by pattern " +
      "matching — headings, bold names and `Name:` lines. Set a model " +
      "in Settings for a messy sheet.",
  );
}


export function castReadOutcome(
  outcome: SidecarPostOutcome,
  name: string,
  text: string,
  model: string,
): CastFromFile {
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
  return patternCastRead(
    name,
    text,
    `${model} could not read it (${trimEndDots(outcome.error.error)}), so this is pattern ` +
      "matching instead — headings, bold names and `Name:` lines. Check it closely.",
  );
}
export function patternCastRead(name: string, text: string, fellBack: string): CastFromFile {
  return { found: parseCast(text), name, readBy: PATTERN_READER, fellBack };
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
