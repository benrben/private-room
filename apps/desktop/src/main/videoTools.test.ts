/**
 * Tests for `videoTools.ts` — `commands/video.rs`'s `probe_video_meta`/
 * `video_trim`/`save_video_frame` port: the pure helpers (side-by-side ports
 * of the Rust source's own `mod tests`), the REAL `/usr/bin/avconvert`
 * subprocess cut (against a real system fixture, skipped rather than faked
 * when the binary or the fixture source is absent — `textUtil.test.ts`'s own
 * convention for its real `/usr/bin/textutil` tests), the REAL default probe
 * seam (`mediaProbe.ts`'s ffprobe engine), and the end-to-end commands against a REAL
 * fixture room via `db-host/open.ts`'s `createRoom` (`previewTools.test.ts`/
 * `peaksTools.test.ts`'s established convention).
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { getMediaMeta, insertFile, setMediaMeta } from "./db-host/files.js";
import { findFfprobe } from "./mediaProbe.js";
import {
  describeConvertError,
  frameName,
  JobMeta,
  MIN_TRIM_SECS,
  probeVideoMeta,
  probeVideoWithFfprobe,
  registerVideoIpc,
  runAvconvert,
  saveVideoFrame,
  splitName,
  stampForName,
  trimmedName,
  validateSpan,
  videoTrim,
  type ProbeVideoFn,
  type RoomSource,
} from "./videoTools.js";
import type { MediaMeta } from "../shared/apiTypes.js";

// ============================================================================
// pure helpers — side-by-side ports of video.rs's own #[cfg(test)] mod tests
// ============================================================================

describe("validateSpan", () => {
  it("a span outside the video is refused and an overrun tail is clamped", () => {
    expect(validateSpan(1.0, 4.0, 10.0)).toEqual([1.0, 4.0]);
    // Dragging the out-point past the end is unambiguous: clamp it.
    expect(validateSpan(1.0, 99.0, 10.0)).toEqual([1.0, 10.0]);
    expect(() => validateSpan(-1.0, 4.0, 10.0)).toThrow(); // negative start
    expect(() => validateSpan(4.0, 4.0, 10.0)).toThrow(); // zero-length span
    expect(() => validateSpan(4.0, 3.0, 10.0)).toThrow(); // inverted span
    expect(() => validateSpan(4.0, 4.05, 10.0)).toThrow(); // sub-frame span
    expect(() => validateSpan(20.0, 25.0, 10.0)).toThrow(); // starts past the end
    expect(() => validateSpan(Number.NaN, 4.0, 10.0)).toThrow();
    expect(() => validateSpan(0.0, Number.POSITIVE_INFINITY, 10.0)).toThrow();
  });

  it("an unknown duration removes the upper bound rather than blocking the cut", () => {
    expect(validateSpan(1.0, 4.0, null)).toEqual([1.0, 4.0]);
    expect(validateSpan(500.0, 600.0, null)).toEqual([500.0, 600.0]);
    // The lower bounds still apply — they don't depend on the duration.
    expect(() => validateSpan(-1.0, 4.0, null)).toThrow();
    expect(() => validateSpan(4.0, 4.0, null)).toThrow();
  });

  it("carries MIN_TRIM_SECS's own value into the refusal message", () => {
    expect(() => validateSpan(4.0, 4.0, null)).toThrow(`${MIN_TRIM_SECS}s`);
  });
});

describe("describeConvertError", () => {
  it("a missing converter says so instead of reporting a trim", () => {
    const msg = describeConvertError('Os { code: 2, kind: NotFound, message: "…" }');
    expect(msg).toContain("avconvert");
    expect(msg).toContain("nothing was trimmed");
    // Anything else keeps the converter's own words.
    expect(describeConvertError("codec not supported")).toContain("codec not supported");
  });
});

describe("derived names carry the span and keep the container", () => {
  it("trimmedName", () => {
    expect(trimmedName("talk.mp4", 7.3, 19.0)).toBe("talk (trim 0-07 to 0-19).mp4");
    expect(trimmedName("a.b.mov", 0.0, 90.0)).toBe("a.b (trim 0-00 to 1-30).mov");
    expect(trimmedName("noext", 0.0, 5.0)).toBe("noext (trim 0-00 to 0-05)");
    // Past an hour the stamp grows a field rather than rolling over.
    expect(trimmedName("x.mp4", 3661.0, 3670.0)).toBe("x (trim 1-01-01 to 1-01-10).mp4");
  });

  it("frameName", () => {
    expect(frameName("talk.mp4", 83.4)).toBe("talk @ 1-23.png");
    // No colons: they read as a path separator once the file is exported.
    expect(frameName("talk.mp4", 83.4)).not.toContain(":");
  });

  it("an upper-case extension is not left inside the derived name", () => {
    expect(trimmedName("IMG_0042.MOV", 0.0, 5.0)).toBe("IMG_0042 (trim 0-00 to 0-05).MOV");
    expect(frameName("IMG_0042.MOV", 5.0)).toBe("IMG_0042 @ 0-05.png");
    expect(trimmedName("Clip.Mp4", 0.0, 5.0)).toBe("Clip (trim 0-00 to 0-05).Mp4");
    // A leading dot is the whole name, not an extension.
    expect(frameName(".hidden", 5.0)).toBe(".hidden @ 0-05.png");
  });
});

describe("splitName / stampForName", () => {
  it("splits stem/extension, preserving case, treating a leading or trailing dot as no extension", () => {
    expect(splitName("talk.mp4")).toEqual(["talk", "mp4"]);
    expect(splitName("a.b.mov")).toEqual(["a.b", "mov"]);
    expect(splitName("noext")).toEqual(["noext", ""]);
    expect(splitName(".hidden")).toEqual([".hidden", ""]);
    expect(splitName("trailing.")).toEqual(["trailing.", ""]);
    expect(splitName("IMG_0042.MOV")).toEqual(["IMG_0042", "MOV"]);
  });

  it("formats seconds as m-ss under an hour and h-mm-ss past it", () => {
    expect(stampForName(0)).toBe("0-00");
    expect(stampForName(65)).toBe("1-05");
    expect(stampForName(3599)).toBe("59-59");
    expect(stampForName(3600)).toBe("1-00-00");
    expect(stampForName(3661)).toBe("1-01-01");
    // Rounds, and never goes negative.
    expect(stampForName(64.6)).toBe("1-05");
    expect(stampForName(-5)).toBe("0-00");
  });
});

// ============================================================================
// runAvconvert — REAL /usr/bin/avconvert, against a real system fixture
// ============================================================================

const AVCONVERT = "/usr/bin/avconvert";
const hasAvconvert = fs.existsSync(AVCONVERT);
const WALLPAPER_SOURCE =
  "/System/Library/Desktop Pictures/.wallpapers/Sonoma/Sonoma Graphic Light Landscape.mov";
const hasFixtureSource = fs.existsSync(WALLPAPER_SOURCE);
const canRunRealAvconvert = hasAvconvert && hasFixtureSource;

let fixtureClip: string | null = null;
let fixtureClipBytes: Buffer | null = null;

/** A real, short .mov built from a file every real Mac has — the same
 * recipe `media_probe.rs`'s own `#[cfg(test)] test_fixture` helper uses
 * (`commands/video.rs`'s tests share it), reproduced here in TS since it is
 * a Rust-only `cfg(test)` helper with nothing to import. */
