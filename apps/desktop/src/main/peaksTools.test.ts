/**
 * Tests for `peaksTools.ts` — `commands/peaks.rs`'s `audio_peaks` port: the
 * pure math (`envelope`/`isSilent`/`describeDecodeError`/`cacheKey`,
 * side-by-side ports of the Rust source's own `mod tests`), the WAV-only
 * decode seam (`decodeAudioBytes`/`wavSampleRate`, exercised for both its
 * real path and its honest NOT_IMPLEMENTED refusal), and the end-to-end
 * `audioPeaks` command against a REAL fixture room via `db-host/open.ts`'s
 * `createRoom` — matching this directory's established convention
 * (`fileTools.test.ts`, `previewTools.test.ts`, `recIpc.test.ts`).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { insertFile, updateFileContent } from "./db-host/files.js";
import { encodeWav, SAMPLE_RATE } from "./recFormat.js";
import {
  audioPeaks,
  audioPeaksForRoom,
  cacheKey,
  clampBuckets,
  clearPeaks,
  createPeakCache,
  DECODE_NON_WAV_NOT_IMPLEMENTED,
  decodeAudioBytes,
  decodeAudioBytesWith,
  DEFAULT_BUCKETS,
  describeDecodeError,
  envelope,
  isSilent,
  MAX_BUCKETS,
  MAX_CACHED,
  mediaKind,
  NOISE_FLOOR,
  registerPeaksIpc,
  transcodeWithMacOsUsing,
  type AudioPeaks,
  type DecodeToPcmFn,
  type PeakCache,
  type RoomSource,
} from "./peaksTools.js";

let tmpDir: string;
let db: Database.Database;
let roomPath = "";

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "peaksTools-"));
  roomPath = path.join(tmpDir, `pr-test-${randomUUID()}.roomai`);
  db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return db;
}

function roomSource(open: boolean): RoomSource {
  return { currentRoom: () => (open ? { db, path: roomPath } : null) };
}

function addWavFile(samples: Float32Array, name = "call.wav"): string {
  return insertFile(db, name, "audio/wav", encodeWav(samples), null, "recording").id;
}

/** A well-formed WAV header (RIFF/WAVE/fmt) with NO data chunk — the
 * "genuine decode failure" fixture: passes `decodeWav`'s magic-byte gate but
 * still fails for a real reason, so its error must reach the caller
 * unchanged rather than being mistaken for the "not a WAV at all" case. */
function malformedWavMissingDataChunk(): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("JUNK", 36, "ascii"); // NOT "data" — the walk finds nothing
  b.writeUInt32LE(0, 40);
  return b;
}

/** `encodeWav`'s output with the header's OWN declared rate overwritten —
 * `encodeWav` itself always hard-codes `recFormat.ts`'s `SAMPLE_RATE`, so a
 * non-16 kHz fixture has to be built this way. */
function wavWithRate(samples: Float32Array, rate: number): Buffer {
  const bytes = encodeWav(samples);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  return bytes;
}

// ============================================================================
// Pure math — side-by-side ports of peaks.rs's own `mod tests`
// ============================================================================

describe("envelope", () => {
  it("an envelope follows the loud parts", () => {
    const samples = new Array(300).fill(0);
    for (let i = 100; i < 200; i++) {
      samples[i] = 0.5;
    }
    const env = envelope(samples, 3);
    expect(env).toHaveLength(3);
    expect(env[0]).toBeLessThan(0.01);
    expect(env[1]).toBeCloseTo(1, 6);
    expect(env[2]).toBeLessThan(0.01);
  });

  it("a mean would have flattened this but a max does not", () => {
    const samples = new Array(100).fill(0);
    samples[50] = 1;
    expect(envelope(samples, 1)).toEqual([1]);
  });

  it("silence is not amplified into noise", () => {
    const env = envelope(new Array(1000).fill(0.0005), 4);
    expect(env.every((v) => v < 0.01)).toBe(true);
  });

  it("buckets cover every sample and never run past the end", () => {
    for (const len of [1, 7, 999, 1001]) {
      for (const buckets of [1, 3, 64, 2000]) {
        const env = envelope(new Array(len).fill(0.25), buckets);
        expect(env).toHaveLength(buckets);
      }
    }
  });

  it("nothing in, nothing out", () => {
    expect(envelope([], 10)).toEqual([]);
    expect(envelope([0.5, 0.5], 0)).toEqual([]);
  });

  it("a negative bucket count is treated as nothing to compute, not a negative-length array (TS-only guard: usize can't go negative in Rust)", () => {
    expect(envelope([0.5, 0.5], -1)).toEqual([]);
  });
});

