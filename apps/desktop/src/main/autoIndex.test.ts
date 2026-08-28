/**
 * Vitest port of `src-tauri/src/commands/jobs/auto_index.rs`'s own
 * `#[cfg(test)] mod tests` (`auto_index_decision_covers_all_branches`), plus
 * the coverage this port adds for the machinery the Rust suite cannot reach
 * without the full Tauri `AppState`/async runtime: {@link runAutoIndexPass}
 * (the debounced tick's real read-decide-dispatch), {@link runAutoIndex} (the
 * bounded retry loop) and {@link scheduleAutoIndex} (the generation race) —
 * the same gap `jobScheduler.test.ts`'s header describes for `tick`.
 *
 * REAL FIXTURE ROOMS: every test that touches the database opens a real
 * `.roomai` through `createRoom` and drives the real `db-host/*` readers,
 * matching this directory's established convention.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag, createCancelState } from "./cancel.js";
import { insertFile } from "./db-host/files.js";
import { createJob, getJob, listJobs, setJobStatus, unfinishedJobs } from "./db-host/jobs.js";
import { createRoom } from "./db-host/open.js";
import { setRecMeta } from "./db-host/recordings.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  type AutoIndexDeps,
  QUIET_FILLER_MAX,
  SUMMARY_FILLER_NOT_IMPLEMENTED,
  autoIndexDecision,
  createAutoIndexState,
  runAutoIndex,
  runAutoIndexPass,
  scheduleAutoIndex,
  spawnSummaryFillerNotImplemented,
  startDeepSummaryAutoNotImplemented,
  startRecReadNotImplemented,
} from "./autoIndex.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "auto-index-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function fakeRooms(handle: RoomHandle | null): RoomSource {
  return { current: () => handle };
}

function addFile(db: Database.Database, name: string, text: string): string {
  return insertFile(db, name, "text/plain", Buffer.from(text, "utf8"), text, "upload").id;
}

/** `n` distinct files that all still need a summary. */
function addMissingSummaryFiles(db: Database.Database, n: number): void {
  for (let i = 0; i < n; i++) {
    addFile(db, `f${i}.txt`, `content number ${i}`);
  }
}

/** A recording with a transcript, never read. `text` is the file's extracted
 * text — pass `""` for a recording that is not ALSO a missing-summary file, so
 * a test can isolate the recording-read arm from the summary sweep. */
function addUnreadRecording(db: Database.Database, name = "meeting.wav", text = "(live recording)"): string {
  const id = addFile(db, name, text);
  const seg =
    '{"id":"s","source":"sys","speaker":"Speaker 1","t0":0,"t1":10,"text":"hi","words":[]}';
  setRecMeta(db, id, `{"durationCs":10,"segments":[${seg}],"cuts":[]}`);
  return id;
}

/**
 * The same database, with a hook that fires just before any statement whose SQL
 * contains `marker` is prepared. Lets a test target exactly ONE of the tick's
 * several room reads — to make it fail, or to move the world out from under it
 * — without taking the whole connection down with it.
 */
function dbOnSql(
  db: Database.Database,
  marker: string,
  onMatch: () => void
): Database.Database {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes(marker)) {
            onMatch();
          }
          return (value as (s: string) => unknown).call(target, sql);
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as Database.Database;
}

/**
 * The same database, but the one statement matching `marker` fails. Rust gets
 * every one of these for free — `get_setting` ends in `.ok()`,
 * `files_missing_summary` in `.unwrap_or(0)`, `recordings_missing_read` in
 * `.unwrap_or_default()`, and the whole stale-job cleanup sits inside a
 * swallowed `let _ = state.with_room(...)`.
 */
function dbFailingOnSql(db: Database.Database, marker: string): Database.Database {
  return dbOnSql(db, marker, () => {
    throw new Error("simulated: this statement cannot run right now");
  });
}

