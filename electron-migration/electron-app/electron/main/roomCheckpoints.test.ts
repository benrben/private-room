/**
 * Vitest suite for `roomCheckpoints.ts` — the command layer over whole-room
 * checkpoints, ported from `src-tauri/src/commands/room_checkpoints.rs`.
 *
 * REAL fixture rooms throughout, this repo's established convention (see
 * `roomManager.test.ts` / `db-host/checkpoints.test.ts`): every test creates a
 * real, on-disk, SQLCipher-keyed `.roomai` through `db-host/open.ts` and
 * drives real `.roomck` copies through this module's exported commands — no
 * mocked database and no mocked filesystem.
 *
 * `db-host/checkpoints.test.ts` already covers the PURE layer this module
 * reuses unchanged (`checkpointIdOk`'s full escape-the-folder table,
 * `formatEpoch`, `reconcile`'s crash recovery, `writeManifest`'s
 * temp-then-rename, `performSwap`'s own mechanics), so this suite does not
 * re-prove those. It proves what only exists once a room-lifecycle state is
 * real: the two distinct rollback-busy refusal strings, the commands that
 * deliberately have NO rollback guard, the drain-not-clean refusals, the
 * verify-before-teardown safety property, `with_room`'s storage-error rewrite,
 * the safety-copy-failure path, both branches of a failed swap, auto-copy
 * pruning across repeated rollbacks, and — the load-bearing one — a full
 * end-to-end round trip proving the LIVE connection is torn down and reopened,
 * not merely that bytes changed on disk under a stale handle.
 *
 * The final `describe` is an ADVERSARIAL pass over the same command, written
 * against the fact that a rollback renames a file over the user's entire
 * workspace: a restore attempted while the room has an open transaction, two
 * restores back to back, two same-named checkpoints, a payload that vanishes
 * inside the drain's awaited window, a zero-length payload `reconcile`
 * adopted and offered from the list, a second rollback and a create/delete
 * genuinely interleaved into the first one's drain, the install-by-rename
 * invariant that makes the swap atomic, and a REAL child process SIGKILLed
 * mid-restore. Two of those (the vanished payload and the zero-length one)
 * were failing tests before `checkpointPayloadPresent` existed — they
 * destroyed the room and reported a successful rollback.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelFlag } from "./cancel.js";
import {
  checkpointFilePath,
  checkpointsDir,
  NOT_A_CHECKPOINT_ID,
  performSwap,
  readManifest,
  writeManifest,
} from "./db-host/checkpoints.js";

/**
 * `performSwap` alone is mocked (default implementation: the REAL one, via
 * `importOriginal`) so ONE test can force the SWAP step specifically to fail
 * while the recovery reopen after it still SUCCEEDS. A permission-based block
 * cannot isolate that branch: `db-host/migrate.ts` runs unconditional `CREATE
 * TABLE IF NOT EXISTS` DDL on every open (it is not gated on `user_version`),
 * so a read-only room directory that blocks the swap's staging copy also
 * breaks the very reopen the test exists to prove succeeds — collapsing the
 * swap-fails/reopen-succeeds and swap-fails/reopen-fails branches into one.
 * Every OTHER test in this file gets the real, unmocked `performSwap`,
 * including the swap-fails-AND-reopen-fails test below.
 */
vi.mock("./db-host/checkpoints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db-host/checkpoints.js")>();
  return { ...actual, performSwap: vi.fn(actual.performSwap) };
});

import { getFileFull, insertFile, updateFileContent } from "./db-host/files.js";
import { createRoom as dbCreateRoom, openRoom as dbOpenRoom } from "./db-host/open.js";
import {
  createRoom,
  createRoomManagerState,
  spawnRoomServerIfEnabledNotImplemented,
  teardownOpenRoom,
  rescanWorkspaceRoom,
  workspaceWatcherStatus,
  type RoomManagerDeps,
  type RoomManagerState,
} from "./roomManager.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import {
  createCheckpointCore,
  createRoomCheckpoint,
  deleteRoomCheckpoint,
  listRoomCheckpoints,
  listStrandedCheckpoints,
  registerRoomCheckpointsIpc,
  rollbackRoomCheckpoint,
  strandedCheckpointNames,
} from "./roomCheckpoints.js";
import { inspectSealedPackage } from "./workspace/sealedPackage.js";

const PASSWORD = "correct horse battery staple";
const OTHER_PASSWORD = "a totally different passphrase";
/** Rust's real drain timings are 20 polls × 50/100 ms; the refusal tests only
 * need "the registry never emptied", so they hand the command this override
 * (DEVIATION 2 in the module doc) rather than waiting ~2 real seconds. */
const FAST = { askPollMs: 1, askMaxPolls: 3, jobPollMs: 1, jobMaxPolls: 3 };
/** Long enough for a second command to enter while the first is suspended
 * inside `drainInflight`, short enough not to be a real wait. */
const SLOW = { askPollMs: 25, askMaxPolls: 40, jobPollMs: 1, jobMaxPolls: 3 };
const DRAIN_NOT_CLEAN = "A background job is still finishing — try again in a moment.";
/** This file's own directory — the real-crash test writes a child script that
 * imports `db-host/checkpoints.ts` by absolute path. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

let tmpDirs: string[] = [];
let strayConns: Database.Database[] = [];

beforeEach(() => {
  // Every unwired dep in `roomManager.ts` logs an honest NOT_IMPLEMENTED/
  // SKIPPED line; keep the suite's own console quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const conn of strayConns) {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
  strayConns = [];
  for (const dir of tmpDirs) {
    try {
      // Undo any permission-tightening a test left behind, so cleanup can walk
      // it — a test that forgot must not wreck every other test's cleanup too.
      chmodSync(dir, 0o755);
    } catch {
      // already gone / never touched
    }
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "roomCheckpoints-"));
  tmpDirs.push(dir);
  return dir;
}

function baseDeps(userDataDir: string, overrides: Partial<RoomManagerDeps> = {}): RoomManagerDeps {
  return {
    userDataDir,
    spawnRoomServerIfEnabled: spawnRoomServerIfEnabledNotImplemented,
    ...overrides,
  };
}

/** A room open on a real fixture file, with the manager state pointed at it —
 * the same shape `roomManager.test.ts`'s own `roomWithReader` uses. */
