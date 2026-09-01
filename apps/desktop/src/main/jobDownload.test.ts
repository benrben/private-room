/**
 * Vitest port of `commands/jobs/download.rs`'s test coverage, driven against a
 * real room DB and the real `jobs.ts`/`jobQueue.ts` machinery — never a
 * hand-rolled fake of the job runner:
 *
 *   - download_titles_prefer_the_filename_then_the_host → {@link downloadTitle}
 *   - a_download_job_claims_no_step_count_it_never_advances — the Rust test
 *     reads its own source text with `include_str!`; here it is pinned as a
 *     BEHAVIOURAL assertion against a real created row's `total` (see
 *     "creates a 'download' row … with total 0" below).
 *
 * PLUS coverage for everything `download.rs`'s own tests could not exercise
 * without the full Tauri `AppState`/`Window`: engine validation, the
 * no-room/offline/bad-URL/queue-full refusals and their ORDER, the
 * immediate-start vs queued-when-busy split, the `"download"` row-starter
 * driven through the real `submit`, and every landing of the runner itself
 * (success, Stop-as-pause, a genuine failure, a room swapped mid-run,
 * unconditional work-dir cleanup) for BOTH engines.
 *
 * The MEDIA engine's own subprocess mechanics (yt-dlp argument selection,
 * format fallback, the progress-line parser, the SSRF pre-flight) are covered
 * at length by `ytdlp.test.ts`/`ytdlp.wire.test.ts`. This file drives
 * `downloadMediaToTemp` FOR REAL where the wrapper's correctness depends on it
 * — a scripted `FakeProcess` (an `EventEmitter` with real `PassThrough` stdio,
 * the same technique `ytdlp.test.ts` uses) stands in for the binary itself —
 * and uses the `downloadMedia` seam only where the point of the test is an
 * exact progress/failure script the real parser cannot be made to produce.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag, createCancelState } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { createJob, getJob, setJobStatus } from "./db-host/jobs.js";
import { setSetting } from "./db-host/settings.js";
import type { JobProgressPayload, ProgressSink, RoomHandle, RoomSource } from "./jobs.js";
import {
  createJobQueueState,
  MAX_QUEUED,
  QUEUE_FULL,
  submit,
  UNREADABLE_PLAN,
  type JobQueueDeps,
  type RowStarter,
} from "./jobQueue.js";
import {
  WEB_OFF_MESSAGE,
  ytdlpPath,
  type MediaDownload,
  type SpawnedProcess,
  type SpawnFn,
} from "./ytdlp.js";
import type { FileMeta } from "../shared/apiTypes.js";
import {
  DOWNLOAD_ENGINE_FETCH,
  DOWNLOAD_ENGINE_MEDIA,
  downloadRowStarter,
  downloadTitle,
  downloadToTempNotImplemented,
  FETCH_DOWNLOAD_NOT_IMPLEMENTED,
  spawnDownload,
  startDownloadJobInner,
  type DownloadEngineDeps,
  type DownloadJobDeps,
  type DownloadMediaFn,
  type DownloadToTempFn,
  type SpawnDownloadDeps,
} from "./jobDownload.js";

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

/** A room with the internet switch OFF — its default posture. */
function freshRoom(): Database.Database {
  const roomPath = path.join(
    tempDir("job-download-"),
    `pr-test-${Math.random().toString(36).slice(2)}.roomai`
  );
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Turns the room's internet switch on — the same setting `webAccess.test.ts`
 * pins the off-by-default rule against. */
function turnWebAccessOn(db: Database.Database): void {
  setSetting(db, "web_provider", "duckduckgo");
}

function freshOnlineRoom(): Database.Database {
  const db = freshRoom();
  turnWebAccessOn(db);
  return db;
}

function fakeRooms(handle: RoomHandle | null): {
  rooms: RoomSource;
  set(h: RoomHandle | null): void;
} {
  let current = handle;
  return {
    rooms: { current: () => current },
    set(h) {
      current = h;
    },
  };
}

function fakeSink(): { sink: ProgressSink; events: JobProgressPayload[] } {
  const events: JobProgressPayload[] = [];
  return { sink: { emit: (p) => events.push(p) }, events };
}

/**
 * Poll until `check()` is true. Used after every fire-and-forget entry point
 * ({@link startDownloadJobInner}, `submit`): those runners do real filesystem
 * I/O, which rides real libuv completions, so a fixed number of macrotask
 * ticks is not a guarantee.
 */
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

/** A literal PUBLIC address: `checkPublicHttpUrl` lets it through and
 * `dns.lookup` answers it from the string itself — the real SSRF guard runs
 * with no DNS query and no network, exactly as `ytdlp.test.ts`'s own fixture
 * of the same name does. */
const PUBLIC_URL = "https://8.8.8.8/video";

const FILE_META: FileMeta = {
  id: "f1",
  name: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: 5,
  source: "download",
  hasText: false,
  createdAt: "2026-01-01T00:00:00Z",
  folderId: null,
  partiallyIndexed: false,
  aiSummary: null,
  originDestination: "library",
  libraryVisibility: "linked",
};

/** A media download that resolves immediately with a REAL (throwaway) work dir,
 * so cleanup assertions have something real to check. */
async function realThrowawayWorkDir(fileName = "clip.mp4"): Promise<MediaDownload> {
  const workDir = tempDir("job-download-media-");
  const filePath = path.join(workDir, fileName);
  await fsp.writeFile(filePath, "not really a video");
  return { workDir, path: filePath };
}

/** The {@link DownloadMediaFn} seam, scripted. Used ONLY where the point of the
 * test is an exact progress/failure sequence the real yt-dlp parser cannot be
 * made to produce; every other media test drives the real engine below. */
function fakeDownloadMedia(
  script: (progress: (status: string, pct: number | null) => void) => Promise<MediaDownload> | MediaDownload
): DownloadMediaFn {
  return async (_dataDir, _url, opts) => script(opts.progress);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function baseEngineDeps(overrides: Partial<DownloadEngineDeps> = {}): DownloadEngineDeps {
  return {
    dataDir: "/tmp/unused-job-download-data-dir",
    importDownload: () => FILE_META,
    findFfmpegFn: () => null,
    downloadMedia: fakeDownloadMedia(() => realThrowawayWorkDir()),
    ...overrides,
  };
}

function makeQueueDeps(
  db: Database.Database | null,
  roomPath = "mem://room",
  overrides: Partial<DownloadJobDeps> = {}
): { deps: DownloadJobDeps; events: JobProgressPayload[]; setRoom(h: RoomHandle | null): void } {
  const { rooms, set } = fakeRooms(db === null ? null : { db, path: roomPath });
  const { sink, events } = fakeSink();
  const queue: JobQueueDeps = {
    state: createJobQueueState(),
    rooms,
    sink,
    cancelState: createCancelState(),
    starters: new Map<string, RowStarter>(),
  };
  return { deps: { ...queue, ...baseEngineDeps(), ...overrides }, events, setRoom: set };
}

/** Runner-only deps ({@link SpawnDownloadDeps}) with recording epilogue hooks —
 * for the tests that drive {@link spawnDownload} directly. */
function makeRunnerDeps(
  db: Database.Database,
  roomPath = "room-a",
  engine: Partial<DownloadEngineDeps> = {}
): {
  deps: SpawnDownloadDeps;
  events: JobProgressPayload[];
  removed: string[];
  settled: string[];
  setRoom(h: RoomHandle | null): void;
} {
  const { rooms, set } = fakeRooms({ db, path: roomPath });
  const { sink, events } = fakeSink();
  const removed: string[] = [];
  const settled: string[] = [];
  return {
    deps: {
      rooms,
      sink,
      removeCancelFlag: (jobId: string) => removed.push(jobId),
      onSettled: (jobId: string) => {
        settled.push(jobId);
      },
      ...baseEngineDeps(engine),
    },
    events,
    removed,
    settled,
    setRoom: set,
  };
}

// ---------------------------------------------------------------- FakeProcess

/** A scriptable stand-in for {@link SpawnedProcess}: an `EventEmitter` with
 * real `PassThrough` stdio, so the real yt-dlp progress-parsing/stream wiring
 * runs unmodified against it. */
class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, "SIGTERM");
    });
    return true;
  }
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function closeFake(fake: FakeProcess, code: number | null): Promise<void> {
  fake.stdout.end();
  fake.stderr.end();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  fake.emit("close", code, null);
}

