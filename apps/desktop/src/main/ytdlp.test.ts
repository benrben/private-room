/**
 * Unit tests for `ytdlp.ts` — everything that can be settled without a real
 * yt-dlp binary and without touching the network.
 *
 * WHAT IS FAKED HERE, AND WHY (the real-subprocess pass lives in the sibling
 * `ytdlp.wire.test.ts`, which drives the ACTUAL yt-dlp against a REAL
 * loopback HTTP server):
 *   - `node:child_process` is NOT module-mocked. Every subprocess-driving
 *     function takes an injectable {@link SpawnFn}, so the branches a real
 *     process cannot be made to hit on demand — a spawn error, an arbitrary
 *     exit code, a process that never exits, a downloader that goes silent
 *     forever — are driven by a scripted `FakeProcess` (an `EventEmitter`
 *     with real `PassThrough` stdio, so the module's real `data`/`line`/
 *     `error`/`close` wiring runs unmodified).
 *   - `ensureYtdlp`'s GitHub binary fetch is never exercised for real. Doing
 *     so would pull a ~35 MB asset from GitHub Releases on every test run for
 *     no added confidence; it is covered against an injected `FetchLike`
 *     (streamed fake chunks) with REAL fs writes, `.part` cleanup, chmod and
 *     rename.
 *   - The SSRF pre-flight (`browser/guard.ts`) is the REAL one, never stubbed.
 *     Tests that need it to pass use the literal address `8.8.8.8`, which
 *     `dns.lookup` answers from the string itself with no DNS query — so
 *     these stay fast and work with no network at all.
 */

import { EventEmitter } from "node:events";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CancelFlag } from "./cancel.js";
import type { ChunkReader } from "./sidecar.js";
import type { FileMeta } from "../shared/apiTypes.js";
import {
  CANCEL_POLL_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_YTDLP_BYTES,
  MEDIA_CANCEL,
  MEDIA_DOWNLOAD_BUDGET_MS,
  MIN_YTDLP_BYTES,
  WEB_OFF_MESSAGE,
  YTDLP_STALE_AFTER_MS,
  YTDLP_UPDATE_BUDGET_MS,
  armMediaCancel,
  cancelMediaDownload,
  downloadMediaToTemp,
  ensureYtdlp,
  explainDownloadFailure,
  findFfmpeg,
  formatSelector,
  importMediaUrl,
  importYoutubeVideo,
  listMediaFormats,
  looksLikeMacosBinary,
  mediaProgressToEventSender,
  parseYtdlpPercent,
  parseYtdlpTotalBytes,
  probeMediaFormats,
  pumpDownloadProgress,
  qualityOptions,
  refreshYtdlpIfStale,
  runCapturing,
  runYtdlpDownload,
  tailLines,
  youtubeVideoId,
  ytdlpPath,
  type FetchLike,
  type HttpResponseLike,
  type ImportDownloadFn,
  type SpawnFn,
  type SpawnedProcess,
} from "./ytdlp.js";

// ------------------------------------------------------------------- fakes

/** A scriptable stand-in for {@link SpawnedProcess}: an `EventEmitter` with
 * real `PassThrough` stdio, so the module's real stream handling runs against
 * it unmodified. */
class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    // A real process, once signalled, ends its stdio and then emits 'close'.
    // A fake that never followed through would HANG every cancel/budget/
    // oversize test (they all kill and then await the close) instead of
    // failing them honestly.
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, "SIGTERM");
    });
    return true;
  }
}

function fakeChunkReader(chunks: Uint8Array[]): ChunkReader {
  let i = 0;
  return {
    read: async () => {
      if (i >= chunks.length) return { done: true };
      return { done: false, value: chunks[i++] as Uint8Array };
    },
  };
}

function fakeFetchOk(chunks: Uint8Array[], contentLength?: number): FetchLike {
  return async (): Promise<HttpResponseLike> => ({
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-length" && contentLength !== undefined
          ? String(contentLength)
          : null,
    },
    body: { getReader: () => fakeChunkReader(chunks) },
  });
}

/** A real Mach-O magic header padded out to `size` bytes. */
function fakeBinaryBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  buf.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  return buf;
}

async function mkTempDir(prefix = "ytdlp-test-"): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A data dir with a placeholder binary already installed and freshly
 * stamped, so `ensureYtdlp` takes its already-installed fast path: no fetch,
 * no `-U`, letting a test isolate the caller's own orchestration. */