beforeAll(() => {
  if (!canRunRealAvconvert) {
    return;
  }
  const out = path.join(os.tmpdir(), `videoTools-test-fixture-${randomUUID()}.mov`);
  execFileSync(AVCONVERT, [
    "-p",
    "PresetPassthrough",
    "-s",
    WALLPAPER_SOURCE,
    "-o",
    out,
    "--duration",
    "4",
    "--replace",
  ]);
  fixtureClip = out;
  fixtureClipBytes = fs.readFileSync(out);
});

afterAll(() => {
  if (fixtureClip !== null) {
    fs.rmSync(fixtureClip, { force: true });
  }
});

describe.skipIf(!canRunRealAvconvert)("runAvconvert, against the REAL /usr/bin/avconvert", () => {
  it("really cuts a shorter clip out of a real .mov", async () => {
    const dst = path.join(os.tmpdir(), `videoTools-test-cut-${randomUUID()}.mov`);
    try {
      await runAvconvert(fixtureClip!, dst, 1, 2);
      expect(fs.existsSync(dst)).toBe(true);
      const cutSize = fs.statSync(dst).size;
      const fullSize = fs.statSync(fixtureClip!).size;
      // PresetPassthrough copies encoded samples, so byte size tracks
      // duration roughly linearly: a 2s cut out of a 4s source should land
      // well under the full size and well above nothing — a real cut
      // happened, not a copy and not an empty file. (No working prober in
      // this port to assert the exact duration — see this module's doc.)
      expect(cutSize).toBeGreaterThan(0);
      expect(cutSize).toBeLessThan(fullSize);
      expect(cutSize).toBeGreaterThan(fullSize * 0.2);
    } finally {
      fs.rmSync(dst, { force: true });
    }
  });

  it("fails honestly on non-video bytes, leaving no output file, and tries only real presets", async () => {
    const src = path.join(os.tmpdir(), `videoTools-test-garbage-${randomUUID()}.mov`);
    const dst = path.join(os.tmpdir(), `videoTools-test-garbage-out-${randomUUID()}.mov`);
    fs.writeFileSync(src, "not a video", { mode: 0o600 });
    try {
      await expect(runAvconvert(src, dst, 0, 1)).rejects.toThrow();
      expect(fs.existsSync(dst)).toBe(false);
    } finally {
      fs.rmSync(src, { force: true });
      fs.rmSync(dst, { force: true });
    }
  });
});

// ============================================================================
// room fixture — shared by probeVideoMeta / videoTrim / saveVideoFrame
// ============================================================================

let tmpDir: string;
let db: Database.Database;
let roomPath = "";

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "videoTools-"));
  roomPath = path.join(tmpDir, `vt-test-${randomUUID()}.roomai`);
  db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return db;
}

interface FakeRoomState {
  open: boolean;
  epoch: number;
}

function roomSource(state: FakeRoomState): RoomSource {
  return {
    currentRoom: () => (state.open ? { db, path: roomPath } : null),
    roomEpoch: () => state.epoch,
  };
}