/** The exact SQL fragments the four best-effort readers are recognizable by. */
const SQL = {
  getSetting: "SELECT value FROM settings WHERE key = ?",
  filesMissingSummary: "ai_summary IS NULL",
  recordingsMissingRead: "json_extract(r.meta, '$.readOf')",
  unfinishedJobs: "WHERE status IN ('running','queued','paused')",
  deleteJobArtifacts: "DELETE FROM job_artifacts WHERE job_id = ?",
} as const;

/** A `deps` fixture whose three action seams are spies and whose room, cancel
 * registry and model probe are all "ready" — individual tests override just
 * the field they exercise. */
function testDeps(
  db: Database.Database,
  overrides: Partial<AutoIndexDeps> = {}
): AutoIndexDeps & {
  recRead: ReturnType<typeof vi.fn>;
  deepSummary: ReturnType<typeof vi.fn>;
  filler: ReturnType<typeof vi.fn>;
} {
  const recRead = vi.fn(async (_roomPath: string, _fileId: string) => "job-rec");
  const deepSummary = vi.fn(async (_roomPath: string) => "job-deep");
  const filler = vi.fn((_roomPath: string, _delaySecs: number) => {});
  const deps: AutoIndexDeps = {
    rooms: fakeRooms({ db, path: "room" }),
    cancelState: createCancelState(),
    listModels: async () => ["qwen3.5:4b"],
    startRecRead: recRead,
    startDeepSummaryAuto: deepSummary,
    spawnSummaryFiller: filler,
    ...overrides,
  };
  return Object.assign(deps, { recRead, deepSummary, filler });
}

/** One pass under a fresh state, at the generation that state is already on. */
function onePass(deps: AutoIndexDeps, roomPath = "room") {
  const state = createAutoIndexState();
  return runAutoIndexPass(deps, state, state.generation, roomPath);
}

// ============================================================================
// The pure policy — the Rust suite's own table, verbatim
// ============================================================================

describe("autoIndexDecision", () => {
  it("covers all branches (auto_index_decision_covers_all_branches)", () => {
    // Toggled off → nothing happens, regardless of everything else. The switch
    // says "Describe new files automatically with the local AI", so OFF has to
    // mean no describing — not a quieter kind of describing.
    expect(autoIndexDecision(false, 100, true, true, false)).toBe("skip");
    expect(autoIndexDecision(false, 1, false, false, true)).toBe("skip");
    // Busy (a streaming answer or a live job) → bounded retry.
    expect(autoIndexDecision(true, 10, true, false, true)).toBe("retry");
    expect(autoIndexDecision(true, 10, false, true, true)).toBe("retry");
    // No model installed → skip (the next import re-arms).
    expect(autoIndexDecision(true, 10, false, false, false)).toBe("skip");
    // Nothing missing → skip.
    expect(autoIndexDecision(true, 0, false, false, true)).toBe("skip");
    // Tiny drop → quiet filler, no job-card noise.
    expect(autoIndexDecision(true, 1, false, false, true)).toBe("quietFiller");
    expect(autoIndexDecision(true, QUIET_FILLER_MAX, false, false, true)).toBe("quietFiller");
    // Above the threshold → one visible durable job.
    expect(autoIndexDecision(true, QUIET_FILLER_MAX + 1, false, false, true)).toBe("startJob");
    // Busy wins over "no model": we re-check availability on the retry.
    expect(autoIndexDecision(true, 10, true, false, false)).toBe("retry");
  });
});

// ============================================================================
// runAutoIndexPass — one debounce-elapsed check
// ============================================================================