/** A yt-dlp data dir with a placeholder binary already installed, so
 * `ensureYtdlp` never attempts a real network fetch. */
async function installedBinDataDir(): Promise<string> {
  const dataDir = tempDir("job-download-ytdlp-");
  const dest = ytdlpPath(dataDir);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, "placeholder-binary");
  return dataDir;
}

/** A fake yt-dlp run that materializes the file the engine looks for
 * afterwards, awaited before 'close' fires. */
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

/** A fake yt-dlp run that just fails, writing nothing. */
function spawnFnFailing(stderr = "ERROR: could not fetch"): SpawnFn {
  return () => {
    const fake = new FakeProcess();
    void (async () => {
      fake.stderr.write(`${stderr}\n`);
      await closeFake(fake, 1);
    })();
    return fake;
  };
}

/** A fake yt-dlp run that goes silent forever — the download only ends when the
 * runner kills it (a Stop). */
function spawnFnSilent(): SpawnFn {
  return () => new FakeProcess();
}

// ============================================================================
// download_title
// ============================================================================

describe("downloadTitle", () => {
  it("download_titles_prefer_the_filename_then_the_host", () => {
    expect(downloadTitle("https://example.com/reports/q3.pdf", DOWNLOAD_ENGINE_FETCH)).toBe(
      "Download q3.pdf"
    );
    // Media URLs rarely end in a meaningful filename — the host is honest.
    expect(downloadTitle("https://www.youtube.com/watch?v=abc12345", DOWNLOAD_ENGINE_MEDIA)).toBe(
      "Download www.youtube.com"
    );
    expect(downloadTitle("not a url", DOWNLOAD_ENGINE_FETCH)).toBe("Download not a url");
  });

  it("falls back to the host when the fetch engine's URL has no path segment", () => {
    expect(downloadTitle("https://example.com/", DOWNLOAD_ENGINE_FETCH)).toBe(
      "Download example.com"
    );
    expect(downloadTitle("https://example.com", DOWNLOAD_ENGINE_FETCH)).toBe(
      "Download example.com"
    );
  });
});

