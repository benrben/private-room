/**
 * Vitest port of `src-tauri/src/commands/studios/podcast_audio.rs`'s
 * `#[cfg(test)] mod tests` — every Rust test reproduced below:
 *
 *   - every_take_of_one_script_gets_its_own_name  -> nextTakeName
 *   - the_transcript_is_the_shape_the_player_already_parses -> timedTranscript
 *   - the_transcript_records_what_was_actually_spoken -> timedTranscript
 *   - a_truncated_episode_says_so_in_the_file_itself -> timedTranscript
 *   - a_missing_offset_drops_the_stamp_rather_than_inventing_one -> timedTranscript
 *   - swapping_two_hosts_names_keeps_both_speakers -> refoldSpeakers
 *   - a_plain_rename_still_carries_every_line -> refoldSpeakers
 *   - a_host_added_beyond_the_old_cast_renames_nobody -> refoldSpeakers
 *   - encoding_falls_back_to_wav_rather_than_losing_the_episode -> encodeEpisode
 *     (run against the REAL `/usr/bin/afconvert` on this Mac, exactly as the
 *     Rust test does — no mock)
 *
 * PLUS coverage this port adds for the Electron-specific plumbing the Rust
 * source reaches through `AppState`/`tauri::Window`, none of which the Rust
 * `#[cfg(test)]` module (no `AppState` there either) could exercise:
 *   - the privacy door (`speakableText`/`redactForSpeech`) against a real
 *     policy and a real fixture room's `web_provider` switch,
 *   - `renderPodcastAudio` end-to-end against a real fixture room and a real
 *     local `node:http` server standing in for the sidecar (the
 *     `sidecarJsonCancellable`-direct-call convention `storyTools.test.ts`
 *     and `sidecarJsonCancellable.test.ts` establish — `ensureUp` is the only
 *     mock), covering: the happy path, no script attached, an empty script,
 *     the room offline, a room-path mismatch, and a cancel flag already set,
 *   - `getPodcast`/`setPodcastCast`/`previewPodcastVoice` against a real room,
 *   - `registerStudiosPodcastAudioIpc`'s channel wiring,
 *   - `safeScopeName`'s own reserved-character/length/empty-fallback cases
 *     (uncovered directly in the Rust source, which has no `studios.rs` test
 *     for it either — `studios.rs` is not part of this batch).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { insertFile } from "./db-host/files.js";
import {
  castFromTurns,
  getPodcast as dbGetPodcast,
  savePodcast,
  setPodcastAudio as dbSetPodcastAudio,
  type PodcastHost,
  type PodcastTurn,
} from "./db-host/podcasts.js";
import { setSetting } from "./db-host/settings.js";
import { CancelFlag } from "./cancel.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import { mediaKind } from "./peaksTools.js";
import {
  clearPolicy,
  setActivePolicyForTests,
  setPolicyRulesForTests,
} from "./privacy.js";

vi.mock("./sidecar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sidecar.js")>();
  return { ...actual, ensureUp: vi.fn(actual.ensureUp) };
});

import { ensureUp } from "./sidecar.js";
import {
  encodeEpisode,
  getPodcast,
  MAX_PODCAST_TURNS,
  MAX_SPEAK_CHARS,
  nextTakeName,
  NULL_STUDIO_STEP_SINK,
  previewPodcastVoice,
  redactForSpeech,
  refoldSpeakers,
  registerStudiosPodcastAudioIpc,
  renderPodcastAudio,
  safeScopeName,
  setPodcastCast,
  SPEECH_OFFLINE_MESSAGE,
  speakableText,
  timedTranscript,
  type StudioStepSink,
} from "./studiosPodcastAudio.js";

let tmpDir: string;
let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  clearPolicy();
  vi.mocked(ensureUp).mockReset();
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "studios-podcast-audio-"));
  const roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  openDb = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return openDb;
}

function fakeRooms(handle: RoomHandle | null): { rooms: RoomSource; set(h: RoomHandle | null): void } {
  let current = handle;
  return {
    rooms: { current: () => current },
    set(h) {
      current = h;
    },
  };
}

function turn(speaker: string, line: string): PodcastTurn {
  return { speaker, line };
}

function host(name: string): PodcastHost {
  return { name, voice: "", rate: "", pitch: "" };
}

function collectingSink(): {
  sink: StudioStepSink;
  steps: Array<{ step: string; local: boolean }>;
  reloads: () => number;
} {
  const steps: Array<{ step: string; local: boolean }> = [];
  let reloads = 0;
  return {
    sink: {
      emit: (p) => steps.push(p),
      filesChanged: () => {
        reloads += 1;
      },
    },
    steps,
    reloads: () => reloads,
  };
}

// ==================================================== next_take_name

describe("nextTakeName", () => {
  it("every take of one script gets its own name", () => {
    const db = freshRoom();
    expect(nextTakeName(db, "Ep", "m4a")).toBe("Ep - episode.m4a");
    insertFile(db, "Ep - episode.m4a", "audio/mp4", Buffer.from([0]), null, "generated");
    expect(nextTakeName(db, "Ep", "m4a")).toBe("Ep - episode 2.m4a");
    insertFile(db, "Ep - episode 2.m4a", "audio/mp4", Buffer.from([0]), null, "generated");
    expect(nextTakeName(db, "Ep", "m4a")).toBe("Ep - episode 3.m4a");
    // A different script is unaffected — the name is per title.
    expect(nextTakeName(db, "Other", "m4a")).toBe("Other - episode.m4a");
  });
});

// ==================================================== timed_transcript

describe("timedTranscript", () => {
  it("is the shape the player already parses", () => {
    const turns = [turn("Ada", "Welcome in."), turn("Bo", "Glad to be here.")];
    const spoken = turns.map((t) => t.line);
    const out = timedTranscript("Ep 1", turns, spoken, [0, 65_400], 0);
    expect(out).toContain("[0:00] Ada: Welcome in.");
    expect(out).toContain("[1:05] Bo: Glad to be here.");
    expect(out.startsWith('Podcast episode "Ep 1"')).toBe(true);
    expect(out).toContain("Not a recording of people.");
  });

  it("records what was actually spoken, not the unredacted script", () => {
    // With the privacy door on, the line that LEFT is the redacted one. A
    // transcript of the original beside audio of the placeholder would be the
    // app disagreeing with itself about what left this Mac.
    const spoken = ["Person A signed it.", "Yes."];
    const turns = [turn("Ada", "Dana Cohen signed it."), turn("Bo", "Yes.")];
    const out = timedTranscript("Ep", turns, spoken, [0, 1000], 0);
    expect(out).toContain("Person A signed it.");
    expect(out).not.toContain("Dana Cohen");
  });

  it("a truncated episode says so in the file itself", () => {
    const turns = [turn("Ada", "Welcome in."), turn("Bo", "Glad to be here.")];
    const spoken = turns.map((t) => t.line);
    const out = timedTranscript("Ep", turns, spoken, [0, 500], 7);
    expect(out).toContain("7 more were not");
  });

  it("a missing offset drops the stamp rather than inventing one", () => {
    // Stamping an unknown row at 0:00 would send every click to the start of
    // the episode and look like a broken player.
    const turns = [turn("Ada", "Welcome in."), turn("Bo", "Glad to be here.")];
    const spoken = turns.map((t) => t.line);
    const out = timedTranscript("Ep", turns, spoken, [0], 0);
    expect(out).toContain("[0:00] Ada:");
    expect(out).toContain("\nBo: Glad to be here.");
  });
});

// ==================================================== refold_speakers

describe("refoldSpeakers", () => {
  it("swapping two hosts' names keeps both speakers", () => {
    // Rewriting the turns once per host let host 1's rule fire on the name
    // host 0 had just written: every line ended up on one speaker.
    const oldCast = [host("Ada"), host("Bo")];
    const newCast = [host("Bo"), host("Ada")];
    const turns = [turn("Ada", "One."), turn("Bo", "Two."), turn("Ada", "Three.")];
    const out = refoldSpeakers(oldCast, newCast, turns);
    expect(out.map((t) => t.speaker)).toEqual(["Bo", "Ada", "Bo"]);
  });

  it("a plain rename still carries every line", () => {
    const oldCast = [host("Ada"), host("Bo")];
    const newCast = [host("Ada Lovelace"), host("Bo")];
    const turns = [turn("ada", "One."), turn("Cy", "Two.")];
    const out = refoldSpeakers(oldCast, newCast, turns);
    // Case-insensitive as before, and a speaker who is in no cast row keeps
    // the name the script gave them.
    expect(out[0]?.speaker).toBe("Ada Lovelace");
    expect(out[1]?.speaker).toBe("Cy");
    expect(out[1]?.line).toBe("Two.");
  });

  it("a host added beyond the old cast renames nobody", () => {
    const oldCast = [host("Ada")];
    const newCast = [host("Ada"), host("Bo")];
    const turns = [turn("Bo", "Hi.")];
    const out = refoldSpeakers(oldCast, newCast, turns);
    expect(out[0]?.speaker).toBe("Bo");
    expect(refoldSpeakers(oldCast, newCast, [])).toEqual([]);
  });
});

// ==================================================== encode_episode

describe("encodeEpisode", () => {
  it("falls back to wav rather than losing the episode", async () => {
    // Real afconvert on a real WAV: the happy path on any Mac. The assertion
    // is deliberately about the CONTRACT — bytes plus a mime and extension
    // that agree — because a machine without the AAC encoder must still get a
    // playable file, just a bigger one.
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + 2000, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(24_000, 24);
    header.writeUInt32LE(48_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(2000, 40);
    const wav = Buffer.concat([header, Buffer.alloc(2000)]);

    const { bytes, mime, ext } = await encodeEpisode(wav);
    expect(bytes.length).toBeGreaterThan(0);
    expect(
      (mime === "audio/mp4" && ext === "m4a") || (mime === "audio/wav" && ext === "wav"),
      `mime and extension must agree: ${mime} / ${ext}`
    ).toBe(true);
    // Whichever it is, the room's own kind detection has to route it to the
    // audio player — a file the viewer cannot open is not an episode.
    expect(mediaKind(mime, ext)).toBe("audio");
  });
});

// ==================================================== safeScopeName

describe("safeScopeName", () => {
  it("folds reserved filesystem characters to spaces", () => {
    expect(safeScopeName('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
  });

  it("caps at 60 code points and falls back to room when empty", () => {
    expect(safeScopeName("")).toBe("room");
    expect(safeScopeName("   ")).toBe("room");
    expect(safeScopeName("a".repeat(100))).toBe("a".repeat(60));
  });
});

// ==================================================== the privacy door

describe("speakableText / redactForSpeech", () => {
  it("refuses when the room's internet switch is off", () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "off");
    expect(() => speakableText(db, "hello")).toThrow(SPEECH_OFFLINE_MESSAGE);
  });

  it("passes an online room's text through the redactor", () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    setPolicyRulesForTests(true, [["Dana Cohen", "[Person A]"]]);
    expect(speakableText(db, "Dana Cohen signed it.")).toBe("[Person A] signed it.");
  });

  it("an old room whose provider predates the switch (any non-off value) still counts as online", () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "brave");
    setActivePolicyForTests();
    expect(() => speakableText(db, "hello")).not.toThrow();
  });

  it("redactForSpeech travels the text unchanged when there is no entity map", () => {
    clearPolicy();
    expect(redactForSpeech("Ben Reich called")).toBe("Ben Reich called");
  });
});

// ==================================================== speakOne / previewPodcastVoice

describe("previewPodcastVoice", () => {
  it("rejects empty and oversize text before ever reaching the sidecar", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    await expect(previewPodcastVoice(db, "   ")).rejects.toThrow("nothing to speak");
    await expect(previewPodcastVoice(db, "a".repeat(MAX_SPEAK_CHARS + 1))).rejects.toThrow(
      "text too long to speak in one chunk"
    );
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("refuses when the room is offline, before any network call", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "off");
    await expect(previewPodcastVoice(db, "hello")).rejects.toThrow(SPEECH_OFFLINE_MESSAGE);
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("reads through the sidecar for real, sending only the redacted sentence", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    setPolicyRulesForTests(true, [["Dana Cohen", "[Person A]"]]);

    let bodySeen: unknown = null;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        bodySeen = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ audio_b64: "aGVsbG8=" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      const result = await previewPodcastVoice(db, "Dana Cohen signed it.", "en-US-AndrewMultilingualNeural");
      expect(result).toBe("aGVsbG8=");
      expect(bodySeen).toEqual({ text: "[Person A] signed it.", voice: "en-US-AndrewMultilingualNeural" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ==================================================== getPodcast / setPodcastCast

describe("getPodcast / setPodcastCast", () => {
  it("reads through to the db-host layer", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const turns = [turn("Ada", "Hi.")];
    savePodcast(db, file.id, "Ep", turns, castFromTurns(turns, []));
    expect(getPodcast(db, file.id)?.title).toBe("Ep");
    expect(getPodcast(db, "missing")).toBeNull();
  });

  it("refuses a file with no podcast script attached", () => {
    const db = freshRoom();
    const file = insertFile(db, "not-a-script.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    expect(() => setPodcastCast(db, file.id, [host("Ada")])).toThrow(
      "This file has no podcast script attached."
    );
  });

  it("refuses a host with no name", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const turns = [turn("Ada", "Hi.")];
    savePodcast(db, file.id, "Ep", turns, castFromTurns(turns, []));
    expect(() => setPodcastCast(db, file.id, [host("  ")])).toThrow("Every host needs a name.");
  });

  it("refuses two hosts sharing a name", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const turns = [turn("Ada", "Hi."), turn("Bo", "Yo.")];
    savePodcast(db, file.id, "Ep", turns, castFromTurns(turns, []));
    expect(() => setPodcastCast(db, file.id, [host("Ada"), host("ADA")])).toThrow(
      "Two hosts can't share a name"
    );
  });

  it("re-casting folds turns onto the new spelling and keeps the rendered audio linked", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const turns = [turn("Ada", "Hi."), turn("Bo", "Yo.")];
    const cast = castFromTurns(turns, ["v1", "v2"]);
    savePodcast(db, file.id, "Ep", turns, cast);
    const audio = insertFile(db, "ep.m4a", "audio/mp4", Buffer.from([0]), null, "generated");
    // Link an already-rendered episode the way `render_podcast_audio` would.
    const before = getPodcast(db, file.id);
    expect(before).not.toBeNull();
    savePodcast(db, file.id, "Ep", turns, cast); // no-op re-save, still no audio yet
    // Simulate a previously rendered episode via the db layer directly.
    dbSetPodcastAudio(db, file.id, audio.id);

    const recast = [host("Ada Lovelace"), host("Bo")];
    const updated = setPodcastCast(db, file.id, recast);
    expect(updated.turns.map((t) => t.speaker)).toEqual(["Ada Lovelace", "Bo"]);
    expect(updated.audioFileId).toBe(audio.id);
  });
});

// ==================================================== renderPodcastAudio

describe("renderPodcastAudio", () => {
  function ttsPodcastServer(handler: (body: unknown) => { status: number; json: unknown }) {
    return http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body: unknown = JSON.parse(raw);
        const { status, json } = handler(body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
  }

  async function withServer<T>(
    handler: (body: unknown) => { status: number; json: unknown },
    run: () => Promise<T>
  ): Promise<T> {
    const server = ttsPodcastServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      return await run();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function tinyWavB64(): string {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24_000, 24);
    header.writeUInt32LE(48_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(0, 40);
    return header.toString("base64");
  }

  function makeScript(db: Database.Database, title: string, turns: PodcastTurn[]): string {
    const file = insertFile(db, `${title}.html`, "text/html", Buffer.from("<p>script</p>"), null, "generated");
    savePodcast(db, file.id, title, turns, castFromTurns(turns, ["v1", "v2"]));
    return file.id;
  }

  it("records an episode end to end: privacy door, synthesis, encoding, transcript, save, and link", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    setPolicyRulesForTests(true, [["Dana Cohen", "[Person A]"]]);
    const fileId = makeScript(db, "Ep 1", [turn("Ada", "Dana Cohen signed it."), turn("Bo", "Yes.")]);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, steps, reloads } = collectingSink();

    let sentTurns: unknown = null;
    const meta = await withServer(
      (body) => {
        sentTurns = (body as { turns: unknown }).turns;
        return {
          status: 200,
          json: { audio_b64: tinyWavB64(), offsets_ms: [0, 1200], duration_ms: 1400 },
        };
      },
      () => renderPodcastAudio(rooms, fileId, new CancelFlag(), "room-a", sink)
    );

    // The redacted text is what was SENT, never the real name.
    expect(sentTurns).toEqual([
      { text: "[Person A] signed it.", voice: "v1", rate: "", pitch: "" },
      { text: "Yes.", voice: "v2", rate: "", pitch: "" },
    ]);
    // Real `afconvert` on this Mac normally succeeds (m4a); a machine without
    // the AAC encoder still gets a playable file, just bigger (wav) — the
    // same either-outcome contract `encodeEpisode`'s own test asserts.
    expect(["Ep 1 - episode.m4a", "Ep 1 - episode.wav"]).toContain(meta.name);
    expect(["audio/mp4", "audio/wav"]).toContain(meta.mimeType);
    expect(meta.name.endsWith(".m4a")).toBe(meta.mimeType === "audio/mp4");
    // Progress was reported, and named the seam correctly (network vs local).
    expect(steps[0]?.local).toBe(false);
    expect(steps[1]?.local).toBe(true);
    // …and the Files list was told to reload, or the episode is in the room
    // but invisible until the user navigates away and back.
    expect(reloads()).toBe(1);
    // Linked back to the script.
    const podcast = dbGetPodcast(db, fileId);
    expect(podcast?.audioFileId).toBe(meta.id);
    // The transcript is redacted, never the raw name.
    const saved = db
      .prepare("SELECT extracted_text FROM files WHERE id = ?")
      .get(meta.id) as { extracted_text: string };
    expect(saved.extracted_text).toContain("[Person A] signed it.");
    expect(saved.extracted_text).not.toContain("Dana Cohen");
  });

  it("refuses a file with no podcast script attached", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const file = insertFile(db, "not-a-script.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const { rooms } = fakeRooms({ db, path: "room-a" });
    await expect(renderPodcastAudio(rooms, file.id, new CancelFlag(), "room-a")).rejects.toThrow(
      "This file has no podcast script attached."
    );
  });

  it("refuses a script with no lines to read", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const fileId = makeScript(db, "Empty", []);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    await expect(renderPodcastAudio(rooms, fileId, new CancelFlag(), "room-a")).rejects.toThrow(
      "This script has no lines to read."
    );
  });

  it("refuses when the room is offline, before any network call", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "off");
    const fileId = makeScript(db, "Ep", [turn("Ada", "Hi.")]);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    await expect(renderPodcastAudio(rooms, fileId, new CancelFlag(), "room-a")).rejects.toThrow(
      SPEECH_OFFLINE_MESSAGE
    );
    expect(ensureUp).not.toHaveBeenCalled();
  });

  it("refuses when the room this job belongs to was closed", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const fileId = makeScript(db, "Ep", [turn("Ada", "Hi.")]);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    await expect(renderPodcastAudio(rooms, fileId, new CancelFlag(), "room-b")).rejects.toThrow(
      "the room this job belongs to was closed"
    );
  });

  it("a cancel flag already set stops before the write, and nothing is saved", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const fileId = makeScript(db, "Ep", [turn("Ada", "Hi.")]);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const cancel = new CancelFlag();
    cancel.store(true);
    await expect(renderPodcastAudio(rooms, fileId, cancel, "room-a")).rejects.toThrow(
      "Stopped — the podcast recording was not saved."
    );
    expect(ensureUp).not.toHaveBeenCalled();
    expect(dbGetPodcast(db, fileId)?.audioFileId ?? null).toBeNull();
  });

  it("truncates a runaway script at MAX_PODCAST_TURNS and says so in the transcript", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const bigTurns = Array.from({ length: MAX_PODCAST_TURNS + 5 }, (_, i) => turn("Ada", `line ${i}`));
    const fileId = makeScript(db, "Long", bigTurns);
    const { rooms } = fakeRooms({ db, path: "room-a" });

    let turnsSent = 0;
    const meta = await withServer(
      (body) => {
        const t = (body as { turns: unknown[] }).turns;
        turnsSent = t.length;
        const offsets = t.map((_, i) => i * 100);
        return { status: 200, json: { audio_b64: tinyWavB64(), offsets_ms: offsets, duration_ms: 0 } };
      },
      () => renderPodcastAudio(rooms, fileId, new CancelFlag(), "room-a", NULL_STUDIO_STEP_SINK)
    );

    expect(turnsSent).toBe(MAX_PODCAST_TURNS);
    const saved = db
      .prepare("SELECT extracted_text FROM files WHERE id = ?")
      .get(meta.id) as { extracted_text: string };
    expect(saved.extracted_text).toContain("5 more were not");
  });

  it("a sidecar failure surfaces as a real, specific error", async () => {
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const fileId = makeScript(db, "Ep", [turn("Ada", "Hi.")]);
    const { rooms } = fakeRooms({ db, path: "room-a" });

    await withServer(
      () => ({ status: 502, json: { code: "TTS_UNAVAILABLE", error: "the voice service is offline" } }),
      async () => {
        await expect(renderPodcastAudio(rooms, fileId, new CancelFlag(), "room-a")).rejects.toThrow(
          "the voice service is offline"
        );
      }
    );
  });
});

// ==================================================== IPC wiring

// `storyTools.test.ts`'s established `fakeIpcMain` shape: `(...args: unknown[])
// => unknown` handlers, which structurally satisfies `Pick<IpcMain, "handle">`.
function fakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    handlers,
  };
}

describe("registerStudiosPodcastAudioIpc", () => {
  it("registers get_podcast, set_podcast_cast and preview_podcast_voice", () => {
    const db = freshRoom();
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>x</p>"), null, "generated");
    const turns = [turn("Ada", "Hi.")];
    savePodcast(db, file.id, "Ep", turns, castFromTurns(turns, []));
    const { rooms } = fakeRooms({ db, path: "room-a" });

    const ipcMain = fakeIpcMain();
    registerStudiosPodcastAudioIpc(ipcMain, rooms);

    expect(new Set(ipcMain.handlers.keys())).toEqual(
      new Set(["get_podcast", "set_podcast_cast", "preview_podcast_voice"])
    );
    const result = ipcMain.handlers.get("get_podcast")?.({}, { fileId: file.id }) as ReturnType<typeof getPodcast>;
    expect(result?.title).toBe("Ep");
  });

  it("throws 'No room is open.' when nothing is open", () => {
    const { rooms } = fakeRooms(null);
    const ipcMain = fakeIpcMain();
    registerStudiosPodcastAudioIpc(ipcMain, rooms);
    expect(() => ipcMain.handlers.get("get_podcast")?.({}, { fileId: "x" })).toThrow("No room is open.");
  });
});

// ============================================================================
// the room-files-changed signal, and the duplicate-host refusal — two defects
// an audit of this batch found (2026-08-23)
// ============================================================================

describe("render_podcast_audio's own window.emit calls", () => {
  // Local copies of the two helpers the `renderPodcastAudio` block above keeps
  // private to itself: a real local sidecar and a 44-byte WAV header.
  function tinyWavB64(): string {
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24_000, 24);
    header.writeUInt32LE(48_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(0, 40);
    return header.toString("base64");
  }

  async function withServer<T>(json: unknown, run: () => Promise<T>): Promise<T> {
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    vi.mocked(ensureUp).mockResolvedValue(`http://127.0.0.1:${port}`);
    try {
      return await run();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("signals room-files-changed exactly once, AFTER the episode is linked to its script", async () => {
    // Rust's last line before `Ok(meta)`. This port originally had no such
    // seam at all: the file landed and the Library never reloaded.
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const turns = [turn("Ada", "Hi.")];
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>s</p>"), null, "generated");
    savePodcast(db, file.id, "Ep", turns, castFromTurns(turns, ["v1"]));
    const { rooms } = fakeRooms({ db, path: "room-a" });

    const order: string[] = [];
    const sink: StudioStepSink = {
      emit: (p) => order.push(`step:${p.step}`),
      filesChanged: () => {
        // The link must already be written when the list is told to reload,
        // or the panel re-reads a script that still says "not recorded".
        order.push(`reload:${dbGetPodcast(db, file.id)?.audioFileId ?? "unlinked"}`);
      },
    };
    const meta = await withServer({ audio_b64: tinyWavB64(), offsets_ms: [0] }, () =>
      renderPodcastAudio(rooms, file.id, new CancelFlag(), "room-a", sink)
    );
    expect(order.filter((e) => e.startsWith("reload:"))).toEqual([`reload:${meta.id}`]);
  });

  it("a throwing sink never turns a saved episode into a failed render", async () => {
    // `let _ = window.emit(...)` — best-effort, exactly like the sibling
    // studio save path's `emitSafely`.
    const db = freshRoom();
    setSetting(db, "web_provider", "duckduckgo");
    const turns = [turn("Ada", "Hi.")];
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>s</p>"), null, "generated");
    savePodcast(db, file.id, "Ep", turns, castFromTurns(turns, ["v1"]));
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const sink: StudioStepSink = {
      emit: () => {},
      filesChanged: () => {
        throw new Error("the window went away");
      },
    };
    const meta = await withServer({ audio_b64: tinyWavB64(), offsets_ms: [0] }, () =>
      renderPodcastAudio(rooms, file.id, new CancelFlag(), "room-a", sink)
    );
    expect(dbGetPodcast(db, file.id)?.audioFileId).toBe(meta.id);
  });
});

describe("setPodcastCast: the duplicate-name refusal trims BOTH sides", () => {
  it("refuses two hosts whose names differ only by surrounding whitespace", () => {
    // Rust compares `e.name.trim()` with `h.name.trim()`. Trimming only the
    // right-hand side let "Ada " and "Ada" through as two hosts — and
    // `renderPodcastAudio` joins a line to a voice with
    // `eqIgnoreAsciiCase(h.name, t.speaker.trim())`, which "Ada " can never
    // satisfy. The padded host would be silent and the other would read the
    // whole episode: the one-narrator outcome this check exists to refuse.
    const db = freshRoom();
    const turns = [turn("Ada", "Hi.")];
    const file = insertFile(db, "ep.html", "text/html", Buffer.from("<p>s</p>"), null, "generated");
    savePodcast(db, file.id, "Ep", turns, castFromTurns(turns, ["v1"]));
    for (const pair of [
      ["Ada ", "Ada"],
      ["Ada", " Ada"],
      ["  ADA  ", "ada"],
    ] as const) {
      expect(() =>
        setPodcastCast(db, file.id, [
          { name: pair[0], voice: "v1", rate: "", pitch: "" },
          { name: pair[1], voice: "v2", rate: "", pitch: "" },
        ])
      ).toThrow("Two hosts can't share a name — the lines are matched by name.");
    }
    // Two genuinely different hosts still go through.
    expect(
      setPodcastCast(db, file.id, [
        { name: "Ada ", voice: "v1", rate: "", pitch: "" },
        { name: "Bo", voice: "v2", rate: "", pitch: "" },
      ]).cast.map((h) => h.name)
    ).toEqual(["Ada ", "Bo"]);
  });
});

describe("safeScopeName is studiosCmds.ts's, not a second copy", () => {
  it("re-exports the shared implementation — podcast_audio.rs reads it from studios.rs via `use super::*`", async () => {
    const shared = await import("./studiosCmds.js");
    expect(safeScopeName).toBe(shared.safeScopeName);
  });
});