/**
 * Run `fn` with `os.tmpdir()` pointed at a fresh, private, empty directory,
 * and return whatever is left in it afterwards.
 *
 * The temp-hygiene assertions below used to scan the SHARED system temp
 * directory for `arcelle-trim-`/`arcelle-probe-` names and diff a
 * before/after snapshot. That is not a sound test on a real machine: ANY
 * other process writing one of those names between the two reads fails it,
 * and on this repo that is not hypothetical — parallel agent sessions run
 * this very suite concurrently, and the shipped app writes the same prefixes.
 * (Rust's own versions of these tests dodge the problem by scoping to a
 * one-off file EXTENSION, which the commands under test here do not let a
 * caller choose.)
 *
 * Isolating `$TMPDIR` instead makes the same assertion both deterministic and
 * STRICTER: the directory must end up completely EMPTY, not merely free of
 * newly-appeared `arcelle-` names. Node's `os.tmpdir()` re-reads `$TMPDIR` on
 * every call — exactly as Rust's `std::env::temp_dir()` does — so the module
 * under test picks it up with no seam of its own.
 *
 * Create the room BEFORE calling this: `freshRoom()` also builds under
 * `os.tmpdir()`, and a room directory inside the isolated dir would read as a
 * leak.
 */
async function withIsolatedTmpdir(fn: () => Promise<void>): Promise<string[]> {
  const previous = process.env.TMPDIR;
  const dir = mkdtempSync(path.join(os.tmpdir(), "videoTools-tmpiso-"));
  process.env.TMPDIR = dir;
  try {
    await fn();
    return fs.readdirSync(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertVideoFile(name = "clip.mov", bytes?: Buffer): { id: string; name: string } {
  const file = insertFile(
    db,
    name,
    "video/quicktime",
    bytes ?? Buffer.from([1, 2, 3, 4]),
    null,
    "library"
  );
  return { id: file.id, name: file.name };
}

const FULL_META: MediaMeta = {
  durationSecs: 12.5,
  width: 1920,
  height: 1080,
  videoCodec: "H.264",
  frameRate: 30,
  bitrateKbps: 4000,
  hasAudio: true,
  audioCodec: "AAC",
};

const EMPTY_META: MediaMeta = {
  durationSecs: null,
  width: null,
  height: null,
  videoCodec: null,
  frameRate: null,
  bitrateKbps: null,
  hasAudio: null,
  audioCodec: null,
};

// ============================================================================
// probeVideoMeta
// ============================================================================

describe("probeVideoMeta", () => {
  it("throws 'No room is open.' when no room is open", async () => {
    freshRoom();
    await expect(probeVideoMeta(roomSource({ open: false, epoch: 1 }), "any-id")).rejects.toThrow(
      "No room is open."
    );
  });

  it("returns a cached value WITHOUT ever calling probe", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    setMediaMeta(db, id, JSON.stringify(FULL_META));
    const probe = vi.fn<ProbeVideoFn>(() => Promise.reject(new Error("must not be called")));
    const result = await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id, probe);
    expect(result).toEqual(FULL_META);
    expect(probe).not.toHaveBeenCalled();
  });

  it("a cached value this port can no longer parse falls through and probes again", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    db.prepare("UPDATE files SET media_meta = ? WHERE id = ?").run("{not valid json", id);
    const probe: ProbeVideoFn = () => Promise.resolve(FULL_META);
    const result = await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id, probe);
    expect(result).toEqual(FULL_META);
  });

  it("a cached value with a field of the wrong JSON type falls through and probes again", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    // width should be a number|null — a string is a type mismatch serde_json
    // would refuse too.
    db.prepare("UPDATE files SET media_meta = ? WHERE id = ?").run(
      JSON.stringify({ ...FULL_META, width: "wide" }),
      id
    );
    const probe: ProbeVideoFn = () => Promise.resolve(FULL_META);
    const result = await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id, probe);
    expect(result).toEqual(FULL_META);
  });

  it("with NO probe dependency at all, a cache miss reaches the REAL default engine — never a NOT_IMPLEMENTED refusal", async () => {
    // Regression: this file used to default the seam to a NOT_IMPLEMENTED
    // rejection, while `mediaProbe.ts` — in this same tree, with passing
    // end-to-end ffprobe subprocess tests — had already established that the
    // very same facts ARE reachable from Node. Two contradictory answers to
    // "can a container be probed here", and the pessimistic one shipped as
    // the default. `probe_video_meta` is `Result<Option<MediaMeta>>` in Rust
    // and CANNOT fail this way.
    freshRoom();
    const { id } = insertVideoFile();
    // A garbage "video": the real engine looks and honestly learns nothing.
    // The contract point is that it RESOLVES (Rust's `Ok(None)`), never
    // throws NOT_IMPLEMENTED.
    await expect(probeVideoMeta(roomSource({ open: true, epoch: 1 }), id)).resolves.toBeNull();
  });

  it("probeVideoWithFfprobe reads a REAL clip's real facts, and answers null for garbage — the same seam, no stub", async () => {
    if (!canRunRealAvconvert || findFfprobe() === null) {
      return; // no fixture source or no ffprobe on this machine — a fact about the Mac
    }
    const real = await probeVideoWithFfprobe(fixtureClip!);
    expect(real).not.toBeNull();
    expect(real!.durationSecs).toBeGreaterThan(0);
    expect(real!.width).toBeGreaterThan(0);
    expect(real!.height).toBeGreaterThan(0);
    expect(real!.videoCodec).toBeTruthy();
    // The wallpaper is video-only: "no audio track" is a FINDING, not an
    // unknown — `media_probe.rs`'s own Rust test asserts exactly this.
    expect(real!.hasAudio).toBe(false);
    expect(real!.audioCodec).toBeNull();

    const garbage = path.join(os.tmpdir(), `videoTools-notmedia-${randomUUID()}.mov`);
    fs.writeFileSync(garbage, "this is not a video", { mode: 0o600 });
    try {
      await expect(probeVideoWithFfprobe(garbage)).resolves.toBeNull();
    } finally {
      fs.rmSync(garbage, { force: true });
    }
    // A path that does not exist at all reads as size 0 — never a throw.
    await expect(
      probeVideoWithFfprobe(path.join(os.tmpdir(), `videoTools-missing-${randomUUID()}.mov`))
    ).resolves.toBeNull();
  }, 30000);

  it("resolves null (not an error) when probe reports nothing readable, and stores nothing", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    const probe: ProbeVideoFn = () => Promise.resolve(null);
    await expect(probeVideoMeta(roomSource({ open: true, epoch: 1 }), id, probe)).resolves.toBeNull();
    expect(getMediaMeta(db, id)).toBeNull();
  });

  it("caches a real probe result for the next call", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    const probe = vi.fn<ProbeVideoFn>(() => Promise.resolve(FULL_META));
    const result = await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id, probe);
    expect(result).toEqual(FULL_META);
    const stored = getMediaMeta(db, id);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual(FULL_META);
  });

  it("passes the file's own bytes and extension to probe, via a private temp file that is removed after", async () => {
    freshRoom();
    const bytes = Buffer.from([9, 8, 7, 6, 5]);
    const { id } = insertVideoFile("clip.mov", bytes);
    let sawPath = "";
    const probe: ProbeVideoFn = async (p) => {
      sawPath = p;
      expect(fs.existsSync(p)).toBe(true);
      expect(p.endsWith(".mov")).toBe(true);
      expect(fs.readFileSync(p).equals(bytes)).toBe(true);
      return FULL_META;
    };
    await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id, probe);
    expect(sawPath).not.toBe("");
    expect(fs.existsSync(sawPath)).toBe(false);
  });

  it("leaves no arcelle-probe- temp file behind, on success, on null, or on a thrown rejection", async () => {
    freshRoom();
    const { id: id1 } = insertVideoFile("a.mov");
    const { id: id2 } = insertVideoFile("b.mov");
    const { id: id3 } = insertVideoFile("c.mov");

    const leftovers = await withIsolatedTmpdir(async () => {
      await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id1, () => Promise.resolve(FULL_META));
      await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id2, () => Promise.resolve(null));
      await expect(
        probeVideoMeta(roomSource({ open: true, epoch: 1 }), id3, () => Promise.reject(new Error("boom")))
      ).rejects.toThrow("boom");
    });
    expect(leftovers).toEqual([]);
  });

  it("throws for a file this room does not have (get_file_full's own Err propagation)", async () => {
    freshRoom();
    await expect(probeVideoMeta(roomSource({ open: true, epoch: 1 }), "no-such-id")).rejects.toThrow();
  });

  it("throws for a non-video file rather than probing it", async () => {
    freshRoom();
    const file = insertFile(db, "notes.txt", "text/plain", Buffer.from("hello"), "hello", "library");
    const probe = vi.fn<ProbeVideoFn>(() => Promise.reject(new Error("must not be called")));
    await expect(probeVideoMeta(roomSource({ open: true, epoch: 1 }), file.id, probe)).rejects.toThrow(
      "This file isn't a video."
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("does NOT write back the cache when the room changed while probing (best-effort, no throw)", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    const state: FakeRoomState = { open: true, epoch: 1 };
    const probe: ProbeVideoFn = async () => {
      state.epoch = 2; // the room reopened (or rolled back) mid-probe
      return FULL_META;
    };
    const result = await probeVideoMeta(roomSource(state), id, probe);
    // The probed value is still handed back — only the cache WRITE is
    // skipped, matching Rust's `let _ = state.with_room(...)`.
    expect(result).toEqual(FULL_META);
    expect(getMediaMeta(db, id)).toBeNull();
  });
});