describe("isSilent", () => {
  it("a silent track is reported as silent and a quiet one is not", () => {
    expect(isSilent(envelope(new Array(1000).fill(0), 8))).toBe(true);
    expect(isSilent(envelope(new Array(1000).fill(0.0005), 8))).toBe(true);
    expect(isSilent(envelope(new Array(1000).fill(0.03), 8))).toBe(false);
    expect(isSilent([])).toBe(false);
  });
});

describe("describeDecodeError", () => {
  it("a missing audio track reads as a sentence, not as converter stderr", () => {
    expect(describeDecodeError("no readable audio track: avconvert: error: nope")).toBe(
      "This video has no audio track this Mac can read."
    );
    expect(describeDecodeError("audio decode failed: bad file")).toBe("audio decode failed: bad file");
  });

  it("passes the DECODE_NON_WAV_NOT_IMPLEMENTED reason straight through unchanged", () => {
    expect(describeDecodeError(DECODE_NON_WAV_NOT_IMPLEMENTED)).toBe(DECODE_NON_WAV_NOT_IMPLEMENTED);
  });
});

describe("cacheKey", () => {
  it("a recording that grew cannot hit its old envelope", () => {
    const before = cacheKey("rec-1", 2000, 4_000_044);
    expect(cacheKey("rec-1", 2000, 4_000_044)).toBe(before);
    expect(cacheKey("rec-1", 2000, 9_100_044)).not.toBe(before);
    expect(cacheKey("rec-1", 4000, 4_000_044)).not.toBe(before);
    expect(cacheKey("rec-2", 2000, 4_000_044)).not.toBe(before);
  });
});

// ============================================================================
// clampBuckets — honest addition, no Rust source (Tauri's Option<usize> closes
// this gap for free; see peaksTools.ts's module doc)
// ============================================================================

describe("clampBuckets", () => {
  it("defaults to DEFAULT_BUCKETS for null, undefined, or non-finite input", () => {
    expect(clampBuckets(null)).toBe(DEFAULT_BUCKETS);
    expect(clampBuckets(undefined)).toBe(DEFAULT_BUCKETS);
    expect(clampBuckets(NaN)).toBe(DEFAULT_BUCKETS);
  });

  it("clamps below 64 up to 64, and above MAX_BUCKETS down to MAX_BUCKETS", () => {
    expect(clampBuckets(1)).toBe(64);
    expect(clampBuckets(-500)).toBe(64);
    expect(clampBuckets(999_999)).toBe(MAX_BUCKETS);
  });

  it("truncates a non-integer rather than passing it through", () => {
    expect(clampBuckets(100.9)).toBe(100);
  });

  it("passes a valid value through unchanged", () => {
    expect(clampBuckets(500)).toBe(500);
  });
});

// ============================================================================
// mediaKind — ported for real; see peaksTools.ts's module doc for why this
// differs from retrievalBackfill_a.ts's/_b.ts's stubs of the same Rust fn
// ============================================================================

describe("mediaKind", () => {
  it("resolves by mime prefix first", () => {
    expect(mediaKind("audio/mpeg", "")).toBe("audio");
    expect(mediaKind("video/quicktime", "")).toBe("video");
  });

  it("mime wins over a conflicting extension", () => {
    expect(mediaKind("video/quicktime", "wav")).toBe("video");
    expect(mediaKind("audio/wav", "mov")).toBe("audio");
  });

  it("falls back to the extension registry when mime doesn't say", () => {
    for (const ext of ["m4a", "mp3", "wav", "aac", "flac", "aiff", "aif", "caf", "ogg", "opus"]) {
      expect(mediaKind("application/octet-stream", ext)).toBe("audio");
    }
    for (const ext of ["mp4", "mov", "m4v"]) {
      expect(mediaKind("application/octet-stream", ext)).toBe("video");
    }
  });

  it("is null for anything neither mime nor extension claims", () => {
    expect(mediaKind("text/plain", "txt")).toBeNull();
    expect(mediaKind("application/pdf", "pdf")).toBeNull();
    expect(mediaKind("", "")).toBeNull();
  });
});

// ============================================================================
// PeakCache
// ============================================================================

