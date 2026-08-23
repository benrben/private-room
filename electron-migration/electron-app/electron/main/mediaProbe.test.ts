/**
 * Tests for `mediaProbe.ts` — `src-tauri/src/media_probe.rs`'s port. Cases
 * named after a Rust `#[test]` reproduce that test's intent (this engine is
 * ffprobe/ffmpeg, not AVFoundation — see `mediaProbe.ts`'s own "ENGINE SWAP"
 * doc for why the facts asserted are the same even though the mechanism
 * differs); cases with no Rust counterpart are new coverage this engine swap
 * needs on its own.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MediaMeta } from "../shared/apiTypes.js";
import {
  codecName,
  EMPTY_MEDIA_META,
  ffmpegLastFrameEngine,
  ffprobeEngine,
  findFfmpeg,
  findFfprobe,
  fourccString,
  isEmptyMediaMeta,
  lastFramePng,
  parseFfprobeOutput,
  probeBytes,
  probePath,
  removeQuietly,
  saneFrameRate,
  writePrivate,
  type LastFrameEngine,
  type ProbeEngine,
} from "./mediaProbe.js";

// ------------------------------------------------------------- isEmptyMediaMeta

describe("isEmptyMediaMeta / EMPTY_MEDIA_META", () => {
  it("an all-null struct is not a probe result", () => {
    expect(isEmptyMediaMeta(EMPTY_MEDIA_META)).toBe(true);
    expect(isEmptyMediaMeta({ ...EMPTY_MEDIA_META })).toBe(true);
  });

  it("has_audio: Some(false) is still a finding, not emptiness", () => {
    expect(isEmptyMediaMeta({ ...EMPTY_MEDIA_META, hasAudio: false })).toBe(false);
  });

  it("any single non-null field disqualifies emptiness", () => {
    expect(isEmptyMediaMeta({ ...EMPTY_MEDIA_META, durationSecs: 1 })).toBe(false);
    expect(isEmptyMediaMeta({ ...EMPTY_MEDIA_META, width: 100 })).toBe(false);
    expect(isEmptyMediaMeta({ ...EMPTY_MEDIA_META, videoCodec: "H.264" })).toBe(false);
  });
});

// ---------------------------------------------------------------------- codecName

describe("codecName", () => {
  it("names codecs the table knows", () => {
    expect(codecName("hvc1")).toBe("HEVC");
    expect(codecName("hev1")).toBe("HEVC");
    expect(codecName("avc1")).toBe("H.264");
    expect(codecName("avc3")).toBe("H.264");
    expect(codecName("vp09")).toBe("VP9");
    expect(codecName("av01")).toBe("AV1");
    expect(codecName("mp4v")).toBe("MPEG-4");
    expect(codecName("jpeg")).toBe("Motion JPEG");
    expect(codecName("aac")).toBe("AAC");
    expect(codecName("mp4a")).toBe("AAC");
    expect(codecName("mp3")).toBe("MP3");
    expect(codecName(".mp3")).toBe("MP3");
    expect(codecName("lpcm")).toBe("Linear PCM");
    expect(codecName("alac")).toBe("Apple Lossless");
    expect(codecName("opus")).toBe("Opus");
    for (const prores of ["apch", "apcn", "apcs", "apco", "ap4h", "ap4x"]) {
      expect(codecName(prores)).toBe("Apple ProRes");
    }
  });

  it("shows an unmapped tag verbatim rather than hiding it", () => {
    expect(codecName("xyzw")).toBe("xyzw");
  });

  it("a tag that collides with Object.prototype does not pollute it (rule 2)", () => {
    expect(codecName("__proto__")).toBe("__proto__");
    expect(codecName("constructor")).toBe("constructor");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ------------------------------------------------------------------- fourccString

describe("fourccString", () => {
  it("passes through printable-ASCII tags, trimmed", () => {
    expect(fourccString("avc1")).toBe("avc1");
    expect(fourccString("aac ")).toBe("aac");
    expect(fourccString(" hvc1 ")).toBe("hvc1");
  });

  it("rejects null/undefined/empty", () => {
    expect(fourccString(null)).toBeNull();
    expect(fourccString(undefined)).toBeNull();
    expect(fourccString("")).toBeNull();
    expect(fourccString("   ")).toBeNull();
  });

  it("rejects a tag with any non-printable-ASCII character", () => {
    expect(fourccString("abc")).toBeNull();
    expect(fourccString("abc")).toBeNull();
    expect(fourccString("café")).toBeNull();
  });

  it("rejects ffmpeg's own bracketed-decimal placeholder for an untagged stream", () => {
    expect(fourccString("[0][0][0][0]")).toBeNull();
    // WAV/AIFF PCM's numeric wFormatTag (1 = WAVE_FORMAT_PCM) — a real value,
    // just not a fourcc a viewer should show as one.
    expect(fourccString("[1][0][0][0]")).toBeNull();
  });
});

// ------------------------------------------------------------------ saneFrameRate

describe("saneFrameRate", () => {
  it("0 fps (AVFoundation/ffprobe's shape for 'container states none') reads as unknown", () => {
    expect(saneFrameRate(0)).toBeNull();
  });

  it("rejects negative, NaN, infinite and absurd values", () => {
    expect(saneFrameRate(-1)).toBeNull();
    expect(saneFrameRate(Number.NaN)).toBeNull();
    expect(saneFrameRate(Number.POSITIVE_INFINITY)).toBeNull();
    expect(saneFrameRate(1e6)).toBeNull();
  });

  it("accepts real frame rates, rounded to 2 decimals — including real slow motion", () => {
    expect(saneFrameRate(29.97)).toBe(29.97);
    expect(saneFrameRate(240)).toBe(240);
    expect(saneFrameRate(1000)).toBe(1000); // inclusive upper bound
    expect(saneFrameRate(23.976023976023978)).toBe(23.98);
  });
});

// -------------------------------------------------------------- parseFfprobeOutput

function ffprobeJson(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("parseFfprobeOutput", () => {
  it("malformed JSON probes to null, same as a file the engine refuses outright", () => {
    expect(parseFfprobeOutput("not json")).toBeNull();
    expect(parseFfprobeOutput("")).toBeNull();
    expect(parseFfprobeOutput("null")).toBeNull();
    expect(parseFfprobeOutput("42")).toBeNull();
    expect(parseFfprobeOutput("[]")).toBeNull();
  });

  it("no video and no audio stream at all is the Rust '0 tracks' guard: null, not zeros", () => {
    expect(parseFfprobeOutput(ffprobeJson({}))).toBeNull();
    expect(parseFfprobeOutput(ffprobeJson({ streams: [], format: {} }))).toBeNull();
    expect(
      parseFfprobeOutput(ffprobeJson({ streams: [{ codec_type: "subtitle" }], format: {} }))
    ).toBeNull();
  });

  it("a real single-video-stream file (this app's own wallpaper fixture, captured verbatim)", () => {
    // Actual `ffprobe -show_format -show_streams` output for the Sonoma
    // wallpaper .mov this migration's real end-to-end test also uses —
    // captured once so this case is exercised without a subprocess.
    const real = ffprobeJson({
      streams: [
        {
          codec_name: "hevc",
          codec_type: "video",
          codec_tag_string: "hvc1",
          codec_tag: "0x31637668",
          width: 3840,
          height: 2160,
          r_frame_rate: "240/1",
          avg_frame_rate: "240/1",
          duration: "90.000000",
          bit_rate: "7295358",
        },
      ],
      format: { duration: "90.000000" },
    });
    expect(parseFfprobeOutput(real)).toEqual<MediaMeta>({
      durationSecs: 90,
      width: 3840,
      height: 2160,
      videoCodec: "HEVC",
      frameRate: 240,
      bitrateKbps: 7295,
      hasAudio: false,
      audioCodec: null,
    });
  });

  it("video with audio: hasAudio true and the audio codec named from its own tag", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [
          { codec_type: "video", codec_tag_string: "avc1", width: 640, height: 360, r_frame_rate: "30/1" },
          { codec_type: "audio", codec_tag_string: "mp4a" },
        ],
        format: { duration: "5.0" },
      })
    );
    expect(out?.hasAudio).toBe(true);
    expect(out?.audioCodec).toBe("AAC");
    expect(out?.videoCodec).toBe("H.264");
  });

  it("audio-only file: hasAudio true, every video-only field stays null", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [{ codec_type: "audio", codec_tag_string: "aac " }],
        format: { duration: "12.5" },
      })
    );
    expect(out).toEqual<MediaMeta>({
      ...EMPTY_MEDIA_META,
      durationSecs: 12.5,
      hasAudio: true,
      audioCodec: "AAC",
    });
  });

  it("a portrait rotation (side_data_list, the newer shape) swaps width and height", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
          },
        ],
        format: {},
      })
    );
    expect(out?.width).toBe(1080);
    expect(out?.height).toBe(1920);
  });

  it("a portrait rotation (tags.rotate, the older shape) also swaps width and height", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [
          { codec_type: "video", width: 1920, height: 1080, tags: { rotate: "90" } },
        ],
        format: {},
      })
    );
    expect(out?.width).toBe(1080);
    expect(out?.height).toBe(1920);
  });

  it("a 180-degree rotation does NOT swap width and height", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [{ codec_type: "video", width: 1920, height: 1080, tags: { rotate: "180" } }],
        format: {},
      })
    );
    expect(out?.width).toBe(1920);
    expect(out?.height).toBe(1080);
  });

  it("no rotation stated leaves width/height as the container's own coded size", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({ streams: [{ codec_type: "video", width: 1920, height: 1080 }], format: {} })
    );
    expect(out?.width).toBe(1920);
    expect(out?.height).toBe(1080);
  });

  it("a stream with no positive width/height reports no display size, not zeros", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({ streams: [{ codec_type: "video" }], format: {} })
    );
    expect(out?.width).toBeNull();
    expect(out?.height).toBeNull();
  });

  it("r_frame_rate '0/0' (ffprobe's own 'no value' shape) falls back to avg_frame_rate", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [
          { codec_type: "video", width: 10, height: 10, r_frame_rate: "0/0", avg_frame_rate: "25/1" },
        ],
        format: {},
      })
    );
    expect(out?.frameRate).toBe(25);
  });

  it("both frame-rate fields absent or unusable leaves frameRate null", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({ streams: [{ codec_type: "video", width: 10, height: 10 }], format: {} })
    );
    expect(out?.frameRate).toBeNull();
  });

  it("a fractional NTSC frame rate rounds to 2 decimals, same bound as saneFrameRate", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [{ codec_type: "video", width: 10, height: 10, r_frame_rate: "30000/1001" }],
        format: {},
      })
    );
    expect(out?.frameRate).toBe(29.97);
  });

  it("bit_rate 'N/A' (ffprobe's own unknown marker) leaves bitrateKbps null, not NaN", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [{ codec_type: "video", width: 10, height: 10, bit_rate: "N/A" }],
        format: {},
      })
    );
    expect(out?.bitrateKbps).toBeNull();
  });

  it("format.duration 'N/A' leaves durationSecs null rather than NaN or 0", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({ streams: [{ codec_type: "video", width: 10, height: 10 }], format: { duration: "N/A" } })
    );
    expect(out?.durationSecs).toBeNull();
  });

  it("no fourcc tag at all falls back to ffprobe's own codec_name, verbatim — the WAV/PCM case", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({
        streams: [
          {
            codec_type: "audio",
            codec_name: "pcm_s16le",
            codec_tag_string: "[1][0][0][0]",
          },
        ],
        format: { duration: "1.0" },
      })
    );
    // NOT "Linear PCM" — see mediaProbe.ts's trackCodec doc for why this is a
    // deliberate, documented deviation rather than a bug.
    expect(out?.audioCodec).toBe("pcm_s16le");
  });

  it("an unmapped-but-real fourcc tag is shown verbatim, same as the Rust table's default arm", () => {
    const out = parseFfprobeOutput(
      ffprobeJson({ streams: [{ codec_type: "video", width: 10, height: 10, codec_tag_string: "xvid" }], format: {} })
    );
    expect(out?.videoCodec).toBe("xvid");
  });
});

// ----------------------------------------------------------- findFfmpeg / findFfprobe

describe("findFfmpeg / findFfprobe", () => {
  it("returns null when nothing on the checked paths is a file", () => {
    expect(findFfmpeg({ isFile: () => false, pathEnv: "" })).toBeNull();
    expect(findFfprobe({ isFile: () => false, pathEnv: "" })).toBeNull();
  });

  it("prefers the explicit Homebrew/MacPorts paths over PATH, which a GUI app lacks", () => {
    const seen: string[] = [];
    const found = findFfprobe({
      isFile: (p) => {
        seen.push(p);
        return p === "/opt/local/bin/ffprobe" || p === "/somewhere/on/path/ffprobe";
      },
      pathEnv: "/somewhere/on/path",
    });
    expect(found).toBe("/opt/local/bin/ffprobe");
    expect(seen.slice(0, 3)).toEqual([
      "/opt/homebrew/bin/ffprobe",
      "/usr/local/bin/ffprobe",
      "/opt/local/bin/ffprobe",
    ]);
  });

  it("falls back to PATH when none of the explicit paths has one", () => {
    expect(
      findFfmpeg({ isFile: (p) => p === "/somewhere/ffmpeg", pathEnv: "/nope:/somewhere" })
    ).toBe("/somewhere/ffmpeg");
  });

  it("ffmpeg and ffprobe are searched independently — one present does not imply the other", () => {
    expect(
      findFfprobe({ isFile: (p) => p.endsWith("/ffmpeg"), pathEnv: "" })
    ).toBeNull();
  });
});

// -------------------------------------------------------------- temp hygiene

describe("writePrivate / removeQuietly", () => {
  it("writes owner-only (0o600) and creation fails if the path already exists", () => {
    const p = path.join(os.tmpdir(), `arcelle-probe-privtest-${randomUUID()}`);
    expect(writePrivate(p, Buffer.from("secret"))).toBe(true);
    try {
      const mode = fs.statSync(p).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(fs.readFileSync(p, "utf8")).toBe("secret");
      // create_new(true): a second write to the same path must fail, not
      // silently overwrite.
      expect(writePrivate(p, Buffer.from("overwrite"))).toBe(false);
    } finally {
      removeQuietly(p);
    }
  });

  it("removeQuietly on a path that was never created is a silent no-op", () => {
    expect(() => removeQuietly(path.join(os.tmpdir(), `arcelle-probe-nope-${randomUUID()}`))).not.toThrow();
  });
});

// ------------------------------------------------------------------- probePath

describe("probePath", () => {
  it("a zero-byte file probes to null without ever calling the engine", async () => {
    const p = path.join(os.tmpdir(), `arcelle-probe-empty-${randomUUID()}`);
    fs.writeFileSync(p, Buffer.alloc(0));
    let called = false;
    const engine: ProbeEngine = async () => {
      called = true;
      return { ...EMPTY_MEDIA_META, hasAudio: true };
    };
    try {
      expect(await probePath(p, engine)).toBeNull();
      expect(called).toBe(false);
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("a missing file reads as size 0 — unwrap_or(0) — and never calls the engine", async () => {
    let called = false;
    const engine: ProbeEngine = async () => {
      called = true;
      return null;
    };
    const missing = path.join(os.tmpdir(), `arcelle-probe-missing-${randomUUID()}`);
    expect(await probePath(missing, engine)).toBeNull();
    expect(called).toBe(false);
  });

  it("a non-empty file is handed to the engine, and the engine's answer is returned as-is", async () => {
    const p = path.join(os.tmpdir(), `arcelle-probe-nonempty-${randomUUID()}`);
    fs.writeFileSync(p, Buffer.from("bytes"));
    const meta: MediaMeta = { ...EMPTY_MEDIA_META, durationSecs: 3, hasAudio: false };
    const engine: ProbeEngine = async (fp) => {
      expect(fp).toBe(p);
      return meta;
    };
    try {
      expect(await probePath(p, engine)).toEqual(meta);
    } finally {
      fs.unlinkSync(p);
    }
  });
});

// ------------------------------------------------------------------ probeBytes

describe("probeBytes", () => {
  it("empty bytes probe to null without writing anything", async () => {
    let called = false;
    const engine: ProbeEngine = async () => {
      called = true;
      return null;
    };
    expect(await probeBytes(Buffer.alloc(0), "mp4", engine)).toBeNull();
    expect(called).toBe(false);
  });

  it("stages bytes to a temp file the engine can open, and always removes it", async () => {
    let seenPath = "";
    let existedDuringCall = false;
    const engine: ProbeEngine = async (fp) => {
      seenPath = fp;
      existedDuringCall = fs.existsSync(fp);
      return { ...EMPTY_MEDIA_META, hasAudio: true };
    };
    const meta = await probeBytes(Buffer.from("video bytes"), "mp4", engine);
    expect(meta).toEqual({ ...EMPTY_MEDIA_META, hasAudio: true });
    expect(existedDuringCall).toBe(true);
    expect(seenPath.endsWith(".mp4")).toBe(true);
    expect(fs.existsSync(seenPath)).toBe(false);
  });

  it("no extension still probes, without a trailing dot in the temp name", async () => {
    let seenPath = "";
    const engine: ProbeEngine = async (fp) => {
      seenPath = fp;
      return null;
    };
    await probeBytes(Buffer.from("bytes"), "", engine);
    expect(seenPath.includes(".")).toBe(false);
    expect(fs.existsSync(seenPath)).toBe(false);
  });

  it("removes the temp file even when the engine throws", async () => {
    let seenPath = "";
    const engine: ProbeEngine = async (fp) => {
      seenPath = fp;
      throw new Error("engine exploded");
    };
    await expect(probeBytes(Buffer.from("bytes"), "mp4", engine)).rejects.toThrow("engine exploded");
    expect(fs.existsSync(seenPath)).toBe(false);
  });

  it("leaves no decrypted copy behind across repeated calls (Rust's own leak check)", async () => {
    const leftovers = () =>
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("arcelle-probe-") && n.endsWith(".probetest")).length;
    expect(leftovers()).toBe(0);
    await probeBytes(Buffer.from("secret video bytes"), "probetest", async () => null);
    expect(leftovers()).toBe(0);
  });
});

// ----------------------------------------------------------------- lastFramePng

describe("lastFramePng", () => {
  it("empty bytes resolve to null without writing anything", async () => {
    let called = false;
    const engine: LastFrameEngine = async () => {
      called = true;
      return null;
    };
    expect(await lastFramePng(Buffer.alloc(0), "mov", engine)).toBeNull();
    expect(called).toBe(false);
  });

  it("stages bytes for the engine and always removes the staged copy", async () => {
    let seenPath = "";
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const engine: LastFrameEngine = async (fp) => {
      seenPath = fp;
      expect(fs.existsSync(fp)).toBe(true);
      return png;
    };
    const out = await lastFramePng(Buffer.from("clip bytes"), "mov", engine);
    expect(out).toEqual(png);
    expect(seenPath.endsWith(".mov")).toBe(true);
    expect(fs.existsSync(seenPath)).toBe(false);
  });

  it("a codec the engine cannot decode resolves null, and still cleans up", async () => {
    let seenPath = "";
    const engine: LastFrameEngine = async (fp) => {
      seenPath = fp;
      return null;
    };
    expect(await lastFramePng(Buffer.from("webm bytes"), "webm", engine)).toBeNull();
    expect(fs.existsSync(seenPath)).toBe(false);
  });

  it("leaves no decrypted copy behind even when the engine throws", async () => {
    let seenPath = "";
    const engine: LastFrameEngine = async (fp) => {
      seenPath = fp;
      throw new Error("boom");
    };
    await expect(lastFramePng(Buffer.from("bytes"), "endframetest", engine)).rejects.toThrow("boom");
    expect(fs.existsSync(seenPath)).toBe(false);
  });
});

// =============================================================================
// REAL end-to-end tests — genuine subprocess calls against a genuine video
// file, never mocked. Skipped (not failed) on a machine with no ffmpeg: that
// is a fact about the machine, same as the Rust suite's own
// `test_fixture`/`eprintln!("skipped: …")` convention for the Sonoma
// wallpaper .mov this same repo's Rust tests reach for.
//
// This engine's fixture is synthesized with `ffmpeg -f lavfi` instead of
// trimming that wallpaper: lavfi's `testsrc`/`sine` sources build a real,
// deterministic clip from nothing on disk, which is a strictly better fit for
// an engine that already depends on ffmpeg being present — no dependency on
// which macOS version (and therefore which wallpaper file) happens to be
// installed. Nothing binary is checked into the repo either way.
// =============================================================================

const HAVE_FFMPEG = findFfmpeg() !== null && findFfprobe() !== null;
const tempFixtures: string[] = [];

async function makeRealClip(opts: { silent?: boolean; seconds?: number } = {}): Promise<string> {
  const ffmpeg = findFfmpeg();
  if (ffmpeg === null) throw new Error("no ffmpeg — guarded by HAVE_FFMPEG");
  const seconds = opts.seconds ?? 1;
  const out = path.join(os.tmpdir(), `arcelle-probe-e2e-${randomUUID()}.mp4`);
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=160x90:rate=25:duration=${seconds}`,
  ];
  if (!opts.silent) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (!opts.silent) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  const ok = await new Promise<boolean>((resolve) => {
    execFile(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 }, (error) => resolve(error === null));
  });
  if (!ok) throw new Error("ffmpeg fixture build failed");
  tempFixtures.push(out);
  return out;
}

afterAll(async () => {
  await Promise.all(tempFixtures.map((f) => fsp.rm(f, { force: true })));
});

describe.skipIf(!HAVE_FFMPEG)("real ffprobe end-to-end", () => {
  it("a real clip reports the facts it has, through a real ffprobe subprocess", async () => {
    const clip = await makeRealClip({ seconds: 1 });
    const bytes = await fsp.readFile(clip);
    const meta = await probeBytes(bytes, "mp4", ffprobeEngine);
    expect(meta).not.toBeNull();
    expect(meta?.durationSecs).not.toBeNull();
    expect(Math.abs((meta?.durationSecs ?? 0) - 1)).toBeLessThan(0.3);
    expect(meta?.width).toBe(160);
    expect(meta?.height).toBe(90);
    expect(meta?.videoCodec).toBe("H.264");
    expect(meta?.hasAudio).toBe(true);
    expect(meta?.audioCodec).toBe("AAC");
    expect(meta?.frameRate).toBe(25);
  });

  it("a video-only clip is a FINDING (hasAudio: false), not an unknown", async () => {
    const clip = await makeRealClip({ silent: true, seconds: 1 });
    const bytes = await fsp.readFile(clip);
    const meta = await probeBytes(bytes, "mp4", ffprobeEngine);
    expect(meta?.hasAudio).toBe(false);
    expect(meta?.audioCodec).toBeNull();
  });

  it("a non-media file probes to null through the real engine, not a crash or zeros", async () => {
    expect(await probeBytes(Buffer.from("this is not a video"), "mp4", ffprobeEngine)).toBeNull();
    expect(await probeBytes(Buffer.alloc(0), "mp4", ffprobeEngine)).toBeNull();
    expect(await probePath(path.join(os.tmpdir(), `arcelle-nope-${randomUUID()}.mp4`), ffprobeEngine)).toBeNull();
  });

  it("probePath reads a real file in place — no temp copy involved", async () => {
    const clip = await makeRealClip({ seconds: 1 });
    const meta = await probePath(clip, ffprobeEngine);
    expect(meta?.width).toBe(160);
  });
});

describe.skipIf(!HAVE_FFMPEG)("real ffmpeg last-frame end-to-end", () => {
  it("extracts a genuine PNG of the clip's last frame", async () => {
    const clip = await makeRealClip({ seconds: 1 });
    const bytes = await fsp.readFile(clip);
    const png = await lastFramePng(bytes, "mp4", ffmpegLastFrameEngine);
    expect(png).not.toBeNull();
    expect(png?.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it("a non-video source resolves null rather than a fabricated frame", async () => {
    const png = await lastFramePng(Buffer.from("not a video"), "mp4", ffmpegLastFrameEngine);
    expect(png).toBeNull();
  });

  it("leaves no decrypted copy behind on either path", async () => {
    const leftovers = () =>
      fs
        .readdirSync(os.tmpdir())
        .filter((n) => n.startsWith("arcelle-endframe-") && n.endsWith(".e2etest")).length;
    expect(leftovers()).toBe(0);
    const clip = await makeRealClip({ seconds: 1 });
    const bytes = await fsp.readFile(clip);
    await lastFramePng(bytes, "e2etest", ffmpegLastFrameEngine);
    expect(leftovers()).toBe(0);
    await lastFramePng(Buffer.from("garbage"), "e2etest", ffmpegLastFrameEngine);
    expect(leftovers()).toBe(0);
  });
});

// =============================================================================
// ADVERSARIAL — malformed media, corrupt containers, and boundary durations
// =============================================================================
//
// `probe_bytes`'s own Rust doc calls the input "bytes that live encrypted in
// the room", and rooms hold whatever the user imported or downloaded. The
// module's central promise is that an unreadable file probes to `null` rather
// than to a struct full of plausible-looking zeros — "0 x 0, 0 s is a claim,
// and it would be a false one" (media_probe.rs, verbatim). These press on
// exactly that.

describe("parseFfprobeOutput, adversarial documents", () => {
  it("a JSON document that is not an object at all probes to null", () => {
    for (const raw of ["[]", '"a string"', "42", "null", "true", ""]) {
      expect(parseFfprobeOutput(raw), raw).toBeNull();
    }
  });

  it("streams of the wrong JSON shape are ignored rather than trusted", () => {
    expect(parseFfprobeOutput('{"streams": "not an array"}')).toBeNull();
    expect(parseFfprobeOutput('{"streams": [1, 2, 3]}')).toBeNull();
    expect(parseFfprobeOutput('{"streams": [{"codec_type": "subtitle"}]}')).toBeNull();
  });

  it("a '__proto__'-shaped codec tag neither pollutes Object.prototype nor renames a codec (rule 2)", () => {
    // The lookup table is a Map for exactly this reason: a `{}` literal keyed
    // by a container's own tag string answers "__proto__" with an object.
    const before = ({} as Record<string, unknown>).polluted;
    const doc = JSON.stringify({
      streams: [{ codec_type: "video", codec_tag_string: "__proto__", width: 4, height: 4 }],
      format: { duration: "1.0" },
    });
    const meta = parseFfprobeOutput(doc);
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(Object.prototype).not.toHaveProperty("polluted");
    // Not in the table, so shown verbatim — a fact about our table, not the file.
    expect(meta!.videoCodec).toBe("__proto__");
    expect(typeof meta!.videoCodec).toBe("string");

    const ctor = parseFfprobeOutput(
      JSON.stringify({
        streams: [{ codec_type: "video", codec_tag_string: "constructor", width: 4, height: 4 }],
      })
    );
    expect(ctor!.videoCodec).toBe("constructor");
  });

  it("a stream that states nothing but its type still answers hasAudio honestly", () => {
    // The one field that is a FINDING rather than an unknown once a track
    // list has been read — Rust's `has_audio: Some(!audio_tracks.is_empty())`.
    const meta = parseFfprobeOutput('{"streams": [{"codec_type": "video"}]}');
    expect(meta).not.toBeNull();
    expect(meta!.hasAudio).toBe(false);
    expect(meta!.width).toBeNull();
    expect(meta!.height).toBeNull();
    expect(meta!.durationSecs).toBeNull();
    expect(meta!.frameRate).toBeNull();
    expect(meta!.bitrateKbps).toBeNull();
  });

  it("negative, zero and absurd numbers never become a reported fact", () => {
    const meta = parseFfprobeOutput(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: -1920,
            height: 0,
            r_frame_rate: "-30/1",
            bit_rate: "-4000000",
          },
        ],
        format: { duration: "-12.5" },
      })
    );
    expect(meta!.width).toBeNull();
    expect(meta!.height).toBeNull();
    expect(meta!.frameRate).toBeNull();
    expect(meta!.bitrateKbps).toBeNull();
    expect(meta!.durationSecs).toBeNull();
  });

  it("a rotation that is not a quarter turn rounds to the nearest one rather than producing a fraction", () => {
    // The named, narrow fidelity loss in this module's own ENGINE SWAP doc.
    // What matters is that the answer stays a whole pixel count either way.
    for (const rotation of [-91, 89, 271, 44, 46, 180.4]) {
      const meta = parseFfprobeOutput(
        JSON.stringify({
          streams: [
            { codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation }] },
          ],
        })
      );
      expect(Number.isInteger(meta!.width), `${rotation}`).toBe(true);
      expect(Number.isInteger(meta!.height), `${rotation}`).toBe(true);
      expect([1920, 1080]).toContain(meta!.width);
      expect([1920, 1080]).toContain(meta!.height);
    }
  });

  it("a NaN or infinite rotation is not a rotation", () => {
    const meta = parseFfprobeOutput(
      JSON.stringify({
        streams: [
          { codec_type: "video", width: 1920, height: 1080, tags: { rotate: "not-a-number" } },
        ],
      })
    );
    expect(meta!.width).toBe(1920);
    expect(meta!.height).toBe(1080);
  });
});

describe.skipIf(!HAVE_FFMPEG)("real ffprobe/ffmpeg, adversarial media", () => {
  it("a TRUNCATED real clip is never reported as a complete one", async () => {
    // Half a real MP4: the moov atom is gone, so a container that cannot be
    // read must answer null, and a container that CAN be partly read must not
    // report a fabricated size or a zero duration.
    const clip = await makeRealClip({ seconds: 2 });
    const whole = await fsp.readFile(clip);
    for (const fraction of [0.02, 0.25, 0.5, 0.9]) {
      const cut = whole.subarray(0, Math.floor(whole.length * fraction));
      const meta = await probeBytes(cut, "mp4", ffprobeEngine);
      if (meta === null) continue; // the honest answer for an unreadable file
      // Whatever it DID read must be a real fact, never a plausible zero.
      if (meta.durationSecs !== null) expect(meta.durationSecs).toBeGreaterThan(0);
      if (meta.width !== null) expect(meta.width).toBeGreaterThan(0);
      if (meta.height !== null) expect(meta.height).toBeGreaterThan(0);
      if (meta.frameRate !== null) expect(meta.frameRate).toBeGreaterThan(0);
      if (meta.bitrateKbps !== null) expect(meta.bitrateKbps).toBeGreaterThan(0);
      expect(isEmptyMediaMeta(meta)).toBe(false);
    }
  }, 60000);

  it("a real clip whose bytes have been CORRUPTED mid-stream still never fabricates", async () => {
    const clip = await makeRealClip({ seconds: 1 });
    const whole = Buffer.from(await fsp.readFile(clip));
    // Scribble over the middle third — header intact, payload nonsense.
    whole.fill(0xa5, Math.floor(whole.length / 3), Math.floor((whole.length * 2) / 3));
    const meta = await probeBytes(whole, "mp4", ffprobeEngine);
    if (meta !== null) {
      if (meta.durationSecs !== null) expect(meta.durationSecs).toBeGreaterThan(0);
      if (meta.width !== null) expect(meta.width).toBeGreaterThan(0);
    }
    // And the staged copy is gone either way.
    const leaked = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("arcelle-probe-") && n.endsWith(".mp4") && !n.includes("e2e"));
    expect(leaked).toEqual([]);
  }, 60000);

  it("a plain text file wearing a .mov extension probes to null, not to zeros", async () => {
    // media_probe.rs's own `a_non_media_file_probes_to_nothing`, end to end.
    await expect(probeBytes(Buffer.from("this is not a video"), "mov", ffprobeEngine)).resolves.toBeNull();
    await expect(probeBytes(Buffer.from("%PDF-1.7\n%âãÏÓ\n"), "mp4", ffprobeEngine)).resolves.toBeNull();
    await expect(probeBytes(Buffer.alloc(4096), "mp4", ffprobeEngine)).resolves.toBeNull();
  }, 60000);

  it("a clip that is a SINGLE FRAME long reports a real, positive duration — not null, not zero", async () => {
    // The boundary the `secs > 0.0` guard sits on: 1/25 s is the shortest
    // clip this fixture generator can make, and it is still a real duration.
    const clip = await makeRealClip({ seconds: 0.04, silent: true });
    const meta = await probePath(clip);
    expect(meta).not.toBeNull();
    expect(meta!.durationSecs).not.toBeNull();
    expect(meta!.durationSecs!).toBeGreaterThan(0);
    expect(meta!.durationSecs!).toBeLessThan(1);
    expect(meta!.width).toBe(160);
    expect(meta!.height).toBe(90);
    expect(meta!.hasAudio).toBe(false);
  }, 60000);

  it("lastFramePng on a truncated clip answers null or a REAL png — never a half-written file", async () => {
    const clip = await makeRealClip({ seconds: 1 });
    const whole = await fsp.readFile(clip);
    const png = await lastFramePng(whole.subarray(0, Math.floor(whole.length / 10)), "mp4", ffmpegLastFrameEngine);
    if (png !== null) {
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(png.length).toBeGreaterThan(8);
    }
    // The engine's own scratch PNG never survives the call.
    const leaked = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("arcelle-lastframe-"));
    expect(leaked).toEqual([]);
  }, 60000);
});