// ============================================================================
// videoTrim
// ============================================================================

describe("videoTrim", () => {
  it("throws 'No room is open.' when no room is open", async () => {
    freshRoom();
    await expect(
      videoTrim(roomSource({ open: false, epoch: 1 }), "any-id", 0, 1)
    ).rejects.toThrow("No room is open.");
  });

  it("throws for a non-video file", async () => {
    freshRoom();
    const file = insertFile(db, "notes.txt", "text/plain", Buffer.from("hello"), "hello", "library");
    await expect(videoTrim(roomSource({ open: true, epoch: 1 }), file.id, 0, 1)).rejects.toThrow(
      "This file isn't a video."
    );
  });

  it("throws for a video file with no stored bytes", async () => {
    freshRoom();
    const { id } = insertVideoFile("clip.mov", Buffer.alloc(0));
    await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 0, 1)).rejects.toThrow(
      "This video has no stored bytes."
    );
  });

  it("rejects an invalid span before ever touching avconvert", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 4, 4)).rejects.toThrow(
      "too short to trim"
    );
  });

  it("honors a cached known duration as the span's upper bound", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    setMediaMeta(db, id, JSON.stringify({ ...EMPTY_META, durationSecs: 5 }));
    await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 10, 12)).rejects.toThrow(
      "video is only 5.0s long"
    );
  });

  (canRunRealAvconvert ? describe : describe.skip)(
    "against a REAL cut (canRunRealAvconvert)",
    () => {
      it("cuts a real span, inserts a NEW file, and never touches the original", async () => {
        freshRoom();
        const { id, name } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const file = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3);
        expect(file.name).toBe("clip (trim 0-01 to 0-03).mov");
        expect(file.id).not.toBe(id);

        const [, , originalBytes] = db
          .prepare("SELECT name, mime_type, original_bytes FROM files WHERE id = ?")
          .raw()
          .get(id) as [string, string, Buffer];
        expect(originalBytes.equals(fixtureClipBytes!)).toBe(true);

        const [, , clipBytes] = db
          .prepare("SELECT name, mime_type, original_bytes FROM files WHERE id = ?")
          .raw()
          .get(file.id) as [string, string, Buffer];
        expect(clipBytes.length).toBeGreaterThan(0);
        expect(clipBytes.length).toBeLessThan(fixtureClipBytes!.length);
        expect(name).toBe("clip.mov");
      });

      it(
        "disambiguates a second trim of the same span with available_name",
        async () => {
          freshRoom();
          const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
          const first = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3);
          const second = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3);
          expect(first.name).toBe("clip (trim 0-01 to 0-03).mov");
          expect(second.name).toBe("clip (trim 0-01 to 0-03) (2).mov");
          expect(second.id).not.toBe(first.id);
        },
        // This intentionally performs two real macOS avconvert subprocesses.
        // Five seconds is enough in isolation but not while the full suite is
        // also exercising native media tools; the product path has not hung.
        15_000,
      );

      it("with NO injected probe, a real cut stores the CLIP'S OWN real media_meta — video.rs's a_real_cut_lands_and_leaves_a_probeable_clip", async () => {
        // The end-to-end shape of Rust's own test: cut 2 s out of the fixture
        // and prove the RESULT probes back to ~2 s. Previously impossible
        // here, because the default seam refused; now the default is real.
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const file = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3);
        const stored = getMediaMeta(db, file.id);
        if (findFfprobe() === null) {
          // No ffprobe on this Mac: `null` is the honest answer, and Rust's
          // own non-macOS arm answers exactly the same way.
          expect(stored).toBeNull();
          return;
        }
        expect(stored).not.toBeNull();
        const meta = JSON.parse(stored!) as MediaMeta;
        expect(meta.durationSecs).not.toBeNull();
        expect(Math.abs(meta.durationSecs! - 2)).toBeLessThan(0.3);
        expect(meta.width).toBeGreaterThan(0);
        expect(meta.height).toBeGreaterThan(0);
        expect(meta.videoCodec).toBeTruthy();
      });

      it("stores a real, non-empty probe result on the new clip", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const probe: ProbeVideoFn = () => Promise.resolve(FULL_META);
        const file = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3, { probe });
        const stored = getMediaMeta(db, file.id);
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored!)).toEqual(FULL_META);
      });

      it("does NOT store an all-null probe result — MediaMeta::is_empty() filters it, matching Rust", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const probe: ProbeVideoFn = () => Promise.resolve(EMPTY_META);
        const file = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3, { probe });
        expect(getMediaMeta(db, file.id)).toBeNull();
      });

      it("a rejecting probe does not fail a real, successful cut", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const probe: ProbeVideoFn = () => Promise.reject(new Error("AVFoundation is unavailable"));
        const file = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3, { probe });
        expect(file.name).toContain("trim");
        expect(getMediaMeta(db, file.id)).toBeNull();
      });

      it("emits room-files-changed on success", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const emit = vi.fn();
        await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3, { emit });
        expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
      });

      it("an emit that throws does not fail a successful trim", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const emit = vi.fn(() => {
          throw new Error("no window");
        });
        await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3, { emit })).resolves.toBeTruthy();
      });

      it("calls enqueueStt with the new clip's own JobMeta", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const jobs: JobMeta[] = [];
        const file = await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3, {
          enqueueStt: (job) => jobs.push(job),
        });
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toEqual({
          id: file.id,
          name: file.name,
          mime: "video/quicktime",
          ext: "mov",
          roomPath,
          epoch: 1,
        });
      });

      it("a throwing enqueueStt does not fail a successful trim — the clip already landed", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        await expect(
          videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3, {
            enqueueStt: () => {
              throw new Error("channel closed");
            },
          })
        ).resolves.toBeTruthy();
      });

      it("no enqueueStt dependency at all — a trim still succeeds, just unqueued for transcription", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3)).resolves.toBeTruthy();
      });

      it("throws when the room changed mid-trim, and saves nothing", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const state: FakeRoomState = { open: true, epoch: 1 };
        // The probe seam is called partway through the real cut, after
        // avconvert finishes and before the DB write — the exact window the
        // room-pin recheck exists to guard.
        const probe: ProbeVideoFn = async () => {
          state.epoch = 2;
          return null;
        };
        const countBefore = (db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;
        await expect(videoTrim(roomSource(state), id, 1, 3, { probe })).rejects.toThrow(
          "The room changed while the video was being trimmed"
        );
        const countAfter = (db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n;
        expect(countAfter).toBe(countBefore);
      });

      it("throws when the room closed mid-trim, and saves nothing", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const state: FakeRoomState = { open: true, epoch: 1 };
        const probe: ProbeVideoFn = async () => {
          state.open = false;
          return null;
        };
        await expect(videoTrim(roomSource(state), id, 1, 3, { probe })).rejects.toThrow(
          "The room changed while the video was being trimmed"
        );
      });

      it("leaves no arcelle-trim- temp file behind on a successful cut", async () => {
        freshRoom();
        const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
        const leftovers = await withIsolatedTmpdir(async () => {
          await videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3);
        });
        // Neither the decrypted SOURCE nor the decrypted RESULT (nor the
        // probe's own staging copy) may outlive the call as plaintext.
        expect(leftovers).toEqual([]);
      });
    }
  );

  it("a non-video (garbage) 'video' file fails the cut honestly and leaves no temp file behind", async () => {
    // Runs regardless of avconvert availability: on a machine WITHOUT
    // avconvert this exercises describeConvertError's own "no /usr/bin/
    // avconvert" branch for real; on a machine WITH it, garbage bytes make
    // avconvert itself fail (Rust's own `trimming_leaves_no_decrypted_
    // copy_behind` test, same idea).
    freshRoom();
    const { id } = insertVideoFile("clip.mov", Buffer.from("not really a video"));
    const leftovers = await withIsolatedTmpdir(async () => {
      await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 0, 1)).rejects.toThrow();
    });
    expect(leftovers).toEqual([]);
  });
});