describe("runAutoIndexPass — the summary sweep", () => {
  it("an unset auto_index setting reads as ON (absent = on)", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, 1);
    expect(getSetting(db, "auto_index")).toBeNull();
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "quietFiller" });
    db.close();
  });

  it("setting off skips, even with a large missing set, models, and an unread recording", async () => {
    const db = freshRoom();
    setSetting(db, "auto_index", "0");
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 5);
    addUnreadRecording(db);
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "skip" });
    expect(deps.deepSummary).not.toHaveBeenCalled();
    expect(deps.filler).not.toHaveBeenCalled();
    // The switch gates the recording-read arm too — half a switch is the same
    // defect as no switch, only harder to notice.
    expect(deps.recRead).not.toHaveBeenCalled();
    db.close();
  });

  it("a live 'asking' cancel flag forces a retry, and starts nothing", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 5);
    addUnreadRecording(db);
    const deps = testDeps(db);
    deps.cancelState.cancels.set("turn-1", new CancelFlag());

    expect(await onePass(deps)).toEqual({ kind: "retry" });
    expect(deps.deepSummary).not.toHaveBeenCalled();
    expect(deps.filler).not.toHaveBeenCalled();
    expect(deps.recRead).not.toHaveBeenCalled();
    db.close();
  });

  it("a live job-cancel flag also forces a retry", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, 1);
    addUnreadRecording(db);
    const deps = testDeps(db);
    deps.cancelState.jobCancels.set("job-1", new CancelFlag());

    expect(await onePass(deps)).toEqual({ kind: "retry" });
    expect(deps.filler).not.toHaveBeenCalled();
    expect(deps.recRead).not.toHaveBeenCalled();
    db.close();
  });

  it("no installed models skips — and never reads a recording either", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 5);
    addUnreadRecording(db);
    const deps = testDeps(db, { listModels: async () => [] });

    expect(await onePass(deps)).toEqual({ kind: "skip" });
    expect(deps.recRead).not.toHaveBeenCalled();
    expect(deps.deepSummary).not.toHaveBeenCalled();
    db.close();
  });

  it("nothing missing and nothing unread is a skip", async () => {
    const db = freshRoom();
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "skip" });
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("a drop at the QUIET_FILLER_MAX boundary goes through the quiet filler, delay 0", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX);
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "quietFiller" });
    // Delay 0 is load-bearing: this waiter already debounced, so the filler's
    // own 45 s head start must not stack on top.
    expect(deps.filler).toHaveBeenCalledExactlyOnceWith("room", 0);
    expect(deps.deepSummary).not.toHaveBeenCalled();
    db.close();
  });

  it("one file past the boundary becomes a durable job instead", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });
    expect(deps.deepSummary).toHaveBeenCalledExactlyOnceWith("room");
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("a refused deep-summary start is reported as such, never as a fabricated success", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db, { startDeepSummaryAuto: startDeepSummaryAutoNotImplemented });

    // Rust discards the result (`let _ = ...`), so the tick still ends here —
    // but it must not reject out of the detached waiter either.
    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: null });
    // And this module never wrote a job row of its own: building the
    // missing-set plan stays `start_deep_summary_inner`'s job once ported.
    expect(listJobs(db)).toHaveLength(0);
    db.close();
  });
});

describe("runAutoIndexPass — the job-lifecycle amendment", () => {
  it("retires a stale unfinished AUTO deep_summary job and leaves a manual one alone", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    // Parked 'paused' by quiesce after a quit mid-run.
    const staleAuto = createJob(db, "deep_summary", "Indexing new files", { auto: true }, 3);
    setJobStatus(db, staleAuto, "paused", null);
    // A manual "Room summary" run is something the user asked for by name.
    const manual = createJob(db, "deep_summary", "Room summary", { auto: false }, 1);
    setJobStatus(db, manual, "paused", null);
    // A job of another kind carrying `auto: true` is not ours to retire.
    const otherKind = createJob(db, "file_pass", "Full pass", { auto: true }, 1);
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });

    expect(() => getJob(db, staleAuto)).toThrow();
    expect(getJob(db, manual).id).toBe(manual);
    expect(getJob(db, otherKind).id).toBe(otherKind);
    db.close();
  });

  it("a plan with no `auto` key, or a non-object plan, is not an auto job", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const noKey = createJob(db, "deep_summary", "Room summary", { steps: [] }, 1);
    const arrayPlan = createJob(db, "deep_summary", "Odd", ["auto"], 1);
    const nullPlan = createJob(db, "deep_summary", "Odder", null, 1);
    const deps = testDeps(db);

    await onePass(deps);

    const left = unfinishedJobs(db).map((j) => j.id);
    expect(left).toContain(noKey);
    expect(left).toContain(arrayPlan);
    expect(left).toContain(nullPlan);
    db.close();
  });

  it("does nothing when the room swapped between the decision and the cleanup", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const staleAuto = createJob(db, "deep_summary", "Indexing new files", { auto: true }, 3);
    let handle: RoomHandle | null = { db, path: "room" };
    const deps = testDeps(db, {
      rooms: { current: () => handle },
      // The model probe is the last await before the cleanup runs.
      listModels: async () => {
        handle = { db, path: "somewhere-else" };
        return ["qwen3.5:4b"];
      },
    });

    // The room pin refuses the read entirely, so the swept room keeps its job.
    await onePass(deps);
    expect(unfinishedJobs(db).map((j) => j.id)).toContain(staleAuto);
    db.close();
  });
});