// ============================================================================
// the injected seams
// ============================================================================

describe("downloadToTempNotImplemented", () => {
  it("fails with a labeled reason, never a silent success", async () => {
    await expect(
      downloadToTempNotImplemented(PUBLIC_URL, 100, undefined, () => {})
    ).rejects.toThrow(FETCH_DOWNLOAD_NOT_IMPLEMENTED);
    expect(FETCH_DOWNLOAD_NOT_IMPLEMENTED).toMatch(/^NOT_IMPLEMENTED: /);
  });
});

// ============================================================================
// start_download_job_inner
// ============================================================================

describe("startDownloadJobInner", () => {
  it("refuses an unknown engine before touching the room at all", () => {
    const { deps } = makeQueueDeps(null);
    expect(() => startDownloadJobInner(deps, PUBLIC_URL, "carrier-pigeon")).toThrow(
      "Unknown download engine."
    );
  });

  it("refuses when no room is open", () => {
    const { deps } = makeQueueDeps(null);
    expect(() => startDownloadJobInner(deps, PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA)).toThrow(
      "No room is open."
    );
  });

  it("refuses when the room's internet switch is off", () => {
    const db = freshRoom(); // web_provider unset — off by default
    const { deps } = makeQueueDeps(db);
    expect(() => startDownloadJobInner(deps, PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA)).toThrow(
      WEB_OFF_MESSAGE
    );
    db.close();
  });

  it("checks the internet switch BEFORE the address, so an offline room is never told its URL is bad", () => {
    const db = freshRoom();
    const { deps } = makeQueueDeps(db);
    expect(() => startDownloadJobInner(deps, "not a url", DOWNLOAD_ENGINE_MEDIA)).toThrow(
      WEB_OFF_MESSAGE
    );
    db.close();
  });

  it("refuses a URL that fails the literal SSRF pre-flight, before creating any row", () => {
    const db = freshOnlineRoom();
    const { deps } = makeQueueDeps(db);
    expect(() => startDownloadJobInner(deps, "not a url", DOWNLOAD_ENGINE_MEDIA)).toThrow(
      /Invalid URL/
    );
    expect(() =>
      startDownloadJobInner(deps, "http://127.0.0.1:9/x", DOWNLOAD_ENGINE_MEDIA)
    ).toThrow(/Local and private-network/);
    db.close();
  });

  it("refuses at capacity, with the sentence every job kind uses", () => {
    const db = freshOnlineRoom();
    for (let i = 0; i < MAX_QUEUED; i++) {
      createJob(db, "workflow", `filler ${i}`, {}, 1);
    }
    const { deps } = makeQueueDeps(db);
    expect(() => startDownloadJobInner(deps, PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA)).toThrow(
      QUEUE_FULL
    );
    db.close();
  });

  it("creates a 'download' row titled from the URL, with plan {url, engine} and total 0", async () => {
    const db = freshOnlineRoom();
    const { deps } = makeQueueDeps(db);

    const jobId = startDownloadJobInner(deps, PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA);

    const row = getJob(db, jobId);
    expect(row.kind).toBe("download");
    expect(row.title).toBe("Download 8.8.8.8");
    expect(row.total, "the cursor never advances — 0 is the honest total").toBe(0);
    expect(row.plan).toEqual({ url: PUBLIC_URL, engine: DOWNLOAD_ENGINE_MEDIA });
    await waitUntil(() => deps.state.runningJob === null);
    db.close();
  });

  it("starts the runner immediately when the slot is free, pinned to the room that is open NOW", async () => {
    const db = freshOnlineRoom();
    const { deps, events } = makeQueueDeps(db, "room-open-now");

    const jobId = startDownloadJobInner(deps, PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA);

    // Reserving the slot and registering the cancel flag both complete before
    // this line — the runner itself is fire-and-forget.
    expect(deps.state.runningJob).toBe(jobId);
    expect(deps.cancelState.jobCancels.has(jobId)).toBe(true);
    expect(getJob(db, jobId).status).toBe("running");
    expect(events[0]).toEqual({ jobId, label: "Downloading…", done: 0, total: 100 });

    await waitUntil(() => getJob(db, jobId).status === "done");
    expect(deps.state.runningJob, "the runner's own epilogue freed the slot").toBeNull();
    expect(deps.cancelState.jobCancels.has(jobId)).toBe(false);
    db.close();
  });

  it("leaves the row queued, with no cancel flag, when the slot is busy", () => {
    const db = freshOnlineRoom();
    const { deps } = makeQueueDeps(db);
    deps.state.runningJob = "someone-elses-job";

    const jobId = startDownloadJobInner(deps, PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA);

    expect(getJob(db, jobId).status).toBe("queued");
    expect(deps.state.runningJob).toBe("someone-elses-job");
    expect(deps.cancelState.jobCancels.has(jobId)).toBe(false);
    db.close();
  });

  it("drives a REAL yt-dlp media download end to end: running -> done, through the import funnel", async () => {
    const dataDir = await installedBinDataDir();
    const db = freshOnlineRoom();
    const seen: Array<[string, string, string]> = [];
    const { deps } = makeQueueDeps(db, "mem://room", {
      dataDir,
      downloadMedia: undefined, // the REAL downloadMediaToTemp
      spawnFn: spawnFnWritingVideo("hello"),
      cancelPollMs: 5,
      importDownload: (p, name, url) => {
        seen.push([p, name, url]);
        return FILE_META;
      },
    });

    const jobId = startDownloadJobInner(deps, PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA);
    expect(getJob(db, jobId).status).toBe("running");
    await waitUntil(() => getJob(db, jobId).status === "done");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[1]).toBe("clip.mp4");
    expect(seen[0]?.[2]).toBe(PUBLIC_URL);
    db.close();
  });
});

