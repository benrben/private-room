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
import { allowsSeconds, limitsFor, type MediaLimits } from "./mediaLimits.js";
import { sidecarJsonCancellable, type SidecarPostOutcome } from "./sidecarJsonCancellable.js";
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
import { MAX_SHOT_CAST, splitWhitespace, storyAddCast, storyAddCastMany, storyAddShot, storyBoard, storyCreateList, storyDeleteList, storyDocuments, storyPicturesInRoom, storyReadCastFile, storyRemoveCast, storyRemoveShot, storyReorderShots, storySetFace, storySetShape, storyTextFromFile, storyUpdateCast, storyUpdateList, storyUpdateShot } from "./storyCastTools.js";
export { storyBoard, resetThumbCacheForTests, storyPictures, storyPicturesInRoom, storyAddCast, storyUpdateCast, storySetFace, storyRemoveCast, storyCreateList, storyUpdateList, storySetShape, storyDeleteList, MAX_SHOT_CAST, storyAddShot, fitShotCast, storyUpdateShot, storyRemoveShot, storyReorderShots, storyDocuments, storyTextFromFile, parseParsedMembers, storyReadCastFile, castReadOutcome, storyAddCastMany } from "./storyCastTools.js";


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
  return snapToMediaLimits(seconds, limitsFor(slug));
}

export function snapToMediaLimits(seconds: number, limits: MediaLimits | undefined): number {
  if (limits === undefined) return seconds;
  if (limits.durations.length === 0 || allowsSeconds(limits, seconds)) return seconds;
  return nearestPublishedDuration(seconds, limits.durations);
}

function nearestPublishedDuration(seconds: number, durations: readonly number[]): number {
  // `durations.iter().copied().min_by_key(|d| d.abs_diff(seconds))`: the
  // first duration with the smallest distance to the asked-for length wins a
  // tie, matching `Iterator::min_by_key`'s documented "first element on a
  // tie" — a strict `<` below (never `<=`) is what keeps that.
  let best = durations[0]!;
  let bestDiff = Math.abs(best - seconds);
  for (const d of durations.slice(1)) {
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
export function namesAppear(haystack: string, needle: string): boolean {
  if (needle === "") {
    return false;
  }
  const hayBytes = Buffer.from(haystack, "utf8");
  const needleBytes = Buffer.from(needle, "utf8");
  return firstWholeWordPosition(hayBytes, needleBytes) !== -1;
}

function firstWholeWordPosition(hayBytes: Buffer, needleBytes: Buffer): number {
  let from = 0;
  while (from < hayBytes.length) {
    const start = hayBytes.indexOf(needleBytes, from);
    if (start === -1) {
      return -1;
    }
    if (hasWholeWordBoundaries(hayBytes, start, needleBytes.length)) {
      return start;
    }
    from = start + needleBytes.length;
  }
  return -1;
}

function hasWholeWordBoundaries(hayBytes: Buffer, start: number, length: number): boolean {
  return isWordBoundary(hayBytes, start - 1) && isWordBoundary(hayBytes, start + length);
}

function isWordBoundary(bytes: Buffer, index: number): boolean {
  return index < 0 || index >= bytes.length || !isAlnumByte(bytes[index]!);
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
    const here = matchingCastIds(shot.action, cast);
    if (here.length === 0) {
      out.push([...carried]);
      continue;
    }
    carried = [...here];
    out.push(here);
  }
  return out;
}

function matchingCastIds(action: string, cast: readonly CastMember[]): string[] {
  const haystack = action.toLowerCase();
  const ids: string[] = [];
  for (const member of cast) {
    if (ids.length >= MAX_SHOT_CAST) {
      return ids;
    }
    if (castNameAppears(haystack, member.name)) {
      ids.push(member.id);
    }
  }
  return ids;
}

function castNameAppears(haystack: string, name: string): boolean {
  const full = name.trim().toLowerCase();
  if (full === "") {
    return false;
  }
  const first = splitWhitespace(full)[0] ?? full;
  return namesAppear(haystack, full) || namesAppear(haystack, first);
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
export { registerStoryIpc } from "./storyIpc.js";
export type { RoomSource } from "./storyIpc.js";
