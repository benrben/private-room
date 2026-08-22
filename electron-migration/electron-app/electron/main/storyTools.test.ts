/**
 * Vitest port of `src-tauri/src/commands/story.rs`'s `mod tests`:
 *
 *   - a_split_puts_the_people_the_shot_names_into_it
 *   - a_shot_that_says_she_keeps_the_person_from_the_shot_before
 *   - an_opening_shot_before_anyone_is_named_gets_nobody
 *   - a_name_inside_another_word_is_not_a_person
 *   - a_fifth_person_on_one_shot_is_refused_rather_than_dropped
 *   - a_crowd_scene_stops_at_the_per_shot_ceiling
 *   - a_shot_prompt_says_who_is_there_and_what_they_do
 *   - a_character_with_no_description_still_gets_named
 *   - an_empty_shot_makes_an_empty_prompt_rather_than_punctuation
 *
 * plus coverage for every other command in the file, against a REAL fixture
 * room (`createRoom`, this repo's established convention). The Rust source has
 * NO `mod tests` for the `#[tauri::command]` wrappers (they close over
 * `AppState`), so those are new tests proving this port's own wiring rather
 * than mirroring a specific Rust assertion.
 *
 * `sidecarJsonCancellable`'s network call is exercised against a REAL local
 * `node:http` server with only `./sidecar.js`'s `ensureUp` mocked to point at
 * it — the convention `sidecarJsonCancellable.test.ts` itself uses, rather than
 * mocking `sidecarJsonCancellable` directly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import sharp from "sharp";
import { createRoom } from "./db-host/open.js";
import { MAX_FOUND } from "./castparse.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import {
  assignCast,
  fitShotCast,
  MAX_SHOT_CAST,
  registerStoryIpc,
  resetThumbCacheForTests,
  shotPrompt,
  snapSeconds,
  storyAddCast,
  storyAddCastMany,
  storyAddShot,
  storyApplySplit,
  storyBoard,
  storyCreateList,
  storyDeleteList,
  storyDocuments,
  storyPictures,
  storyPlanSplit,
  storyReadCastFile,
  storyRemoveCast,
  storyRemoveShot,
  storyReorderShots,
  storySetFace,
  storySetShape,
  storyTextFromFile,
  storyUpdateCast,
  storyUpdateList,
  storyUpdateShot,
  STORY_PLAN_SPLIT_NOT_IMPLEMENTED,
  type PlannedShot,
  type RoomSource,
} from "./storyTools.js";
import type { CastMember } from "./db-host/story.js";
import type { Commands } from "../shared/ipc-contract.js";

/** Every `story_*` channel the pre-migration frontend actually invokes, minus
 * the two that are registered next to them in `lib.rs` but live in
 * `commands/jobs/create.rs` — a different Rust file, out of this batch. Typing
 * the expected list against this makes a MISSPELLED channel name a compile
 * error rather than a test that quietly proves the wrong string was
 * registered. */
type StoryChannel = Exclude<
  Extract<keyof Commands, `story_${string}`>,
  "story_film_plan"
>;

/** `T` must be `never`, or this fails to compile — used below to prove the
 * registered list COVERS the contract, not merely that every name in it is
 * spelled right. */
type MustBeNever<T extends never> = T;

let tmpDir: string;
let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  vi.mocked(ensureUp).mockReset();
  resetThumbCacheForTests();
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "story-tools-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  openDb = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return openDb;
}

function insertFile(
  db: Database.Database,
  id: string,
  opts: { mimeType?: string; bytes?: Buffer; text?: string | null } = {}
): void {
  db.prepare(
    "INSERT INTO files (id, name, mime_type, original_bytes, extracted_text, source) VALUES (?, ?, ?, ?, ?, 'generated')"
  ).run(id, id, opts.mimeType ?? "text/plain", opts.bytes ?? Buffer.from("x"), opts.text ?? null);
}

function member(name: string, description = ""): CastMember {
  return { id: name, name, description, story: "", faceFileId: null, ord: 0 };
}

function planned(action: string): PlannedShot {
  return { action, seconds: 15 };
}

// =========================================================== pure functions

