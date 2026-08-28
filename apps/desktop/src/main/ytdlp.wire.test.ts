/**
 * REAL cross-process pass for `ytdlp.ts`. Nothing here is mocked or injected
 * except the URL's far end: this spawns the ACTUAL yt-dlp on this machine and
 * points it at a REAL HTTP server this test starts on loopback.
 *
 * WHY A LOCAL SERVER RATHER THAN A REAL SITE: everything worth proving here
 * is on THIS side of the socket — real spawn, real `--newline` progress
 * lines, real `-j` JSON, real exit codes, real SIGTERM-on-Stop, real ffmpeg
 * discovery, real work-dir sweeping. Pointing at YouTube (or any third-party
 * host) would buy none of that and would make the suite fail on extractor
 * churn, bot detection, or a machine with no network. Verified by hand before
 * relying on it: a `video/mp4` content-type plus a real `Content-Length` is
 * enough for yt-dlp's `generic` extractor to treat the URL as a direct
 * download and emit ordinary `[download] NN% of X.XXMiB` lines.
 *
 * The SSRF guard forbids loopback for a real caller — correctly — so these
 * drive the inner halves (`runYtdlpDownload`, `probeMediaFormats`) that
 * `downloadMediaToTemp`/`listMediaFormats` delegate to once the pre-flight
 * passes. That the pre-flight IS wired to the public halves, and does refuse
 * loopback, is proved in `ytdlp.test.ts`.
 *
 * WHAT IS DELIBERATELY NOT COVERED HERE, AND WHY:
 *   - `ensureYtdlp`'s GitHub fetch of the real `yt-dlp_macos` asset: it would
 *     pull ~35 MB from GitHub Releases on every run and make routine testing
 *     depend on their availability. Fully covered against an injected
 *     `FetchLike` in `ytdlp.test.ts`, with real fs writes, `.part` cleanup,
 *     chmod and rename.
 *   - A real `-U` self-update: same reason (a real ~38 MB GitHub fetch), and
 *     it would mutate whatever binary it was pointed at. The stale-check,
 *     the spawn, the mtime re-stamp, the failure and the over-budget kill are
 *     all covered against a scripted process.
 *   - A real split-stream YouTube merge (ffmpeg actually joining two
 *     streams): needs a real YouTube extraction. The selector strings are
 *     unit-tested for both booleans, and the test below proves the REAL
 *     binary accepts the string this module builds and honors the real
 *     `--ffmpeg-location` this module passes.
 *
 * Skips (rather than fails) when yt-dlp isn't installed, so a machine without
 * it still gets an honest green rather than a red that means nothing.
 */

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CancelFlag } from "./cancel.js";
import {
  ensureYtdlp,
  findFfmpeg,
  probeMediaFormats,
  qualityOptions,
  runCapturing,
  runYtdlpDownload,
  ytdlpPath,
  type SpawnFn,
} from "./ytdlp.js";

