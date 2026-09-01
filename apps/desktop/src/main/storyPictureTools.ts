import type Database from "better-sqlite3-multiple-ciphers";
import sharp from "sharp";
import { getFileBytes, listFiles } from "./db-host/files.js";
import { listCast, listShots, listStoryLists } from "./db-host/story.js";
import type { RoomPicture, StoryBoard } from "../shared/apiTypes.js";




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

export

// --------------------------------------------------------------- pictures

/** The longest edge of a preview. Big enough to recognize a face, small enough
 * that a hundred of them cost less than one real picture. */
const THUMB_EDGE = 192;

export

/** How many pictures the picker offers. A cap rather than the whole room: the
 * list is for choosing a face or a starting frame, and decoding a thousand
 * images to fill a scroll nobody reaches is a page that takes seconds to open.
 * Newest first (matching `listFiles`'s own ordering), because a picture just
 * generated is the one being reached for. */
const PICKER_LIMIT = 150;

export

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

export

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

export

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