// ============================================================================
// start_download_row — the queue's RowStarter
// ============================================================================

describe("downloadRowStarter", () => {
  it("refuses a plan carrying no url, before any engine is reached — through the real submit", async () => {
    const db = freshOnlineRoom();
    let reached = false;
    const { deps } = makeQueueDeps(db, "mem://room", {
      starters: new Map([
        [
          "download",
          downloadRowStarter(
            baseEngineDeps({
              downloadMedia: fakeDownloadMedia(() => {
                reached = true;
                return realThrowawayWorkDir();
              }),
            })
          ),
        ],
      ]),
    });
    const jobId = createJob(db, "download", "Download", { engine: DOWNLOAD_ENGINE_MEDIA }, 0);

    await submit(deps, jobId);

    expect(getJob(db, jobId).status).toBe("error");
    expect(getJob(db, jobId).error).toBe(UNREADABLE_PLAN);
    expect(reached).toBe(false);
    db.close();
  });

  it("defaults a missing engine to fetch, matching start_download_row", async () => {
    const db = freshOnlineRoom();
    let calledWith: string | null = null;
    const { deps } = makeQueueDeps(db, "mem://room", {
      starters: new Map([
        [
          "download",
          downloadRowStarter(
            baseEngineDeps({
              downloadToTemp: (async (url) => {
                calledWith = url;
                return { kind: "too-large" as const };
              }) as DownloadToTempFn,
            })
          ),
        ],
      ]),
    });
    const jobId = createJob(db, "download", "Download", { url: PUBLIC_URL }, 0);

    await submit(deps, jobId);
    await waitUntil(() => getJob(db, jobId).status === "error");

    expect(calledWith).toBe(PUBLIC_URL);
    db.close();
  });

  it("holds the slot while the download is in flight, and the epilogue frees it", async () => {
    const db = freshOnlineRoom();
    let settle!: (v: MediaDownload) => void;
    const inFlight = new Promise<MediaDownload>((res) => {
      settle = res;
    });
    const { deps } = makeQueueDeps(db, "mem://room", {
      starters: new Map([
        ["download", downloadRowStarter(baseEngineDeps({ downloadMedia: fakeDownloadMedia(() => inFlight) }))],
      ]),
    });
    const jobId = createJob(
      db,
      "download",
      "Download",
      { url: PUBLIC_URL, engine: DOWNLOAD_ENGINE_MEDIA },
      0
    );

    await submit(deps, jobId);

    expect(deps.state.runningJob).toBe(jobId);
    expect(getJob(db, jobId).status).toBe("running");

    settle(await realThrowawayWorkDir());
    await waitUntil(() => deps.state.runningJob === null);

    expect(getJob(db, jobId).status).toBe("done");
    expect(deps.cancelState.jobCancels.has(jobId)).toBe(false);
    db.close();
  });

  it("hands the runner the very cancel flag the queue registered", async () => {
    const db = freshOnlineRoom();
    const { deps } = makeQueueDeps(db);
    let seenCancel: CancelFlag | null = null;
    const starter = downloadRowStarter(
      baseEngineDeps({
        downloadToTemp: (async (_url, _max, c) => {
          seenCancel = c as CancelFlag;
          return { kind: "too-large" as const };
        }) as DownloadToTempFn,
      })
    );
    const cancel = new CancelFlag();
    const jobId = createJob(
      db,
      "download",
      "x",
      { url: PUBLIC_URL, engine: DOWNLOAD_ENGINE_FETCH },
      0
    );

    const result = await starter(deps, getJob(db, jobId), "mem://room", cancel);
    expect(result).toEqual({ kind: "runner" });
    await waitUntil(() => seenCancel !== null);

    expect(seenCancel).toBe(cancel);
    db.close();
  });
});