// ============================================================================
// saveVideoFrame
// ============================================================================

// A minimal-but-real 1x1 PNG (the shortest well-formed PNG stream: IHDR,
// IDAT, IEND).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64"
);

describe("saveVideoFrame", () => {
  it("throws 'No room is open.' when no room is open", () => {
    freshRoom();
    expect(() =>
      saveVideoFrame(roomSource({ open: false, epoch: 1 }), "id", TINY_PNG.toString("base64"), 5)
    ).toThrow("No room is open.");
  });

  it("throws on invalid base64", () => {
    freshRoom();
    expect(() =>
      saveVideoFrame(roomSource({ open: true, epoch: 1 }), "id", "not base64!!", 5)
    ).toThrow("didn't arrive as valid image data");
  });

  it("throws when the bytes decode but aren't a PNG", () => {
    freshRoom();
    const notPng = Buffer.from("just some bytes, not a png").toString("base64");
    expect(() => saveVideoFrame(roomSource({ open: true, epoch: 1 }), "id", notPng, 5)).toThrow(
      "didn't arrive as a PNG"
    );
  });

  it("saves a real PNG under the frame-name convention, deriving the stem from the video's own name", () => {
    freshRoom();
    const { id } = insertVideoFile("talk.mp4");
    const file = saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, TINY_PNG.toString("base64"), 83.4);
    expect(file.name).toBe("talk @ 1-23.png");
    expect(file.mimeType).toBe("image/png");
    const [bytes] = db
      .prepare("SELECT original_bytes FROM files WHERE id = ?")
      .raw()
      .get(file.id) as [Buffer];
    expect(bytes.equals(TINY_PNG)).toBe(true);
  });

  it("disambiguates two stills a second apart that round to the same stamp", () => {
    freshRoom();
    const { id } = insertVideoFile("talk.mp4");
    const first = saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, TINY_PNG.toString("base64"), 10.1);
    const second = saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, TINY_PNG.toString("base64"), 10.4);
    expect(first.name).toBe("talk @ 0-10.png");
    expect(second.name).toBe("talk @ 0-10 (2).png");
  });

  it("emits room-files-changed on success, and an emit that throws does not fail the save", () => {
    freshRoom();
    const { id } = insertVideoFile("talk.mp4");
    const emit = vi.fn(() => {
      throw new Error("no window");
    });
    expect(() =>
      saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, TINY_PNG.toString("base64"), 5, emit)
    ).not.toThrow();
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
  });

  it("throws for a file this room does not have", () => {
    freshRoom();
    expect(() =>
      saveVideoFrame(roomSource({ open: true, epoch: 1 }), "no-such-id", TINY_PNG.toString("base64"), 5)
    ).toThrow();
  });

  it("trims whitespace off the incoming base64 before decoding, matching Rust's png_b64.trim()", () => {
    freshRoom();
    const { id } = insertVideoFile("talk.mp4");
    const padded = `  ${TINY_PNG.toString("base64")}\n`;
    const file = saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, padded, 5);
    expect(file.mimeType).toBe("image/png");
  });
});