function openRoomState(
  tag: string,
  overrides: Partial<RoomManagerDeps> = {}
): { state: RoomManagerState; deps: RoomManagerDeps; dir: string; roomPath: string } {
  const dir = freshDir();
  const roomPath = path.join(dir, `${tag}-${randomUUID()}.roomai`);
  const conn = dbCreateRoom(roomPath, PASSWORD, "QA Room");
  strayConns.push(conn);
  const state = createRoomManagerState();
  state.room = { conn, path: roomPath, name: "QA Room", password: PASSWORD };
  return { state, deps: baseDeps(dir, overrides), dir, roomPath };
}

describe("workspace-folder checkpoints", () => {
  it("packages normal files and restores through a verified sibling while keeping a backup", async () => {
    const dir = freshDir();
    const roomPath = path.join(dir, "Workspace Room");
    const state = createRoomManagerState();
    const deps = baseDeps(dir);
    createRoom(state, deps, roomPath, PASSWORD, "Workspace Room", "workspace-folder");
    try {
      const room = state.room!;
      expect(workspaceWatcherStatus(state)?.state).toMatch(/starting|healthy/);
      const rescanned = await rescanWorkspaceRoom(state);
      expect(rescanned.state).toBe("healthy");
      expect(rescanned.lastReconciledAt).not.toBeNull();
      const sourcePath = path.join(dir, "source.txt");
      writeFileSync(sourcePath, "checkpoint content", "utf8");
      const imported = await room.workspace!.importFile(sourcePath, "notes.txt");
      const roomId = room.descriptor!.roomId;

      const saved = await createRoomCheckpoint(state, "Before edit");
      expect(inspectSealedPackage(
        checkpointFilePath(checkpointsDir(roomPath), saved.id),
        PASSWORD,
      )).toMatchObject({ purpose: "checkpoint", roomId, fileCount: 1 });

      await room.workspace!.writeAtomic(
        imported.fileId,
        Readable.from(Buffer.from("changed after checkpoint")),
        imported.sha256 ?? undefined,
      );
      const info = await rollbackRoomCheckpoint(state, deps, saved.id, FAST);

      expect(info.path).toBe(roomPath);
      expect(readFileSync(path.join(roomPath, "notes.txt"), "utf8")).toBe("checkpoint content");
      expect(state.room?.descriptor?.roomId).toBe(roomId);
      expect(state.room?.conn.prepare(
        "SELECT original_bytes, storage_kind FROM files WHERE relative_path = 'notes.txt'",
      ).get()).toEqual({ original_bytes: null, storage_kind: "workspace" });

      const backups = readdirSync(dir).filter((name) => name.includes(".before-checkpoint-") && name.endsWith(".backup"));
      expect(backups).toHaveLength(1);
      expect(readFileSync(path.join(dir, backups[0]!, "notes.txt"), "utf8"))
        .toBe("changed after checkpoint");
      expect(listRoomCheckpoints(state).entries.some((entry) => entry.auto)).toBe(true);
    } finally {
      teardownOpenRoom(state, deps);
    }
  });
});

/** Plant a real, valid `.roomck` encrypted under a DIFFERENT password, with a
 * manifest entry naming it — exactly what a `change_password` re-key that
 * failed on one copy leaves behind (SEC-4). */
function plantStrandedCheckpoint(roomPath: string, name: string): string {
  const dir = checkpointsDir(roomPath);
  const id = randomUUID();
  dbCreateRoom(checkpointFilePath(dir, id), OTHER_PASSWORD, "Stranded").close();
  const manifest = readManifest(dir);
  manifest.entries.push({
    id,
    name,
    createdAt: "2020-01-01T00:00:00Z",
    sizeBytes: 1,
    auto: false,
  });
  writeManifest(dir, manifest);
  return id;
}

// ============================================================================
// createRoomCheckpoint / createCheckpointCore
// ============================================================================