describe("runAutoIndexPass — the recording-read arm", () => {
  it("reads the unread recording first and ends the tick, even with a large missing set", async () => {
    const db = freshRoom();
    const fileId = addUnreadRecording(db);
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 5);
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "recRead", fileId });
    expect(deps.recRead).toHaveBeenCalledExactlyOnceWith("room", fileId);
    // The read spent this tick's single model lane, so the sweep stands down.
    expect(deps.deepSummary).not.toHaveBeenCalled();
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("reads exactly ONE recording per tick, however many are unread", async () => {
    // The queue serializes them anyway, and the next ingest (or the next
    // recording stopped) re-arms the waiter, so a backlog drains steadily
    // instead of all at once.
    const db = freshRoom();
    const ids = [
      addUnreadRecording(db, "one.wav"),
      addUnreadRecording(db, "two.wav"),
      addUnreadRecording(db, "three.wav"),
    ];
    const deps = testDeps(db);

    const outcome = await onePass(deps);

    expect(deps.recRead).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("recRead");
    expect(ids).toContain(outcome.kind === "recRead" ? outcome.fileId : null);
    db.close();
  });

  it("REGRESSION: a REFUSED read falls through to the summary sweep on the same tick", async () => {
    // Rust: `if start_rec_read(...).await.is_ok() { return; }` — an Err does
    // NOT return. Ending the tick on a refusal starved the sweep for as long
    // as the recording stayed unread: every import after it went undescribed,
    // on this tick and on every later one.
    const db = freshRoom();
    addUnreadRecording(db);
    addMissingSummaryFiles(db, 1);
    const deps = testDeps(db, { startRecRead: startRecReadNotImplemented });

    expect(await onePass(deps)).toEqual({ kind: "quietFiller" });
    expect(deps.filler).toHaveBeenCalledExactlyOnceWith("room", 0);
    db.close();
  });

  it("REGRESSION: a refused read falls through to a durable job for a big drop too", async () => {
    const db = freshRoom();
    addUnreadRecording(db);
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db, {
      startRecRead: async () => {
        throw new Error("the queue is full");
      },
    });

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });
    expect(deps.deepSummary).toHaveBeenCalledExactlyOnceWith("room");
    db.close();
  });

  it("a refused read with nothing else missing falls through and finds nothing to do", async () => {
    const db = freshRoom();
    addUnreadRecording(db, "meeting.wav", ""); // no extracted text = not a missing summary
    const deps = testDeps(db, { startRecRead: startRecReadNotImplemented });

    expect(await onePass(deps)).toEqual({ kind: "skip" });
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("a recording with no transcript yet is not 'unread' — the sweep runs normally", async () => {
    const db = freshRoom();
    addFile(db, "silent.wav", "(live recording)");
    setRecMeta(db, addFile(db, "empty.wav", "(live)"), '{"durationCs":0,"segments":[],"cuts":[]}');
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db);

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });
    expect(deps.recRead).not.toHaveBeenCalled();
    db.close();
  });
});

