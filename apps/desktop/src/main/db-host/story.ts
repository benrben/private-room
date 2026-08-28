/**
 * The room's cast and its shot lists — the data behind telling a story.
 * Ported from `src-tauri/src/db/story.rs` (573 lines, read in full, including
 * its `#[cfg(test)] mod tests` — all six are reproduced in `story.test.ts`).
 *
 * Two tables and one idea, carried over from the Rust source's own module doc:
 * **a character is a picture, not a description**. Everything else here is
 * bookkeeping around that. Asking a model twice for "a woman with red hair"
 * gets two different women; handing it the same portrait twice gets the same
 * woman. So `faceFileId` is the column that makes the feature work, and the
 * prose fields exist to write good prompts and to remind the user who these
 * people are.
 *
 * Shots keep BOTH the still and the clip. A shot is made in two paid steps —
 * draw the frame, then animate out of it — and holding on to the still means
 * a re-animation (longer, different model, different motion) does not pay to
 * draw the frame again.
 *
 * SCHEMA: `story_cast`, `story_lists` and `story_shots` are already created
 * (and, for `story_lists`, ALTER-backfilled with `aspect_ratio` /
 * `still_resolution` / `clip_resolution`) by `migrate.ts` — verified by
 * reading it in full before writing a line of this file, so there is no
 * migration gap for this module to close.
 *
 * CONVENTIONS reused from `util.ts`/`checkpoints.ts`/`memories.ts`: every
 * read/write goes through `queryOne`/`queryOpt`/`queryRows`/`executeOne`/
 * `executeExisting` rather than a bare `db.prepare` call site; rows are read
 * POSITIONALLY via `.raw()` (`Row`), matching the Rust mappers' `r.get(i)`
 * order column-for-column so the SQL stays a character-for-character copy of
 * the Rust SQL; errors are thrown `Error`s rather than a `Result<T, String>`
 * wrapper.
 *
 * WHICH WRITES REFUSE AND WHICH NO-OP is copied per statement from the Rust
 * source, not decided here: `updateCastMember`, `setCastFace` and
 * `updateShot` check the affected-row count (the Rust source returns
 * `Err("That … is no longer …")`), and every OTHER by-id write is a plain
 * `conn.execute(...)?; Ok(())` in Rust — a silent no-op on an id that names
 * nothing.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeExisting, executeOne, queryOne, queryOpt, queryRows, type Row } from "./util.js";

// ------------------------------------------------------------------- types

/** Mirrors the Rust `CastMember` struct (`#[serde(rename_all = "camelCase")]`),
 * which is field-for-field the `CastMember` in `shared/apiTypes.ts` — a cast
 * row goes out to the frontend unchanged. Redeclared here rather than imported,
 * the same choice `memories.ts`/`files.ts` make for their own row shapes: this
 * layer's types describe the TABLE, and the day the two disagree the db module
 * must not be the one that silently follows. */
export interface CastMember {
  id: string;
  name: string;
  /** What they look like. Goes into the prompt. */
  description: string;
  /** Who they are — history, wants, voice. The user's own writing; it is
   * theirs to keep whether or not any model ever reads it. */
  story: string;
  /** Their portrait, as a room file. THE thing that holds a face together
   * across shots. `null` means they exist but have no face yet. */
  faceFileId: string | null;
  ord: number;
}

/** Mirrors the Rust `StoryList` struct — one shot list. Never called a
 * "script" on screen: this app already uses that word for runnable Python. */
export interface StoryList {
  id: string;
  title: string;
  logline: string;
  /** The frame shape for the WHOLE list, e.g. `"16:9"`. One value rather than
   * one per shot, because a shot's still becomes its clip's literal first
   * frame: a still drawn 1:1 and pinned to a 16:9 clip is pinned to a frame
   * of the wrong shape. Empty = let each model's own default stand. */
  aspectRatio: string;
  /** Output size for the stills and for the clips. Two fields because the two
   * catalogues publish different vocabularies — `"1K"`/`"2K"` for pictures,
   * `"720p"`/`"1080p"`/`"4K"` for video. */
  stillResolution: string;
  clipResolution: string;
  shotCount: number;
  updatedAt: string;
}

/** Mirrors the Rust `StoryShot` struct — one shot: what happens, who is in
 * it, and what has been made of it. */
export interface StoryShot {
  id: string;
  listId: string;
  ord: number;
  action: string;
  /** Cast ids present in this shot. Their portraits become the references. */
  castIds: string[];
  /** Clip length. `null` = let the model's own default decide, which is the
   * honest state before a video model has been chosen: legal lengths differ
   * per model, so a number picked now may be illegal later. */
  seconds: number | null;
  imageModel: string;
  videoModel: string;
  stillFileId: string | null;
  clipFileId: string | null;
}