// ============================================================================
// spawn_download / run_download — every landing, both engines
// ============================================================================

describe("spawnDownload — FETCH engine (the injected seam)", () => {
  it("with no downloadToTemp dependency, reaches NOT_IMPLEMENTED as a real error path", async () => {
    const db = freshRoom();
    const id = createJob(
      db,
      "download",
      "Download 8.8.8.8",
      { url: PUBLIC_URL, engine: DOWNLOAD_ENGINE_FETCH },
      0
    );
    const { deps, events, removed, settled } = makeRunnerDeps(db);

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_FETCH, new CancelFlag());

    const row = getJob(db, id);
    expect(row.status).toBe("error");
    expect(row.error).toBe(FETCH_DOWNLOAD_NOT_IMPLEMENTED);
    expect(events[0]).toEqual({ jobId: id, label: "Downloading…", done: 0, total: 100 });
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: `Download failed — ${FETCH_DOWNLOAD_NOT_IMPLEMENTED}`,
      done: 0,
      total: 100,
      failed: true,
    });
    expect(removed).toEqual([id]);
    expect(settled).toEqual([id]);
    db.close();
  });

  it("a successful fetch marks the job done and names the imported file", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download x", { url: PUBLIC_URL }, 0);
    const downloadToTemp: DownloadToTempFn = vi.fn(async (_url, _max, _cancel, progress) => {
      progress(50, 100);
      return { kind: "done" as const, file: { path: "/tmp/staged/vid.mp4", fileName: "vid.mp4" } };
    });
    const { deps, events } = makeRunnerDeps(db, "room-a", { downloadToTemp });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_FETCH, new CancelFlag());

    expect(downloadToTemp).toHaveBeenCalled();
    expect(getJob(db, id).status).toBe("done");
    expect(events).toContainEqual({ jobId: id, label: "Downloading…", done: 50, total: 100 });
    expect(events).toContainEqual({
      jobId: id,
      label: "Sealing into the room…",
      done: 99,
      total: 100,
    });
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: `${FILE_META.name} arrived in the room`,
      done: 100,
      total: 100,
      finished: true,
      fileId: FILE_META.id,
    });
    db.close();
  });

  it("a fetch with no declared length keeps the bar at zero rather than inventing a fraction, and never reaches 100 mid-flight", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download x", { url: PUBLIC_URL }, 0);
    const { deps, events } = makeRunnerDeps(db, "room-a", {
      downloadToTemp: (async (_url, _max, _cancel, progress) => {
        progress(1234, null); // no content-length
        progress(1234, 0); // a declared zero is not a denominator either
        progress(100, 100); // complete on the wire — still 99 at most on the card
        return { kind: "done" as const, file: { path: "/tmp/x", fileName: "x" } };
      }) as DownloadToTempFn,
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_FETCH, new CancelFlag());

    const bars = events.filter((e) => e.label === "Downloading…").map((e) => e.done);
    expect(bars).toEqual([0, 0, 0, 99]);
    db.close();
  });

  it("a too-large outcome is a real, honest failure naming the cap", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download x", { url: PUBLIC_URL }, 0);
    const { deps } = makeRunnerDeps(db, "room-a", {
      downloadToTemp: (async () => ({ kind: "too-large" }) as const) as DownloadToTempFn,
      maxDownloadBytes: 10 * 1024 * 1024,
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_FETCH, new CancelFlag());

    const row = getJob(db, id);
    expect(row.status).toBe("error");
    expect(row.error).toContain("larger than the 10 MB limit");
    db.close();
  });

  it("an unrecognised stored engine falls back to the fetch path, matching start_download_row's default", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download x", { url: PUBLIC_URL }, 0);
    const { deps } = makeRunnerDeps(db);

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, "carrier-pigeon", new CancelFlag());

    expect(getJob(db, id).error).toBe(FETCH_DOWNLOAD_NOT_IMPLEMENTED);
    db.close();
  });

  it("an error raised while the cancel flag is set is reported as a clean Pause", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download x", { url: PUBLIC_URL }, 0);
    const cancel = new CancelFlag();
    const { deps, events } = makeRunnerDeps(db, "room-a", {
      downloadToTemp: (async () => {
        cancel.store(true);
        throw new Error("stopped mid-request");
      }) as DownloadToTempFn,
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_FETCH, cancel);

    const row = getJob(db, id);
    expect(row.status).toBe("paused");
    expect(row.error, "a pause has nothing to explain").toBeNull();
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: "Paused",
      done: 0,
      total: 100,
      paused: true,
    });
    db.close();
  });

  it("a room swapped out from under the job writes nothing to the wrong room, but still emits the terminal event", async () => {
    const dbA = freshRoom();
    const id = createJob(dbA, "download", "Download x", { url: PUBLIC_URL }, 0);
    setJobStatus(dbA, id, "running", null);
    const { rooms, set } = fakeRooms({ db: dbA, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps: SpawnDownloadDeps = {
      rooms,
      sink,
      removeCancelFlag: () => {},
      onSettled: () => {},
      ...baseEngineDeps({
        downloadToTemp: (async () => {
          set(null); // simulate the room swapping mid-download
          return { kind: "done", file: { path: "/tmp/vid.mp4", fileName: "vid.mp4" } } as const;
        }) as DownloadToTempFn,
      }),
    };

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_FETCH, new CancelFlag());

    expect(getJob(dbA, id).status, "no terminal write reached the room that closed").toBe("running");
    expect((events[events.length - 1] as JobProgressPayload).finished).toBe(true);
    dbA.close();
  });
});