async function withInstalledBin<T>(fn: (dataDir: string) => Promise<T>): Promise<T> {
  const dataDir = await mkTempDir();
  try {
    const dest = ytdlpPath(dataDir);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, "placeholder-binary");
    return await fn(dataDir);
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * End a fake's stdio and THEN report 'close', with real turns of the event
 * loop in between — exactly the order Node guarantees for a real child (its
 * 'close' fires only once the stdio streams have closed).
 *
 * This is load-bearing, not ceremony: a fake that fired 'close' in the same
 * tick as its last stderr write would let the module read a tail `readline`
 * had not delivered yet, and the stderr-tail assertions would be green
 * whether or not the concurrent drain worked.
 */
async function closeFake(fake: FakeProcess, code: number | null): Promise<void> {
  fake.stdout.end();
  fake.stderr.end();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  fake.emit("close", code, null);
}

/** A literal PUBLIC address: `checkPublicHttpUrl` lets it through and
 * `dns.lookup` answers it from the string itself, so the REAL SSRF guard runs
 * with no DNS query and no network. */
const PUBLIC_URL = "https://8.8.8.8/video";

const FILE_META: FileMeta = {
  id: "f1",
  name: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: 64,
  source: "download",
  hasText: false,
  createdAt: "2026-08-22T00:00:00.000Z",
  folderId: null,
  partiallyIndexed: false,
  aiSummary: null,
  originDestination: "library",
  libraryVisibility: "linked",
};

// =====================================================================
// Pure functions — ported from ytdlp.rs's own #[cfg(test)] module
// =====================================================================

describe("looksLikeMacosBinary", () => {
  it("accepts Mach-O 64/32-bit and both byte orders of a universal binary", () => {
    expect(looksLikeMacosBinary(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x07]))).toBe(true);
    expect(looksLikeMacosBinary(new Uint8Array([0xce, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(looksLikeMacosBinary(new Uint8Array([0xca, 0xfe, 0xba, 0xbe]))).toBe(true);
    expect(looksLikeMacosBinary(new Uint8Array([0xbe, 0xba, 0xfe, 0xca]))).toBe(true);
  });

  it("rejects an error page, a zip, a truncated body, and nothing at all", () => {
    expect(looksLikeMacosBinary(new TextEncoder().encode("<!DOCTYPE html>"))).toBe(false);
    expect(looksLikeMacosBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false); // "PK\x03\x04"
    expect(looksLikeMacosBinary(new Uint8Array([0xcf, 0xfa]))).toBe(false);
    expect(looksLikeMacosBinary(new Uint8Array([]))).toBe(false);
  });
});

describe("parseYtdlpPercent", () => {
  it("parses progress lines and ignores noise", () => {
    expect(parseYtdlpPercent("[download]  42.7% of 12.3MiB at 1.2MiB/s")).toBe(42.7);
    expect(parseYtdlpPercent("[download] 100% of 5MiB")).toBe(100);
    expect(parseYtdlpPercent("[youtube] abc: Downloading webpage")).toBeNull();
    expect(parseYtdlpPercent("[download] Destination: x.mp4")).toBeNull();
    expect(parseYtdlpPercent("")).toBeNull();
  });

  it("a bare '%' token is not 0% progress", () => {
    // `Number("")` is 0 where Rust's `.parse::<f64>()` is an error — reporting
    // a percent-less line as 0% would rewind a progress bar mid-download.
    expect(parseYtdlpPercent("[download] % of 5MiB")).toBeNull();
    expect(parseYtdlpPercent("[download] abc% of 5MiB")).toBeNull();
  });
});

describe("parseYtdlpTotalBytes", () => {
  it("reads the total off a progress line, and 'of' noise never parses as a size", () => {
    const mib = 1024 * 1024;
    expect(parseYtdlpTotalBytes("[download]  42.7% of 12.3MiB at 1.2MiB/s")).toBe(
      Math.trunc(12.3 * mib)
    );
    // HLS totals arrive as estimates, both spellings.
    expect(parseYtdlpTotalBytes("[download]   0.1% of ~ 871.20MiB at 11.33MiB/s")).toBe(
      Math.trunc(871.2 * mib)
    );
    expect(parseYtdlpTotalBytes("[download]   0.1% of ~4.71GiB at 1MiB/s")).toBe(
      Math.trunc(4.71 * 1024 * mib)
    );
    expect(parseYtdlpTotalBytes("[download] 100% of 246.27KiB in 00:00:00")).toBe(
      Math.trunc(246.27 * 1024)
    );
    // A false positive here aborts a legitimate download.
    expect(parseYtdlpTotalBytes("[download] Downloading fragment 1 of 100")).toBeNull();
    expect(parseYtdlpTotalBytes("[download] Got error. Retrying (attempt 1 of 3)...")).toBeNull();
    expect(parseYtdlpTotalBytes("[download] 50% of 12.3TiB")).toBeNull(); // unknown unit
    expect(parseYtdlpTotalBytes("[youtube] abc: Downloading webpage")).toBeNull();
    expect(parseYtdlpTotalBytes("")).toBeNull();
  });
});

describe("tailLines", () => {
  it("keeps the LAST n lines, in their original order", () => {
    expect(tailLines("a\nb\nc\nd\n", 3)).toBe("b c d");
    expect(tailLines("only\n", 3)).toBe("only");
    expect(tailLines("", 3)).toBe("");
    expect(tailLines("a\r\nb\r\n", 3)).toBe("a b");
  });
});

describe("formatSelector", () => {
  it("offers merge branches exactly when ffmpeg exists, pre-muxed mp4 always first", () => {
    for (const height of [undefined, null, 720]) {
      expect(formatSelector(false, height)).not.toContain("+");
      expect(formatSelector(true, height)).toContain("+");
    }
    for (const selector of [formatSelector(false, null), formatSelector(true, null)]) {
      expect(selector.startsWith("b[ext=mp4]/")).toBe(true);
    }
  });

  it("leads with the chosen height and never strands the download", () => {
    for (const hasFfmpeg of [true, false]) {
      const capped = formatSelector(hasFfmpeg, 480);
      const free = formatSelector(hasFfmpeg, null);
      expect(capped.startsWith("b[ext=mp4][height<=480]")).toBe(true);
      expect(capped.endsWith(free)).toBe(true);
    }
  });

  it("never asks for a smaller file to fit the cap — the owner's no-downgrade rule", () => {
    for (const hasFfmpeg of [true, false]) {
      for (const h of [null, 1080]) {
        const selector = formatSelector(hasFfmpeg, h);
        expect(selector).not.toContain("filesize");
        expect(selector).not.toContain("worst");
      }
    }
  });
});

describe("qualityOptions", () => {
  const info = {
    formats: [
      { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", filesize: 50_000_000 },
      { format_id: "136", vcodec: "avc1.64001f", acodec: "none", height: 720, filesize: 400_000_000 },
      { format_id: "247", vcodec: "vp9", acodec: "none", height: 720, filesize: 300_000_000 },
      { format_id: "137", vcodec: "avc1.640028", acodec: "none", height: 1080, filesize_approx: 900_000_000 },
      { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, filesize: 80_000_000 },
      { format_id: "sb0", vcodec: "none", acodec: "none" },
    ],
  };

  it("folds heights honestly, best first, with and without ffmpeg", () => {
    const withFfmpeg = qualityOptions(info, true);
    expect(withFfmpeg.map((q) => q.height)).toEqual([1080, 720, 360]);
    // 1080p: 900 MB video + 50 MB audio = 950 MB — over the 900 MiB cap.
    expect(withFfmpeg[0]?.approxBytes).toBe(950_000_000);
    expect(withFfmpeg[0]?.fits).toBe(false);
    // 720p: the h264 size (400 MB), not vp9's smaller 300 MB — the downloader
    // will pick h264, and the estimate must match its pick.
    expect(withFfmpeg[1]?.approxBytes).toBe(450_000_000);
    expect(withFfmpeg[1]?.fits).toBe(true);
    // 360p is pre-muxed: its size already carries the audio — no add.
    expect(withFfmpeg[2]?.approxBytes).toBe(80_000_000);

    // Without ffmpeg only the pre-muxed 360p is downloadable, so it is the
    // only chip offered — a choice the downloader can't honor is a lie.
    const without = qualityOptions(info, false);
    expect(without.map((q) => q.height)).toEqual([360]);
    expect(without[0]?.approxBytes).toBe(80_000_000);

    expect(qualityOptions({}, true)).toEqual([]);
  });

  it("an unknown size is offered as fitting rather than refused on a guess", () => {
    const noSizes = { formats: [{ vcodec: "avc1", acodec: "mp4a", height: 720 }] };
    expect(qualityOptions(noSizes, true)).toEqual([{ height: 720, approxBytes: null, fits: true }]);
  });

  it("survives junk where an object or a number was expected", () => {
    expect(qualityOptions(null, true)).toEqual([]);
    expect(qualityOptions("nope", true)).toEqual([]);
    expect(qualityOptions({ formats: "nope" }, true)).toEqual([]);
    expect(
      qualityOptions({ formats: [null, 7, { vcodec: "avc1", acodec: "mp4a", height: "720" }] }, true)
    ).toEqual([]);
  });

  it("MAX_DOWNLOAD_BYTES is the 900 MiB the fits-math above assumes", () => {
    // Pinned so a future edit can't silently flip a `fits` verdict. NOTE for
    // the owner: the commissioning brief said 800 MB; `web/fetch.rs` says 900.
    expect(MAX_DOWNLOAD_BYTES).toBe(900 * 1024 * 1024);
  });
});

describe("explainDownloadFailure", () => {
  it("only the split-stream-without-ffmpeg failure gets install guidance", () => {
    const formatErr = "ERROR: [youtube] abc: Requested format is not available.";
    expect(explainDownloadFailure(formatErr, false)).toContain("brew install ffmpeg");
    // With ffmpeg present that error means something else — don't prescribe.
    expect(explainDownloadFailure(formatErr, true)).not.toContain("ffmpeg");
    const other = "ERROR: unable to download video data: HTTP Error 403: Forbidden";
    const explained = explainDownloadFailure(other, false);
    expect(explained).toContain(other);
    expect(explained).not.toContain("brew");
  });
});

describe("youtubeVideoId", () => {
  it("recognizes every URL shape the Rust test does", () => {
    const cases: Array<[string, string | null]> = [
      ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
      ["https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
      ["https://example.com/watch?v=dQw4w9WgXcQ", null],
      ["https://www.youtube.com/feed/history", null],
      ["not a url", null],
    ];
    for (const [url, want] of cases) {
      expect(youtubeVideoId(url), `for ${url}`).toBe(want);
    }
  });

  it("rejects an id outside the 8-16 char alnum/-/_ shape", () => {
    expect(youtubeVideoId("https://youtu.be/short")).toBeNull();
    expect(youtubeVideoId("https://youtu.be/waytoolongtobeavalidytid")).toBeNull();
    expect(youtubeVideoId("https://youtu.be/not!valid!")).toBeNull();
  });
});

describe("constants that encode a decision", () => {
  it("the downloader goes stale well before YouTube's observed breakage cadence", () => {
    expect(YTDLP_STALE_AFTER_MS).toBeLessThanOrEqual(21 * 24 * 60 * 60 * 1000);
    expect(YTDLP_STALE_AFTER_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(YTDLP_UPDATE_BUDGET_MS).toBeLessThan(MEDIA_DOWNLOAD_BUDGET_MS);
  });

  it("a media download is bounded and Stop is polled while the downloader is silent", () => {
    expect(MEDIA_DOWNLOAD_BUDGET_MS).toBeGreaterThan(0);
    expect(CANCEL_POLL_MS).toBeLessThan(1000);
    expect(CANCEL_POLL_MS).toBeLessThan(MEDIA_DOWNLOAD_BUDGET_MS);
    expect(MIN_YTDLP_BYTES).toBeLessThan(MAX_YTDLP_BYTES);
  });
});

describe("ytdlpPath", () => {
  it("lives under <dataDir>/bin/yt-dlp", () => {
    expect(ytdlpPath("/Users/x/Library/Application Support/Arcelle")).toBe(
      path.join("/Users/x/Library/Application Support/Arcelle", "bin", "yt-dlp")
    );
  });
});

describe("findFfmpeg", () => {
  it("returns null when nothing on the checked paths is a file", () => {
    expect(findFfmpeg({ isFile: () => false, pathEnv: "" })).toBeNull();
  });

  it("prefers the explicit Homebrew/MacPorts paths over PATH, which a GUI app lacks", () => {
    const seen: string[] = [];
    const found = findFfmpeg({
      isFile: (p) => {
        seen.push(p);
        return p === "/opt/local/bin/ffmpeg" || p === "/somewhere/on/path/ffmpeg";
      },
      pathEnv: "/somewhere/on/path",
    });
    expect(found).toBe("/opt/local/bin/ffmpeg");
    expect(seen.slice(0, 3)).toEqual([
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/opt/local/bin/ffmpeg",
    ]);
  });

  it("GH #29: finds Apple Silicon Homebrew ffmpeg even when the GUI PATH omits Homebrew", () => {
    expect(
      findFfmpeg({
        isFile: (p) => p === "/opt/homebrew/bin/ffmpeg",
        pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin",
      })
    ).toBe("/opt/homebrew/bin/ffmpeg");
  });

  it("falls back to PATH when none of the explicit paths has one", () => {
    expect(
      findFfmpeg({ isFile: (p) => p === "/somewhere/ffmpeg", pathEnv: "/nope:/somewhere" })
    ).toBe("/somewhere/ffmpeg");
  });
});

describe("mediaProgressToEventSender", () => {
  it("wraps status/percent into the ytdlp-progress wire shape", () => {
    const events: Array<[string, unknown]> = [];
    const progress = mediaProgressToEventSender((event, payload) => events.push([event, payload]));
    progress("Downloading the video…", 42.5);
    expect(events).toEqual([["ytdlp-progress", { status: "Downloading the video…", percent: 42.5 }]]);
  });

  it("swallows a send that throws, matching turn.ts's TurnId.emit", () => {
    const progress = mediaProgressToEventSender(() => {
      throw new Error("window is gone");
    });
    expect(() => progress("x", null)).not.toThrow();
  });
});

// =====================================================================
// media cancel
// =====================================================================

describe("media cancel: armed per download, never left latched", () => {
  it("a stale Stop cannot cancel the NEXT download", () => {
    // Port of `stop_is_armed_per_download_not_left_latched`: arm, confirm
    // clear, Stop, confirm set, arm again, confirm a fresh download starts
    // clean.
    armMediaCancel();
    expect(MEDIA_CANCEL.load()).toBe(false);
    cancelMediaDownload();
    expect(MEDIA_CANCEL.load()).toBe(true);
    armMediaCancel();
    expect(MEDIA_CANCEL.load()).toBe(false);
  });

  it("Stop is idempotent when nothing is downloading", () => {
    armMediaCancel();
    cancelMediaDownload();
    cancelMediaDownload();
    expect(MEDIA_CANCEL.load()).toBe(true);
    armMediaCancel();
  });
});

// =====================================================================
// runCapturing
// =====================================================================

describe("runCapturing (scripted fake process)", () => {
  it("captures stdout/stderr and the exit code", async () => {
    const fake = new FakeProcess();
    const promise = runCapturing(() => fake, "x", [], 5000);
    fake.stdout.end("hello ");
    fake.stderr.end("warn");
    fake.emit("close", 0, null);
    const result = await promise;
    expect(result.kind).toBe("exited");
    if (result.kind === "exited") {
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("hello ");
      expect(result.stderr).toBe("warn");
    }
  });

  it("reports a spawn error distinctly from a bad exit code", async () => {
    const fake = new FakeProcess();
    const promise = runCapturing(() => fake, "nonexistent", [], 5000);
    fake.emit("error", new Error("spawn ENOENT"));
    const result = await promise;
    expect(result.kind).toBe("spawn-error");
    if (result.kind === "spawn-error") expect(result.error).toContain("ENOENT");
  });

  it("kills and reports a timeout when nothing ever closes", async () => {
    const fake = new FakeProcess();
    const result = await runCapturing(() => fake, "x", [], 20);
    expect(result.kind).toBe("timeout");
    expect(fake.killed).toBe(true);
  });

  it("reassembles a multi-byte character split across two pipe reads", async () => {
    // A pipe hands over ~64 KB at a time and a `-j` info dict is hundreds of
    // KB, so a Hebrew/CJK/emoji character landing on a read boundary is
    // routine. Decoding each chunk as it arrived turned both halves into
    // U+FFFD — and because U+FFFD is perfectly legal inside a JSON string,
    // nothing threw: the title just silently came back as "???".
    const text = 'title: מוזיקה 🎬 音楽';
    const buf = Buffer.from(text, "utf8");
    const cut = buf.indexOf(Buffer.from("🎬", "utf8")) + 2; // mid-codepoint
    // Each half is undecodable ALONE — that is the hazard, and asserting it
    // stops a future edit from moving the cut to a harmless boundary.
    expect(buf.subarray(0, cut).toString("utf8")).toContain("�");
    expect(buf.subarray(cut).toString("utf8")).toContain("�");
    const fake = new FakeProcess();
    const promise = runCapturing(() => fake, "x", [], 5000);
    fake.stdout.write(buf.subarray(0, cut));
    // A real turn of the event loop, so the two halves really do arrive as
    // two separate 'data' events rather than being coalesced into one.
    await new Promise((r) => setTimeout(r, 0));
    fake.stdout.end(buf.subarray(cut));
    fake.stderr.end();
    await new Promise((r) => setTimeout(r, 0));
    fake.emit("close", 0, null);
    const result = await promise;
    expect(result.kind).toBe("exited");
    if (result.kind === "exited") {
      expect(result.stdout).toBe(text);
      expect(result.stdout).not.toContain("�");
    }
  });
});

// =====================================================================
// ensureYtdlp / refreshYtdlpIfStale
// =====================================================================

describe("ensureYtdlp (injected fetch, real filesystem)", () => {
  it("downloads, verifies, chmods and installs a binary when none exists yet", async () => {
    const dataDir = await mkTempDir();
    try {
      const total = MIN_YTDLP_BYTES + 100;
      const full = fakeBinaryBytes(total);
      // The magic header is split across a chunk boundary on purpose: it
      // proves the sniff is assembled across reads, not read whole.
      const progress: Array<[string, number | null]> = [];
      const dest = await ensureYtdlp(dataDir, (s, p) => progress.push([s, p]), {
        fetchFn: fakeFetchOk([full.slice(0, 2), full.slice(2)], total),
      });
      expect(dest).toBe(ytdlpPath(dataDir));
      const stat = await fsp.stat(dest);
      expect(stat.size).toBe(total);
      expect(stat.mode & 0o777).toBe(0o755);
      expect(progress.some(([s]) => s.includes("first time only"))).toBe(true);
      await expect(fsp.stat(`${dest}.part`)).rejects.toThrow(); // no half binary left
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses a declared Content-Length over the cap without writing anything", async () => {
    const dataDir = await mkTempDir();
    try {
      await expect(
        ensureYtdlp(dataDir, () => {}, {
          fetchFn: fakeFetchOk([fakeBinaryBytes(10)], MAX_YTDLP_BYTES + 1),
        })
      ).rejects.toThrow(/implausibly large/);
      await expect(fsp.stat(ytdlpPath(dataDir))).rejects.toThrow();
      await expect(fsp.stat(`${ytdlpPath(dataDir)}.part`)).rejects.toThrow();
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses and cleans up when the streamed bytes cross the cap with no header at all", async () => {
    const dataDir = await mkTempDir();
    try {
      await expect(
        ensureYtdlp(dataDir, () => {}, {
          fetchFn: fakeFetchOk([fakeBinaryBytes(600), new Uint8Array(600)]),
          maxBytes: 1000,
        })
      ).rejects.toThrow(/implausibly large/);
      await expect(fsp.stat(`${ytdlpPath(dataDir)}.part`)).rejects.toThrow();
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses a big-enough body with the wrong magic bytes (an HTML error page padded out)", async () => {
    const dataDir = await mkTempDir();
    try {
      const html = new Uint8Array(MIN_YTDLP_BYTES + 10);
      html.set(new TextEncoder().encode("<!DOCTYPE html>"), 0);
      await expect(
        ensureYtdlp(dataDir, () => {}, { fetchFn: fakeFetchOk([html]) })
      ).rejects.toThrow(/not the video downloader/);
      await expect(fsp.stat(`${ytdlpPath(dataDir)}.part`)).rejects.toThrow();
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("refuses an undersized body even with valid magic bytes", async () => {
    const dataDir = await mkTempDir();
    try {
      await expect(
        ensureYtdlp(dataDir, () => {}, { fetchFn: fakeFetchOk([fakeBinaryBytes(10)]) })
      ).rejects.toThrow(/not the video downloader/);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("surfaces a non-2xx status honestly", async () => {
    const dataDir = await mkTempDir();
    try {
      await expect(
        ensureYtdlp(dataDir, () => {}, {
          fetchFn: async () => ({ ok: false, status: 404, headers: { get: () => null }, body: null }),
        })
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("gives up on a server that answers and then goes SILENT mid-body, instead of hanging forever", async () => {
    // The whole reason this fetch has a timeout at all (see the Rust
    // comment): a bare fetch with no deadline left the app on "Getting the
    // video downloader…" forever. A deadline that covers only the HEADERS
    // would pass every other test in this file and still hang here.
    const dataDir = await mkTempDir();
    try {
      const stalling: FetchLike = async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: (): Promise<{ done: boolean; value?: Uint8Array }> =>
              new Promise(() => {
                // Never resolves: the server went quiet after its headers.
              }),
          }),
        },
      });
      await expect(
        ensureYtdlp(dataDir, () => {}, { fetchFn: stalling, fetchTimeoutMs: 40 })
      ).rejects.toThrow(/gave up after/);
      await expect(fsp.stat(`${ytdlpPath(dataDir)}.part`)).rejects.toThrow();
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("single-flight: a second concurrent install is refused rather than fetched twice", async () => {
    const dataDir = await mkTempDir();
    try {
      let fetches = 0;
      // Parks briefly and then fails on its own, so the guard is released
      // deterministically — it is MODULE state shared by every test here.
      const stuck: FetchLike = () => {
        fetches++;
        return new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("released for test cleanup")), 50)
        );
      };
      const first = ensureYtdlp(dataDir, () => {}, { fetchFn: stuck }).catch(() => {});
      await expect(ensureYtdlp(dataDir, () => {}, { fetchFn: stuck })).rejects.toThrow(
        /already being installed/
      );
      await first;
      expect(fetches).toBe(1);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("an installed, fresh binary is returned with no fetch and no self-update", async () => {
    await withInstalledBin(async (dataDir) => {
      let fetched = false;
      let spawned = false;
      const dest = await ensureYtdlp(dataDir, () => {}, {
        fetchFn: async () => {
          fetched = true;
          throw new Error("must not be called");
        },
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      });
      expect(dest).toBe(ytdlpPath(dataDir));
      expect(fetched).toBe(false);
      expect(spawned).toBe(false);
    });
  });

  it("a STALE installed binary self-updates BEFORE it is handed back", async () => {
    // The invariant the 2026-08-21 403 wave bought: the update happens as a
    // precondition of the next download, never as a retry after one failed.
    await withInstalledBin(async (dataDir) => {
      const dest = ytdlpPath(dataDir);
      const longAgo = new Date(Date.now() - YTDLP_STALE_AFTER_MS - 60_000);
      await fsp.utimes(dest, longAgo, longAgo);
      const calls: string[][] = [];
      const returned = await ensureYtdlp(dataDir, () => {}, {
        spawnFn: (_cmd, args) => {
          calls.push(args);
          const fake = new FakeProcess();
          queueMicrotask(() => fake.emit("close", 0, null));
          return fake;
        },
        fetchFn: async () => {
          throw new Error("must not be called");
        },
      });
      expect(calls).toEqual([["-U"]]);
      expect(returned).toBe(dest);
    });
  });
});

describe("refreshYtdlpIfStale", () => {
  it("does nothing to a fresh binary — no self-update spawned", async () => {
    await withInstalledBin(async (dataDir) => {
      let spawned = false;
      await refreshYtdlpIfStale(ytdlpPath(dataDir), () => {}, {
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      });
      expect(spawned).toBe(false);
    });
  });

  it("runs -U on a stale binary and re-stamps its mtime on success", async () => {
    await withInstalledBin(async (dataDir) => {
      const dest = ytdlpPath(dataDir);
      const longAgo = new Date(Date.now() - YTDLP_STALE_AFTER_MS - 60_000);
      await fsp.utimes(dest, longAgo, longAgo);
      const progress: string[] = [];
      await refreshYtdlpIfStale(dest, (s) => progress.push(s), {
        spawnFn: () => {
          const fake = new FakeProcess();
          queueMicrotask(() => fake.emit("close", 0, null));
          return fake;
        },
      });
      expect(progress.some((s) => s.includes("Updating"))).toBe(true);
      // "Already up to date" leaves the file untouched, which would re-run
      // this check on every download for the rest of the release gap.
      expect(Date.now() - (await fsp.stat(dest)).mtimeMs).toBeLessThan(5000);
    });
  });

  it("a failed self-update is best-effort: the old binary and its mtime are left alone", async () => {
    await withInstalledBin(async (dataDir) => {
      const dest = ytdlpPath(dataDir);
      const longAgo = new Date(Date.now() - YTDLP_STALE_AFTER_MS - 60_000);
      await fsp.utimes(dest, longAgo, longAgo);
      await refreshYtdlpIfStale(dest, () => {}, {
        spawnFn: () => {
          const fake = new FakeProcess();
          queueMicrotask(() => fake.emit("close", 1, null));
          return fake;
        },
      });
      expect((await fsp.stat(dest)).mtimeMs).toBeCloseTo(longAgo.getTime(), -2);
      expect(await fsp.readFile(dest, "utf8")).toBe("placeholder-binary");
    });
  });

  it("an update that cannot even spawn does not throw", async () => {
    await withInstalledBin(async (dataDir) => {
      const dest = ytdlpPath(dataDir);
      const longAgo = new Date(Date.now() - YTDLP_STALE_AFTER_MS - 60_000);
      await fsp.utimes(dest, longAgo, longAgo);
      await expect(
        refreshYtdlpIfStale(dest, () => {}, {
          spawnFn: () => {
            const fake = new FakeProcess();
            queueMicrotask(() => fake.emit("error", new Error("EACCES")));
            return fake;
          },
        })
      ).resolves.toBeUndefined();
      expect((await fsp.stat(dest)).mtimeMs).toBeCloseTo(longAgo.getTime(), -2);
    });
  });

  it("an over-budget update is killed and abandoned, leaving the old binary in place", async () => {
    await withInstalledBin(async (dataDir) => {
      const dest = ytdlpPath(dataDir);
      const longAgo = new Date(Date.now() - YTDLP_STALE_AFTER_MS - 60_000);
      await fsp.utimes(dest, longAgo, longAgo);
      const fake = new FakeProcess(); // never closes on its own
      await expect(
        refreshYtdlpIfStale(dest, () => {}, { spawnFn: () => fake, updateBudgetMs: 20 })
      ).resolves.toBeUndefined();
      expect(fake.killed).toBe(true);
      expect((await fsp.stat(dest)).mtimeMs).toBeCloseTo(longAgo.getTime(), -2);
    });
  });

  it("a missing binary is not 'stale' — it is nothing to update", async () => {
    const dataDir = await mkTempDir();
    try {
      let spawned = false;
      await refreshYtdlpIfStale(path.join(dataDir, "absent"), () => {}, {
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      });
      expect(spawned).toBe(false);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// pumpDownloadProgress — the select! loop, driven by a bare PassThrough
// =====================================================================

describe("pumpDownloadProgress (scripted stdout, no process at all)", () => {
  it("forwards percent from [download] lines and ignores noise", async () => {
    const stdout = new PassThrough();
    const calls: Array<[string, number | null]> = [];
    const done = pumpDownloadProgress(
      { stdout },
      undefined,
      (s, p) => calls.push([s, p]),
      MAX_DOWNLOAD_BYTES,
      60_000,
      30
    );
    stdout.write("[youtube] abc: Downloading webpage\n");
    stdout.write("[download]  42.7% of 12.3MiB at 1.2MiB/s\n");
    stdout.write("[download] 100% of 5MiB\n");
    stdout.end();
    expect(await done).toBeNull();
    expect(calls).toEqual([
      ["Downloading the video…", 42.7],
      ["Downloading the video…", 100],
    ]);
  });

  it("abandons the moment an announced total exceeds the cap, before the file arrives", async () => {
    const stdout = new PassThrough();
    const calls: Array<number | null> = [];
    const done = pumpDownloadProgress(
      { stdout },
      undefined,
      (_s, p) => calls.push(p),
      MAX_DOWNLOAD_BYTES,
      60_000,
      30
    );
    stdout.write("[download]   0.1% of ~4.71GiB at 1MiB/s\n");
    const reason = await done;
    expect(reason).toMatch(/about \d+ MB — larger than the \d+ MB limit/);
    expect(reason).toContain("Stopped before downloading it.");
    expect(calls).toEqual([]); // that line carried no percent to forward
  });

  it("honors a Stop raised mid-download, while the downloader is silent", async () => {
    const stdout = new PassThrough(); // never ends on its own
    const cancel = new CancelFlag();
    const done = pumpDownloadProgress({ stdout }, cancel, () => {}, MAX_DOWNLOAD_BYTES, 60_000, 15);
    await new Promise((r) => setTimeout(r, 40));
    cancel.store(true);
    expect(await done).toBe("Stopped.");
  });

  it("gives up once the budget elapses, even with a perfectly silent downloader", async () => {
    const stdout = new PassThrough(); // never writes, never ends
    const started = Date.now();
    const reason = await pumpDownloadProgress(
      { stdout },
      undefined,
      () => {},
      MAX_DOWNLOAD_BYTES,
      25,
      10
    );
    expect(reason).toContain("gave up after");
    expect(reason).toContain("it may be stalled.");
    // And it gave up ON TIME. Asserting only the words leaves a budget that
    // fires long after its deadline indistinguishable from one that works —
    // the hour-long ceiling could quietly become a four-day one and every
    // other assertion here would stay green.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("a stream that simply ends returns null — the caller reads the real exit code", async () => {
    const stdout = new PassThrough();
    const done = pumpDownloadProgress({ stdout }, undefined, () => {}, MAX_DOWNLOAD_BYTES, 60_000, 30);
    stdout.end();
    expect(await done).toBeNull();
  });

  it("no stdout at all resolves null immediately", async () => {
    expect(await pumpDownloadProgress({ stdout: null }, undefined, () => {})).toBeNull();
  });
});

// =====================================================================
// runYtdlpDownload — the engine, against a scripted fake process
// =====================================================================

describe("runYtdlpDownload (scripted fake process)", () => {
  /** A fake yt-dlp that materializes files where `-o` points, then exits. */
  function spawnFnWriting(
    files: Array<{ name: string; bytes: number | Buffer }>,
    code: number,
    stdoutLines: string[] = [],
    stderrLines: string[] = [],
    capture?: (args: string[]) => void
  ): SpawnFn {
    return (_command, args) => {
      capture?.(args);
      const fake = new FakeProcess();
      const template = argAfter(args, "-o");
      void (async () => {
        if (template !== undefined) {
          const dir = path.dirname(template);
          await fsp.mkdir(dir, { recursive: true });
          for (const f of files) {
            const body = typeof f.bytes === "number" ? Buffer.alloc(f.bytes, 7) : f.bytes;
            await fsp.writeFile(path.join(dir, f.name), body);
          }
        }
        for (const line of stderrLines) fake.stderr.write(`${line}\n`);
        for (const line of stdoutLines) fake.stdout.write(`${line}\n`);
        await closeFake(fake, code);
      })();
      return fake;
    };
  }

  it("builds the args, forwards progress, and returns the largest non-.part file", async () => {
    await withInstalledBin(async (dataDir) => {
      let seen: string[] = [];
      const progress: Array<[string, number | null]> = [];
      const result = await runYtdlpDownload(dataDir, PUBLIC_URL, {
        maxHeight: 720,
        progress: (s, p) => progress.push([s, p]),
        findFfmpegFn: () => "/opt/homebrew/bin/ffmpeg",
        spawnFn: spawnFnWriting(
          [
            { name: "clip.mp4.part", bytes: 4096 }, // must be ignored despite being biggest
            { name: "clip.mp4", bytes: 1024 },
            { name: "clip.jpg", bytes: 16 },
          ],
          0,
          ["[download]  50.0% of 1.00KiB at 1.0KiB/s"],
          [],
          (args) => (seen = args)
        ),
      });
      try {
        expect(path.basename(result.path)).toBe("clip.mp4");
        expect(seen).toContain("--no-playlist");
        expect(seen).toContain("--newline");
        expect(seen).toContain("--no-warnings");
        expect(argAfter(seen, "--ffmpeg-location")).toBe("/opt/homebrew/bin/ffmpeg");
        expect(argAfter(seen, "-f")).toBe(formatSelector(true, 720));
        expect(argAfter(seen, "-o")).toContain("%(title).100B.%(ext)s");
        expect(seen[seen.length - 1]).toBe(PUBLIC_URL);
        expect(progress[0]).toEqual(["Downloading the video…", 0]);
        expect(progress).toContainEqual(["Downloading the video…", 50]);
      } finally {
        await fsp.rm(result.workDir, { recursive: true, force: true });
      }
    });
  });

  it("without ffmpeg it neither offers merge branches nor passes --ffmpeg-location", async () => {
    await withInstalledBin(async (dataDir) => {
      let seen: string[] = [];
      const result = await runYtdlpDownload(dataDir, PUBLIC_URL, {
        progress: () => {},
        findFfmpegFn: () => null,
        spawnFn: spawnFnWriting([{ name: "clip.mp4", bytes: 32 }], 0, [], [], (a) => (seen = a)),
      });
      try {
        expect(seen).not.toContain("--ffmpeg-location");
        expect(argAfter(seen, "-f")).toBe("b[ext=mp4]/b");
        expect(argAfter(seen, "-f")).not.toContain("+");
      } finally {
        await fsp.rm(result.workDir, { recursive: true, force: true });
      }
    });
  });

  it("surfaces a non-zero exit through explainDownloadFailure, using the stderr TAIL", async () => {
    await withInstalledBin(async (dataDir) => {
      const err = await runYtdlpDownload(dataDir, PUBLIC_URL, {
        progress: () => {},
        findFfmpegFn: () => null,
        spawnFn: spawnFnWriting([], 1, [], [
          "line one, dropped",
          "line two",
          "line three",
          "ERROR: [youtube] abc: Requested format is not available.",
        ]),
      }).then(
        () => null,
        (e: unknown) => e as Error
      );
      expect(err).not.toBeNull();
      expect(err?.message).toContain("brew install ffmpeg");
      // …and the tail really is BOUNDED to STDERR_TAIL_LINES. Without this the
      // whole drain could be unbounded and every assertion above would still
      // pass, while a downloader noisy enough to print a megabyte of warnings
      // would put all of it in front of the user as "the" failure.
      expect(err?.message).toContain("line two");
      expect(err?.message).not.toContain("line one, dropped");
    });
  });

  it("reports a spawn failure as such, not as 'produced no file'", async () => {
    await withInstalledBin(async (dataDir) => {
      await expect(
        runYtdlpDownload(dataDir, PUBLIC_URL, {
          progress: () => {},
          findFfmpegFn: () => null,
          spawnFn: () => {
            const fake = new FakeProcess();
            queueMicrotask(() => {
              fake.stdout.end();
              fake.stderr.end();
              fake.emit("error", new Error("spawn ENOENT"));
              fake.emit("close", null, null);
            });
            return fake;
          },
        })
      ).rejects.toThrow(/couldn't start the video downloader: spawn ENOENT/);
    });
  });

  it("says so honestly when the downloader exits 0 and leaves nothing behind", async () => {
    await withInstalledBin(async (dataDir) => {
      await expect(
        runYtdlpDownload(dataDir, PUBLIC_URL, {
          progress: () => {},
          findFfmpegFn: () => null,
          spawnFn: spawnFnWriting([], 0, ["[download] 100% of 1.00KiB"]),
        })
      ).rejects.toThrow(/produced no file/);
    });
  });

  it("REFUSES a finished file over the cap — never a quieter, smaller download — and sweeps the work dir", async () => {
    await withInstalledBin(async (dataDir) => {
      let workDir = "";
      await expect(
        runYtdlpDownload(dataDir, PUBLIC_URL, {
          progress: () => {},
          findFfmpegFn: () => null,
          maxDownloadBytes: 1024 * 1024,
          spawnFn: spawnFnWriting(
            [{ name: "huge.mp4", bytes: 2 * 1024 * 1024 }],
            0,
            [],
            [],
            (args) => (workDir = path.dirname(argAfter(args, "-o") as string))
          ),
        })
      ).rejects.toThrow("The video is 2 MB — larger than the 1 MB limit for a room file.");
      await expect(fsp.stat(workDir)).rejects.toThrow();
    });
  });

  it("abandons on the first over-cap progress line and sweeps the work dir", async () => {
    await withInstalledBin(async (dataDir) => {
      let workDir = "";
      let fake: FakeProcess | undefined;
      await expect(
        runYtdlpDownload(dataDir, PUBLIC_URL, {
          progress: () => {},
          findFfmpegFn: () => null,
          spawnFn: (_cmd, args) => {
            workDir = path.dirname(argAfter(args, "-o") as string);
            fake = new FakeProcess(); // never finishes; the engine must kill it
            queueMicrotask(() => fake?.stdout.write("[download]   0.1% of ~4.71GiB at 1MiB/s\n"));
            return fake;
          },
        })
      ).rejects.toThrow(/Stopped before downloading it\./);
      expect(fake?.killed).toBe(true);
      await expect(fsp.stat(workDir)).rejects.toThrow();
    });
  });

  it("a Stop mid-download kills the process, sweeps the work dir, and says 'Stopped.'", async () => {
    await withInstalledBin(async (dataDir) => {
      const cancel = new CancelFlag();
      let fake: FakeProcess | undefined;
      let workDir = "";
      const promise = runYtdlpDownload(dataDir, PUBLIC_URL, {
        progress: () => {},
        findFfmpegFn: () => null,
        cancel,
        cancelPollMs: 10,
        spawnFn: (_cmd, args) => {
          workDir = path.dirname(argAfter(args, "-o") as string);
          fake = new FakeProcess(); // silent forever
          return fake;
        },
      });
      await new Promise((r) => setTimeout(r, 30));
      cancel.store(true);
      await expect(promise).rejects.toThrow("Stopped.");
      expect(fake?.killed).toBe(true);
      await expect(fsp.stat(workDir)).rejects.toThrow();
    });
  });

  it("gives up on a stalled download once the budget elapses, and does so on time", async () => {
    await withInstalledBin(async (dataDir) => {
      const started = Date.now();
      await expect(
        runYtdlpDownload(dataDir, PUBLIC_URL, {
          progress: () => {},
          findFfmpegFn: () => null,
          mediaDownloadBudgetMs: 40,
          cancelPollMs: 10,
          spawnFn: () => new FakeProcess(),
        })
      ).rejects.toThrow(/gave up after/);
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  it("a STALE downloader updates itself BEFORE the download runs — never after one fails", async () => {
    // The invariant the 2026-08-21 403 wave bought, pinned where it actually
    // matters: the `-U` is a PRECONDITION of the next download, not a retry
    // bolted onto a failure. Proven by the spawn ORDER, and by there being
    // exactly two spawns — a second download attempt would mean a retry.
    await withInstalledBin(async (dataDir) => {
      const dest = ytdlpPath(dataDir);
      const longAgo = new Date(Date.now() - YTDLP_STALE_AFTER_MS - 60_000);
      await fsp.utimes(dest, longAgo, longAgo);
      const spawns: string[][] = [];
      const download = spawnFnWriting([{ name: "clip.mp4", bytes: 64 }], 0);
      const result = await runYtdlpDownload(dataDir, PUBLIC_URL, {
        progress: () => {},
        findFfmpegFn: () => null,
        spawnFn: (cmd, args) => {
          spawns.push(args);
          if (args[0] === "-U") {
            const fake = new FakeProcess();
            queueMicrotask(() => fake.emit("close", 0, null));
            return fake;
          }
          return download(cmd, args);
        },
      });
      try {
        expect(spawns).toHaveLength(2);
        expect(spawns[0]).toEqual(["-U"]);
        expect(spawns[1]).toContain(PUBLIC_URL);
      } finally {
        await fsp.rm(result.workDir, { recursive: true, force: true });
      }
    });
  });

  it("propagates ensureYtdlp's own failure before ever spawning the downloader", async () => {
    const dataDir = await mkTempDir();
    try {
      let spawned = false;
      await expect(
        runYtdlpDownload(dataDir, PUBLIC_URL, {
          progress: () => {},
          fetchFn: async () => {
            throw new Error("network unreachable");
          },
          spawnFn: () => {
            spawned = true;
            return new FakeProcess();
          },
        })
      ).rejects.toThrow(/downloader fetch failed/);
      expect(spawned).toBe(false);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });
});

// =====================================================================
// The SSRF pre-flight is really wired to the public entry points
// =====================================================================

describe("the SSRF pre-flight is on the public entry points, not optional", () => {
  it("downloadMediaToTemp refuses a loopback URL before spawning anything", async () => {
    let spawned = false;
    await expect(
      downloadMediaToTemp("/tmp/unused", "http://127.0.0.1:11434/video.mp4", {
        progress: () => {},
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      })
    ).rejects.toThrow(/Local and private-network/);
    expect(spawned).toBe(false);
  });

  it("downloadMediaToTemp refuses a .local name before spawning anything", async () => {
    await expect(
      downloadMediaToTemp("/tmp/unused", "http://printer.local/v.mp4", { progress: () => {} })
    ).rejects.toThrow(/Local and private-network/);
  });

  it("listMediaFormats refuses a loopback URL before spawning anything", async () => {
    let spawned = false;
    await expect(
      listMediaFormats("http://127.0.0.1:9/x", {
        dataDir: "/tmp/unused",
        webAccessAllowed: () => true,
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      })
    ).rejects.toThrow(/Local and private-network/);
    expect(spawned).toBe(false);
  });

  it("downloadMediaToTemp lets a public address through to the engine", async () => {
    await withInstalledBin(async (dataDir) => {
      const result = await downloadMediaToTemp(dataDir, PUBLIC_URL, {
        progress: () => {},
        findFfmpegFn: () => null,
        spawnFn: (_cmd, args) => {
          const fake = new FakeProcess();
          const dir = path.dirname(argAfter(args, "-o") as string);
          void (async () => {
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(path.join(dir, "clip.mp4"), Buffer.alloc(64, 1));
            await closeFake(fake, 0);
          })();
          return fake;
        },
      });
      expect(path.basename(result.path)).toBe("clip.mp4");
      await fsp.rm(result.workDir, { recursive: true, force: true });
    });
  });
});

// =====================================================================
// listMediaFormats / probeMediaFormats
// =====================================================================

describe("listMediaFormats / probeMediaFormats", () => {
  it("refuses without reaching anything when the room's internet switch is off", async () => {
    let spawned = false;
    await expect(
      listMediaFormats(PUBLIC_URL, {
        dataDir: "/tmp/unused",
        webAccessAllowed: () => false,
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      })
    ).rejects.toThrow(WEB_OFF_MESSAGE);
    expect(spawned).toBe(false);
  });

  it("parses a successful probe's JSON into quality options", async () => {
    await withInstalledBin(async (dataDir) => {
      const info = {
        formats: [{ vcodec: "avc1.4d401f", acodec: "mp4a.40.2", height: 480, filesize: 12_345 }],
      };
      const options = await listMediaFormats(PUBLIC_URL, {
        dataDir,
        webAccessAllowed: () => true,
        findFfmpegFn: () => null,
        spawnFn: () => {
          const fake = new FakeProcess();
          void (async () => {
            fake.stdout.write(JSON.stringify(info));
            await closeFake(fake, 0);
          })();
          return fake;
        },
      });
      expect(options).toEqual([{ height: 480, approxBytes: 12_345, fits: true }]);
    });
  });

  it("a non-ASCII info dict split across pipe reads still parses byte-for-byte", async () => {
    // The same boundary hazard as runCapturing's own test, but end to end and
    // at the size it really happens: a real `-j` dict is hundreds of KB, so
    // the split is not a contrivance. Rust parses the raw bytes
    // (`serde_json::from_slice`) and never had this failure mode.
    await withInstalledBin(async (dataDir) => {
      const info = {
        title: "מוזיקה 🎬 音楽",
        formats: [{ vcodec: "avc1", acodec: "mp4a", height: 720, filesize: 1234 }],
      };
      const buf = Buffer.from(JSON.stringify(info), "utf8");
      const cut = buf.indexOf(Buffer.from("🎬", "utf8")) + 2; // mid-codepoint
      // The split really is mid-character — each half is undecodable ALONE,
      // which is precisely what per-chunk decoding used to destroy. Without
      // this the two writes could land on a clean boundary and the test would
      // prove nothing.
      expect(buf.subarray(0, cut).toString("utf8")).toContain("�");
      expect(buf.subarray(cut).toString("utf8")).toContain("�");
      const options = await probeMediaFormats(PUBLIC_URL, {
        dataDir,
        webAccessAllowed: () => true,
        findFfmpegFn: () => null,
        spawnFn: () => {
          const fake = new FakeProcess();
          void (async () => {
            // A real turn of the loop before the first write, so `runCapturing`
            // has attached its reader (a listener added any earlier switches
            // the stream to flowing and the module never sees chunk one), and
            // another between the halves so they arrive as two 'data' events
            // rather than one coalesced buffer.
            await new Promise((r) => setTimeout(r, 0));
            fake.stdout.write(buf.subarray(0, cut));
            await new Promise((r) => setTimeout(r, 0));
            fake.stdout.write(buf.subarray(cut));
            await closeFake(fake, 0);
          })();
          return fake;
        },
      });
      // …and the dict parsed with its text intact rather than throwing
      // "made no sense" or quietly returning mojibake.
      expect(options).toEqual([{ height: 720, approxBytes: 1234, fits: true }]);
    });
  });

  it("passes exactly the metadata-only flags — a probe downloads nothing", async () => {
    await withInstalledBin(async (dataDir) => {
      let seen: string[] = [];
      await probeMediaFormats(PUBLIC_URL, {
        dataDir,
        webAccessAllowed: () => true,
        findFfmpegFn: () => null,
        spawnFn: (_cmd, args) => {
          seen = args;
          const fake = new FakeProcess();
          void (async () => {
            fake.stdout.write("{}");
            await closeFake(fake, 0);
          })();
          return fake;
        },
      });
      expect(seen).toEqual(["--no-playlist", "--no-warnings", "-j", PUBLIC_URL]);
    });
  });

  it("surfaces yt-dlp's own stderr tail on a failed probe", async () => {
    await withInstalledBin(async (dataDir) => {
      await expect(
        probeMediaFormats(PUBLIC_URL, {
          dataDir,
          webAccessAllowed: () => true,
          spawnFn: () => {
            const fake = new FakeProcess();
            void (async () => {
              fake.stderr.write("noise\nERROR: Unsupported URL\n");
              await closeFake(fake, 1);
            })();
            return fake;
          },
        })
      ).rejects.toThrow(/Couldn't look up this video's qualities: noise ERROR: Unsupported URL/);
    });
  });

  it("times out a probe that never answers", async () => {
    await withInstalledBin(async (dataDir) => {
      const fake = new FakeProcess(); // never closes
      await expect(
        probeMediaFormats(PUBLIC_URL, {
          dataDir,
          webAccessAllowed: () => true,
          spawnFn: () => fake,
          formatProbeBudgetMs: 25,
        })
      ).rejects.toThrow(/took too long/);
      expect(fake.killed).toBe(true);
    });
  });

  it("reports honestly when the probe's stdout is not JSON", async () => {
    await withInstalledBin(async (dataDir) => {
      await expect(
        probeMediaFormats(PUBLIC_URL, {
          dataDir,
          webAccessAllowed: () => true,
          spawnFn: () => {
            const fake = new FakeProcess();
            void (async () => {
              fake.stdout.write("not json at all");
              await closeFake(fake, 0);
            })();
            return fake;
          },
        })
      ).rejects.toThrow(/made no sense/);
    });
  });

  it("reports a probe that cannot be spawned at all", async () => {
    await withInstalledBin(async (dataDir) => {
      await expect(
        probeMediaFormats(PUBLIC_URL, {
          dataDir,
          webAccessAllowed: () => true,
          spawnFn: () => {
            const fake = new FakeProcess();
            queueMicrotask(() => fake.emit("error", new Error("spawn EACCES")));
            return fake;
          },
        })
      ).rejects.toThrow(/couldn't start the video downloader: spawn EACCES/);
    });
  });
});

// =====================================================================
// importMediaUrl / importYoutubeVideo
// =====================================================================

describe("importMediaUrl / importYoutubeVideo", () => {
  beforeEach(() => {
    armMediaCancel();
  });
  afterEach(() => {
    armMediaCancel();
  });

  /** A fake yt-dlp run that ACTUALLY materializes the file the engine looks
   * for afterwards, awaited before 'close' fires so there is no race between
   * "the file exists" and "the process reported success". */
  function spawnFnWritingVideo(contents: string): SpawnFn {
    return (_command, args) => {
      const fake = new FakeProcess();
      const template = argAfter(args, "-o");
      void (async () => {
        if (template !== undefined) {
          const dir = path.dirname(template);
          await fsp.mkdir(dir, { recursive: true });
          await fsp.writeFile(path.join(dir, "clip.mp4"), contents);
        }
        fake.stdout.write(`[download] 100% of ${contents.length}B\n`);
        await closeFake(fake, 0);
      })();
      return fake;
    };
  }

  it("refuses without touching the download engine when the room is offline", async () => {
    let spawned = false;
    let imported = false;
    await expect(
      importMediaUrl(PUBLIC_URL, {
        dataDir: "/tmp/unused",
        webAccessAllowed: () => false,
        importDownload: () => {
          imported = true;
          throw new Error("must not be called");
        },
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      })
    ).rejects.toThrow(WEB_OFF_MESSAGE);
    expect(spawned).toBe(false);
    expect(imported).toBe(false);
  });

  it("downloads, imports through the funnel with (path, name, url), then sweeps the temp copy", async () => {
    await withInstalledBin(async (dataDir) => {
      const seen: Array<[string, string, string]> = [];
      const importDownload: ImportDownloadFn = (p, name, url) => {
        seen.push([p, name, url]);
        return FILE_META;
      };
      const progress: Array<[string, number | null]> = [];
      const report = await importMediaUrl(`  ${PUBLIC_URL}  `, {
        dataDir,
        webAccessAllowed: () => true,
        importDownload,
        findFfmpegFn: () => null,
        spawnFn: spawnFnWritingVideo("hello"),
        progress: (s, p) => progress.push([s, p]),
      });
      expect(report).toEqual({ imported: [FILE_META], errors: [] });
      expect(seen).toHaveLength(1);
      const [staged, name, url] = seen[0] as [string, string, string];
      expect(name).toBe("clip.mp4");
      expect(url).toBe(PUBLIC_URL); // trimmed before the funnel sees it
      expect(progress).toContainEqual(["Sealing the video into the room…", null]);
      expect(progress).toContainEqual(["Done", 100]);
      await expect(fsp.stat(path.dirname(staged))).rejects.toThrow(); // work dir swept
    });
  });

  it("still sweeps and still emits Done when the import funnel throws, then rethrows (faithful port)", async () => {
    await withInstalledBin(async (dataDir) => {
      let workDir = "";
      const progress: string[] = [];
      await expect(
        importMediaUrl(PUBLIC_URL, {
          dataDir,
          webAccessAllowed: () => true,
          importDownload: (p) => {
            workDir = path.dirname(p);
            throw new Error("room is sealed");
          },
          findFfmpegFn: () => null,
          spawnFn: spawnFnWritingVideo("x"),
          progress: (s) => progress.push(s),
        })
      ).rejects.toThrow("room is sealed");
      expect(progress).toContain("Done");
      expect(workDir).not.toBe("");
      await expect(fsp.stat(workDir)).rejects.toThrow();
    });
  });

  it("arms a fresh Stop, so a leftover one from a finished download cannot kill this one", async () => {
    await withInstalledBin(async (dataDir) => {
      cancelMediaDownload(); // a Stop pressed a moment too late, last time
      expect(MEDIA_CANCEL.load()).toBe(true);
      const report = await importMediaUrl(PUBLIC_URL, {
        dataDir,
        webAccessAllowed: () => true,
        importDownload: () => FILE_META,
        findFfmpegFn: () => null,
        spawnFn: spawnFnWritingVideo("x"),
      });
      expect(report.imported).toEqual([FILE_META]);
      expect(MEDIA_CANCEL.load()).toBe(false);
    });
  });

  it("importYoutubeVideo rejects a non-YouTube link before web access or any download", async () => {
    let asked = false;
    let spawned = false;
    await expect(
      importYoutubeVideo(PUBLIC_URL, {
        dataDir: "/tmp/unused",
        webAccessAllowed: () => {
          asked = true;
          return true;
        },
        importDownload: () => FILE_META,
        spawnFn: () => {
          spawned = true;
          return new FakeProcess();
        },
      })
    ).rejects.toThrow("That doesn't look like a YouTube video link.");
    expect(asked).toBe(false);
    expect(spawned).toBe(false);
  });

  it("importYoutubeVideo accepts a real YouTube link and delegates into the same funnel", async () => {
    // Proven WITHOUT any network: the room is offline, so delegation is
    // observable as importMediaUrl's own refusal rather than the id gate's.
    let asked = false;
    await expect(
      importYoutubeVideo("  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ", {
        dataDir: "/tmp/unused",
        webAccessAllowed: () => {
          asked = true;
          return false;
        },
        importDownload: () => FILE_META,
      })
    ).rejects.toThrow(WEB_OFF_MESSAGE);
    expect(asked).toBe(true);
  });
});