describe("runAutoIndexPass — the room pin and the generation race", () => {
  it("is stale when no room is open", async () => {
    const db = freshRoom();
    const deps = testDeps(db, { rooms: fakeRooms(null) });

    expect(await onePass(deps)).toEqual({ kind: "stale" });
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("is stale when the room open is a different path", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db, { rooms: fakeRooms({ db, path: "another-room" }) });

    expect(await onePass(deps)).toEqual({ kind: "stale" });
    expect(deps.deepSummary).not.toHaveBeenCalled();
    db.close();
  });

  it("is stale on entry when a later ingest already re-armed the debounce", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db);
    const state = createAutoIndexState();
    state.generation = 5;

    // This waiter's stamp (2) went stale while it was asleep.
    expect(await runAutoIndexPass(deps, state, 2, "room")).toEqual({ kind: "stale" });
    expect(deps.deepSummary).not.toHaveBeenCalled();
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("is stale when the generation moves during the model probe's await", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, 1);
    const state = createAutoIndexState();
    state.generation = 1;
    const deps = testDeps(db, {
      listModels: async () => {
        state.generation = 2; // a newer schedule call raced ahead of us
        return ["qwen3.5:4b"];
      },
    });

    expect(await runAutoIndexPass(deps, state, 1, "room")).toEqual({ kind: "stale" });
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("is stale when the generation moves during a REFUSED rec-read's await", async () => {
    const db = freshRoom();
    addUnreadRecording(db);
    addMissingSummaryFiles(db, 1);
    const state = createAutoIndexState();
    state.generation = 1;
    const deps = testDeps(db, {
      startRecRead: async () => {
        state.generation = 2;
        throw new Error("the queue is full");
      },
    });

    expect(await runAutoIndexPass(deps, state, 1, "room")).toEqual({ kind: "stale" });
    // The newer waiter owns the sweep now — this one must not also run it.
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("is stale when the room closed between the stale-job cleanup and the dispatch", async () => {
    // The folded `main_window(&app)` guard: Rust bails the dispatch outright
    // when there is no live window left to run it in.
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const open: { handle: RoomHandle | null } = { handle: null };
    // Closes the room the instant the cleanup's own read runs — the last thing
    // before the dispatch's guard.
    const closingDb = dbOnSql(db, SQL.unfinishedJobs, () => {
      open.handle = null;
    });
    open.handle = { db: closingDb, path: "room" };
    const deps = testDeps(db, { rooms: { current: () => open.handle } });

    expect(await onePass(deps)).toEqual({ kind: "stale" });
    expect(deps.deepSummary).not.toHaveBeenCalled();
    db.close();
  });
});

describe("runAutoIndexPass — every room read is best-effort, as in Rust", () => {
  it("REGRESSION: a failing unfinished-jobs read does not reject the detached waiter", async () => {
    // Rust wraps the whole cleanup in `let _ = state.with_room(...)`, so the
    // `?` on `db::unfinished_jobs` is swallowed. Letting it escape here would
    // surface as an unhandled promise rejection out of `scheduleAutoIndex`'s
    // fire-and-forget call.
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db, {
      rooms: fakeRooms({ db: dbFailingOnSql(db, SQL.unfinishedJobs), path: "room" }),
    });

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });
    db.close();
  });

  it("a failing delete leaves the stale job but still starts the fresh run", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const staleAuto = createJob(db, "deep_summary", "Indexing new files", { auto: true }, 3);
    const deps = testDeps(db, {
      rooms: fakeRooms({ db: dbFailingOnSql(db, SQL.deleteJobArtifacts), path: "room" }),
    });

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });
    expect(unfinishedJobs(db).map((j) => j.id)).toContain(staleAuto);
    db.close();
  });

  it("a failing settings read reads as ON, matching Rust's `.ok()` on get_setting", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db, {
      rooms: fakeRooms({ db: dbFailingOnSql(db, SQL.getSetting), path: "room" }),
    });

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });
    db.close();
  });

  it("a failing missing-summary read counts as 0, matching Rust's `.unwrap_or(0)`", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 5);
    const deps = testDeps(db, {
      rooms: fakeRooms({ db: dbFailingOnSql(db, SQL.filesMissingSummary), path: "room" }),
    });

    expect(await onePass(deps)).toEqual({ kind: "skip" });
    expect(deps.deepSummary).not.toHaveBeenCalled();
    db.close();
  });

  it("a failing unread-recordings read reads as none, and the sweep still runs", async () => {
    const db = freshRoom();
    addUnreadRecording(db);
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db, {
      rooms: fakeRooms({ db: dbFailingOnSql(db, SQL.recordingsMissingRead), path: "room" }),
    });

    expect(await onePass(deps)).toEqual({ kind: "startJob", jobId: "job-deep" });
    expect(deps.recRead).not.toHaveBeenCalled();
    db.close();
  });
});

