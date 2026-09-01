/**
 * Vitest port of `src-tauri/src/db/podcasts.rs`'s `#[cfg(test)] mod tests` —
 * every Rust test reproduced below, plus one bonus case
 * (`eq_ignore_ascii_case is ASCII-only, not full Unicode folding`) proving a
 * fidelity point this port had to get right by hand (JS's `.toLowerCase()`
 * folds far more than Rust's `str::eq_ignore_ascii_case` does).
 *
 * REAL FIXTURE ROOMS: every test opens a real `.roomai` file through
 * `createRoom` (better-sqlite3-multiple-ciphers), matching `files.test.ts`'s
 * established convention — no bare mocks, and the REAL `insertFile` builds
 * every fixture.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { deleteFile, insertFile } from "./files.js";
import {
  castFromTurns,
  getPodcast,
  normalizeTurnSpeakers,
  savePodcast,
  setPodcastAudio,
  setPodcastCast,
  stripSpeakerLabel,
  type PodcastHost,
  type PodcastTurn,
} from "./podcasts.js";

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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-podcasts-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  openDb = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return openDb;
}

function turn(speaker: string, line: string): PodcastTurn {
  return { speaker, line };
}

function host(name: string): PodcastHost {
  return { name, voice: "", rate: "", pitch: "" };
}

// =========================================================== cast_from_turns

describe("castFromTurns", () => {
  it("has one host per speaker however it was spelled", () => {
    const turns = [turn("Ada", "Welcome in."), turn("Bo", "Glad to be here."), turn("ada ", "Let's start.")];
    const cast = castFromTurns(turns, ["v1", "v2", "v3"]);
    expect(cast).toHaveLength(2);
    expect(cast.map((h) => h.name)).toEqual(["Ada", "Bo"]);
  });

  it("never lets two hosts share a voice", () => {
    // Two hosts in one voice is not a two-voice podcast — it is one narrator
    // reading a dialogue, which is the thing this feature exists to stop.
    const turns = [turn("Ada", "a"), turn("Bo", "b"), turn("Cy", "c")];
    const cast = castFromTurns(turns, ["v1", "v2", "v3"]);
    expect(cast.map((h) => h.voice)).toEqual(["v1", "v2", "v3"]);
  });

  it("an empty catalog still produces an editable cast", () => {
    // Offline on first open: the hosts exist with the product-default voice,
    // so the panel has rows the user can change rather than nothing.
    const turns = [turn("Ada", "a"), turn("Bo", "b")];
    const cast = castFromTurns(turns, []);
    expect(cast).toHaveLength(2);
    expect(cast.every((h) => h.voice === "")).toBe(true);
  });

  it("ignores a turn whose speaker is only whitespace", () => {
    expect(castFromTurns([turn("   ", "stage direction"), turn("Ada", "hello")], ["v1"])).toEqual([
      { name: "Ada", voice: "v1", rate: "", pitch: "" },
    ]);
  });
});

// ======================================================= normalize_turn_speakers

describe("normalizeTurnSpeakers", () => {
  it("folds every line's speaker onto the cast's own spelling", () => {
    // The join key. Left unfolded, "ada" gets the default voice while the
    // panel shows Ada assigned to a chosen one.
    const turns = [turn("ada", "a"), turn("BO", "b"), turn("Ada", "c")];
    const cast = castFromTurns(turns, ["v1", "v2"]);
    normalizeTurnSpeakers(turns, cast);
    expect(turns.map((t) => t.speaker)).toEqual(["ada", "BO", "ada"]);
  });
});

// ===================================================== round trip through a room

describe("getPodcast / savePodcast / setPodcastCast / setPodcastAudio", () => {
  it("a script round-trips through the room", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const turns = [turn("Ada", "Welcome."), turn("Bo", "Hello.")];
    const cast = castFromTurns(turns, ["v1", "v2"]);
    savePodcast(db, file.id, "Episode 1", turns, cast);

    const got = getPodcast(db, file.id);
    expect(got?.title).toBe("Episode 1");
    expect(got?.turns).toEqual(turns);
    expect(got?.cast).toEqual(cast);
    expect(got?.audioFileId).toBeNull();

    // Re-casting keeps the rendered audio linked — the old episode is a real
    // file the user may still be playing.
    const audio = insertFile(db, "ep.m4a", "audio/mp4", Buffer.from([0]), null, "generated");
    setPodcastAudio(db, file.id, audio.id);
    const recast = cast.map((h, i) => (i === 0 ? { ...h, voice: "other" } : h));
    setPodcastCast(db, file.id, recast);
    const after = getPodcast(db, file.id);
    expect(after?.cast[0]?.voice).toBe("other");
    expect(after?.audioFileId).toBe(audio.id);
  });

  it("a file that is not a podcast reads as null, not an error", () => {
    const db = freshRoom();
    expect(getPodcast(db, "no-such-file")).toBeNull();
  });

  it("treats an unreadable or malformed stored cast as empty", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    savePodcast(db, file.id, "Episode 1", [turn("Ada", "Welcome.")], [host("Ada")]);

    const replaceCast = (json: string): void => {
      db.prepare("UPDATE podcasts SET cast_json = ? WHERE file_id = ?").run(json, file.id);
    };
    replaceCast("not json");
    expect(getPodcast(db, file.id)?.cast).toEqual([]);
    replaceCast("{}");
    expect(getPodcast(db, file.id)?.cast).toEqual([]);
    replaceCast('[{"name":"Ada","voice":9,"rate":false,"pitch":null}]');
    expect(getPodcast(db, file.id)?.cast).toEqual([host("Ada")]);
    replaceCast('[{"name":9}]');
    expect(getPodcast(db, file.id)?.cast).toEqual([]);
    replaceCast("[null]");
    expect(getPodcast(db, file.id)?.cast).toEqual([]);

    const replaceTurns = (json: string): void => {
      db.prepare("UPDATE podcasts SET turns = ? WHERE file_id = ?").run(json, file.id);
    };
    replaceTurns("not json");
    expect(getPodcast(db, file.id)?.turns).toEqual([]);
    replaceTurns('[{"speaker":9,"line":"Welcome."}]');
    expect(getPodcast(db, file.id)?.turns).toEqual([]);
    replaceTurns("[null]");
    expect(getPodcast(db, file.id)?.turns).toEqual([]);
  });

  it("trashing the script for good takes its podcast row (ON DELETE CASCADE)", () => {
    // A destroyed script must not leave a row pointing at a file id that no
    // longer resolves.
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    savePodcast(db, file.id, "t", [turn("A", "x")], []);
    deleteFile(db, file.id);
    expect(getPodcast(db, file.id)).toBeNull();
  });
});

// =================================================== strip_speaker_label

describe("stripSpeakerLabel", () => {
  it("a host does not read their own name aloud", () => {
    // The reported bug: the model states the name as the field AND again
    // inside the text, so the voice service would be handed "Alex: welcome in".
    expect(stripSpeakerLabel("Alex: welcome in", "Alex")).toBe("welcome in");
    expect(stripSpeakerLabel("ALEX:  welcome in", "Alex")).toBe("welcome in");
    expect(stripSpeakerLabel("**Jordan:** sure", "Jordan")).toBe("sure");
    expect(stripSpeakerLabel("[Jordan]: sure", "Jordan")).toBe("sure");
    // "Ada Lovelace" labelled as "Ada:" — the first word still matches.
    expect(stripSpeakerLabel("Ada: hello", "Ada Lovelace")).toBe("hello");
    // Doubled, which a re-generated script really does produce.
    expect(stripSpeakerLabel("Alex: Alex: hi", "Alex")).toBe("hi");
    // Already clean: unchanged, so the strip is safe to run on every read.
    expect(stripSpeakerLabel("welcome in", "Alex")).toBe("welcome in");
  });

  it("an ordinary sentence containing a colon survives", () => {
    // THE RISK THIS FIX INTRODUCES: "cut at the first colon" would eat the
    // start of real sentences. Only a prefix that IS this speaker's name may go.
    expect(stripSpeakerLabel("Here's the thing: it works", "Alex")).toBe("Here's the thing: it works");
    // Another host's name is left alone — a mislabelled turn, and guessing at
    // it would rewrite what the script says.
    expect(stripSpeakerLabel("Jordan: no", "Alex")).toBe("Jordan: no");
    expect(stripSpeakerLabel(": body", "Alex")).toBe(": body");
    expect(stripSpeakerLabel("Alex: body", "")).toBe("Alex: body");
    // A colon far into prose is prose, not a label.
    const long = "One thing I keep coming back to about all of this is: it works";
    expect(stripSpeakerLabel(long, "Alex")).toBe(long);
    // A line that is ONLY a label strips to empty; callers decide.
    expect(stripSpeakerLabel("Alex:", "Alex")).toBe("");
  });

  it("a script stored before the strip existed is fixed when it is read", () => {
    // No migration: the rows already in people's rooms are cleaned where they
    // are read, so re-recording an old episode stops speaking names.
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const dirty = [turn("Alex", "Alex: welcome in"), turn("Jordan", "Jordan: glad to be here")];
    const cast = castFromTurns(dirty, ["v1", "v2"]);
    savePodcast(db, file.id, "Episode 1", dirty, cast);

    const got = getPodcast(db, file.id);
    expect(got?.turns.map((t) => t.line)).toEqual(["welcome in", "glad to be here"]);
    // The speakers themselves are untouched — they are the join key.
    expect(got?.turns[0]?.speaker).toBe("Alex");
  });

  it("eq_ignore_ascii_case is ASCII-only, not full Unicode folding", () => {
    // Rust's `eq_ignore_ascii_case` leaves non-ASCII characters untouched, so
    // "Ünal" and "ünal" are DIFFERENT speakers — a naive `.toLowerCase()` port
    // would fold them together and misattribute the line's voice.
    expect(stripSpeakerLabel("Ünal: hi", "ünal")).toBe("Ünal: hi");
    expect(stripSpeakerLabel("Ünal: hi", "Ünal")).toBe("hi");
  });
});