describe("createPeakCache / clearPeaks", () => {
  it("starts empty", () => {
    expect(createPeakCache().map.size).toBe(0);
  });

  it("clearPeaks empties a populated cache", () => {
    const cache = createPeakCache();
    cache.map.set("x", { peaks: [], duration: 0, silent: true });
    clearPeaks(cache);
    expect(cache.map.size).toBe(0);
  });
});

// ============================================================================
// decodeAudioBytes / wavSampleRate
// ============================================================================

describe("decodeAudioBytes", () => {
  it("falls back to a system ffmpeg when avconvert cannot demux MKV AAC", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "arcelle-peaks-fallback-"));
    const commands: Array<[string, readonly string[]]> = [];
    try {
      await transcodeWithMacOsUsing(
        path.join(root, "sample.mkv"),
        path.join(root, "decoded.wav"),
        "video",
        root,
        {
          findFfmpeg: () => "/opt/homebrew/bin/ffmpeg",
          exec: async (command, args) => {
            commands.push([command, args]);
            if (command === "/usr/bin/avconvert") throw new Error("unsupported container");
          },
        },
      );
      expect(commands.map(([command]) => command)).toEqual([
        "/usr/bin/avconvert",
        "/opt/homebrew/bin/ffmpeg",
      ]);
      expect(commands[1]?.[1]).toEqual(expect.arrayContaining([
        "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      ]));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("decodes this app's own recordings, at recFormat's SAMPLE_RATE", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
    const decoded = await decodeAudioBytes(encodeWav(samples), "wav", "audio");
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(Array.from(decoded.samples as Float32Array)).toHaveLength(4);
  });

  it("reads the WAV header's OWN declared sample rate rather than assuming 16 kHz", async () => {
    const samples = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const decoded = await decodeAudioBytes(wavWithRate(samples, 44_100), "wav", "audio");
    expect(decoded.sampleRate).toBe(44_100);
  });

  it("transcodes non-WAV bytes and decodes the converter's private WAV output", async () => {
    const bytes = Buffer.from("ID3 not really an mp3 file", "utf8");
    const decoded = await decodeAudioBytesWith(bytes, "mp3", "audio", async (_source, wav) => {
      await fs.writeFile(wav, encodeWav(new Float32Array([0.25, -0.25])), { mode: 0o600 });
    });
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(Array.from(decoded.samples)).toHaveLength(2);
  });

  it("passes video kind to the converter so it can extract the audio track first", async () => {
    let seen = "";
    await decodeAudioBytesWith(Buffer.from([0, 0, 0, 1]), "mp4", "video", async (_source, wav, kind) => {
      seen = kind;
      await fs.writeFile(wav, encodeWav(new Float32Array([0.1])));
    });
    expect(seen).toBe("video");
  });

  it("a WAV-shaped file that fails to parse for a REAL reason keeps its own words, not NOT_IMPLEMENTED", async () => {
    await expect(decodeAudioBytes(malformedWavMissingDataChunk(), "wav", "audio")).rejects.toThrow(
      "WAV has no data chunk"
    );
  });

  // ADVERSARIAL: malformed and truncated headers. `wavSampleRate` is this
  // port's own addition (Rust never reads the field, because `afconvert` has
  // already guaranteed 16 kHz upstream), so its failure modes have no Rust
  // counterpart to inherit and have to be pinned here.
  it("an EMPTY buffer is refused, never decoded as a zero-length silence", async () => {
    await expect(decodeAudioBytesWith(Buffer.alloc(0), "wav", "audio", async () => {
      throw new Error("audio decode failed: empty input");
    })).rejects.toThrow("audio decode failed: empty input");
  });

  it("a truncated RIFF header (under the 44-byte minimum) is refused, not read past the end", async () => {
    await expect(decodeAudioBytesWith(Buffer.from("RIFF", "ascii"), "wav", "audio", async () => {
      throw new Error("audio decode failed: truncated input");
    })).rejects.toThrow("audio decode failed: truncated input");
  });

  it("a chunk walk over a zero-sized junk chunk terminates rather than spinning", async () => {
    // A `size: 0` chunk that is neither "fmt " nor "data" must still advance
    // the cursor — otherwise the header walk never reaches the end of the
    // buffer. Bounded by vitest's own timeout if it ever regresses.
    const samples = new Float32Array([0.5, -0.5]);
    const real = encodeWav(samples);
    const junk = Buffer.alloc(8);
    junk.write("JUNK", 0, "ascii");
    junk.writeUInt32LE(0, 4);
    // RIFF(12) + JUNK(8) + the rest of the real file's chunks.
    const spliced = Buffer.concat([real.subarray(0, 12), junk, real.subarray(12)]);
    spliced.writeUInt32LE(spliced.length - 8, 4);
    const decoded = await decodeAudioBytes(spliced, "wav", "audio");
    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.samples.length).toBe(2);
  });

  it("a STEREO 44.1 kHz WAV reports its own rate and its FRAME count, not 16 kHz and not bytes", async () => {
    // The exact file the Rust source could never see (afconvert resamples and
    // downmixes first) and the one a blind 16 kHz assumption gets wrong by
    // 2.75x. `decodeWav` averages the channels; `wavSampleRate` reads 44100.
    const frames = 100;
    const b = Buffer.alloc(44 + frames * 4);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(36 + frames * 4, 4);
    b.write("WAVE", 8, "ascii");
    b.write("fmt ", 12, "ascii");
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(2, 22); // stereo
    b.writeUInt32LE(44_100, 24);
    b.writeUInt32LE(44_100 * 4, 28);
    b.writeUInt16LE(4, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36, "ascii");
    b.writeUInt32LE(frames * 4, 40);
    const decoded = await decodeAudioBytes(b, "wav", "audio");
    expect(decoded.sampleRate).toBe(44_100);
    expect(decoded.samples.length).toBe(frames);
  });
});