// ============================================================================
// runAutoIndex — the debounce + bounded retry loop
// ============================================================================

describe("runAutoIndex", () => {
  it("debounces, then acts on the decision exactly once", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX);
    const deps = testDeps(db);
    const state = createAutoIndexState();

    expect(await runAutoIndex(deps, state, state.generation, "room", { debounceMs: 0 })).toEqual({
      kind: "quietFiller",
    });
    expect(deps.filler).toHaveBeenCalledExactlyOnceWith("room", 0);
    db.close();
  });

  it("a room that closed during the debounce is a clean stale exit", async () => {
    const deps = testDeps(freshRoom(), { rooms: fakeRooms(null) });
    const state = createAutoIndexState();

    expect(await runAutoIndex(deps, state, state.generation, "gone", { debounceMs: 0 })).toEqual({
      kind: "stale",
    });
  });

  it("stays busy → retries exactly AUTO_INDEX_MAX_RETRIES times, then gives up", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, 1);
    const deps = testDeps(db);
    deps.cancelState.cancels.set("run-1", new CancelFlag()); // "asking" forever
    const listModels = vi.fn(async () => ["qwen3.5:4b"]);
    deps.listModels = listModels;
    const state = createAutoIndexState();

    const outcome = await runAutoIndex(deps, state, state.generation, "room", {
      debounceMs: 0,
      retryMs: 0,
    });

    // The first attempt plus 10 retries — bounded, never more. The next
    // ingest re-arms from zero.
    expect(listModels).toHaveBeenCalledTimes(11);
    expect(outcome).toEqual({ kind: "retry" });
    expect(deps.deepSummary).not.toHaveBeenCalled();
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("a room that frees up mid-retry gets its decision on the next pass", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, 1);
    const deps = testDeps(db);
    deps.cancelState.jobCancels.set("job-1", new CancelFlag());
    let ticks = 0;
    deps.listModels = async () => {
      ticks += 1;
      if (ticks > 2) {
        deps.cancelState.jobCancels.clear();
      }
      return ["qwen3.5:4b"];
    };
    const state = createAutoIndexState();

    expect(
      await runAutoIndex(deps, state, state.generation, "room", { debounceMs: 0, retryMs: 0 })
    ).toEqual({ kind: "quietFiller" });
    expect(deps.filler).toHaveBeenCalledExactlyOnceWith("room", 0);
    db.close();
  });

  it("a room that closes mid-retry stops the loop rather than spinning to the bound", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, 1);
    let handle: RoomHandle | null = { db, path: "room" };
    const deps = testDeps(db, { rooms: { current: () => handle } });
    deps.cancelState.cancels.set("run-1", new CancelFlag());
    let calls = 0;
    deps.listModels = async () => {
      calls += 1;
      if (calls === 2) {
        handle = null; // the room closed between retries
      }
      return ["qwen3.5:4b"];
    };
    const state = createAutoIndexState();

    expect(
      await runAutoIndex(deps, state, state.generation, "room", { debounceMs: 0, retryMs: 0 })
    ).toEqual({ kind: "stale" });
    expect(calls).toBe(2);
    db.close();
  });

  it("a stale generation never touches the room at all", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 3);
    const deps = testDeps(db);
    const listModels = vi.fn(async () => ["qwen3.5:4b"]);
    deps.listModels = listModels;
    const state = createAutoIndexState();
    state.generation = 5;

    expect(await runAutoIndex(deps, state, 2, "room", { debounceMs: 0 })).toEqual({ kind: "stale" });
    expect(listModels).not.toHaveBeenCalled();
    expect(deps.deepSummary).not.toHaveBeenCalled();
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });
});

