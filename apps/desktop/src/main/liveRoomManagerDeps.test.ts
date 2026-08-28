/**
 * Production wiring tests for the room-open scheduler and job queue.
 *
 * Proves `createLiveRoomManagerDeps` (`registry.ts`) genuinely wires
 * `jobScheduler.ts`'s `spawnWorkflowScheduler` and `jobQueue.ts`'s
 * `pumpOnOpen` into a room open, DRIVEN THROUGH THE REAL, UNCHANGED
 * `roomManager.ts` lifecycle (`createRoom`/`openRoom`/`closeRoom`) — not by
 * calling `spawnWorkflowScheduler`/`pumpOnOpen` directly (those already have
 * their own full suites: `jobScheduler.test.ts`, `jobQueue.test.ts`) and not
 * by asserting a spy was called. Both tests read back real state a fake
 * could not produce by accident: an overdue schedule's `next_run_at` actually
 * advancing in a real SQLCipher room, and a job row left `'queued'` from a
 * "previous session" actually being picked up and dispatched (to a labeled
 * `NOT_IMPLEMENTED` poison for an unwired kind — proving the REAL
 * `jobQueue.ts` dispatch path ran, not a fabricated success).
 *
 * Before this wiring, `roomManager.ts` logs `SKIPPED: spawn_workflow_scheduler`
 * / `SKIPPED: pump_on_open` on every room open (see its own `logSkipped` call
 * sites) because `registry.ts`'s `createDefaultRoomManagerDeps` leaves both
 * `RoomManagerDeps.scheduler`/`.jobQueue` unset. These tests fail on that
 * baseline (an overdue schedule never advances; a queued job never leaves
 * `'queued'`) and pass once `createLiveRoomManagerDeps` supplies the real
 * bundles.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJob, getJob } from "./db-host/jobs.js";
import { createWorkflow, getSchedule, setWorkflowStatus, upsertSchedule } from "./db-host/workflows.js";
import { closeRoom, createRoom, createRoomManagerState, openRoom } from "./roomManager.js";
import { createLiveRoomManagerDeps } from "./ipc/registry.js";

const PASSWORD = "correct horse battery staple";

let tmpDirs: string[] = [];

beforeEach(() => {
  // Room open/close logs plenty of honest NOT_IMPLEMENTED/SKIPPED lines for
  // the seams this batch does not touch (mcp, closeBrowser, policy, ...) —
  // silence them so test output stays readable; nothing here asserts on them.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "registry-a-"));
  tmpDirs.push(dir);
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition never became true within " + timeoutMs + "ms");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe("createLiveRoomManagerDeps — the workflow scheduler fires on room open", () => {
  it("advances an overdue, catch-up-enabled schedule's next_run_at on unlock, for real", async () => {
    const dir = freshDir();
    const roomPath = path.join(dir, `room-${randomUUID()}.roomai`);
    const state = createRoomManagerState();
    const emit = vi.fn();
    const deps = createLiveRoomManagerDeps(state, dir, emit);

    createRoom(state, deps, roomPath, PASSWORD, "Scheduler Room");
    const db = state.room!.conn;

    const workflowId = createWorkflow(db, "Nightly", "", "🌙", { nodes: [] }, "user", { scope: "general" });
    setWorkflowStatus(db, workflowId, "active");
    const overdue = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    upsertSchedule(db, workflowId, "interval", "60", true, /* catchUp */ true, overdue);
    expect(getSchedule(db, workflowId)?.nextRunAt).toBe(overdue);

    // Close and reopen the SAME room: `roomManager.ts`'s own "catch up at
    // unlock" hook (`runCreateOpenSpawns` -> `spawnWorkflowScheduler`, which
    // runs one `catchUpPass` before its tick loop even starts) is the real
    // path this exercises — matching how a schedule that fired late because
    // the app was closed is supposed to be caught up.
    await closeRoom(state, deps);
    openRoom(state, deps, roomPath, PASSWORD);
    const db2 = state.room!.conn;

    await waitFor(() => getSchedule(db2, workflowId)?.nextRunAt !== overdue);

    const after = getSchedule(db2, workflowId);
    expect(after?.nextRunAt).not.toBeNull();
    expect(after?.nextRunAt).not.toBe(overdue);
    // A real catch-up fire: `startWorkflowRun` is the documented
    // `startWorkflowRunNotImplemented` stub (the workflow ENGINE genuinely
    // has no Electron port yet — see registry.ts's module doc), so the run
    // fails to start and the schedule is advanced via `setScheduleNextRun`
    // rather than `markScheduleRun` — `lastRunAt`/`lastJobId` stay unset,
    // exactly like a real `Err(_)` branch. This is a real, honest degrade,
    // not this test's oversight.
    expect(after?.lastRunAt).toBeNull();
    expect(after?.lastJobId).toBeNull();

    await closeRoom(state, deps);
  });
});

describe("createLiveRoomManagerDeps — the job queue pumps on room open", () => {
  it("picks up a job left 'queued' from a previous session and dispatches it for real", async () => {
    const dir = freshDir();
    const roomPath = path.join(dir, `room-${randomUUID()}.roomai`);
    const state = createRoomManagerState();
    const emit = vi.fn();
    const deps = createLiveRoomManagerDeps(state, dir, emit);

    createRoom(state, deps, roomPath, PASSWORD, "Queue Room");
    const db = state.room!.conn;
    // `deep_summary` is a KNOWN job kind (`jobQueue.ts`'s `KNOWN_JOB_KINDS`)
    // with no real Electron row-starter — `defaultRowStarters()` wires only
    // `podcast_audio` for real, so this kind deterministically poisons
    // through `notImplementedRowStarter`, proving the real dispatch path ran
    // without needing a TTS/sidecar backend for the test to be fast and
    // hermetic.
    const jobId = createJob(db, "deep_summary", "Left over", {}, 1);
    expect(getJob(db, jobId).status).toBe("queued");

    // Simulate "left queued from a previous session": close, then reopen.
    await closeRoom(state, deps);
    openRoom(state, deps, roomPath, PASSWORD);
    const db2 = state.room!.conn;

    await waitFor(() => getJob(db2, jobId).status !== "queued");

    const after = getJob(db2, jobId);
    expect(after.status).toBe("error");
    expect(after.error).toContain("NOT_IMPLEMENTED");
    expect(after.error).toContain("deep_summary");

    await closeRoom(state, deps);
  });
});