// ============================================================================
// audioPeaks — end to end, against a real fixture room
// ============================================================================

describe("audioPeaks", () => {
  let cache: PeakCache;

  beforeEach(() => {
    cache = createPeakCache();
  });

  it("throws when the id names no file in this room", async () => {
    freshRoom();
    await expect(audioPeaks(db, cache, "no-such-id", null)).rejects.toThrow();
  });

  it("throws 'This file has no audio to draw.' for empty bytes", async () => {
    freshRoom();
    const id = insertFile(db, "empty.wav", "audio/wav", new Uint8Array(), null, "upload").id;
    await expect(audioPeaks(db, cache, id, null)).rejects.toThrow("This file has no audio to draw.");
  });

  it("throws 'This file is not audio or video.' for a document", async () => {
    freshRoom();
    const id = insertFile(db, "notes.txt", "text/plain", Buffer.from("hello"), "hello", "upload").id;
    await expect(audioPeaks(db, cache, id, null)).rejects.toThrow("This file is not audio or video.");
  });

  it("computes real peaks/duration/silent for this room's own recording", async () => {
    freshRoom();
    // A requested bucket count below 64 is clamped up (matching Rust's
    // `.clamp(64, MAX_BUCKETS)`), so the fixture is shaped for 64 buckets: a
    // loud burst in the middle, quiet everywhere else.
    const total = 6400;
    const samples = new Float32Array(total);
    for (let i = 3000; i < 3400; i++) {
      samples[i] = 0.5;
    }
    const id = addWavFile(samples);
    const result = await audioPeaks(db, cache, id, 3);
    expect(result.peaks).toHaveLength(64);
    expect(Math.max(...result.peaks)).toBeCloseTo(1, 6);
    expect(result.peaks[0]).toBeLessThan(0.01);
    expect(result.peaks[63]).toBeLessThan(0.01);
    expect(result.duration).toBeCloseTo(total / SAMPLE_RATE, 6);
    expect(result.silent).toBe(false);
  });

  it("defaults to DEFAULT_BUCKETS when buckets is null", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array(50));
    const result = await audioPeaks(db, cache, id, null);
    expect(result.peaks).toHaveLength(DEFAULT_BUCKETS);
  });

  it("reports silence for a track that never rises above the noise floor", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array(1000).fill(0.0005));
    const result = await audioPeaks(db, cache, id, 8);
    expect(result.silent).toBe(true);
    expect(result.peaks.every((v) => v < NOISE_FLOOR)).toBe(true);
  });

  it("caches by (id, buckets, size) — a hit never re-reads the file's bytes", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array(200).fill(0.2));
    const first = await audioPeaks(db, cache, id, 4);
    expect(cache.map.size).toBe(1);
    // Corrupt the row's bytes directly WITHOUT touching size_bytes — a cache
    // HIT must never notice, because it never reaches this column again.
    db.prepare("UPDATE files SET original_bytes = ? WHERE id = ?").run(Buffer.alloc(0), id);
    const second = await audioPeaks(db, cache, id, 4);
    expect(second).toEqual(first);
  });

  it("a cache hit returns an INDEPENDENT copy — mutating it cannot corrupt the cache (Rust's .cloned())", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array(200).fill(0.2));
    const first = await audioPeaks(db, cache, id, 4);
    first.peaks[0] = 999;
    const second = await audioPeaks(db, cache, id, 4);
    expect(second.peaks[0]).not.toBe(999);
  });

  it("a file that GREW cannot hit its old envelope — the 'Continue recording' bug cacheKey exists to prevent", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array(100).fill(0.3));
    const before = await audioPeaks(db, cache, id, 4);
    updateFileContent(db, id, encodeWav(new Float32Array(500).fill(0.3)), null);
    const after = await audioPeaks(db, cache, id, 4);
    expect(after.duration).toBeGreaterThan(before.duration);
    expect(cache.map.size).toBe(2); // both entries live, keyed by their own size
  });

  it("evicts the whole cache rather than growing past MAX_CACHED", async () => {
    freshRoom();
    for (let i = 0; i < MAX_CACHED; i++) {
      cache.map.set(`dummy-${i}`, { peaks: [], duration: 0, silent: true });
    }
    expect(cache.map.size).toBe(MAX_CACHED);
    const id = addWavFile(new Float32Array(10).fill(0.5));
    await audioPeaks(db, cache, id, 4);
    expect(cache.map.size).toBe(1);
  });

  it("reports a real converter failure for non-WAV audio", async () => {
    freshRoom();
    const id = insertFile(db, "song.mp3", "audio/mpeg", Buffer.from("not really an mp3"), null, "upload").id;
    const decode: DecodeToPcmFn = (bytes, ext, kind) => decodeAudioBytesWith(bytes, ext, kind, async () => {
      throw new Error("audio decode failed: bad container");
    });
    await expect(audioPeaks(db, cache, id, null, decode)).rejects.toThrow("audio decode failed: bad container");
  });

  // ADVERSARIAL: the three "there is nothing here" shapes, and the one
  // arithmetic edge a header full of zeros can force.
  it("a TRASHED recording is refused, never drawn — get_file_meta's `trashed_at IS NULL` is part of the contract", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array(200).fill(0.4), "deleted.wav");
    db.prepare("UPDATE files SET trashed_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(id);
    const decode = vi.fn<DecodeToPcmFn>();
    await expect(audioPeaks(db, cache, id, 64, decode)).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
    expect(cache.map.size).toBe(0); // a refusal must not seed the cache
  });

  it("an EMPTY id is a missing file, not an empty waveform", async () => {
    freshRoom();
    await expect(audioPeaks(db, cache, "", null)).rejects.toThrow();
  });

  it("a WAV header declaring a ZERO sample rate reports duration 0, never Infinity or NaN", async () => {
    // `duration` crosses IPC and positions every speaker lane, chapter rule
    // and click-to-seek as a fraction of it. A non-finite one does not
    // survive JSON, so the viewer would receive `null` and mis-place every
    // single mark — worse than an honest zero.
    freshRoom();
    const bytes = encodeWav(new Float32Array(400).fill(0.5));
    bytes.writeUInt32LE(0, 24); // fmt body offset 4 = nSamplesPerSec
    const id = insertFile(db, "corrupt.wav", "audio/wav", bytes, null, "upload").id;
    const result = await audioPeaks(db, cache, id, 64);
    expect(Number.isFinite(result.duration)).toBe(true);
    expect(result.duration).toBe(0);
    // The envelope itself is rate-agnostic and must still be real.
    expect(result.peaks).toHaveLength(64);
    expect(result.silent).toBe(false);
  });

  it("MAX_BUCKETS of them over a 10-sample file still yields exactly MAX_BUCKETS, none running past the end", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array([0, 0.5, -0.5, 0.25, 0, 0.75, -0.9, 0.1, 0, 0.2]));
    const result = await audioPeaks(db, cache, id, 999_999);
    expect(result.peaks).toHaveLength(MAX_BUCKETS);
    expect(result.peaks.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  });

  it("forwards an injected decode dependency instead of the default WAV/NOT_IMPLEMENTED split", async () => {
    freshRoom();
    const id = insertFile(db, "song.mp3", "audio/mpeg", Buffer.from([1, 2, 3]), null, "upload").id;
    const fakeDecode: DecodeToPcmFn = () =>
      Promise.resolve({ samples: new Float32Array([1, 1, 1, 1]), sampleRate: 8000 });
    // buckets=2 clamps up to 64; every sample is 1, so every bucket (however
    // few real samples it maps to) reads the same constant peak.
    const result = await audioPeaks(db, cache, id, 2, fakeDecode);
    expect(result.duration).toBeCloseTo(4 / 8000, 6);
    expect(result.peaks).toEqual(new Array(64).fill(1));
  });

  it("reads workspace audio from the normal file and keeps original_bytes NULL", async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "peaks-workspace-"));
    const workspacePath = path.join(tmpDir, "Room");
    const created = createWorkspaceRoom(workspacePath, "correct horse battery staple", "Room");
    try {
      const workspace = new WorkspaceService(created.db, workspacePath);
      const bytes = encodeWav(new Float32Array(400).fill(0.5));
      const entry = await workspace.createFile("call.wav", Readable.from([bytes]), "recording");
      created.db.prepare("UPDATE files SET mime_type = 'audio/wav' WHERE id = ?").run(entry.fileId);

      const result = await audioPeaksForRoom(
        { db: created.db, path: workspacePath, workspace },
        createPeakCache(),
        entry.fileId,
        64,
      );
      expect(result.peaks).toHaveLength(64);
      expect(result.silent).toBe(false);
      expect(created.db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(entry.fileId))
        .toEqual({ original_bytes: null });
    } finally {
      created.db.close();
    }
  });
});

