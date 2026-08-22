/**
 * Vitest port of `src-tauri/src/db/story.rs`'s `mod tests`:
 *
 *   - a_new_character_lands_at_the_end_of_the_cast
 *   - faces_come_back_in_the_order_the_shot_names_them
 *   - filing_a_clip_does_not_wipe_the_still_it_came_from
 *   - a_shot_survives_a_cast_field_that_cannot_be_read
 *   - deleting_a_list_takes_its_shots_with_it
 *   - reordering_writes_the_positions_it_was_given
 *
 * plus coverage for the write paths the Rust suite exercises only through its
 * command layer (the `executeExisting` refusals on `updateCastMember`/
 * `setCastFace`/`updateShot`, the silent no-op shape of every OTHER by-id
 * write, and `nextShotId`/`prevShot`'s ordering) — added here because
 * `story.ts` is this port's only home for that behavior.
 *
 * DEVIATION from the Rust test module, which uses `Connection::open_in_memory()`
 * plus a hand-run `SCHEMA` batch: this uses a REAL fixture room via
 * `createRoom` (this repo's established convention — see `memories.test.ts`),
 * so the cascade test below exercises the actual `PRAGMA foreign_keys = ON`
 * constraint rather than assuming it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import {
  addCastMember,
  addShot,
  castFaces,
  createStoryList,
  deleteStoryList,
  listCast,
  listShots,
  listStoryLists,
  nextShotId,
  prevShot,
  removeCastMember,
  removeShot,
  reorderShots,
  setCastFace,
  setShotResult,
  setStoryShape,
  updateCastMember,
  updateShot,
  updateStoryList,
} from "./story.js";

let tmpDir: string;
let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-story-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  openDb = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return openDb;
}

/** A minimal, real `files` row — the same shape the Rust tests insert — so a
 * `face_file_id`/`still_file_id`/`clip_file_id` reference is never dangling
 * under the room's real `PRAGMA foreign_keys = ON`. */
function insertFile(db: Database.Database, id: string, mimeType = "image/png"): void {
  db.prepare(
    "INSERT INTO files (id, name, mime_type, original_bytes, source) VALUES (?, ?, ?, x'00', 'generated')"
  ).run(id, id, mimeType);
}

describe("cast", () => {
  it("a new character lands at the end of the cast", () => {
    const db = freshRoom();
    const lead = addCastMember(db, "Mira", "tall, grey coat", "lost her ship");
    const extra = addCastMember(db, "Doran", "broad, scarred", "");
    expect(lead.ord).toBe(0);
    expect(extra.ord, "a new minor part must not displace the lead").toBe(1);
    const all = listCast(db);
    expect(all.map((c) => c.name)).toEqual(["Mira", "Doran"]);
    // Nobody has a face until one is made or chosen.
    expect(all.every((c) => c.faceFileId === null)).toBe(true);
  });

  it("faces come back in the order the shot names them", () => {
    // Not the cast's order: a shot naming the villain first means the villain
    // is the first reference, and models do weight the order.
    const db = freshRoom();
    const a = addCastMember(db, "Mira", "", "");
    const b = addCastMember(db, "Doran", "", "");
    const c = addCastMember(db, "Nobody", "", "");
    for (const [member, file] of [
      [a, "file-a"],
      [b, "file-b"],
    ] as const) {
      insertFile(db, file);
      setCastFace(db, member.id, file);
    }
    const faces = castFaces(db, [b.id, a.id, c.id]);
    expect(faces, "asked order, faceless skipped").toEqual(["file-b", "file-a"]);
  });

  it("castFaces on an empty id list is an empty list, not an error", () => {
    const db = freshRoom();
    expect(castFaces(db, [])).toEqual([]);
  });

  it("updating a character that is no longer in the room is refused", () => {
    const db = freshRoom();
    expect(() => updateCastMember(db, "nope", "Name", "", "")).toThrow(
      "That character is no longer in this room."
    );
  });

  it("setting a face on a character that is no longer in the room is refused", () => {
    const db = freshRoom();
    expect(() => setCastFace(db, "nope", null)).toThrow("That character is no longer in this room.");
  });

  it("a face can be taken away with null", () => {
    const db = freshRoom();
    const member = addCastMember(db, "Mira", "", "");
    insertFile(db, "file-a");
    setCastFace(db, member.id, "file-a");
    expect(listCast(db)[0]?.faceFileId).toBe("file-a");
    setCastFace(db, member.id, null);
    expect(listCast(db)[0]?.faceFileId).toBeNull();
  });

  it("removing a character that does not exist is a silent no-op", () => {
    const db = freshRoom();
    expect(() => removeCastMember(db, "nope")).not.toThrow();
  });
});