describe("spawnDownload — MEDIA engine", () => {
  it("translates the engine's own status/percent into job-progress events (floor, and clamped)", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download", { url: PUBLIC_URL }, 0);
    const { deps, events } = makeRunnerDeps(db, "room-a", {
      downloadMedia: fakeDownloadMedia(async (progress) => {
        progress("Fetching the video downloader…", null);
        progress("Downloading the video…", 42.9); // floor, not round, per Rust's `as usize`
        progress("Downloading the video…", 137); // clamps to 100
        progress("Downloading the video…", -5); // clamps to 0
        return realThrowawayWorkDir();
      }),
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA, new CancelFlag());

    const mediaEvents = events.filter(
      (e) => e.label !== "Downloading…" && e.label !== "Sealing into the room…" && !e.finished
    );
    expect(mediaEvents).toEqual([
      { jobId: id, label: "Fetching the video downloader…", done: 0, total: 100 },
      { jobId: id, label: "Downloading the video…", done: 42, total: 100 },
      { jobId: id, label: "Downloading the video…", done: 100, total: 100 },
      { jobId: id, label: "Downloading the video…", done: 0, total: 100 },
    ]);
    db.close();
  });

  it("sweeps the temp work dir even when the import fails", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download", { url: PUBLIC_URL }, 0);
    const media = await realThrowawayWorkDir();
    const { deps } = makeRunnerDeps(db, "room-a", {
      downloadMedia: fakeDownloadMedia(() => media),
      importDownload: () => {
        throw new Error("the room refused it");
      },
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA, new CancelFlag());

    expect(getJob(db, id).status).toBe("error");
    expect(getJob(db, id).error).toBe("the room refused it");
    expect(
      await pathExists(media.workDir),
      "cleanup runs unconditionally, like the Rust source"
    ).toBe(false);
    db.close();
  });

  it("keeps a completed import successful when best-effort temp cleanup fails", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download", { url: PUBLIC_URL }, 0);
    const media = await realThrowawayWorkDir();
    const rm = vi.fn(async () => { throw new Error("fabricated cleanup refusal"); });
    const { deps } = makeRunnerDeps(db, "room-a", {
      downloadMedia: fakeDownloadMedia(() => media),
      removeWorkDir: rm,
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA, new CancelFlag());
    expect(getJob(db, id).status).toBe("done");
    expect(rm).toHaveBeenCalledWith(media.workDir, { recursive: true, force: true });
    db.close();
  });

  it("a genuine failure (cancel NOT set) parks the job with the real reason", async () => {
    const db = freshRoom();
    const id = createJob(db, "download", "Download", { url: PUBLIC_URL }, 0);
    const { deps, events } = makeRunnerDeps(db, "room-a", {
      downloadMedia: fakeDownloadMedia(() => {
        throw new Error("the video is gone");
      }),
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA, new CancelFlag());

    const row = getJob(db, id);
    expect(row.status).toBe("error");
    expect(row.error).toBe("the video is gone");
    const terminal = events[events.length - 1] as JobProgressPayload;
    expect(terminal.label).toBe("Download failed — the video is gone");
    expect(terminal.failed).toBe(true);
    db.close();
  });
});

describe("spawnDownload — MEDIA engine, against the REAL ytdlp.ts core", () => {
  it("a real download succeeds: running -> done, imports through the funnel, sweeps the temp dir", async () => {
    const dataDir = await installedBinDataDir();
    const db = freshRoom();
    const id = createJob(
      db,
      "download",
      "Download x",
      { url: PUBLIC_URL, engine: DOWNLOAD_ENGINE_MEDIA },
      0
    );
    const seen: Array<[string, string, string]> = [];
    const { deps, events } = makeRunnerDeps(db, "room-a", {
      dataDir,
      downloadMedia: undefined, // the REAL downloadMediaToTemp
      spawnFn: spawnFnWritingVideo("hello"),
      importDownload: (p, name, url) => {
        seen.push([p, name, url]);
        return FILE_META;
      },
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA, new CancelFlag());

    expect(getJob(db, id).status).toBe("done");
    expect(seen).toHaveLength(1);
    const [staged, name] = seen[0] as [string, string, string];
    expect(name).toBe("clip.mp4");
    expect(await pathExists(path.dirname(staged)), "work dir swept").toBe(false);
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: `${FILE_META.name} arrived in the room`,
      done: 100,
      total: 100,
      finished: true,
      fileId: FILE_META.id,
    });
    db.close();
  });

  it("a real download failure (bad exit code) parks the job with yt-dlp's own explanation", async () => {
    const dataDir = await installedBinDataDir();
    const db = freshRoom();
    const id = createJob(db, "download", "Download x", { url: PUBLIC_URL }, 0);
    const { deps, events } = makeRunnerDeps(db, "room-a", {
      dataDir,
      downloadMedia: undefined,
      spawnFn: spawnFnFailing("ERROR: Requested format is not available"),
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA, new CancelFlag());

    const row = getJob(db, id);
    expect(row.status).toBe("error");
    expect(row.error).toContain("The download failed");
    expect((events[events.length - 1] as JobProgressPayload).failed).toBe(true);
    expect((events[events.length - 1] as JobProgressPayload).label).toContain("Download failed —");
    db.close();
  });

  it("a Stop mid-download is a clean Pause, not a failure", async () => {
    const dataDir = await installedBinDataDir();
    const db = freshRoom();
    const id = createJob(db, "download", "Download x", { url: PUBLIC_URL }, 0);
    const cancel = new CancelFlag();
    cancel.store(true); // Stop pressed before the download even starts
    const { deps, events } = makeRunnerDeps(db, "room-a", {
      dataDir,
      downloadMedia: undefined,
      spawnFn: spawnFnSilent(),
      cancelPollMs: 5,
    });

    await spawnDownload(deps, id, "room-a", PUBLIC_URL, DOWNLOAD_ENGINE_MEDIA, cancel);

    const row = getJob(db, id);
    expect(row.status).toBe("paused");
    expect(row.error).toBeNull();
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: "Paused",
      done: 0,
      total: 100,
      paused: true,
    });
    db.close();
  });
});