describe("createRoomCheckpoint", () => {
  it("refuses with ROLLBACK_BUSY while a rollback is in flight", async () => {
    const { state } = openRoomState("create-busy");
    state.rollingBack = true;
    await expect(createRoomCheckpoint(state, "mine")).rejects.toThrow(ROLLBACK_BUSY);
  });

  it("refuses with NO_ROOM_OPEN when no room is open", async () => {
    const state = createRoomManagerState();
    await expect(createRoomCheckpoint(state, "mine")).rejects.toThrow("No room is open.");
  });

  it("writes a real, independently openable .roomck plus its manifest entry", async () => {
    const { state, roomPath } = openRoomState("create-real");
    const meta = await createRoomCheckpoint(state, "  before edit  ");

    expect(meta.name).toBe("before edit"); // trimmed, matching write_checkpoint
    expect(meta.auto).toBe(false);
    expect(meta.sizeBytes).toBeGreaterThan(0);

    const dir = checkpointsDir(roomPath);
    const manifest = readManifest(dir);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.id).toBe(meta.id);

    // The payload really is a full copy openable under the SAME password, not
    // just a manifest entry.
    const ckPath = checkpointFilePath(dir, meta.id);
    expect(existsSync(ckPath)).toBe(true);
    const reopened = dbOpenRoom(ckPath, PASSWORD);
    strayConns.push(reopened);
    expect(reopened.prepare("SELECT value FROM meta WHERE key='name'").get()).toEqual({
      value: "QA Room",
    });
  });

  it("falls back to a dated default name when given only whitespace", async () => {
    const { state } = openRoomState("create-blank-name");
    const meta = await createRoomCheckpoint(state, "   ");
    expect(meta.name).toMatch(/^Checkpoint — \d{4}-\d{2}-\d{2}$/);
  });

  it("explains a storage failure in words instead of surfacing raw SQLite text", async () => {
    // Rust's `create_checkpoint_core` is `state.with_room(|room|
    // write_checkpoint(..))`, and `with_room` runs every closure error through
    // `humanize_storage_error`. The documented failure of this feature is a
    // room-sized VACUUM INTO that cannot be written, whose raw text is
    // "unable to open database: /…/<uuid>.tmp" — a storage error the rewrite
    // recognizes and replaces with a sentence naming a remedy.
    const { state, roomPath } = openRoomState("create-humanized");
    await createRoomCheckpoint(state, "establishes the dir");
    const dir = checkpointsDir(roomPath);
    chmodSync(dir, 0o500); // r-x: no NEW payload can be written into it
    try {
      await expect(createRoomCheckpoint(state, "doomed")).rejects.toThrow(
        /This room's file couldn't be read or written just now/
      );
      // …and the original text is kept in brackets, which is what a bug report
      // needs (`humanizeStorageError` never throws the raw message away).
      await expect(createRoomCheckpoint(state, "doomed")).rejects.toThrow(
        /\[unable to open database/
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("createCheckpointCore takes an auto copy without any rollback guard of its own", async () => {
    const { state, roomPath } = openRoomState("core-auto");
    // The guard lives in the two CALLERS, exactly as Rust keeps it out of the
    // `_core` helper — the rollback path calls this while its own flag is up.
    state.rollingBack = true;
    const meta = createCheckpointCore(state, "Before rollback to \"x\"", true);
    state.rollingBack = false;
    expect(meta.auto).toBe(true);
    expect(existsSync(checkpointFilePath(checkpointsDir(roomPath), meta.id))).toBe(true);
  });
});

// ============================================================================
// listRoomCheckpoints
// ============================================================================

describe("listRoomCheckpoints", () => {
  it("refuses with NO_ROOM_OPEN when no room is open", () => {
    const state = createRoomManagerState();
    expect(() => listRoomCheckpoints(state)).toThrow("No room is open.");
  });

  it("is empty with zero total bytes before any checkpoint exists — no directory, no crash", () => {
    const { state } = openRoomState("list-empty");
    expect(listRoomCheckpoints(state)).toEqual({ entries: [], totalBytes: 0 });
  });

  it("lists newest first and sums total bytes", async () => {
    const { state, roomPath } = openRoomState("list-order");
    const first = await createRoomCheckpoint(state, "first");
    const second = await createRoomCheckpoint(state, "second");

    // Both can legitimately land in the same wall-clock second (`createdAt`
    // has 1 s resolution), so force a distinguishable order by editing the
    // manifest rather than racing the clock. `reconcile` never rewrites
    // `createdAt` for an existing entry (only `sizeBytes`), so this is exactly
    // what two checkpoints made a day apart look like on disk.
    const dir = checkpointsDir(roomPath);
    const manifest = readManifest(dir);
    for (const e of manifest.entries) {
      if (e.id === first.id) e.createdAt = "2020-01-01T00:00:00Z";
      if (e.id === second.id) e.createdAt = "2020-01-02T00:00:00Z";
    }
    writeManifest(dir, manifest);

    const list = listRoomCheckpoints(state);
    expect(list.entries.map((e) => e.id)).toEqual([second.id, first.id]);
    expect(list.totalBytes).toBe(first.sizeBytes + second.sizeBytes);
    expect(list.totalBytes).toBeGreaterThan(0);
  });

  it("has NO rollback guard — reading the list mid-rollback is allowed, as in Rust", async () => {
    const { state } = openRoomState("list-during-rollback");
    await createRoomCheckpoint(state, "cp");
    state.rollingBack = true;
    expect(listRoomCheckpoints(state).entries).toHaveLength(1);
    // `list_stranded_checkpoints` is unguarded in Rust too.
    expect(listStrandedCheckpoints(state)).toEqual([]);
  });
});

// ============================================================================
// deleteRoomCheckpoint
// ============================================================================

describe("deleteRoomCheckpoint", () => {
  it("refuses mid-rollback with ITS OWN literal (not the shared ROLLBACK_BUSY), before even the id check", () => {
    const { state } = openRoomState("delete-order");
    state.rollingBack = true;
    // The rollback refusal wins even over an id that would also be rejected —
    // Rust's own order.
    expect(() => deleteRoomCheckpoint(state, "not even a valid id / with slashes")).toThrow(
      "Can't delete a checkpoint while the room is rolling back."
    );
    // And specifically NOT the shared create/rollback sentence: Rust keeps
    // these two apart on purpose.
    expect(() => deleteRoomCheckpoint(state, "abc")).not.toThrow(ROLLBACK_BUSY);
  });

  it("refuses a malformed id with NOT_A_CHECKPOINT_ID (checkpointIdOk's exhaustive table is db-host's own suite)", () => {
    const { state } = openRoomState("delete-bad-id");
    expect(() => deleteRoomCheckpoint(state, "../../etc/passwd")).toThrow(NOT_A_CHECKPOINT_ID);
  });

  it("refuses with NO_ROOM_OPEN for a well-shaped id when no room is open", () => {
    const state = createRoomManagerState();
    expect(() => deleteRoomCheckpoint(state, randomUUID())).toThrow("No room is open.");
  });

  it("removes both the payload file and the manifest entry", async () => {
    const { state, roomPath } = openRoomState("delete-real");
    const meta = await createRoomCheckpoint(state, "doomed");
    const dir = checkpointsDir(roomPath);
    const ckPath = checkpointFilePath(dir, meta.id);
    expect(existsSync(ckPath)).toBe(true);

    deleteRoomCheckpoint(state, meta.id);

    expect(existsSync(ckPath)).toBe(false);
    expect(readManifest(dir).entries).toHaveLength(0);
  });

  it("tolerates a payload already deleted in Finder, and an id that never existed", async () => {
    const { state, roomPath } = openRoomState("delete-missing");
    const meta = await createRoomCheckpoint(state, "hand-deleted");
    const keeper = await createRoomCheckpoint(state, "kept");
    const dir = checkpointsDir(roomPath);
    unlinkSync(checkpointFilePath(dir, meta.id));

    // The entry still self-heals out of the registry (Rust's `let _ =
    // remove_file` + reconcile), and an unknown id is a silent no-op.
    expect(() => deleteRoomCheckpoint(state, meta.id)).not.toThrow();
    expect(() => deleteRoomCheckpoint(state, randomUUID())).not.toThrow();
    expect(readManifest(dir).entries.map((e) => e.id)).toEqual([keeper.id]);
  });
});

// ============================================================================
// strandedCheckpointNames / listStrandedCheckpoints (SEC-4)
// ============================================================================

describe("strandedCheckpointNames / listStrandedCheckpoints", () => {
  it("is empty when the checkpoints directory does not exist at all", () => {
    expect(strandedCheckpointNames("/no/such/room.roomai", PASSWORD)).toEqual([]);
  });

  it("refuses with NO_ROOM_OPEN when no room is open", () => {
    const state = createRoomManagerState();
    expect(() => listStrandedCheckpoints(state)).toThrow("No room is open.");
  });

  it("names exactly the checkpoints that do NOT open under the room's current password", async () => {
    const { state, roomPath } = openRoomState("stranded");
    const healthy = await createRoomCheckpoint(state, "Healthy");
    plantStrandedCheckpoint(roomPath, "Locked out");

    const names = strandedCheckpointNames(roomPath, PASSWORD);
    expect(names).toEqual(["Locked out"]);
    expect(names).not.toContain(healthy.name);

    // The command reads the OPEN room's own (path, password) pair.
    expect(listStrandedCheckpoints(state)).toEqual(["Locked out"]);
  });

  it("reports every checkpoint once the room's password itself has moved on", async () => {
    const { state } = openRoomState("stranded-all");
    await createRoomCheckpoint(state, "one");
    state.room!.password = "stale-in-memory-password";
    expect(listStrandedCheckpoints(state)).toEqual(["one"]);
  });
});

// ============================================================================
// rollbackRoomCheckpoint — SAFETY-CRITICAL
// ============================================================================

describe("rollbackRoomCheckpoint", () => {
  it("refuses a malformed id before touching the room at all", async () => {
    const { state, deps } = openRoomState("rollback-bad-id");
    const room = state.room;
    await expect(rollbackRoomCheckpoint(state, deps, "../escape", FAST)).rejects.toThrow(
      NOT_A_CHECKPOINT_ID
    );
    expect(state.room).toBe(room); // untouched
    expect(state.rollingBack).toBe(false);
  });

  it("refuses with NO_ROOM_OPEN when no room is open", async () => {
    const state = createRoomManagerState();
    await expect(rollbackRoomCheckpoint(state, baseDeps(""), randomUUID(), FAST)).rejects.toThrow(
      "No room is open."
    );
  });

  it("refuses when the checkpoint file is gone, without ever claiming the rollback flag", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-missing");
    const meta = await createRoomCheckpoint(state, "gone");
    unlinkSync(checkpointFilePath(checkpointsDir(roomPath), meta.id));
    const room = state.room;

    await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
      "That checkpoint is no longer available."
    );
    expect(state.room).toBe(room); // never torn down
    expect(state.rollingBack).toBe(false); // the flag was never claimed
  });

  it("refuses with ROLLBACK_BUSY when one is already in flight, without clearing the other one's flag", async () => {
    const { state, deps } = openRoomState("rollback-busy");
    const meta = await createRoomCheckpoint(state, "target");
    state.rollingBack = true; // someone else's in-flight rollback

    await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
      ROLLBACK_BUSY
    );
    expect(state.rollingBack).toBe(true); // still theirs — the `finally` must not steal it
  });

  it("refuses when a streaming ask never drains, and releases the guard", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-stuck-ask");
    const meta = await createRoomCheckpoint(state, "target");
    // A writer that never observes its own cancel flag within the bounded
    // wait — the drain cannot prove it won't write post-swap.
    state.cancel.cancels.set("stuck-ask", new CancelFlag());
    const originalConn = state.room?.conn;

    await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
      DRAIN_NOT_CLEAN
    );
    expect(state.rollingBack).toBe(false);
    expect(state.room?.conn).toBe(originalConn); // never torn down
    expect(state.room?.path).toBe(roomPath); // never swapped
  });

  it("refuses when a background job never drains, and releases the guard", async () => {
    const { state, deps } = openRoomState("rollback-stuck-job");
    const meta = await createRoomCheckpoint(state, "target");
    state.cancel.jobCancels.set("stuck-job", new CancelFlag());
    const originalConn = state.room?.conn;

    await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
      DRAIN_NOT_CLEAN
    );
    expect(state.rollingBack).toBe(false);
    expect(state.room?.conn).toBe(originalConn);
  });

  it("verifies the checkpoint's password BEFORE tearing anything down", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-stranded");
    await createRoomCheckpoint(state, "Healthy"); // establishes the dir for real
    const strandedId = plantStrandedCheckpoint(roomPath, "Stranded copy");
    const originalConn = state.room!.conn;

    await expect(rollbackRoomCheckpoint(state, deps, strandedId, FAST)).rejects.toThrow(
      /could not be unlocked with the room's current password/
    );
    // SAFETY: the live room is completely untouched — same handle, still usable.
    expect(state.room).not.toBeNull();
    expect(state.room!.conn).toBe(originalConn);
    expect(() => originalConn.prepare("SELECT 1").get()).not.toThrow();
    expect(state.rollingBack).toBe(false);
  });

  it("surfaces a safety-copy failure and leaves the room open", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-safety-fail");
    const meta = await createRoomCheckpoint(state, "target");
    const dir = checkpointsDir(roomPath);
    const originalConn = state.room!.conn;

    // Block any NEW file from being written into the checkpoints directory
    // (the safety copy's .tmp payload) without touching the target checkpoint
    // that already exists there.
    chmodSync(dir, 0o500);
    try {
      await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
        "Could not take a safety copy before rolling back:"
      );
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(state.room).not.toBeNull();
    expect(state.room!.conn).toBe(originalConn);
    expect(state.rollingBack).toBe(false);
  });

  it("a failed swap leaves the ORIGINAL in place, reopens it, and surfaces the swap error ALONE", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-swap-fail");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("original"),
      "original",
      "upload"
    );
    const meta = await createRoomCheckpoint(state, "before edit");
    updateFileContent(state.room!.conn, file.id, Buffer.from("changed"), "changed");

    // Force JUST the swap step to fail — see this file's header on why a
    // permission-based block cannot isolate this branch.
    vi.mocked(performSwap).mockImplementationOnce(() => {
      throw new Error("simulated I/O failure mid-copy");
    });

    // Reported ALONE: the recovery reopen succeeded, so the "it is now CLOSED"
    // sentence must NOT be appended.
    await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
      /^simulated I\/O failure mid-copy$/
    );

    // Room is open again, at the SAME path, with its CHANGED (never actually
    // rolled back) content — nothing was swapped.
    expect(state.room).not.toBeNull();
    expect(state.room!.path).toBe(roomPath);
    expect(state.rollingBack).toBe(false);
    const [, , bytes] = getFileFull(state.room!.conn, file.id);
    expect(bytes?.toString()).toBe("changed");
    strayConns.push(state.room!.conn);
  });

  it("a failed swap AND a failed reopen reports both, and leaves the room CLOSED", async () => {
    const { state, deps, dir, roomPath } = openRoomState("rollback-swap-and-reopen-fail");
    const meta = await createRoomCheckpoint(state, "target");

    // The room file is gone by the time the swap runs (a moved drive, a
    // deleted file). Unlinking a file a connection still has open is fine on
    // POSIX — the room's own fd (which the safety copy vacuums from) keeps
    // working. Done BEFORE the chmod, which would otherwise block the unlink
    // itself (removing a directory entry needs write access to the directory).
    unlinkSync(roomPath);
    chmodSync(dir, 0o500); // forces the swap's staging copy to fail

    try {
      await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
        /nothing was rolled back, but this room could not be reopened either \(.+\), so it is now CLOSED/
      );
    } finally {
      chmodSync(dir, 0o755);
    }

    expect(state.room).toBeNull();
    expect(state.rollingBack).toBe(false);
  });

  it(
    "restores the room to the checkpointed state byte for byte, end to end, over a REOPENED connection",
    async () => {
      const { state, deps, roomPath } = openRoomState("rollback-e2e");
      const emit = vi.fn();
      const depsWithEmit = { ...deps, emit };
      const originalRoom = state.room!;

      const file = insertFile(
        originalRoom.conn,
        "note.txt",
        "text/plain",
        Buffer.from("original content"),
        "original content",
        "upload"
      );
      const checkpoint = await createRoomCheckpoint(state, "before edit");
      updateFileContent(
        originalRoom.conn,
        file.id,
        Buffer.from("changed content"),
        "changed content"
      );

      // Prove the live DB really changed before the rollback.
      const [, , changedBytes, changedText] = getFileFull(originalRoom.conn, file.id);
      expect(changedBytes?.toString()).toBe("changed content");
      expect(changedText).toBe("changed content");

      const info = await rollbackRoomCheckpoint(state, depsWithEmit, checkpoint.id, FAST);

      // The room handle was genuinely torn down and reopened, not just mutated
      // on disk under a stale handle.
      expect(state.rollingBack).toBe(false);
      expect(state.room).not.toBeNull();
      expect(state.room!.conn).not.toBe(originalRoom.conn);
      expect(() => originalRoom.conn.prepare("SELECT 1").get()).toThrow();
      expect(state.room!.path).toBe(roomPath);
      strayConns.push(state.room!.conn);

      // Byte for byte (and text for text) back to the checkpointed state.
      const [name, , bytes, text] = getFileFull(state.room!.conn, file.id);
      expect(name).toBe("note.txt");
      expect(bytes?.toString()).toBe("original content");
      expect(text).toBe("original content");

      // The RoomInfo returned is what a fresh room_info would say, and the
      // same object was broadcast on "room-rolled-back".
      expect(info.name).toBe("QA Room");
      expect(info.path).toBe(roomPath);
      expect(emit).toHaveBeenCalledWith("room-rolled-back", info);

      // A "Before rollback to …" AUTO safety copy sits alongside the
      // checkpoint that was rolled back to…
      const dir = checkpointsDir(roomPath);
      const manifest = readManifest(dir);
      expect(manifest.entries.some((e) => e.id === checkpoint.id && !e.auto)).toBe(true);
      const safety = manifest.entries.find((e) => e.auto);
      expect(safety).toBeDefined();
      expect(safety!.name).toBe('Before rollback to "before edit"');

      // …and reading THROUGH it proves it holds the pre-rollback state, so
      // nothing the rollback replaced was actually lost.
      const safetyConn = dbOpenRoom(checkpointFilePath(dir, safety!.id), PASSWORD);
      strayConns.push(safetyConn);
      const [, , safetyBytes] = getFileFull(safetyConn, file.id);
      expect(safetyBytes?.toString()).toBe("changed content");
    },
    15_000
  );

  it("a listener that throws cannot turn a COMPLETED rollback into a failure", async () => {
    const { state, deps } = openRoomState("rollback-emit-throws");
    // Scoped to THIS module's own emit. `roomManager.ts`'s `teardownOpenRoom`
    // makes an unguarded `deps.emit("mcp-status", [])` call of its own (Rust
    // wraps that one in `let _ =` too, so it is a pre-existing gap in that
    // committed file, not this module's to fix from here) — throwing for
    // every event would prove nothing about the line under test.
    const emit = vi.fn((event: string) => {
      if (event === "room-rolled-back") {
        throw new Error("the renderer went away mid-emit");
      }
    });
    const meta = await createRoomCheckpoint(state, "target");

    const info = await rollbackRoomCheckpoint(state, { ...deps, emit }, meta.id, FAST);

    expect(info.path).toBe(state.room!.path);
    expect(emit).toHaveBeenCalledWith("room-rolled-back", info);
    expect(state.rollingBack).toBe(false);
    strayConns.push(state.room!.conn);
  });

  // --------------------------------------------------------------------------
  // Data-safety boundary: nothing that is not a real payload may ever reach
  // `performSwap`, because the swap is a RENAME OVER THE USER'S ROOM FILE.
  //
  // Both tests below cover the same defect from its two reachable directions.
  // `verifyPassword` (db-host/rekey.ts) opens its throwaway connection with
  // `new Database(path)` — SQLite's default `SQLITE_OPEN_CREATE`, exactly like
  // the Rust source's `Connection::open` — so a MISSING `.roomck` is silently
  // minted as a brand-new empty database, and an empty database VERIFIES
  // CLEAN: `SELECT count(*) FROM sqlite_master` on a zero-byte file succeeds
  // under any key at all. Without a guard the command then tears the room
  // down and renames those zero bytes over it, and reports "Rolled back, but
  // reopening the room failed" — announcing a successful restore over a room
  // that no longer exists.
  // --------------------------------------------------------------------------

  /** A cancellable writer that, when the drain signals it, takes the checkpoint
   * payload with it. The drain is the ONLY awaited window in the whole rollback
   * sequence, so it is the one point at which anything else — Finder, a backup
   * or cleanup tool, another app — can remove a file this command already
   * checked for. Subclassing the real {@link CancelFlag} makes that window
   * deterministic instead of timing-dependent. */
  class VanishingWriter extends CancelFlag {
    constructor(private readonly onCancel: () => void) {
      super();
    }
    override store(next: boolean): void {
      this.onCancel();
      super.store(next);
    }
  }

  it("refuses a checkpoint that vanished during the drain instead of swapping an empty database over the room", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-vanishes-mid-drain");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("irreplaceable"),
      "irreplaceable",
      "upload"
    );
    const meta = await createRoomCheckpoint(state, "target");
    const ckPath = checkpointFilePath(checkpointsDir(roomPath), meta.id);

    state.cancel.cancels.set(
      "writer",
      new VanishingWriter(() => {
        unlinkSync(ckPath);
        state.cancel.cancels.delete("writer");
      })
    );

    await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
      "That checkpoint is no longer available."
    );

    // THE POINT: the room file is still the user's room — not a zero-byte
    // husk minted by the verify step — and still opens with its own password.
    expect(state.rollingBack).toBe(false);
    expect(statSync(roomPath).size).toBeGreaterThan(0);
    const reopened = dbOpenRoom(roomPath, PASSWORD);
    strayConns.push(reopened);
    const [, , bytes] = getFileFull(reopened, file.id);
    expect(bytes?.toString()).toBe("irreplaceable");
    // And the refusal did not leave a fabricated payload behind for
    // `reconcile` to adopt and offer back as a "Recovered checkpoint".
    expect(existsSync(ckPath)).toBe(false);
  });

  it("refuses a zero-length .roomck that reconcile adopted, instead of swapping it over the room", async () => {
    // No race needed for this one: `reconcile` ADOPTS any `.roomck` sitting in
    // the directory, so a zero-byte file — a truncated copy, an interrupted
    // external backup, or the husk a previous occurrence of the defect above
    // left behind — is listed to the user as "Recovered checkpoint" and can be
    // picked from the rollback screen like any other.
    const { state, deps, roomPath } = openRoomState("rollback-zero-length");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("irreplaceable"),
      "irreplaceable",
      "upload"
    );
    await createRoomCheckpoint(state, "a real one");
    const dir = checkpointsDir(roomPath);
    const zeroId = randomUUID();
    writeFileSync(checkpointFilePath(dir, zeroId), "");

    // It really is offered to the user, which is what makes this reachable.
    expect(listRoomCheckpoints(state).entries.map((e) => e.id)).toContain(zeroId);

    await expect(rollbackRoomCheckpoint(state, deps, zeroId, FAST)).rejects.toThrow(
      "That checkpoint is no longer available."
    );

    // The room is untouched — still open, same live handle, same content.
    expect(state.room).not.toBeNull();
    expect(state.rollingBack).toBe(false);
    const [, , bytes] = getFileFull(state.room!.conn, file.id);
    expect(bytes?.toString()).toBe("irreplaceable");
    // Refused BEFORE the drain, so an in-flight answer is not cancelled for a
    // rollback that was never going to happen.
    expect(statSync(roomPath).size).toBeGreaterThan(0);
  });

  it(
    "caps auto (safety) copies at 3 across repeated rollbacks, never touching the user's own",
    async () => {
      const { state, deps, roomPath } = openRoomState("rollback-prune");
      const target = await createRoomCheckpoint(state, "target");

      for (let i = 0; i < 4; i++) {
        await rollbackRoomCheckpoint(state, deps, target.id, FAST);
      }
      strayConns.push(state.room!.conn);

      const dir = checkpointsDir(roomPath);
      const manifest = readManifest(dir);
      expect(manifest.entries.filter((e) => e.auto)).toHaveLength(3);
      // The user's own named checkpoint is never touched by pruning.
      expect(manifest.entries.some((e) => e.id === target.id && !e.auto)).toBe(true);
      // And every surviving auto payload really is still on disk (pruning
      // removes the file AND the entry together).
      for (const e of manifest.entries) {
        expect(existsSync(checkpointFilePath(dir, e.id))).toBe(true);
      }
    },
    20_000
  );
});