describe("shot lists", () => {
  it("a blank title becomes Untitled", () => {
    const db = freshRoom();
    const id = createStoryList(db, "   ", "");
    expect(listStoryLists(db).find((l) => l.id === id)?.title).toBe("Untitled");
  });

  it("updating a list that does not exist is a silent no-op", () => {
    const db = freshRoom();
    expect(() => updateStoryList(db, "nope", "Title", "logline")).not.toThrow();
  });

  it("the frame shape is set independently of title/logline", () => {
    const db = freshRoom();
    const id = createStoryList(db, "Harbour", "one night");
    setStoryShape(db, id, "16:9", "1K", "720p");
    const list = listStoryLists(db).find((l) => l.id === id);
    expect(list?.aspectRatio).toBe("16:9");
    expect(list?.stillResolution).toBe("1K");
    expect(list?.clipResolution).toBe("720p");
    expect(list?.title).toBe("Harbour");
  });

  it("deleting a list takes its shots with it", () => {
    const db = freshRoom();
    const list = createStoryList(db, "Harbour", "one night");
    addShot(db, list, "one");
    addShot(db, list, "two");
    expect(listShots(db, list)).toHaveLength(2);
    deleteStoryList(db, list);
    expect(listShots(db, list)).toHaveLength(0);
  });
});

describe("shots", () => {
  it("filing a clip does not wipe the still it came from", () => {
    // The still is what a re-animation reuses. Losing it means paying to draw
    // the same frame again.
    const db = freshRoom();
    const list = createStoryList(db, "Harbour", "");
    const shot = addShot(db, list, "the boat leaves");
    insertFile(db, "still-1");
    insertFile(db, "clip-1");
    setShotResult(db, shot.id, "still-1", null);
    setShotResult(db, shot.id, null, "clip-1");
    const shots = listShots(db, list);
    expect(shots[0]?.stillFileId).toBe("still-1");
    expect(shots[0]?.clipFileId).toBe("clip-1");
  });

  it("a shot survives a cast field that cannot be read", () => {
    // One corrupt row must not take the whole shot list down with it.
    const db = freshRoom();
    const list = createStoryList(db, "Harbour", "");
    const shot = addShot(db, list, "the boat leaves");
    db.prepare("UPDATE story_shots SET cast_ids = 'not json' WHERE id = ?").run(shot.id);
    const shots = listShots(db, list);
    expect(shots).toHaveLength(1);
    expect(shots[0]?.castIds).toEqual([]);
    expect(shots[0]?.action).toBe("the boat leaves");
  });

  it("valid JSON that is not a string array reads as empty too, not partially kept", () => {
    // `serde_json::from_str::<Vec<String>>` fails type validation the same way
    // invalid JSON does, and `unwrap_or_default()` folds both to an empty vec —
    // so an array with ONE non-string element loses the whole array, not just
    // that element.
    const db = freshRoom();
    const list = createStoryList(db, "Harbour", "");
    const shot = addShot(db, list, "action");
    db.prepare("UPDATE story_shots SET cast_ids = ? WHERE id = ?").run('["a", 5, "b"]', shot.id);
    expect(listShots(db, list)[0]?.castIds).toEqual([]);
    db.prepare("UPDATE story_shots SET cast_ids = ? WHERE id = ?").run("[1,2,3]", shot.id);
    expect(listShots(db, list)[0]?.castIds).toEqual([]);
    db.prepare("UPDATE story_shots SET cast_ids = ? WHERE id = ?").run('{"a":1}', shot.id);
    expect(listShots(db, list)[0]?.castIds).toEqual([]);
  });

  it("reordering writes the positions it was given", () => {
    const db = freshRoom();
    const list = createStoryList(db, "Harbour", "");
    const one = addShot(db, list, "one");
    const two = addShot(db, list, "two");
    const three = addShot(db, list, "three");
    reorderShots(db, list, [three.id, one.id, two.id]);
    const actions = listShots(db, list).map((s) => s.action);
    expect(actions).toEqual(["three", "one", "two"]);
  });

  it("updating a shot that is no longer in the list is refused", () => {
    const db = freshRoom();
    expect(() => updateShot(db, "nope", "action", [], null, "", "")).toThrow(
      "That shot is no longer in this list."
    );
  });

  it("removing a shot that does not exist is a silent no-op", () => {
    const db = freshRoom();
    expect(() => removeShot(db, "nope")).not.toThrow();
  });

  it("negative seconds are clamped to zero, matching the Rust `.max(0)`", () => {
    const db = freshRoom();
    const list = createStoryList(db, "Harbour", "");
    const shot = addShot(db, list, "action");
    db.prepare("UPDATE story_shots SET seconds = -5 WHERE id = ?").run(shot.id);
    expect(listShots(db, list)[0]?.seconds).toBe(0);
  });

  it("nextShotId and prevShot walk the list in `ord` order", () => {
    const db = freshRoom();
    const list = createStoryList(db, "Harbour", "");
    const one = addShot(db, list, "one");
    const two = addShot(db, list, "two");
    const three = addShot(db, list, "three");

    expect(nextShotId(db, one.id)).toBe(two.id);
    expect(nextShotId(db, three.id)).toBeNull();
    expect(prevShot(db, one.id)).toBeNull();
    const prev = prevShot(db, two.id);
    expect(prev?.id).toBe(one.id);
    expect(prev?.clipFileId).toBeNull();
    expect(prev?.videoModel).toBe("");

    insertFile(db, "clip-1");
    updateShot(db, one.id, "one", [], null, "", "veo-3");
    setShotResult(db, one.id, null, "clip-1");
    const prevWithClip = prevShot(db, two.id);
    expect(prevWithClip?.clipFileId).toBe("clip-1");
    expect(prevWithClip?.videoModel).toBe("veo-3");
  });
});