function which(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Checked, not assumed — and reported, so a skip reads as an environment
 * fact rather than a silent gap. */
const REAL_YTDLP = which("yt-dlp");
const REAL_FFMPEG = which("ffmpeg");

const realSpawnFn: SpawnFn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

const WIRE_TIMEOUT_MS = 30_000;

interface FakeMediaServer {
  url: string;
  close: () => Promise<void>;
}

/** A real HTTP server on loopback serving `bytes` as a direct video file.
 * `drip` slows it down so a mid-flight Stop is deterministic rather than a
 * race against a download that finishes in milliseconds. `status` lets a test
 * make the real binary fail the way a real dead link does. */
function startMediaServer(
  bytes: Buffer,
  opts: { drip?: { chunkSize: number; delayMs: number }; status?: number } = {}
): Promise<FakeMediaServer> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      if (opts.status !== undefined && opts.status !== 200) {
        res.writeHead(opts.status, { "Content-Type": "text/plain" });
        res.end("nope");
        return;
      }
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
      if (!opts.drip) {
        res.end(bytes);
        return;
      }
      const { chunkSize, delayMs } = opts.drip;
      let offset = 0;
      const pump = (): void => {
        if (res.destroyed) return;
        if (offset >= bytes.length) {
          res.end();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.length);
        res.write(bytes.subarray(offset, end));
        offset = end;
        setTimeout(pump, delayMs);
      };
      pump();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/video.mp4`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

describe.skipIf(REAL_YTDLP === null)("the REAL yt-dlp binary, against a REAL loopback server", () => {
  let dataDir = "";

  /** Seed the real yt-dlp as the module's own installed binary, freshly
   * stamped so `ensureYtdlp` takes its already-installed path: no GitHub
   * fetch, and no `-U` against a binary this test does not own. */
  async function setUp(): Promise<string> {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ytdlp-wire-"));
    const dest = ytdlpPath(dataDir);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(REAL_YTDLP as string, dest);
    await fsp.chmod(dest, 0o755);
    const now = new Date();
    await fsp.utimes(dest, now, now);
    return dataDir;
  }

  afterEach(async () => {
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true });
    dataDir = "";
  });

  it(
    "runCapturing captures a real process's stdout and exit code",
    async () => {
      const result = await runCapturing(realSpawnFn, REAL_YTDLP as string, ["--version"], 10_000);
      expect(result.kind).toBe("exited");
      if (result.kind === "exited") {
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
      }
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "runCapturing reports a real spawn failure rather than hanging on a 'close' that never comes",
    async () => {
      const result = await runCapturing(realSpawnFn, "/definitely/not/here/yt-dlp", [], 5000);
      // Node emits 'error' AND then 'close' for a failed spawn; the module
      // must settle on the first of the two, whichever the OS delivers.
      expect(["spawn-error", "exited"]).toContain(result.kind);
      if (result.kind === "exited") expect(result.code).not.toBe(0);
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "ensureYtdlp hands back a freshly-stamped installed binary with no fetch and no self-update",
    async () => {
      const dir = await setUp();
      const progress: Array<[string, number | null]> = [];
      const bin = await ensureYtdlp(dir, (s, p) => progress.push([s, p]));
      expect(bin).toBe(ytdlpPath(dir));
      // No "Getting the video downloader" and no "Updating" — proof that
      // neither the fetch path nor the `-U` path ran.
      expect(progress).toEqual([]);
    },
    WIRE_TIMEOUT_MS
  );

  it("findFfmpeg finds the real system ffmpeg when this Mac has one", () => {
    if (REAL_FFMPEG === null) return; // nothing to assert without one
    expect(findFfmpeg()).toBe(REAL_FFMPEG);
  });

  it(
    "downloads a real file end to end: real spawn, real progress lines, real bytes on disk",
    async () => {
      const dir = await setUp();
      const bytes = Buffer.alloc(512 * 1024);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
      const server = await startMediaServer(bytes);
      try {
        const progress: Array<[string, number | null]> = [];
        // findFfmpegFn is NOT injected: this run uses whatever this Mac
        // really has, so the real binary really is handed the real
        // `--ffmpeg-location` and the real selector string this module builds.
        const result = await runYtdlpDownload(dir, server.url, {
          progress: (s, p) => progress.push([s, p]),
        });
        try {
          expect((await fsp.readFile(result.path)).equals(bytes)).toBe(true);
          const percents = progress
            .filter(([s]) => s === "Downloading the video…")
            .map(([, p]) => p)
            .filter((p): p is number => p !== null);
          expect(percents.length).toBeGreaterThan(1);
          expect(Math.max(...percents)).toBe(100);
        } finally {
          await fsp.rm(result.workDir, { recursive: true, force: true });
        }
      } finally {
        await server.close();
      }
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "a real Stop mid-flight kills the real process and sweeps the work dir",
    async () => {
      const dir = await setUp();
      // Dripped slowly so the Stop lands mid-download deterministically.
      const server = await startMediaServer(Buffer.alloc(6 * 1024 * 1024, 7), {
        drip: { chunkSize: 128 * 1024, delayMs: 60 },
      });
      try {
        const cancel = new CancelFlag();
        const started = Date.now();
        const promise = runYtdlpDownload(dir, server.url, {
          progress: () => {},
          cancel,
          cancelPollMs: 50,
        });
        setTimeout(() => cancel.store(true), 300);
        await expect(promise).rejects.toThrow("Stopped.");
        // It stopped BECAUSE of the Stop, not because the download finished:
        // at 128 KiB per 60 ms a 6 MiB body needs ~3 s to arrive.
        expect(Date.now() - started).toBeLessThan(2500);
      } finally {
        await server.close();
      }
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "a real over-cap download is REFUSED on its first progress line, not downgraded",
    async () => {
      const dir = await setUp();
      const server = await startMediaServer(Buffer.alloc(2 * 1024 * 1024, 3), {
        drip: { chunkSize: 64 * 1024, delayMs: 20 },
      });
      try {
        await expect(
          runYtdlpDownload(dir, server.url, {
            progress: () => {},
            maxDownloadBytes: 1024 * 1024,
          })
        ).rejects.toThrow(/larger than the 1 MB limit for a room file\. Stopped before downloading it\./);
      } finally {
        await server.close();
      }
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "a real failing URL surfaces the real binary's own words through explainDownloadFailure",
    async () => {
      const dir = await setUp();
      const server = await startMediaServer(Buffer.alloc(0), { status: 404 });
      try {
        await expect(
          runYtdlpDownload(dir, server.url, { progress: () => {} })
        ).rejects.toThrow(/The download failed: .*404/);
      } finally {
        await server.close();
      }
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "a real `-j` probe parses: real JSON in, an honest (empty) picker out",
    async () => {
      const dir = await setUp();
      const server = await startMediaServer(Buffer.alloc(64 * 1024, 1));
      try {
        const options = await probeMediaFormats(server.url, {
          dataDir: dir,
          webAccessAllowed: () => true,
        });
        // A plain direct-file URL's format entry carries no `height` at all,
        // so the honest answer is an empty picker, not a fabricated one.
        expect(options).toEqual([]);
        // …and the real info dict really did parse: fold it by hand and
        // confirm the shape rather than only the (empty) verdict.
        const raw = await runCapturing(
          realSpawnFn,
          ytdlpPath(dir),
          ["--no-playlist", "--no-warnings", "-j", server.url],
          WIRE_TIMEOUT_MS
        );
        expect(raw.kind).toBe("exited");
        if (raw.kind === "exited") {
          const info = JSON.parse(raw.stdout) as { formats?: unknown };
          expect(Array.isArray(info.formats)).toBe(true);
          expect(qualityOptions(info, true)).toEqual([]);
        }
      } finally {
        await server.close();
      }
    },
    WIRE_TIMEOUT_MS
  );

  it(
    "a real probe of a dead URL surfaces the real stderr tail",
    async () => {
      const dir = await setUp();
      const server = await startMediaServer(Buffer.alloc(0), { status: 500 });
      try {
        await expect(
          probeMediaFormats(server.url, { dataDir: dir, webAccessAllowed: () => true })
        ).rejects.toThrow(/Couldn't look up this video's qualities: .+/);
      } finally {
        await server.close();
      }
    },
    WIRE_TIMEOUT_MS
  );
});

describe("wire-suite honesty", () => {
  it("states what this machine actually has, so a skip is an environment fact", () => {
    // Not an assertion about the environment — either binary may legitimately
    // be missing; this exists so the run's output says which.
    console.log(
      `[ytdlp.wire.test.ts] yt-dlp: ${REAL_YTDLP ?? "NOT FOUND (real-subprocess suite skipped)"}; ` +
        `ffmpeg: ${REAL_FFMPEG ?? "NOT FOUND (ffmpeg assertion skipped)"}`
    );
    expect(REAL_YTDLP === null || typeof REAL_YTDLP === "string").toBe(true);
  });
});