// ============================================================================
// registerVideoIpc
// ============================================================================

describe("registerVideoIpc", () => {
  function listener(
    handle: ReturnType<typeof vi.fn>,
    channel: string
  ): (...args: unknown[]) => unknown {
    const entry = handle.mock.calls.find((c) => c[0] === channel);
    if (entry === undefined) {
      throw new Error(`channel ${channel} was not registered`);
    }
    return entry[1] as (...args: unknown[]) => unknown;
  }

  it("registers exactly the three video channels, by their Tauri command names", () => {
    freshRoom();
    const handle = vi.fn();
    registerVideoIpc({ handle }, roomSource({ open: true, epoch: 1 }));
    expect(handle).toHaveBeenCalledTimes(3);
    const names = handle.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["probe_video_meta", "video_trim", "save_video_frame"]);
  });

  it("probe_video_meta: refuses with 'No room is open.' and reaches the real logic otherwise", async () => {
    freshRoom();
    const handle = vi.fn();
    registerVideoIpc({ handle }, roomSource({ open: false, epoch: 1 }));
    const fn = listener(handle, "probe_video_meta");
    await expect(Promise.resolve().then(() => fn({}, { id: "anything" }))).rejects.toThrow(
      "No room is open."
    );
  });

  it("video_trim: forwards id/startSecs/endSecs through to the real logic", async () => {
    freshRoom();
    const { id } = insertVideoFile();
    const handle = vi.fn();
    registerVideoIpc({ handle }, roomSource({ open: true, epoch: 1 }));
    const fn = listener(handle, "video_trim");
    // No probe wired, but the span-length validation runs first and fails
    // for a zero-length span, proving args really reached the real
    // validateSpan rather than a stub.
    await expect(fn({}, { id, startSecs: 4, endSecs: 4 })).rejects.toThrow("too short to trim");
  });

  it("save_video_frame: forwards id/pngB64/atSecs through to the real logic", async () => {
    freshRoom();
    const { id } = insertVideoFile("talk.mp4");
    const handle = vi.fn();
    registerVideoIpc({ handle }, roomSource({ open: true, epoch: 1 }));
    const fn = listener(handle, "save_video_frame");
    const result = (await fn({}, {
      id,
      pngB64: TINY_PNG.toString("base64"),
      atSecs: 5,
    })) as { name: string };
    expect(result.name).toBe("talk @ 0-05.png");
  });

  it(
    "forwards an injected probe/emit/enqueueStt deps bag through to video_trim",
    async () => {
      if (!canRunRealAvconvert) {
        return;
      }
      freshRoom();
      const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
      const probe: ProbeVideoFn = () => Promise.resolve(FULL_META);
      const emit = vi.fn();
      const jobs: JobMeta[] = [];
      const handle = vi.fn();
      registerVideoIpc(
        { handle },
        roomSource({ open: true, epoch: 1 }),
        { probe, emit, enqueueStt: (job) => jobs.push(job) }
      );
      const fn = listener(handle, "video_trim");
      const file = (await fn({}, { id, startSecs: 1, endSecs: 3 })) as {
        id: string;
        name: string;
      };
      expect(getMediaMeta(db, file.id)).not.toBeNull();
      expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
      expect(jobs).toHaveLength(1);
    },
    // This exercises the real macOS avconvert binary. Under full-suite load it
    // can legitimately exceed Vitest's five-second unit-test default.
    15_000,
  );
});

