/**
 * Coverage for `execTool.ts`'s `download_media`/`download_url` wiring — the ONE
 * surgical edit this batch made to that file (see the `execDownloadMedia` arm's
 * own comment for the exact Rust arm it mirrors, `agent.rs`'s `"download_media"`
 * match arm, lines ~3817-3836).
 *
 * `execTool.test.ts` itself is untouched: under its own all-default `deps()`
 * (no `outboundUrlRefusal`, no `downloadJob`), `download_media` still resolves
 * to a labeled `NOT_IMPLEMENTED` — identical to its pre-existing behaviour —
 * which is exactly why that file needed no edit. This file adds the coverage
 * for what happens once those two seams ARE wired: the real dispatch through
 * `jobDownload.ts`'s `startDownloadJobInner`.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createCancelState } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { getJob } from "./db-host/jobs.js";
import { setSetting } from "./db-host/settings.js";
import { createJobQueueState, type JobQueueDeps, type RowStarter } from "./jobQueue.js";
import type { RoomHandle } from "./jobs.js";
import type { DownloadJobDeps } from "./jobDownload.js";
import { ytdlpPath, type SpawnedProcess, type SpawnFn } from "./ytdlp.js";
import { createToolEffects, execTool, type ExecToolDeps } from "./execTool.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function freshRoom(): Database.Database {
  const roomPath = path.join(
    tempDir("exec-tool-download-"),
    `t-${Math.random().toString(36).slice(2)}.roomai`
  );
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function turnWebAccessOn(db: Database.Database): void {
  setSetting(db, "web_provider", "duckduckgo");
}

/** A yt-dlp data dir with a placeholder binary already installed, so
 * `ensureYtdlp` never attempts a real network fetch — the same technique
 * `ytdlp.test.ts`/`jobDownload.test.ts` use. */
function installedYtdlpDataDir(): string {
  const dir = tempDir("exec-tool-download-ytdlp-");
  const dest = ytdlpPath(dir);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, "placeholder-binary");
  return dir;
}

/** A yt-dlp subprocess stand-in that fails immediately, writing no file — so
 * the background runner this test never awaits settles (to 'error') within a
 * tick or two instead of hanging or reaching the real network. */
class FailFastProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(): boolean {
    return true;
  }
}

function failFastSpawnFn(): SpawnFn {
  return () => {
    const fake = new FailFastProcess();
    queueMicrotask(() => {
      fake.stderr.write("ERROR: no such video\n");
      fake.stdout.end();
      fake.stderr.end();
      fake.emit("close", 1, null);
    });
    return fake;
  };
}

function downloadJobDeps(
  db: Database.Database,
  overrides: Partial<DownloadJobDeps> = {}
): DownloadJobDeps {
  const rooms = { current: (): RoomHandle | null => ({ db, path: "mem://room" }) };
  const queueDeps: JobQueueDeps = {
    state: createJobQueueState(),
    rooms,
    sink: { emit: () => {} },
    cancelState: createCancelState(),
    starters: new Map<string, RowStarter>(),
  };
  return {
    ...queueDeps,
    dataDir: installedYtdlpDataDir(),
    findFfmpegFn: () => null,
    spawnFn: failFastSpawnFn(),
    importDownload: () => {
      throw new Error("must not be called — the fake yt-dlp run in this file never succeeds");
    },
    ...overrides,
  };
}

function deps(overrides: Partial<ExecToolDeps> = {}): ExecToolDeps {
  return { db: null, routes: [], ...overrides };
}

async function waitUntil(check: () => boolean, timeoutMs = 10000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("download_url", () => {
  it("stays an honest stub naming exactly what it needs", async () => {
    const outcome = await execTool(
      "download_url",
      { url: "https://example.com/x" },
      createToolEffects(),
      deps()
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/^NOT_IMPLEMENTED: /);
      expect(outcome.error).toContain("download_to_temp");
      expect(outcome.error).toContain("outbound_url_hides");
      // Names download_media as the sibling that IS wired, so a reader of the
      // transcript is not left thinking neither tool works at all.
      expect(outcome.error).toContain("download_media");
    }
  });
});