describe("assignCast", () => {
  it("a split puts the people the shot names into it", () => {
    // THE BUG THIS PINS: `story_apply_split` used to write `[]` for every shot,
    // so a 21-shot episode had nobody in any of it — no portrait attached, so
    // the model drew a different lead in every scene.
    const cast = [member("Mira Halloran", "grey coat"), member("Doran", "broad")];
    const shots = [
      planned("Mira walks the length of the quay."),
      planned("Doran watches from the window."),
    ];
    const assigned = assignCast(shots, cast);
    // Matched on the FIRST name too: the sheet says "Mira Halloran", the script
    // says "Mira".
    expect(assigned[0]).toEqual(["Mira Halloran"]);
    expect(assigned[1]).toEqual(["Doran"]);
  });

  it("a shot that says 'she' keeps the person from the shot before", () => {
    const cast = [member("Noa", "small, ink-stained hands")];
    const shots = [
      planned("Noa weaves through the market stalls."),
      planned("She stops. The noise drops away."),
      planned("Her hand closes on empty air."),
    ];
    const assigned = assignCast(shots, cast);
    expect(assigned[0]).toEqual(["Noa"]);
    expect(assigned[1], "the scene is still going").toEqual(["Noa"]);
    expect(assigned[2]).toEqual(["Noa"]);
  });

  it("an opening shot before anyone is named gets nobody", () => {
    const cast = [member("Noa")];
    const shots = [planned("The market at first light. Empty."), planned("Noa arrives.")];
    const assigned = assignCast(shots, cast);
    expect(assigned[0]).toEqual([]);
    expect(assigned[1]).toEqual(["Noa"]);
  });

  it("a name inside another word is not a person", () => {
    const cast = [member("Noa")];
    const shots = [
      planned("Noah shuts the door. There is no answer."),
      planned("They announce the tide."),
    ];
    const assigned = assignCast(shots, cast);
    expect(assigned[0], "Noah and 'no answer' are not Noa").toEqual([]);
    expect(assigned[1], "nor is 'announce'").toEqual([]);
  });

  it("a crowd scene stops at the per-shot ceiling", () => {
    const cast = ["Ada", "Bo", "Cai", "Dev", "Eli"].map((n) => member(n));
    const shots = [planned("Ada, Bo, Cai, Dev and Eli all arrive at once.")];
    expect(assignCast(shots, cast)[0]).toHaveLength(MAX_SHOT_CAST);
  });

  it("reproduces the Rust boundary check byte for byte, quirk included", () => {
    // `names_appear` casts a raw UTF-8 BYTE to `char`, so the first byte of a
    // multi-byte character (an em dash: 0xE2 → `â`) reads as alphanumeric and
    // the match is refused. That is what the shipped app does; a "fixed"
    // Unicode-aware check would put a different person in this shot, and a port
    // that changes who ends up in a shot cannot be diffed against the original.
    const cast = [member("Mira")];
    expect(assignCast([planned("Mira—she turns.")], cast)[0]).toEqual([]);
    // An ASCII boundary is matched exactly as before.
    expect(assignCast([planned("Mira, she turns.")], cast)[0]).toEqual(["Mira"]);
    // And a non-ASCII NAME is still found when its own boundaries are ASCII.
    expect(assignCast([planned("Zoë waits.")], [member("Zoë")])[0]).toEqual(["Zoë"]);
  });
});

describe("fitShotCast", () => {
  it("a fifth person on one shot is refused rather than dropped", () => {
    // The silent `take(4)` this replaces: the row kept the fifth chip pressed
    // while the room stored four.
    const four = ["a", "b", "c", "d"];
    expect(fitShotCast(four)).toEqual(four);
    expect(fitShotCast([])).toEqual([]);
    expect(() => fitShotCast(["a", "b", "c", "d", "e"])).toThrow(/at most/);
  });
});