/** Mirrors the Rust `PrevShot` struct — the shot immediately BEFORE this one:
 * its id, its clip if it has one, and its clip model. The three facts the
 * (not-yet-ported) continuity chain gate decides on. */
export interface PrevShot {
  id: string;
  clipFileId: string | null;
  videoModel: string;
}

// ---------------------------------------------------------------- helpers

/**
 * `serde_json::from_str::<Vec<String>>(&cast_json).unwrap_or_default()` — ALL
 * of the array or NONE of it.
 *
 * A Rust `Vec<String>` fails to deserialize entirely the moment ONE element is
 * not a string, and `unwrap_or_default()` then folds that to an empty vec — so
 * a wrong SHAPE reads exactly like invalid JSON here, mirroring the Rust
 * source's own comment: "A row whose JSON cannot be read is an empty cast, not
 * a failed page: one corrupt field must not hide the shot list." Same
 * all-or-nothing shape `organizeTools.ts`'s array parsers already use.
 */
function parseCastIds(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    return [];
  }
  return parsed as string[];
}

/**
 * `SELECT COALESCE(MAX(ord), -1) + 1 FROM …` is an aggregate over the whole
 * table, so it always returns exactly one row (0 on an empty table) — this can
 * only throw on a genuine SQL/driver failure, which the Rust source swallows
 * with `.unwrap_or(0)` at both of its own call sites (`add_cast_member`,
 * `add_shot`). Mirrored here as a try/catch around the same query, not as a
 * `queryOpt`, since "no rows" is not actually a reachable outcome for it.
 */