describe("download_media", () => {
  it("refuses (NOT_IMPLEMENTED) before touching any room when the privacy gate is unwired", async () => {
    const outcome = await execTool(
      "download_media",
      { url: "https://example.com/x" },
      createToolEffects(),
      deps() // no outboundUrlRefusal, no downloadJob, no db
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/^NOT_IMPLEMENTED: /);
      expect(outcome.error).toContain("outbound_url_hides");
    }
  });

  it("a privacy refusal is a normal ok() result naming what was blocked, never a tool failure", async () => {
    const outcome = await execTool(
      "download_media",
      { url: "https://example.com/dana-cohen" },
      createToolEffects(),
      deps({ outboundUrlRefusal: () => "Not fetched: this URL carries 1 protected name(s)..." })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("Not fetched");
    }
  });

  it("outbound_url_refusal runs before the room check — 'No room is open' is never reached ahead of it", async () => {
    let sawUrl: string | null = null;
    const outcome = await execTool(
      "download_media",
      { url: "  https://example.com/x  " },
      createToolEffects(),
      deps({
        outboundUrlRefusal: (url) => {
          sawUrl = url;
          return null; // clean
        },
      })
    );
    // The Rust arm trims BEFORE the privacy check, so the checked string is the
    // one that would go on the wire.
    expect(sawUrl).toBe("https://example.com/x");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("No room is open.");
    }
  });

  it("answers 'web access is off' as a normal result once a room is open but offline", async () => {
    const db = freshRoom(); // web_provider unset -> off
    const outcome = await execTool(
      "download_media",
      { url: "https://example.com/x" },
      createToolEffects(),
      deps({ db, outboundUrlRefusal: () => null })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toBe("Web access is turned off in Settings → Online features.");
    }
    db.close();
  });

  it("is NOT_IMPLEMENTED for the queue wiring specifically, once privacy and web-access both pass", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    const outcome = await execTool(
      "download_media",
      { url: "https://example.com/x" },
      createToolEffects(),
      deps({ db, outboundUrlRefusal: () => null }) // no downloadJob
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/^NOT_IMPLEMENTED: /);
      expect(outcome.error).toContain("queue");
    }
    db.close();
  });

  it("fully wired: creates a real download job, starts the real runner, and reports the id", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    const outcome = await execTool(
      "download_media",
      { url: "https://8.8.8.8/video" },
      createToolEffects(),
      deps({ db, outboundUrlRefusal: () => null, downloadJob: downloadJobDeps(db) })
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toContain("Downloading the media as background job");
      expect(outcome.text).toContain("job_status");
      const jobId = /background job (\S+) —/.exec(outcome.text)?.[1];
      expect(jobId).toBeDefined();
      const row = getJob(db, jobId as string);
      expect(row.kind).toBe("download");
      expect(row.total, "no step count — the cursor never advances").toBe(0);
      expect(row.plan).toEqual({ url: "https://8.8.8.8/video", engine: "media" });
      // The slot was free, so the real runner already started before this call
      // returned — matching jobDownload.ts's own startDownloadJobInner.
      expect(row.status).toBe("running");

      // Let the (deliberately fast-failing) yt-dlp stand-in run to completion,
      // proving the wiring drives a REAL runner rather than a fire-and-forget
      // no-op.
      await waitUntil(() => getJob(db, jobId as string).status === "error");
    }
    db.close();
  });

  it("a genuine refusal from startDownloadJobInner (e.g. an invalid URL) is a real tool failure", async () => {
    const db = freshRoom();
    turnWebAccessOn(db);
    const outcome = await execTool(
      "download_media",
      { url: "not a url" },
      createToolEffects(),
      deps({ db, outboundUrlRefusal: () => null, downloadJob: downloadJobDeps(db) })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toMatch(/Invalid URL/);
    }
    db.close();
  });
});