describe("shotPrompt", () => {
  it("says who is there and what they do", () => {
    const prompt = shotPrompt(
      "she cuts the mooring rope as the tide turns",
      [member("Mira", "tall, grey coat"), member("Doran", "broad, scarred")],
      "one night on the harbour"
    );
    expect(prompt).toBe(
      "one night on the harbour. Mira — tall, grey coat. Doran — broad, scarred. " +
        "she cuts the mooring rope as the tide turns"
    );
  });

  it("a character with no description still gets named", () => {
    expect(shotPrompt("waits", [member("Mira", "")], "")).toBe("Mira. waits");
    expect(shotPrompt("waits", [member("Mira", "   ")], "")).toBe("Mira. waits");
  });

  it("an empty shot makes an empty prompt rather than punctuation", () => {
    expect(shotPrompt("", [], "")).toBe("");
    expect(shotPrompt("   ", [], "  ")).toBe("");
  });
});

// =========================================================== board

describe("storyBoard", () => {
  it("falls back to the most recently touched list when none is selected", () => {
    const db = freshRoom();
    const older = storyCreateList(db, "Older", "");
    const newer = storyCreateList(db, "Newer", "");
    // `updated_at` has one-second resolution, so two lists created in the same
    // tick would tie — stamp them explicitly rather than assert on a race.
    db.prepare("UPDATE story_lists SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(older);
    expect(storyBoard(db, null).selected).toBe(newer);
  });

  it("an unknown list id also falls back rather than erroring", () => {
    const db = freshRoom();
    const only = storyCreateList(db, "Only", "");
    expect(storyBoard(db, "nope").selected).toBe(only);
    expect(storyBoard(db, only).selected).toBe(only);
  });

  it("no lists at all means no selection and an empty shot list", () => {
    const db = freshRoom();
    const board = storyBoard(db, null);
    expect(board.selected).toBeNull();
    expect(board.shots).toEqual([]);
    expect(board.lists).toEqual([]);
    expect(board.cast).toEqual([]);
  });

  it("carries the selected list's shots and the whole cast", () => {
    const db = freshRoom();
    storyAddCast(db, "Mira", "", "");
    const list = storyCreateList(db, "Harbour", "");
    storyAddShot(db, list, "one");
    const board = storyBoard(db, list);
    expect(board.cast).toHaveLength(1);
    expect(board.shots).toHaveLength(1);
  });
});

// =========================================================== cast commands

describe("storyAddCast / storyUpdateCast", () => {
  it("a nameless character is refused", () => {
    const db = freshRoom();
    expect(() => storyAddCast(db, "  ", "", "")).toThrow("Give them a name first.");
    expect(() => storyUpdateCast(db, "nope", "  ", "", "")).toThrow("Give them a name first.");
  });

  it("adds and updates for real", () => {
    const db = freshRoom();
    const mira = storyAddCast(db, "Mira", "tall", "lost her ship");
    storyUpdateCast(db, mira.id, "Mira Halloran", "tall, grey coat", "lost her ship");
    const [updated] = storyBoard(db, null).cast;
    expect(updated?.name).toBe("Mira Halloran");
    expect(updated?.description).toBe("tall, grey coat");
  });
});

describe("storySetFace", () => {
  it("refuses a file that is not a picture", () => {
    const db = freshRoom();
    const mira = storyAddCast(db, "Mira", "", "");
    insertFile(db, "doc-1", { mimeType: "application/pdf" });
    expect(() => storySetFace(db, mira.id, "doc-1")).toThrow(
      // Curly quotes, exactly as the Rust format string writes them.
      "“doc-1” is not a picture, so it cannot be a face."
    );
  });

  it("pins and clears a face for real", () => {
    const db = freshRoom();
    const mira = storyAddCast(db, "Mira", "", "");
    insertFile(db, "pic-1", { mimeType: "image/png" });
    storySetFace(db, mira.id, "pic-1");
    expect(storyBoard(db, null).cast[0]?.faceFileId).toBe("pic-1");
    storySetFace(db, mira.id, null);
    expect(storyBoard(db, null).cast[0]?.faceFileId).toBeNull();
  });
});

describe("storyRemoveCast", () => {
  it("removes for real", () => {
    const db = freshRoom();
    const mira = storyAddCast(db, "Mira", "", "");
    storyRemoveCast(db, mira.id);
    expect(storyBoard(db, null).cast).toEqual([]);
  });
});

// =========================================================== list commands

describe("list commands", () => {
  it("storyUpdateList and storySetShape write for real, independently", () => {
    const db = freshRoom();
    const list = storyCreateList(db, "Harbour", "one night");
    storyUpdateList(db, list, "Harbour Nights", "a different night");
    storySetShape(db, list, "16:9", "1K", "720p");
    const found = storyBoard(db, list).lists.find((l) => l.id === list);
    expect(found?.title).toBe("Harbour Nights");
    expect(found?.aspectRatio).toBe("16:9");
    expect(found?.stillResolution).toBe("1K");
    expect(found?.clipResolution).toBe("720p");
  });

  it("storyDeleteList removes it and its shots", () => {
    const db = freshRoom();
    const list = storyCreateList(db, "Harbour", "");
    storyAddShot(db, list, "one");
    storyDeleteList(db, list);
    expect(storyBoard(db, list).lists).toEqual([]);
  });
});

// =========================================================== shot commands

describe("shot commands", () => {
  it("storyUpdateShot enforces the per-shot cast cap", () => {
    const db = freshRoom();
    const list = storyCreateList(db, "Harbour", "");
    const shot = storyAddShot(db, list, "action");
    expect(() =>
      storyUpdateShot(db, shot.id, "action", ["a", "b", "c", "d", "e"], null, "", "")
    ).toThrow(/at most/);
    storyUpdateShot(db, shot.id, "action", ["a", "b"], 10, "img-1", "vid-1");
    const found = storyBoard(db, list).shots[0];
    expect(found?.castIds).toEqual(["a", "b"]);
    expect(found?.seconds).toBe(10);
    expect(found?.imageModel).toBe("img-1");
  });

  it("storyRemoveShot and storyReorderShots write for real", () => {
    const db = freshRoom();
    const list = storyCreateList(db, "Harbour", "");
    const one = storyAddShot(db, list, "one");
    const two = storyAddShot(db, list, "two");
    const three = storyAddShot(db, list, "three");
    storyReorderShots(db, list, [three.id, one.id, two.id]);
    expect(storyBoard(db, list).shots.map((s) => s.action)).toEqual(["three", "one", "two"]);
    storyRemoveShot(db, two.id);
    expect(storyBoard(db, list).shots.map((s) => s.action)).toEqual(["three", "one"]);
  });
});

// =========================================================== documents

describe("storyDocuments / storyTextFromFile", () => {
  it("lists only files with real, non-blank extracted text", () => {
    const db = freshRoom();
    insertFile(db, "doc-1", { text: "Once upon a time there was a harbour town." });
    insertFile(db, "doc-2", { text: "   " }); // blank after trim, excluded
    insertFile(db, "doc-3", { text: null }); // no text at all, excluded
    const docs = storyDocuments(db);
    expect(docs.map((d) => d.fileId)).toEqual(["doc-1"]);
    expect(docs[0]?.snippet.startsWith("Once upon a time")).toBe(true);
    expect(docs[0]?.words).toBeGreaterThan(0);
  });

  it("collapses the snippet's whitespace, the way `split_whitespace().join(' ')` does", () => {
    const db = freshRoom();
    insertFile(db, "doc-1", { text: "INT.  HARBOUR\n\n  — NIGHT" });
    expect(storyDocuments(db)[0]?.snippet).toBe("INT. HARBOUR — NIGHT");
  });

  it("returns the whole text, unclamped", () => {
    const db = freshRoom();
    const long = "word ".repeat(5000);
    insertFile(db, "doc-1", { text: long });
    expect(storyTextFromFile(db, "doc-1")).toBe(long);
  });

  it("a file with no readable text is refused, not silently returned empty", () => {
    const db = freshRoom();
    insertFile(db, "doc-1", { text: "   " });
    expect(() => storyTextFromFile(db, "doc-1")).toThrow("has no readable text in this room");
  });
});

// =========================================================== pictures

describe("storyPictures", () => {
  beforeEach(() => {
    resetThumbCacheForTests();
  });

  it("thumbnails a big picture down into the 192px box, as a real JPEG", async () => {
    const db = freshRoom();
    const png = await sharp({
      create: { width: 400, height: 200, channels: 4, background: { r: 200, g: 20, b: 20, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    insertFile(db, "pic-1", { mimeType: "image/png", bytes: png });

    const pictures = await storyPictures(db);
    expect(pictures).toHaveLength(1);
    expect(pictures[0]?.fileId).toBe("pic-1");
    const jpeg = Buffer.from(pictures[0]!.thumbB64, "base64");
    // JPEG magic bytes — proves this is a REAL re-encode, not an echo of the
    // PNG input.
    expect(jpeg[0]).toBe(0xff);
    expect(jpeg[1]).toBe(0xd8);
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([192, 96]);
    // `to_rgb8()` drops the alpha channel; a JPEG cannot carry one anyway.
    expect(meta.channels).toBe(3);
  });

  it("a picture SMALLER than the box is scaled up, matching Rust's thumbnail()", async () => {
    // `DynamicImage::thumbnail` computes its target from `resize_dimensions(…,
    // fill=false)`, which is `min(w_ratio, h_ratio)` with no clamp at 1.0 — so a
    // small picture is enlarged to fill the box. `withoutEnlargement: true`
    // would leave this at 40×20 and disagree with the shipped app.
    const db = freshRoom();
    const png = await sharp({
      create: { width: 40, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    insertFile(db, "pic-1", { mimeType: "image/png", bytes: png });
    const pictures = await storyPictures(db);
    const meta = await sharp(Buffer.from(pictures[0]!.thumbB64, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([192, 96]);
  });

  it("a corrupt image is skipped, not fatal to the rest of the picker", async () => {
    const db = freshRoom();
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    insertFile(db, "good", { mimeType: "image/png", bytes: png });
    insertFile(db, "bad", { mimeType: "image/png", bytes: Buffer.from("not a real image") });

    const pictures = await storyPictures(db);
    expect(pictures.map((p) => p.fileId)).toEqual(["good"]);
  });

  it("a non-image file never appears in the picker", async () => {
    const db = freshRoom();
    insertFile(db, "doc-1", { mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4") });
    expect(await storyPictures(db)).toEqual([]);
  });

  it("a cache hit is served without touching the file's bytes again", async () => {
    const db = freshRoom();
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png()
      .toBuffer();
    insertFile(db, "pic-1", { mimeType: "image/png", bytes: png });
    const first = await storyPictures(db);
    // Corrupt the stored bytes in place; a cache hit must not need to decode
    // them again to answer the same thumbnail.
    db.prepare("UPDATE files SET original_bytes = ? WHERE id = ?").run(
      Buffer.from("garbage"),
      "pic-1"
    );
    const second = await storyPictures(db);
    expect(second).toEqual(first);
  });
});

// =========================================================== read cast file

describe("storyReadCastFile", () => {
  it("refuses a file with no readable text before ever looking at the model setting", async () => {
    const db = freshRoom();
    insertFile(db, "doc-1", { text: "   " });
    await expect(storyReadCastFile(db, "doc-1")).rejects.toThrow("has no readable text in this room");
  });

  it("falls back to the pattern reader when no model is set", async () => {
    const db = freshRoom();
    insertFile(db, "doc-1", { text: "## Mira\nTall, grey coat.\n\nLost her ship.\n" });
    const result = await storyReadCastFile(db, "doc-1");
    expect(result.readBy).toBe("pattern matching");
    expect(result.fellBack).toContain("no AI model set");
    expect(result.found).toEqual([
      { name: "Mira", description: "Tall, grey coat.", story: "Lost her ship." },
    ]);
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("reads through the sidecar for real when a model is set, and reports no fallback", async () => {
    const db = freshRoom();
    db.prepare("INSERT INTO settings (key, value) VALUES ('model', 'qwen3.5:4b')").run();
    insertFile(db, "doc-1", { text: "Mira is the harbourmaster's daughter." });

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        expect(JSON.parse(body).mode).toBe("cast");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            cast: [{ name: "Mira", description: "", story: "harbourmaster's daughter" }],
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const result = await storyReadCastFile(db, "doc-1");
      expect(result.readBy).toBe("qwen3.5:4b");
      expect(result.fellBack).toBeNull();
      expect(result.found).toEqual([
        { name: "Mira", description: "", story: "harbourmaster's daughter" },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a reply whose cast is not a full ParsedMember array reads as nobody, not partially", async () => {
    // `serde_json::from_value::<Vec<ParsedMember>>` is all-or-nothing: one
    // element missing `story` loses the WHOLE array in Rust.
    const db = freshRoom();
    db.prepare("INSERT INTO settings (key, value) VALUES ('model', 'qwen3.5:4b')").run();
    insertFile(db, "doc-1", { text: "Mira is the harbourmaster's daughter." });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ cast: [{ name: "Mira", description: "tall", story: "x" }, { name: "Doran" }] })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const result = await storyReadCastFile(db, "doc-1");
      expect(result.readBy).toBe("qwen3.5:4b");
      expect(result.found).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("falls back to the pattern reader, with an honest explanation, when the model cannot answer", async () => {
    const db = freshRoom();
    db.prepare("INSERT INTO settings (key, value) VALUES ('model', 'qwen3.5:4b')").run();
    insertFile(db, "doc-1", { text: "## Doran\nBroad, scarred.\n" });
    vi.mocked(ensureUp).mockRejectedValue(new Error("no bundled binary in Resources/."));

    const result = await storyReadCastFile(db, "doc-1");
    expect(result.readBy).toBe("pattern matching");
    expect(result.fellBack).toContain("qwen3.5:4b could not read it");
    // The trailing period on the underlying error is stripped before it is
    // folded into this sentence's own punctuation.
    expect(result.fellBack).not.toContain("Resources/.)");
    expect(result.found).toEqual([{ name: "Doran", description: "Broad, scarred.", story: "" }]);
  });
});

// =========================================================== add cast many

describe("storyAddCastMany", () => {
  it("refuses an empty (or all-blank) list", () => {
    const db = freshRoom();
    expect(() => storyAddCastMany(db, [])).toThrow("Nobody to add.");
    expect(() => storyAddCastMany(db, [{ name: "   ", description: "", story: "" }])).toThrow(
      "Nobody to add."
    );
  });

  it("adds every real member and reports the count", () => {
    const db = freshRoom();
    const added = storyAddCastMany(db, [
      { name: "Mira", description: "tall", story: "" },
      { name: "  ", description: "skipped", story: "" },
      { name: "Doran", description: "broad", story: "" },
    ]);
    expect(added).toBe(2);
    expect(storyBoard(db, null).cast.map((c) => c.name)).toEqual(["Mira", "Doran"]);
  });

  it("caps at MAX_FOUND", () => {
    const db = freshRoom();
    const many = Array.from({ length: MAX_FOUND + 20 }, (_, i) => ({
      name: `Person ${i}`,
      description: "",
      story: "",
    }));
    expect(storyAddCastMany(db, many)).toBe(MAX_FOUND);
  });
});

// =========================================================== split

describe("storyPlanSplit", () => {
  it("is an honest NOT_IMPLEMENTED refusal, not a guessed re-implementation", () => {
    expect(() => storyPlanSplit("A script.", 5, 15)).toThrow(STORY_PLAN_SPLIT_NOT_IMPLEMENTED);
    expect(STORY_PLAN_SPLIT_NOT_IMPLEMENTED).toContain("shotsplit.rs");
  });
});

describe("snapSeconds", () => {
  it("passes its input through — the documented always-taken degradation", () => {
    // `media_limits.rs` is unported, so every model reads as "no duration
    // data", which is the branch Rust takes for an unrecognized model AND for
    // every model until the catalogue has been fetched once.
    expect(snapSeconds(10, "veo-3")).toBe(10);
    expect(snapSeconds(7, "")).toBe(7);
  });
});

describe("storyApplySplit", () => {
  it("assigns cast to each written shot and clamps the length", () => {
    const db = freshRoom();
    const list = storyCreateList(db, "Harbour", "");
    const mira = storyAddCast(db, "Mira Halloran", "grey coat", "");
    const doran = storyAddCast(db, "Doran", "broad", "");

    const shots: PlannedShot[] = [
      { action: "Mira walks the quay.", seconds: 15 },
      { action: "Doran watches.", seconds: 90 }, // clamped to 60
      { action: "She turns back.", seconds: 0 }, // clamped to 1, inherits Doran
    ];
    expect(storyApplySplit(db, list, shots, " img-model ", " vid-model ")).toBe(3);

    const board = storyBoard(db, list);
    expect(board.shots).toHaveLength(3);
    expect(board.shots.map((s) => s.seconds)).toEqual([15, 60, 1]);
    // Cast IDS, not names — the ids of the real cast rows.
    expect(board.shots[0]?.castIds).toEqual([mira.id]);
    expect(board.shots[1]?.castIds).toEqual([doran.id]);
    expect(board.shots[2]?.castIds, "inherits the shot before it").toEqual([doran.id]);
    // The models are trimmed on the way in, as `update_shot` does in Rust.
    expect(board.shots[0]?.imageModel).toBe("img-model");
    expect(board.shots[0]?.videoModel).toBe("vid-model");
  });

  it("APPENDS rather than replacing — paid work already in the list survives", () => {
    const db = freshRoom();
    const list = storyCreateList(db, "Harbour", "");
    storyAddShot(db, list, "already drawn");
    storyApplySplit(db, list, [planned("new one")], "", "");
    expect(storyBoard(db, list).shots.map((s) => s.action)).toEqual(["already drawn", "new one"]);
  });

  it("refuses a batch bigger than one room writes in one go", () => {
    const db = freshRoom();
    const list = storyCreateList(db, "Harbour", "");
    const many = Array.from({ length: 81 }, (_, i) => planned(`shot ${i}`));
    expect(() => storyApplySplit(db, list, many, "", "")).toThrow(/at most 80/);
    expect(storyBoard(db, list).shots).toEqual([]);
  });
});

// =========================================================== IPC (unwired)

describe("registerStoryIpc", () => {
  function fakeIpcMain() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    return {
      handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      }),
      handlers,
    };
  }

  it("registers every channel the pre-migration frontend calls", () => {
    const ipcMain = fakeIpcMain();
    const room: RoomSource = { currentRoom: () => null };
    registerStoryIpc(ipcMain, room);
    const expected = [
      "story_board",
      "story_pictures",
      "story_add_cast",
      "story_update_cast",
      "story_set_face",
      "story_remove_cast",
      "story_create_list",
      "story_update_list",
      "story_set_shape",
      "story_delete_list",
      "story_add_shot",
      "story_update_shot",
      "story_remove_shot",
      "story_reorder_shots",
      "story_documents",
      "story_text_from_file",
      "story_read_cast_file",
      "story_add_cast_many",
      "story_plan_split",
      "story_apply_split",
    ] as const satisfies readonly StoryChannel[];
    // A `story_*` channel the contract declares and this list omits is a
    // COMPILE error, so "registers every channel" cannot rot into "registers
    // every channel somebody remembered to add here".
    type _NoneMissing = MustBeNever<Exclude<StoryChannel, (typeof expected)[number]>>;
    for (const channel of expected) {
      expect(ipcMain.handlers.has(channel), channel).toBe(true);
    }
    expect(ipcMain.handlers.size).toBe(expected.length);
  });

  it("a channel called with no room open answers exactly what the shipped app says", () => {
    const ipcMain = fakeIpcMain();
    const room: RoomSource = { currentRoom: () => null };
    registerStoryIpc(ipcMain, room);
    const handler = ipcMain.handlers.get("story_add_cast")!;
    expect(() => handler({}, { name: "Mira", description: "", story: "" })).toThrow(
      "No room is open."
    );
  });

  it("a channel called with a room open forwards to the real command", () => {
    const db = freshRoom();
    const ipcMain = fakeIpcMain();
    const room: RoomSource = { currentRoom: () => ({ db, path: "irrelevant.roomai" }) };
    registerStoryIpc(ipcMain, room);
    const handler = ipcMain.handlers.get("story_add_cast")!;
    const created = handler({}, { name: "Mira", description: "tall", story: "" }) as CastMember;
    expect(created.name).toBe("Mira");
    expect(storyBoard(db, null).cast).toHaveLength(1);
  });
});