// ============================================================================
// rollbackRoomCheckpoint — the adversarial pass over the data-safety boundary
// ============================================================================

describe("rollbackRoomCheckpoint under adversarial conditions", () => {
  it("refuses while the room has an OPEN transaction, leaving the uncommitted work in place", async () => {
    // A rollback replaces the whole file, so work the user has in progress
    // must not be able to disappear into it silently. `VACUUM INTO` refuses to
    // run inside a transaction, which means the SAFETY COPY is what fails —
    // before the teardown, before the swap — and the refusal is therefore also
    // the guarantee that no rollback ever happens over a half-written write.
    const { state, deps } = openRoomState("rollback-open-txn");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("committed"),
      "committed",
      "upload"
    );
    const meta = await createRoomCheckpoint(state, "target");
    const originalConn = state.room!.conn;

    originalConn.exec("BEGIN");
    updateFileContent(originalConn, file.id, Buffer.from("in progress"), "in progress");

    await expect(rollbackRoomCheckpoint(state, deps, meta.id, FAST)).rejects.toThrow(
      /Could not take a safety copy before rolling back: .*VACUUM/
    );

    expect(state.room).not.toBeNull();
    expect(state.room!.conn).toBe(originalConn);
    expect(state.rollingBack).toBe(false);
    const [, , bytes] = getFileFull(originalConn, file.id);
    expect(bytes?.toString()).toBe("in progress");
    originalConn.exec("ROLLBACK");
  });

  it("restores twice in a row, each rollback's own safety copy holding what that rollback replaced", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-twice");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("v0"),
      "v0",
      "upload"
    );
    const target = await createRoomCheckpoint(state, "target");
    const dir = checkpointsDir(roomPath);

    updateFileContent(state.room!.conn, file.id, Buffer.from("v1"), "v1");
    await rollbackRoomCheckpoint(state, deps, target.id, FAST);
    expect(getFileFull(state.room!.conn, file.id)[2]?.toString()).toBe("v0");

    // The second rollback runs against the REOPENED connection, over a room
    // file that is itself a restored copy — the case a "restore it again"
    // click actually produces.
    updateFileContent(state.room!.conn, file.id, Buffer.from("v2"), "v2");
    await rollbackRoomCheckpoint(state, deps, target.id, FAST);
    strayConns.push(state.room!.conn);
    expect(getFileFull(state.room!.conn, file.id)[2]?.toString()).toBe("v0");
    expect(state.rollingBack).toBe(false);

    // Two distinct safety copies, holding v1 and v2 — the two states the two
    // rollbacks replaced. Neither restore threw the other's undo away.
    const autos = readManifest(dir).entries.filter((e) => e.auto);
    expect(autos).toHaveLength(2);
    const heldContents = autos.map((a) => {
      const conn = dbOpenRoom(checkpointFilePath(dir, a.id), PASSWORD);
      strayConns.push(conn);
      return getFileFull(conn, file.id)[2]?.toString();
    });
    expect(heldContents.sort()).toEqual(["v1", "v2"]);
  }, 20_000);

  it("keeps two same-named checkpoints apart, restoring the one whose id was asked for", async () => {
    // Names are user text and are never unique keys — every lookup is by id.
    // A collision must not make the rollback restore the wrong bytes, nor make
    // the safety copy's `Before rollback to "…"` name ambiguous enough to
    // matter (it is display text; the id is what is acted on).
    const { state, deps, roomPath } = openRoomState("rollback-name-collision");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("first"),
      "first",
      "upload"
    );
    const first = await createRoomCheckpoint(state, "Monday backup");
    updateFileContent(state.room!.conn, file.id, Buffer.from("second"), "second");
    const second = await createRoomCheckpoint(state, "Monday backup");
    expect(first.id).not.toBe(second.id);
    updateFileContent(state.room!.conn, file.id, Buffer.from("third"), "third");

    await rollbackRoomCheckpoint(state, deps, first.id, FAST);
    strayConns.push(state.room!.conn);
    expect(getFileFull(state.room!.conn, file.id)[2]?.toString()).toBe("first");

    // Both same-named entries are still listed, and both payloads still exist.
    const dir = checkpointsDir(roomPath);
    const entries = readManifest(dir).entries;
    expect(entries.filter((e) => e.name === "Monday backup").map((e) => e.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
    expect(entries.find((e) => e.auto)?.name).toBe('Before rollback to "Monday backup"');
    for (const e of entries) {
      expect(existsSync(checkpointFilePath(dir, e.id))).toBe(true);
    }
  }, 20_000);

  it("refuses a second rollback that starts while the first is inside its awaited drain", async () => {
    // The existing ROLLBACK_BUSY test sets the flag by hand. This one proves
    // the property that flag exists for: the claim is check-then-set with no
    // `await` between the two AND before the first suspension point, so a
    // second command entering during the first one's drain cannot slip past
    // it — and its `finally` must not release the flag the FIRST one holds.
    const { state, deps } = openRoomState("rollback-concurrent");
    const meta = await createRoomCheckpoint(state, "target");
    state.cancel.cancels.set("holder", new CancelFlag());
    setTimeout(() => state.cancel.cancels.clear(), 40);

    const first = rollbackRoomCheckpoint(state, deps, meta.id, SLOW);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(state.rollingBack).toBe(true);

    await expect(rollbackRoomCheckpoint(state, deps, meta.id, SLOW)).rejects.toThrow(
      ROLLBACK_BUSY
    );
    expect(state.rollingBack).toBe(true); // still the FIRST one's

    await expect(first).resolves.toBeDefined();
    strayConns.push(state.room!.conn);
    expect(state.rollingBack).toBe(false);
    expect(state.room).not.toBeNull();
  }, 20_000);

  it("refuses create and delete — but not list — from inside the same drain window", async () => {
    const { state, deps, roomPath } = openRoomState("rollback-interleaved");
    const meta = await createRoomCheckpoint(state, "target");
    const other = await createRoomCheckpoint(state, "someone else's");
    state.cancel.cancels.set("holder", new CancelFlag());
    setTimeout(() => state.cancel.cancels.clear(), 40);

    const roll = rollbackRoomCheckpoint(state, deps, meta.id, SLOW);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(createRoomCheckpoint(state, "sneaky")).rejects.toThrow(ROLLBACK_BUSY);
    expect(() => deleteRoomCheckpoint(state, other.id)).toThrow(
      "Can't delete a checkpoint while the room is rolling back."
    );
    // Reads stay open (Rust guards neither), and see a room that has NOT been
    // torn down — everything destructive happens after the drain, with no
    // suspension point for another command to observe a half-swapped room.
    expect(listRoomCheckpoints(state).entries).toHaveLength(2);

    await expect(roll).resolves.toBeDefined();
    strayConns.push(state.room!.conn);
    // The delete that was refused really did not happen.
    expect(existsSync(checkpointFilePath(checkpointsDir(roomPath), other.id))).toBe(true);
  }, 20_000);

  it("installs the checkpoint by RENAME, never by writing into the live room file", async () => {
    // This is what makes a restore atomic, and it is a property of the FILE,
    // not of any error handling: the staged copy is a sibling of the room and
    // the install is a single `renameSync`, so `roomPath` never names a
    // partially-written database for even an instant. An implementation that
    // copied straight into the room file would leave the SAME inode in place;
    // a rename necessarily installs a different one.
    const { state, deps, roomPath } = openRoomState("rollback-install-by-rename");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("checkpointed"),
      "checkpointed",
      "upload"
    );
    const meta = await createRoomCheckpoint(state, "target");
    updateFileContent(state.room!.conn, file.id, Buffer.from("later edit"), "later edit");
    const inodeBefore = statSync(roomPath).ino;

    await rollbackRoomCheckpoint(state, deps, meta.id, FAST);
    strayConns.push(state.room!.conn);

    expect(statSync(roomPath).ino).not.toBe(inodeBefore);
    expect(getFileFull(state.room!.conn, file.id)[2]?.toString()).toBe("checkpointed");
  }, 20_000);

  it("survives a REAL crash mid-restore with the room file untouched", async () => {
    // A REAL child process running the REAL `performSwap`, SIGKILLed while it
    // is genuinely inside the staging copy — no unwinding, no `finally`, no
    // cleanup, exactly what a crash or a force-quit does at the worst moment.
    // A FIFO source with no writer blocks `copyFileSync` indefinitely, which
    // is the one interruptible point the operation has: on APFS the staging
    // copy is a clone and the install is a rename, so there is no other window
    // in which a partial state could exist at all.
    //
    // What must hold afterwards: the room file is byte-identical and still
    // opens and reads. A crashed restore costs the user nothing.
    const { state, roomPath, dir } = openRoomState("rollback-real-crash");
    const file = insertFile(
      state.room!.conn,
      "note.txt",
      "text/plain",
      Buffer.from("must survive a crash"),
      "must survive a crash",
      "upload"
    );
    await createRoomCheckpoint(state, "target");
    const sizeBefore = statSync(roomPath).size;
    state.room!.conn.close();

    const fifo = path.join(dir, "never-delivers.fifo");
    execFileSync("mkfifo", [fifo]);
    const child = path.join(dir, "crash-mid-swap.mts");
    writeFileSync(
      child,
      `import { performSwap } from ${JSON.stringify(path.join(HERE, "db-host/checkpoints.ts"))};\n` +
        `process.stdout.write("BLOCKING\\n");\n` +
        `performSwap(${JSON.stringify(roomPath)}, ${JSON.stringify(fifo)});\n`
    );

    const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", child], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Attached BEFORE the kill, so an early exit can never be missed.
    const exited = new Promise<void>((resolve) => proc.on("exit", () => resolve()));
    await Promise.race([
      new Promise<void>((resolve) => {
        proc.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("BLOCKING")) resolve();
        });
      }),
      exited,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    proc.kill("SIGKILL");
    await exited;

    expect(statSync(roomPath).size).toBe(sizeBefore);
    const reopened = dbOpenRoom(roomPath, PASSWORD);
    strayConns.push(reopened);
    expect(getFileFull(reopened, file.id)[2]?.toString()).toBe("must survive a crash");
  }, 30_000);
});