// ============================================================================
// ADVERSARIAL — boundary spans, hostile payloads, and real corrupt media
// ============================================================================

describe("validateSpan, exact boundaries", () => {
  it("a span of EXACTLY MIN_TRIM_SECS is allowed; a hair under is not", () => {
    // `end - start < MIN_TRIM_SECS` — the comparison is strict, so the
    // boundary value itself is a legal cut. Off-by-one here silently refuses
    // the shortest trim the UI can express.
    expect(validateSpan(0, MIN_TRIM_SECS, null)).toEqual([0, MIN_TRIM_SECS]);
    expect(() => validateSpan(0, MIN_TRIM_SECS - Number.EPSILON, null)).toThrow();
    expect(validateSpan(0, MIN_TRIM_SECS, 100)).toEqual([0, MIN_TRIM_SECS]);
  });

  it("a start of EXACTLY the duration is refused; a start a hair under is not", () => {
    // `start >= d` — refused AT the end, allowed just before it.
    expect(() => validateSpan(10, 20, 10)).toThrow("only 10.0s long");
    expect(validateSpan(9.9, 20, 10)).toEqual([9.9, 10]);
  });

  it("an end of EXACTLY the duration is kept, not clamped away", () => {
    expect(validateSpan(0, 10, 10)).toEqual([0, 10]);
  });

  it("a zero-length video refuses every span rather than emitting an empty clip", () => {
    expect(() => validateSpan(0, 5, 0)).toThrow();
  });

  it("start exactly 0 is the beginning of the video, not a negative", () => {
    expect(validateSpan(0, 5, 10)).toEqual([0, 5]);
    expect(() => validateSpan(-Number.EPSILON, 5, 10)).toThrow(
      "can't start before the beginning"
    );
  });

  it("a NaN or infinite duration is not an upper bound — but the span itself must still be real", () => {
    expect(() => validateSpan(Number.NaN, Number.NaN, null)).toThrow("aren't real numbers");
    expect(() => validateSpan(1, Number.NaN, 10)).toThrow("aren't real numbers");
    expect(() => validateSpan(Number.NEGATIVE_INFINITY, 5, null)).toThrow();
  });
});