// ============================================================================
// registerPeaksIpc
// ============================================================================

describe("registerPeaksIpc", () => {
  function listener(handle: ReturnType<typeof vi.fn>, channel: string): (...args: unknown[]) => unknown {
    const entry = handle.mock.calls.find((c) => c[0] === channel);
    if (entry === undefined) {
      throw new Error(`channel ${channel} was not registered`);
    }
    return entry[1] as (...args: unknown[]) => unknown;
  }

  it("registers exactly the audio_peaks channel", () => {
    freshRoom();
    const handle = vi.fn();
    registerPeaksIpc({ handle }, roomSource(true), createPeakCache());
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe("audio_peaks");
  });

  it("refuses with 'No room is open.' when no room is open", async () => {
    freshRoom();
    const handle = vi.fn();
    registerPeaksIpc({ handle }, roomSource(false), createPeakCache());
    const fn = listener(handle, "audio_peaks");
    // openDb() throws SYNCHRONOUSLY, matching recIpc.test.ts's/previewTools.test.ts's
    // own normalization of the same "No room is open." case.
    await expect(Promise.resolve().then(() => fn({}, { id: "anything", buckets: null }))).rejects.toThrow(
      "No room is open."
    );
  });

  it("reaches the real DB-backed logic, not a stub — a bad id gets the real failure", async () => {
    freshRoom();
    const handle = vi.fn();
    registerPeaksIpc({ handle }, roomSource(true), createPeakCache());
    const fn = listener(handle, "audio_peaks");
    await expect(fn({}, { id: "not-a-real-id", buckets: null })).rejects.toThrow();
  });

  it("forwards an injected decode dependency through to the real logic", async () => {
    freshRoom();
    const id = insertFile(db, "song.mp3", "audio/mpeg", Buffer.from([1, 2]), null, "upload").id;
    const fakeDecode: DecodeToPcmFn = () =>
      Promise.resolve({ samples: new Float32Array([0.5, 0.5]), sampleRate: 2 });
    const handle = vi.fn();
    registerPeaksIpc({ handle }, roomSource(true), createPeakCache(), fakeDecode);
    const fn = listener(handle, "audio_peaks");
    const result = (await fn({}, { id, buckets: 1 })) as AudioPeaks;
    // buckets=1 clamps up to 64; both (equal) samples normalize to 1 in every
    // bucket.
    expect(result.peaks).toEqual(new Array(64).fill(1));
  });

  it("shares one cache across calls made through the same registration", async () => {
    freshRoom();
    const id = addWavFile(new Float32Array(50).fill(0.2));
    const cache = createPeakCache();
    const handle = vi.fn();
    registerPeaksIpc({ handle }, roomSource(true), cache);
    const fn = listener(handle, "audio_peaks");
    await fn({}, { id, buckets: 4 });
    expect(cache.map.size).toBe(1);
  });
});