// ============================================================================
// registerRoomCheckpointsIpc — thin forwarding, invoked directly (rule 4: not
// wired into any live bootstrap)
// ============================================================================

type Handler = (...args: unknown[]) => unknown;

/** The same shape `roomManager.test.ts`'s own register helper uses: a fake
 * `IpcMainInvokeEvent` is spliced in so each captured handler can be called
 * with just its real arguments. */
function registerForTest(state: RoomManagerState, deps: RoomManagerDeps): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeEvent = {} as never;
  const handle = vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, (...args: unknown[]) => listener(fakeEvent, ...args));
  });
  registerRoomCheckpointsIpc({ handle }, state, deps);
  return handlers;
}

describe("registerRoomCheckpointsIpc", () => {
  it("registers all five channels and forwards arguments faithfully", async () => {
    const { state, deps } = openRoomState("ipc");
    const handlers = registerForTest(state, deps);

    expect([...handlers.keys()]).toEqual([
      "create_room_checkpoint",
      "list_room_checkpoints",
      "delete_room_checkpoint",
      "rollback_room_checkpoint",
      "list_stranded_checkpoints",
    ]);

    const created = (await handlers.get("create_room_checkpoint")!({ name: "via ipc" })) as {
      id: string;
      name: string;
    };
    expect(created.name).toBe("via ipc");

    expect((handlers.get("list_room_checkpoints")!() as { entries: unknown[] }).entries).toHaveLength(
      1
    );
    expect(handlers.get("list_stranded_checkpoints")!()).toEqual([]);

    // The rollback channel forwards its `id` — an id this room has no
    // checkpoint for comes back with the command's own refusal, not a
    // "no handler" error.
    await expect(
      handlers.get("rollback_room_checkpoint")!({ id: randomUUID() })
    ).rejects.toThrow("That checkpoint is no longer available.");

    handlers.get("delete_room_checkpoint")!({ id: created.id });
    expect(
      (handlers.get("list_room_checkpoints")!() as { entries: unknown[] }).entries
    ).toHaveLength(0);
  });
});