// ============================================================================
// scheduleAutoIndex — the fire-and-forget waiter
// ============================================================================

describe("scheduleAutoIndex", () => {
  it("bumps the generation and returns it; the superseded waiter never runs", async () => {
    const db = freshRoom();
    addMissingSummaryFiles(db, QUIET_FILLER_MAX + 1);
    const deps = testDeps(db);
    const state = createAutoIndexState();

    const first = scheduleAutoIndex(deps, state, "room", { debounceMs: 40 });
    const second = scheduleAutoIndex(deps, state, "room", { debounceMs: 0 });
    expect(second).toBe(first + 1);
    expect(state.generation).toBe(second);

    // Long enough for the second (0 ms) waiter to finish and the first (40 ms)
    // to wake up and discover it is stale.
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(deps.deepSummary).toHaveBeenCalledExactlyOnceWith("room");
    expect(deps.filler).not.toHaveBeenCalled();
    db.close();
  });

  it("REGRESSION: a throwing seam cannot reject the detached waiter", async () => {
    // `tauri::async_runtime::spawn` parks a failed task in its JoinHandle — a
    // panicking waiter never takes the app down with it. A bare `void
    // runAutoIndex(...)` has no such floor: any throw from a caller-supplied
    // seam (`spawnSummaryFiller` is `void`, so it has no other way to fail; and
    // `rooms.current()` is called unguarded three times a tick) escapes as an
    // unhandled rejection, which Node has thrown on by default since v15 and
    // Electron's main process does not survive.
    const db = freshRoom();
    addMissingSummaryFiles(db, 1);
    const deps = testDeps(db, {
      spawnSummaryFiller: () => {
        throw new Error("the filler blew up");
      },
    });
    const state = createAutoIndexState();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      scheduleAutoIndex(deps, state, "room", { debounceMs: 0 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Retired quietly and reported — not swallowed in silence either.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    db.close();
  });

  it("uses the real ~30 s debounce when no opts are given — nothing fires synchronously", () => {
    const db = freshRoom();
    const deps = testDeps(db);
    const state = createAutoIndexState();

    expect(scheduleAutoIndex(deps, state, "room")).toBe(1);
    expect(deps.filler).not.toHaveBeenCalled();
    expect(deps.deepSummary).not.toHaveBeenCalled();
    // Retire the still-pending waiter: its `sleep` is `unref`'d so it cannot
    // hold the process open, and bumping the generation makes it a guaranteed
    // no-op (checked before any room access) if it ever does fire.
    state.generation += 1;
    db.close();
  });
});

// ============================================================================
// The three unported seams
// ============================================================================

describe("the unported actions are honest stubs, not fabricated successes", () => {
  it("startDeepSummaryAutoNotImplemented rejects with a labeled reason", async () => {
    await expect(startDeepSummaryAutoNotImplemented("room")).rejects.toThrow(
      /NOT_IMPLEMENTED: start_deep_summary_inner/
    );
  });

  it("startRecReadNotImplemented rejects with a labeled reason", async () => {
    await expect(startRecReadNotImplemented("room", "file-1")).rejects.toThrow(
      /NOT_IMPLEMENTED: start_rec_read/
    );
  });

  it("spawnSummaryFillerNotImplemented reports rather than throwing or staying silent", () => {
    // Void in Rust, so there is no Result to reject — but a silent no-op is
    // indistinguishable from a production wiring that forgot the real filler.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => spawnSummaryFillerNotImplemented("room", 0)).not.toThrow();
      expect(spy).toHaveBeenCalledWith(SUMMARY_FILLER_NOT_IMPLEMENTED);
    } finally {
      spy.mockRestore();
    }
  });
});