describe("saveVideoFrame, adversarial payloads", () => {
  it("PNG magic bytes with nothing behind them are accepted — this end only checks the magic, exactly as Rust does", () => {
    // Not a defect to document as one: `save_video_frame`'s Rust body checks
    // `png.starts_with(b"\x89PNG\r\n\x1a\n")` and nothing more. Pinning it so
    // a future "improvement" that starts decoding here is a deliberate change.
    freshRoom();
    const { id } = insertVideoFile("talk.mov");
    const magicOnly = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, magicOnly.toString("base64"), 5);
    expect(file.name).toBe("talk @ 0-05.png");
  });

  it("a PNG magic prefix that is one byte short is refused", () => {
    freshRoom();
    const { id } = insertVideoFile("talk.mov");
    const short = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]);
    expect(() =>
      saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, short.toString("base64"), 5)
    ).toThrow("didn't arrive as a PNG");
  });

  it("base64 with INTERIOR whitespace or a non-alphabet character is refused, never silently mangled", () => {
    // Node's own `Buffer.from(s, "base64")` never throws — it skips what it
    // does not understand — which would turn a corrupted paste into a
    // corrupted file written into the room under a confident name.
    freshRoom();
    const { id } = insertVideoFile("talk.mov");
    const room = roomSource({ open: true, epoch: 1 });
    const valid = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const interior = valid.slice(0, 4) + " " + valid.slice(4);
    for (const bad of [interior, valid + "!", "====", "a", valid.slice(0, -1), "%%%%"]) {
      expect(() => saveVideoFrame(room, id, bad, 5), JSON.stringify(bad)).toThrow(
        /valid image data|didn't arrive as a PNG/
      );
    }
  });

  it("an at-seconds of NaN or Infinity still produces a usable, colon-free file name", () => {
    // The stamp feeds a FILE NAME; "NaN" or "Infinity-NaN" in it would be
    // ugly but survivable — a colon would not (the Finder reads it as a path
    // separator once exported), and neither would a crash.
    freshRoom();
    const { id } = insertVideoFile("talk.mov");
    const png = TINY_PNG.toString("base64");
    for (const at of [Number.NaN, Number.POSITIVE_INFINITY, -5, 1e21]) {
      const file = saveVideoFrame(roomSource({ open: true, epoch: 1 }), id, png, at);
      expect(file.name, `${at}`).not.toContain(":");
      expect(file.name, `${at}`).toMatch(/\.png$/);
      expect(file.name.length, `${at}`).toBeGreaterThan(4);
    }
  });
});

describe.skipIf(!canRunRealAvconvert)("probeVideoMeta / videoTrim against REAL corrupt media", () => {
  it("a TRUNCATED real clip probes to an honest answer through the REAL default engine, never fabricated zeros", async () => {
    freshRoom();
    const truncated = fixtureClipBytes!.subarray(0, Math.floor(fixtureClipBytes!.length / 4));
    const { id } = insertVideoFile("half.mov", Buffer.from(truncated));
    const meta = await probeVideoMeta(roomSource({ open: true, epoch: 1 }), id);
    if (meta === null) {
      // The honest answer for a container that cannot be read — and NOTHING
      // is cached, so a later, better probe is not shadowed by it.
      expect(getMediaMeta(db, id)).toBeNull();
      return;
    }
    if (meta.durationSecs !== null) expect(meta.durationSecs).toBeGreaterThan(0);
    if (meta.width !== null) expect(meta.width).toBeGreaterThan(0);
    if (meta.height !== null) expect(meta.height).toBeGreaterThan(0);
  }, 30000);

  it("a garbage 'video' probes to null through the real default engine — Ok(None), never a throw", async () => {
    freshRoom();
    const { id } = insertVideoFile("fake.mov", Buffer.from("MOOV? no."));
    await expect(probeVideoMeta(roomSource({ open: true, epoch: 1 }), id)).resolves.toBeNull();
    expect(getMediaMeta(db, id)).toBeNull();
  }, 30000);

  it("a HOSTILE cached duration cannot make a legal cut illegal, nor an illegal one legal", async () => {
    // `known_duration` comes out of the room's own media_meta cache, which a
    // previous (or corrupted) write controls. It only ever REMOVES an upper
    // bound or clamps a tail — it must never widen what validate_span allows.
    freshRoom();
    const { id } = insertVideoFile("clip.mov", fixtureClipBytes!);
    setMediaMeta(db, id, JSON.stringify({ ...EMPTY_META, durationSecs: 0.05 }));
    // The cache says the video is 0.05 s long, so a 1-3 s cut starts past the
    // end and is refused — no avconvert call at all.
    await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3)).rejects.toThrow(
      "the video is only 0.1s long"
    );

    // A NEGATIVE cached duration is not a duration: the clamp `end.min(d)`
    // would otherwise invert the span. It must still refuse rather than cut.
    setMediaMeta(db, id, JSON.stringify({ ...EMPTY_META, durationSecs: -10 }));
    await expect(videoTrim(roomSource({ open: true, epoch: 1 }), id, 1, 3)).rejects.toThrow();
  }, 30000);

  it("a cached media_meta that is a JSON ARRAY, not an object, is not an answer", async () => {
    freshRoom();
    const { id } = insertVideoFile("clip.mov");
    setMediaMeta(db, id, "[1,2,3]");
    const probe = vi.fn<ProbeVideoFn>(() => Promise.resolve(FULL_META));
    await expect(probeVideoMeta(roomSource({ open: true, epoch: 1 }), id, probe)).resolves.toEqual(
      FULL_META
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