function nextOrd(db: Database.Database, sql: string, params: readonly unknown[]): number {
  try {
    return queryOne(db, sql, params, (r) => r[0] as number);
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------- cast

function castMemberRow(r: Row): CastMember {
  return {
    id: r[0] as string,
    name: r[1] as string,
    description: r[2] as string,
    story: r[3] as string,
    faceFileId: r[4] as string | null,
    ord: r[5] as number,
  };
}

export function listCast(db: Database.Database): CastMember[] {
  return queryRows(
    db,
    `SELECT id, name, description, story, face_file_id, ord
       FROM story_cast ORDER BY ord, created_at`,
    [],
    castMemberRow
  );
}

/** Appended, not inserted at the top: a cast is read as an order of
 * importance, and a new minor character should not displace the lead. */
export function addCastMember(
  db: Database.Database,
  name: string,
  description: string,
  story: string
): CastMember {
  const id = randomUUID();
  const ord = nextOrd(db, "SELECT COALESCE(MAX(ord), -1) + 1 FROM story_cast", []);
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const trimmedStory = story.trim();
  executeOne(
    db,
    "INSERT INTO story_cast (id, name, description, story, ord) VALUES (?, ?, ?, ?, ?)",
    [id, trimmedName, trimmedDescription, trimmedStory, ord]
  );
  return {
    id,
    name: trimmedName,
    description: trimmedDescription,
    story: trimmedStory,
    faceFileId: null,
    ord,
  };
}

export function updateCastMember(
  db: Database.Database,
  id: string,
  name: string,
  description: string,
  story: string
): void {
  executeExisting(
    db,
    `UPDATE story_cast
        SET name = ?, description = ?, story = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
    [name.trim(), description.trim(), story.trim(), id],
    "That character is no longer in this room."
  );
}

/** Give someone a face — or take it away with `null`. */
export function setCastFace(db: Database.Database, id: string, fileId: string | null): void {
  executeExisting(
    db,
    `UPDATE story_cast
        SET face_file_id = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
    [fileId, id],
    "That character is no longer in this room."
  );
}

/** Plain DELETE, matching the Rust source's own `remove_cast_member` exactly:
 * no changed-row check, so an id that names nobody is a silent no-op rather
 * than an error. */
export function removeCastMember(db: Database.Database, id: string): void {
  executeOne(db, "DELETE FROM story_cast WHERE id = ?", [id]);
}

/**
 * The portraits for a set of cast ids, in the order asked for, skipping
 * anyone who has no face yet.
 *
 * Order is the caller's, not the table's: a shot naming the villain first
 * means the villain is the first reference, and models do weight them.
 */
export function castFaces(db: Database.Database, ids: readonly string[]): string[] {
  const faces: string[] = [];
  for (const id of ids) {
    // `.optional()` (no such cast member) and `.flatten()` (a cast member with
    // no face yet) both collapse to `None` in Rust; `queryOpt` already returns
    // `null` for "no row", and the mapper passes a NULL `face_file_id` column
    // straight through as `null`, so the two cases land on the same value here
    // with no extra flattening needed.
    const face = queryOpt(
      db,
      "SELECT face_file_id FROM story_cast WHERE id = ?",
      [id],
      (r) => r[0] as string | null
    );
    if (face !== null) {
      faces.push(face);
    }
  }
  return faces;
}

// ------------------------------------------------------------- shot lists

function storyListRow(r: Row): StoryList {
  return {
    id: r[0] as string,
    title: r[1] as string,
    logline: r[2] as string,
    updatedAt: r[3] as string,
    shotCount: r[4] as number,
    aspectRatio: r[5] as string,
    stillResolution: r[6] as string,
    clipResolution: r[7] as string,
  };
}

export function listStoryLists(db: Database.Database): StoryList[] {
  return queryRows(
    db,
    `SELECT l.id, l.title, l.logline, l.updated_at,
            (SELECT COUNT(*) FROM story_shots s WHERE s.list_id = l.id),
            l.aspect_ratio, l.still_resolution, l.clip_resolution
       FROM story_lists l ORDER BY l.updated_at DESC`,
    [],
    storyListRow
  );
}

export function createStoryList(db: Database.Database, title: string, logline: string): string {
  const id = randomUUID();
  const trimmedTitle = title.trim();
  const finalTitle = trimmedTitle === "" ? "Untitled" : trimmedTitle;
  executeOne(db, "INSERT INTO story_lists (id, title, logline) VALUES (?, ?, ?)", [
    id,
    finalTitle,
    logline.trim(),
  ]);
  return id;
}

/** Plain UPDATE, matching the Rust source exactly: no changed-row check. */
export function updateStoryList(
  db: Database.Database,
  id: string,
  title: string,
  logline: string
): void {
  executeOne(
    db,
    `UPDATE story_lists
        SET title = ?, logline = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
    [title.trim(), logline.trim(), id]
  );
}

/**
 * Set the frame shape and the two output sizes for a whole list.
 *
 * Separate from {@link updateStoryList} because the title and logline are
 * typed on every keystroke while the shape is chosen from a menu of values the
 * provider published — folding them together would have every character typed
 * in the title re-write three columns that nobody touched. Plain UPDATE,
 * matching the Rust source exactly: no changed-row check.
 */
export function setStoryShape(
  db: Database.Database,
  id: string,
  aspectRatio: string,
  stillResolution: string,
  clipResolution: string
): void {
  executeOne(
    db,
    `UPDATE story_lists
        SET aspect_ratio = ?, still_resolution = ?, clip_resolution = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
    [aspectRatio.trim(), stillResolution.trim(), clipResolution.trim(), id]
  );
}

/** Plain DELETE; `story_shots.list_id` cascades (`ON DELETE CASCADE`), so a
 * list's shots go with it — proven against the real schema's foreign key, not
 * assumed, in `story.test.ts`. */
export function deleteStoryList(db: Database.Database, id: string): void {
  executeOne(db, "DELETE FROM story_lists WHERE id = ?", [id]);
}

// ------------------------------------------------------------------ shots

/**
 * The shot immediately after this one in its list, if any.
 *
 * One query rather than a list walk because the caller is a finishing JOB —
 * it holds the room lock for the moment this takes, and the continuity chain
 * needs exactly one answer: whose first frame does my end frame become.
 * Ordered the same way {@link listShots} orders, so "next" here is "next"
 * there.
 */
export function nextShotId(db: Database.Database, shotId: string): string | null {
  return queryOpt(
    db,
    `SELECT s2.id
       FROM story_shots s1
       JOIN story_shots s2 ON s2.list_id = s1.list_id
      WHERE s1.id = ?
        AND (s2.ord > s1.ord OR (s2.ord = s1.ord AND s2.created_at > s1.created_at))
      ORDER BY s2.ord, s2.created_at
      LIMIT 1`,
    [shotId],
    (r) => r[0] as string
  );
}

/** The shot immediately BEFORE this one — see {@link PrevShot}. */
export function prevShot(db: Database.Database, shotId: string): PrevShot | null {
  return queryOpt(
    db,
    `SELECT s2.id, s2.clip_file_id, s2.video_model
       FROM story_shots s1
       JOIN story_shots s2 ON s2.list_id = s1.list_id
      WHERE s1.id = ?
        AND (s2.ord < s1.ord OR (s2.ord = s1.ord AND s2.created_at < s1.created_at))
      ORDER BY s2.ord DESC, s2.created_at DESC
      LIMIT 1`,
    [shotId],
    (r): PrevShot => ({
      id: r[0] as string,
      clipFileId: r[1] as string | null,
      videoModel: r[2] as string,
    })
  );
}

function storyShotRow(r: Row): StoryShot {
  const rawSeconds = r[5] as number | null;
  return {
    id: r[0] as string,
    listId: r[1] as string,
    ord: r[2] as number,
    action: r[3] as string,
    // A row whose JSON cannot be read is an empty cast, not a failed page: one
    // corrupt field must not hide the shot list.
    castIds: parseCastIds(r[4] as string),
    // `r.get::<_, Option<i64>>(5)?.map(|n| n.max(0) as u32)`.
    seconds: rawSeconds === null ? null : Math.max(0, rawSeconds),
    imageModel: r[6] as string,
    videoModel: r[7] as string,
    stillFileId: r[8] as string | null,
    clipFileId: r[9] as string | null,
  };
}

export function listShots(db: Database.Database, listId: string): StoryShot[] {
  return queryRows(
    db,
    `SELECT id, list_id, ord, action, cast_ids, seconds,
            image_model, video_model, still_file_id, clip_file_id
       FROM story_shots WHERE list_id = ? ORDER BY ord, created_at`,
    [listId],
    storyShotRow
  );
}

export function addShot(db: Database.Database, listId: string, action: string): StoryShot {
  const id = randomUUID();
  const ord = nextOrd(db, "SELECT COALESCE(MAX(ord), -1) + 1 FROM story_shots WHERE list_id = ?", [
    listId,
  ]);
  const trimmedAction = action.trim();
  executeOne(db, "INSERT INTO story_shots (id, list_id, ord, action) VALUES (?, ?, ?, ?)", [
    id,
    listId,
    ord,
    trimmedAction,
  ]);
  return {
    id,
    listId,
    ord,
    action: trimmedAction,
    castIds: [],
    seconds: null,
    imageModel: "",
    videoModel: "",
    stillFileId: null,
    clipFileId: null,
  };
}

/**
 * Save one shot's editable fields. The two file ids are NOT here: they are
 * written only by a finished generation ({@link setShotResult}), so a stale
 * form cannot erase a picture the user paid for.
 */
export function updateShot(
  db: Database.Database,
  id: string,
  action: string,
  castIds: readonly string[],
  seconds: number | null,
  imageModel: string,
  videoModel: string
): void {
  // Rust's `serde_json::to_string(cast_ids).unwrap_or_else(|_| "[]".into())`.
  // The fallback arm is unreachable for a `string[]` (no cycles, no BigInts,
  // no functions), so this is the plain stringify rather than a dead catch.
  const castJson = JSON.stringify(castIds);
  executeExisting(
    db,
    `UPDATE story_shots
        SET action = ?, cast_ids = ?, seconds = ?,
            image_model = ?, video_model = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
    [action.trim(), castJson, seconds, imageModel.trim(), videoModel.trim(), id],
    "That shot is no longer in this list."
  );
}

/** Record what a finished generation produced. COALESCE, so filing a clip does
 * not wipe the still it was animated from. Plain UPDATE, matching the Rust
 * source exactly: no changed-row check. */
export function setShotResult(
  db: Database.Database,
  id: string,
  stillFileId: string | null,
  clipFileId: string | null
): void {
  executeOne(
    db,
    `UPDATE story_shots
        SET still_file_id = COALESCE(?, still_file_id),
            clip_file_id  = COALESCE(?, clip_file_id),
            updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`,
    [stillFileId, clipFileId, id]
  );
}

/** Plain DELETE, matching the Rust source exactly: no changed-row check. */
export function removeShot(db: Database.Database, id: string): void {
  executeOne(db, "DELETE FROM story_shots WHERE id = ?", [id]);
}

/** Re-order a whole list in one go, from the ids in their new order. Plain
 * per-row UPDATE, matching the Rust source exactly: no changed-row check, so
 * an id that is not actually in `listId` is silently skipped rather than
 * erroring the whole reorder. */
export function reorderShots(
  db: Database.Database,
  listId: string,
  ids: readonly string[]
): void {
  ids.forEach((id, index) => {
    executeOne(db, "UPDATE story_shots SET ord = ? WHERE id = ? AND list_id = ?", [
      index,
      id,
      listId,
    ]);
  });
}
