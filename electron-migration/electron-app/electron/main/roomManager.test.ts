/**
 * Vitest port of `src-tauri/src/commands/rooms.rs`'s `mod tests`, plus
 * coverage for everything else in that file (the four rollback guards, the
 * string formulas, the teardown ORDER, the recovery/rename/room_info commands,
 * the injected-deps split) and for `roomManagerIpc.ts`'s registration shim.
 *
 * REAL FIXTURE ROOMS throughout, this repo's established convention (see
 * `db-host/folders.test.ts` / `recIpc.test.ts`): every test that needs a room
 * creates a real, on-disk, SQLCipher-keyed `.roomai` through `db-host/open.ts`
 * — no mocked database anywhere.
 *
 * PORTED 1:1 FROM THE RUST SUITE
 *   - locking_a_room_parks_the_job_that_was_running_inside_it
 *   - the_teardown_sweep_is_a_park_not_a_reset
 *   - teardown_parks_in_flight_jobs_while_the_room_can_still_be_written_to
 *   - teardown_bumps_the_room_epoch_so_stragglers_cannot_write_after_it
 *   - a_failed_recording_rescue_waits_for_the_workspace_to_collect_it
 *   - teardown_drops_a_parked_recovery_message_with_the_room_it_belongs_to
 *   - a_teardown_with_no_room_open_reports_nothing_rather_than_guessing
 *
 * NOT PORTED, with the reason
 *   - `the_room_survives_a_panic_under_its_own_lock` — a property of Rust's
 *     `Mutex` poisoning for the rest of the PROCESS when a thread panics under
 *     the lock. `RoomManagerState` is a plain object with no lock to poison
 *     (Node is single-threaded, and nothing here holds a guard across an
 *     await), so the failure mode this test exists for cannot occur.
 *   - `teardown_clears_the_staged_preview_pages` — `HtmlPreviews` has no
 *     Electron port. `teardown calls clearEphemeralCaches` below proves the
 *     HOOK that stands in for it fires, at the right point in the sequence.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { insertFile } from "./db-host/files.js";
import { checkpointJob, createJob, getJob, setJobStatus } from "./db-host/jobs.js";
import { getMeta } from "./db-host/meta.js";
import { createRoom as dbCreateRoom, openRoom as dbOpenRoom } from "./db-host/open.js";
import { hasRecovery } from "./db-host/recovery.js";
import { setSetting } from "./db-host/settings.js";
import { resetBaseUrlOverrideForTests, resolvedBaseUrl } from "./engineRouting.js";
import { PARKED_BY_EXIT, PARKED_BY_LOCK } from "./jobs.js";
import { McpManager } from "./mcpClient.js";
import { peekPendingOpen, setPendingOpen } from "./pendingOpen.js";
import { readRecent } from "./recentTools.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import {
  applyOllamaOverride,
  closeRoom,
  createRoom,
  createRoomManagerState,
  drainInflight,
  hasRecoveryKey,
  humanizeStorageError,
  infoOf,
  isSyncedPath,
  MAX_ROOM_NAME_CHARS,
  NO_ROOM_OPEN,
  openRoom,
  openRoomImpl,
  openRoomWithRecovery,
  parkInflightJobsForTeardown,
  pendingMcpFor,
  renameRoom,
  reportRecRecoveryFailure,
  ROOM_SERVER_NOT_IMPLEMENTED,
  roomInfo,
  roomNameFromPath,
  shouldEmitRecRecovery,
  spawnRoomServerIfEnabledNotImplemented,
  takePendingOpen,
  takeRecRecoveryError,
  teardownOpenRoom,
  toRoomPinSource,
  toRoomSource,
  touchIdDisable,
  touchIdEnable,
  touchIdHas,
  touchIdOpen,
  writeRecoveryKey,
  type Room,
  type RoomManagerDeps,
  type RoomManagerState,
} from "./roomManager.js";
import { registerRoomManagerIpc } from "./roomManagerIpc.js";

const PASSWORD = "correct horse battery staple";

let tmpDirs: string[] = [];
let strayConns: Database.Database[] = [];

beforeEach(() => {
  // Every unwired dep logs an honest NOT_IMPLEMENTED/SKIPPED line; the tests
  // that assert on those re-spy locally.
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBaseUrlOverrideForTests();
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
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "roomManager-"));
  tmpDirs.push(dir);
  return dir;
}

function roomPathIn(dir: string, tag = "room"): string {
  return path.join(dir, `${tag}-${randomUUID()}.roomai`);
}

function baseDeps(userDataDir: string, overrides: Partial<RoomManagerDeps> = {}): RoomManagerDeps {
  return {
    userDataDir,
    spawnRoomServerIfEnabled: spawnRoomServerIfEnabledNotImplemented,
    ...overrides,
  };
}

/** A room open on a real fixture file, plus a SECOND connection to the same
 * file so a test can still read it after the teardown has closed the room's
 * own handle — the same shape as the Rust suite's `open_room_with_reader`. */
function roomWithReader(tag: string): {
  state: RoomManagerState;
  deps: RoomManagerDeps;
  reader: Database.Database;
  dir: string;
  roomPath: string;
} {
  const dir = freshDir();
  const roomPath = path.join(dir, `${tag}.roomai`);
  const conn = dbCreateRoom(roomPath, PASSWORD, "QA");
  strayConns.push(conn);
  const reader = dbOpenRoom(roomPath, PASSWORD);
  strayConns.push(reader);
  const state = createRoomManagerState();
  state.room = { conn, path: roomPath, name: "QA", password: PASSWORD };
  return { state, deps: baseDeps(dir), reader, dir, roomPath };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Pure helpers — commands.rs
// ============================================================================

describe("roomNameFromPath", () => {
  it("uses the file stem", () => {
    expect(roomNameFromPath("/a/b/My Journal.roomai")).toBe("My Journal");
  });

  it("splits only at the FINAL dot", () => {
    expect(roomNameFromPath("/x/archive.tar.gz")).toBe("archive.tar");
  });

  it("keeps a leading-dot name with no other dot whole (Rust file_stem parity)", () => {
    expect(roomNameFromPath("/home/.bashrc")).toBe(".bashrc");
    expect(roomNameFromPath("/a/.gitignore")).toBe(".gitignore");
  });

  it("falls back to Room for every path Rust's file_name() calls None", () => {
    // `.` and `..` are the two that a naive "strip after the last dot" gets
    // wrong: Rust's `Path::file_name()` returns None for both, so the room is
    // "Room" — never "." (which is what slicing off the extension produces).
    expect(roomNameFromPath("")).toBe("Room");
    expect(roomNameFromPath("/")).toBe("Room");
    expect(roomNameFromPath(".")).toBe("Room");
    expect(roomNameFromPath("..")).toBe("Room");
    expect(roomNameFromPath("/a/..")).toBe("Room");
  });
});

describe("isSyncedPath (HLT-6)", () => {
  const originalHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("iCloud / File-Provider CloudStorage paths are synced regardless of $HOME", () => {
    expect(isSyncedPath("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/a.roomai")).toBe(true);
    expect(isSyncedPath("/Users/x/Library/CloudStorage/Dropbox/a.roomai")).toBe(true);
  });

  it("a room directly inside a known sync folder under $HOME is synced", () => {
    process.env.HOME = "/Users/x";
    expect(isSyncedPath("/Users/x/Dropbox/a.roomai")).toBe(true);
    expect(isSyncedPath("/Users/x/pCloudDrive/a.roomai")).toBe(true);
  });

  it("Dropbox Business's ' (Work)' suffix still counts", () => {
    process.env.HOME = "/Users/x";
    expect(isSyncedPath("/Users/x/Dropbox (Work)/a.roomai")).toBe(true);
  });

  it("a folder name that only shares a PREFIX is not a match", () => {
    process.env.HOME = "/Users/x";
    expect(isSyncedPath("/Users/x/Dropboxes/a.roomai")).toBe(false);
  });

  it("an ordinary folder under $HOME is not synced", () => {
    process.env.HOME = "/Users/x";
    expect(isSyncedPath("/Users/x/Documents/a.roomai")).toBe(false);
  });
});

describe("humanizeStorageError", () => {
  it("passes a non-storage error through unchanged (no confident wrong diagnosis)", () => {
    const err = humanizeStorageError(new Error("syntax error near SELECT"), "/anywhere.roomai");
    expect(err.message).toBe("syntax error near SELECT");
  });

  it("names a vanished drive when the room path no longer exists", () => {
    const missing = path.join(os.tmpdir(), `nope-${randomUUID()}.roomai`);
    const err = humanizeStorageError(new Error("disk I/O error"), missing);
    expect(err.message).toContain("gone away");
    expect(err.message).toContain("[disk I/O error]");
  });

  it("names a full disk when the room path still exists", () => {
    const dir = freshDir();
    const roomPath = roomPathIn(dir);
    dbCreateRoom(roomPath, PASSWORD, "R").close();
    expect(humanizeStorageError(new Error("database or disk is full"), roomPath).message).toContain(
      "disk holding this room is full"
    );
  });

  it("gives the generic storage message for a recognized error whose file exists", () => {
    const dir = freshDir();
    const roomPath = roomPathIn(dir);
    dbCreateRoom(roomPath, PASSWORD, "R").close();
    expect(
      humanizeStorageError(new Error("unable to open database file"), roomPath).message
    ).toContain("disconnected, full, or read-only");
  });

  it("matches ENOENT/ENOSPC only as WHOLE os-error numbers", () => {
    const dir = freshDir();
    const roomPath = roomPathIn(dir);
    dbCreateRoom(roomPath, PASSWORD, "R").close();
    // "os error 24" must NOT be mistaken for the disconnected-drive "os error 2".
    expect(
      humanizeStorageError(new Error("Too many open files (os error 24)"), roomPath).message
    ).toBe("Too many open files (os error 24)");
    expect(
      humanizeStorageError(new Error("No space left on device (os error 28)"), roomPath).message
    ).toContain("is full");
  });
});

describe("applyOllamaOverride (D10, the Closet)", () => {
  it("applies the room's saved remote URL", () => {
    const dir = freshDir();
    const conn = dbCreateRoom(roomPathIn(dir, "closet"), PASSWORD, "Closet");
    strayConns.push(conn);
    setSetting(conn, "remote_ollama_url", "http://box.lan:11434/");
    applyOllamaOverride(conn);
    expect(resolvedBaseUrl()).toBe("http://box.lan:11434");
  });

  it("clears any previous room's override when this room has none", () => {
    const dir = freshDir();
    const withUrl = dbCreateRoom(roomPathIn(dir, "with"), PASSWORD, "With");
    const without = dbCreateRoom(roomPathIn(dir, "without"), PASSWORD, "Without");
    strayConns.push(withUrl, without);
    setSetting(withUrl, "remote_ollama_url", "http://box.lan:11434");
    applyOllamaOverride(withUrl);
    expect(resolvedBaseUrl()).toBe("http://box.lan:11434");

    applyOllamaOverride(without);
    expect(resolvedBaseUrl()).not.toBe("http://box.lan:11434");
  });
});

describe("pendingMcpFor (SEC-1) / infoOf", () => {
  it("is null when no connector config was ever saved", () => {
    const dir = freshDir();
    const conn = dbCreateRoom(roomPathIn(dir, "no-mcp"), PASSWORD, "No MCP");
    strayConns.push(conn);
    expect(pendingMcpFor(conn, dir)).toBeNull();
  });

  it("describes an enabled, unapproved server for the approval dialog", () => {
    const dir = freshDir();
    const conn = dbCreateRoom(roomPathIn(dir, "needs-approval"), PASSWORD, "Needs Approval");
    strayConns.push(conn);
    setSetting(
      conn,
      "mcp_config",
      JSON.stringify({ mcpServers: { search: { command: "uvx", args: ["duckduckgo-mcp-server"] } } })
    );
    const pending = pendingMcpFor(conn, dir);
    expect(pending?.servers).toEqual([{ name: "search", command: "uvx duckduckgo-mcp-server" }]);
    expect(pending?.fingerprint).toBeTruthy();
  });

  it("composes counts, synced and pendingMcp together", () => {
    const dir = freshDir();
    const roomPath = roomPathIn(dir, "compose");
    const conn = dbCreateRoom(roomPath, PASSWORD, "Compose");
    strayConns.push(conn);
    const room: Room = { conn, path: roomPath, name: "Compose", password: PASSWORD };
    expect(infoOf(room, dir)).toEqual({
      name: "Compose",
      path: roomPath,
      fileCount: 0,
      messageCount: 0,
      synced: false,
      pendingMcp: null,
    });
  });

  it("RoomInfo carries the pending approval through, not a placeholder null", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "info-pending");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "Pending");
    setSetting(
      state.room!.conn,
      "mcp_config",
      JSON.stringify({ mcpServers: { fs: { command: "npx", args: ["server-filesystem"] } } })
    );
    expect(roomInfo(state, baseDeps(dir))?.pendingMcp?.servers).toEqual([
      { name: "fs", command: "npx server-filesystem" },
    ]);
  });
});

// ============================================================================
// create_room
// ============================================================================

describe("createRoom", () => {
  it("creates a real room file and returns its RoomInfo", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir);
    const info = createRoom(state, baseDeps(dir), roomPath, PASSWORD, "My Room");
    expect(info).toEqual({
      name: "My Room",
      path: roomPath,
      fileCount: 0,
      messageCount: 0,
      synced: false,
      pendingMcp: null,
    });
    expect(state.room?.path).toBe(roomPath);
  });

  it("falls back to the file's own name when none is given, and trims a blank one", () => {
    const dir = freshDir();
    const roomPath = path.join(dir, "untitled-project.roomai");
    const a = createRoomManagerState();
    expect(createRoom(a, baseDeps(dir), roomPath, PASSWORD, "   ").name).toBe("untitled-project");

    const other = path.join(dir, "second-project.roomai");
    const b = createRoomManagerState();
    expect(createRoom(b, baseDeps(dir), other, PASSWORD, null).name).toBe("second-project");
  });

  it("writes the room through to the recents file on disk", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "recent-check");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "Recent Check");
    expect(readRecent(dir)).toContainEqual(
      expect.objectContaining({ path: roomPath, name: "Recent Check", missing: false })
    );
  });

  it("refuses while a rollback is in flight, and creates no file", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    state.rollingBack = true;
    const roomPath = roomPathIn(dir);
    expect(() => createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R")).toThrow(ROLLBACK_BUSY);
    expect(state.room).toBeNull();
    expect(readRecent(dir)).toEqual([]);
  });

  it("propagates the password-too-short refusal without opening anything", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    expect(() => createRoom(state, baseDeps(dir), roomPathIn(dir), "short")).toThrow(
      /at least 8 characters/
    );
    expect(state.room).toBeNull();
  });

  it("quiesces a job left 'running' by a crash — but only on the room it opened", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    createRoom(state, baseDeps(dir), roomPathIn(dir), PASSWORD, "R");
    expect(state.room).not.toBeNull();
  });

  it("tears the previously open room down — and CLOSES its connection — before installing the new one", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const firstPath = path.join(dir, "first.roomai");
    createRoom(state, baseDeps(dir), firstPath, PASSWORD, "First");
    const firstConn = state.room!.conn;
    expect(firstConn.open).toBe(true);

    const askFlag = new CancelFlag();
    state.cancel.cancels.set("some-ask", askFlag);

    const secondPath = path.join(dir, "second.roomai");
    const info = createRoom(state, baseDeps(dir), secondPath, PASSWORD, "Second");

    expect(info.name).toBe("Second");
    expect(state.room?.path).toBe(secondPath);
    expect(state.roomEpoch).toBe(1);
    expect(askFlag.load()).toBe(true);
    // Rust's `*state.room_guard() = None` DROPS the Room, closing its
    // connection. A JS port that only nulls the field leaves the previous
    // room's encrypted file open with its key resident for the whole process.
    expect(firstConn.open).toBe(false);
    state.room!.conn.close();
  });
});

// ============================================================================
// open_room / open_room_impl
// ============================================================================

describe("openRoom / openRoomImpl", () => {
  function existingRoom(dir: string, name = "Alpha"): string {
    const roomPath = path.join(dir, "existing.roomai");
    dbCreateRoom(roomPath, PASSWORD, name).close();
    return roomPath;
  }

  it("opens a room created earlier and reads its stored name from meta", () => {
    const dir = freshDir();
    const roomPath = existingRoom(dir);
    const state = createRoomManagerState();
    expect(openRoom(state, baseDeps(dir), roomPath, PASSWORD).name).toBe("Alpha");
    expect(state.room?.path).toBe(roomPath);
    state.room!.conn.close();
  });

  it("falls back to the file's own name when the room has none in meta", () => {
    const dir = freshDir();
    const roomPath = path.join(dir, "fallback-name.roomai");
    const conn = dbCreateRoom(roomPath, PASSWORD, "Original");
    conn.prepare("DELETE FROM meta WHERE key = 'name'").run();
    conn.close();
    const state = createRoomManagerState();
    expect(openRoom(state, baseDeps(dir), roomPath, PASSWORD).name).toBe("fallback-name");
    state.room!.conn.close();
  });

  it("rejects the wrong password without disturbing the room already open", () => {
    const dir = freshDir();
    const roomPath = existingRoom(dir);
    const state = createRoomManagerState();
    createRoom(state, baseDeps(dir), path.join(dir, "other.roomai"), PASSWORD, "Other");
    const openHandle = state.room;

    expect(() => openRoom(state, baseDeps(dir), roomPath, "definitely wrong")).toThrow();
    // Rust runs the teardown only AFTER the password proved right, so a failed
    // unlock never locks the room the user is in.
    expect(state.room).toBe(openHandle);
    expect(state.room!.conn.open).toBe(true);
    state.room!.conn.close();
  });

  it("a failed migration leaves the previously open room untouched", () => {
    const dir = freshDir();
    // `migrate` reads `PRAGMA table_info(messages)` unguarded, exactly as Rust
    // does — a room without that table fails the open at the migrate step.
    const brokenPath = path.join(dir, "broken.roomai");
    const broken = dbCreateRoom(brokenPath, PASSWORD, "Broken");
    broken.exec("DROP TABLE messages");
    broken.close();

    const state = createRoomManagerState();
    createRoom(state, baseDeps(dir), path.join(dir, "safe.roomai"), PASSWORD, "Safe");
    const safeHandle = state.room;

    expect(() => openRoom(state, baseDeps(dir), brokenPath, PASSWORD)).toThrow(/messages/);
    expect(state.room).toBe(safeHandle);
    expect(state.room!.conn.open).toBe(true);
    state.room!.conn.close();
  });

  it("refuses while a rollback is in flight", () => {
    const dir = freshDir();
    const roomPath = existingRoom(dir);
    const state = createRoomManagerState();
    state.rollingBack = true;
    expect(() => openRoom(state, baseDeps(dir), roomPath, PASSWORD)).toThrow(ROLLBACK_BUSY);
    expect(state.room).toBeNull();
  });

  it("openRoomImpl is the unguarded body — it ignores rollingBack", () => {
    const dir = freshDir();
    const roomPath = existingRoom(dir);
    const state = createRoomManagerState();
    state.rollingBack = true;
    expect(openRoomImpl(state, baseDeps(dir), roomPath, PASSWORD).name).toBe("Alpha");
    state.room!.conn.close();
  });

  it("runs migrate() on open — the integration db-host/open.ts deliberately stops short of", () => {
    const dir = freshDir();
    const roomPath = path.join(dir, "legacy.roomai");
    const raw = dbCreateRoom(roomPath, PASSWORD, "Legacy");
    // Simulate a room from before `messages.chat_id` existed: drop the column
    // schema.sql bakes into a fresh room, so only migrate() can put it back.
    raw.exec("DROP INDEX IF EXISTS idx_messages_chat");
    raw.exec("ALTER TABLE messages DROP COLUMN chat_id");
    raw.close();

    const state = createRoomManagerState();
    openRoom(state, baseDeps(dir), roomPath, PASSWORD);
    const cols = state.room!.conn.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "chat_id")).toBe(true);
    expect(state.room!.conn.pragma("user_version", { simple: true })).toBe(3);
    state.room!.conn.close();
  });

  it("quiesces a job left 'running' by a crash to paused/PARKED_BY_EXIT, keeping its checkpoint", () => {
    const dir = freshDir();
    const roomPath = path.join(dir, "crashed.roomai");
    const raw = dbCreateRoom(roomPath, PASSWORD, "R");
    const jobId = createJob(raw, "workflow", "W", { workflow_id: "wf-1" }, 4);
    setJobStatus(raw, jobId, "running", null);
    checkpointJob(raw, jobId, 2, { done: [0, 1] });
    raw.close(); // no graceful drain — mirrors a crash

    const state = createRoomManagerState();
    openRoom(state, baseDeps(dir), roomPath, PASSWORD);
    const job = getJob(state.room!.conn, jobId);
    expect(job.status).toBe("paused");
    expect(job.parkedReason).toBe(PARKED_BY_EXIT);
    expect(job.cursor).toBe(2);
    state.room!.conn.close();
  });

  it("recovers interrupted recording checkpoints, and says nothing when nothing went wrong", () => {
    const dir = freshDir();
    const roomPath = path.join(dir, "rec-recovery.roomai");
    const conn = dbCreateRoom(roomPath, PASSWORD, "Rec Recovery");
    const meta = insertFile(conn, "r.wav", "audio/wav", emptyWav(), null, "recording");
    conn.prepare("INSERT INTO rec_chunks(file_id, seq, pcm) VALUES (?, 0, ?)").run(
      meta.id,
      Buffer.alloc(4)
    );
    conn.close();

    const state = createRoomManagerState();
    openRoom(state, baseDeps(dir), roomPath, PASSWORD);
    const remaining = state.room!.conn.prepare("SELECT count(*) AS c FROM rec_chunks").get() as {
      c: number;
    };
    expect(remaining.c).toBe(0); // spliced, then cleared
    expect(state.recRecoveryError).toBeNull();
    state.room!.conn.close();
  });

  it("parks a rescue failure for the workspace to collect, without failing the unlock", () => {
    const dir = freshDir();
    const roomPath = path.join(dir, "rec-recovery-fail.roomai");
    const conn = dbCreateRoom(roomPath, PASSWORD, "Rec Recovery Fail");
    // Garbage stored bytes (not a valid WAV) make the splice throw — the
    // per-recording FAILURE this reports, not a missing-row skip.
    const meta = insertFile(conn, "r.wav", "audio/wav", Buffer.from("not a wav file"), null, "recording");
    conn.prepare("INSERT INTO rec_chunks(file_id, seq, pcm) VALUES (?, 0, ?)").run(
      meta.id,
      Buffer.alloc(4)
    );
    conn.close();

    const state = createRoomManagerState();
    expect(() => openRoom(state, baseDeps(dir), roomPath, PASSWORD)).not.toThrow();
    expect(state.recRecoveryError).toContain("could not be restored");
    expect(takeRecRecoveryError(state)).toContain("could not be restored");
    expect(state.recRecoveryError).toBeNull();
    state.room!.conn.close();
  });

  it("refreshes the privacy policy on unlock, and create_room does NOT (Rust's own asymmetry)", () => {
    const dir = freshDir();
    const roomPath = existingRoom(dir);
    const state = createRoomManagerState();
    const skipped = vi.spyOn(console, "error");

    createRoom(state, baseDeps(dir), path.join(dir, "created.roomai"), PASSWORD, "C");
    const afterCreate = skipped.mock.calls.map((c) => String(c[0]));
    expect(afterCreate.some((m) => m.includes("refresh_policy"))).toBe(false);

    openRoom(state, baseDeps(dir), roomPath, PASSWORD);
    const afterOpen = skipped.mock.calls.map((c) => String(c[0]));
    expect(afterOpen.some((m) => m.includes("refresh_policy"))).toBe(true);
    expect(afterOpen.some((m) => m.includes("schedule_privacy_scan"))).toBe(true);
    state.room!.conn.close();
  });

  it("runs every create/open background spawn in Rust's own order", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const calls: string[] = [];
    const deps = baseDeps(dir, {
      refreshMcp: () => calls.push("refresh_mcp"),
      spawnReextractBackfill: () => calls.push("reextract"),
      spawnLegacyTextRepair: () => calls.push("legacy_text_repair"),
      spawnEmbeddingBackfill: () => calls.push("embedding"),
      spawnRoomServerIfEnabled: () => calls.push("room_server"),
    });
    createRoom(state, deps, roomPathIn(dir, "spawn-order"), PASSWORD, "S");
    expect(calls).toEqual([
      "refresh_mcp",
      "reextract",
      "legacy_text_repair",
      "embedding",
      "room_server",
    ]);
    state.room!.conn.close();
  });
});

/** A minimal, valid, silent 16-bit mono 16 kHz WAV — enough for the splice to
 * accept as a real (if silent) recording, per `db-host/recordings.ts`. */
function emptyWav(): Buffer {
  const sampleRate = 16000;
  const buf = Buffer.alloc(44);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(0, 40);
  return buf;
}

// ============================================================================
// recovery: write_recovery_key / has_recovery_key / open_room_with_recovery
// ============================================================================

describe("recovery", () => {
  it("has no sidecar before writing, one after", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "recoverable");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "Recoverable");

    expect(hasRecoveryKey(roomPath)).toBe(false);
    const code = await writeRecoveryKey(state);
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/);
    expect(hasRecoveryKey(roomPath)).toBe(true);
    expect(hasRecovery(roomPath)).toBe(true);
    state.room!.conn.close();
  });

  it("refuses when no room is open", async () => {
    await expect(writeRecoveryKey(createRoomManagerState())).rejects.toThrow(NO_ROOM_OPEN);
  });

  it("recovers the password and opens exactly as openRoom does", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "recover-open");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "Recover Open");
    const code = await writeRecoveryKey(state);
    await closeRoom(state, baseDeps(dir));

    const info = await openRoomWithRecovery(state, baseDeps(dir), roomPath, code);
    expect(info.name).toBe("Recover Open");
    expect(state.room?.path).toBe(roomPath);
    state.room!.conn.close();
  });

  it("rejects a wrong code", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "recover-wrong");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");
    await writeRecoveryKey(state);
    await closeRoom(state, baseDeps(dir));

    await expect(
      openRoomWithRecovery(state, baseDeps(dir), roomPath, "WRONG-CODE-0000-0000-0000-0000")
    ).rejects.toThrow();
  });

  it("still refuses mid-rollback — it opens through the GUARDED open_room", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "recover-rollback");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");
    const code = await writeRecoveryKey(state);
    await closeRoom(state, baseDeps(dir));

    state.rollingBack = true;
    await expect(openRoomWithRecovery(state, baseDeps(dir), roomPath, code)).rejects.toThrow(
      ROLLBACK_BUSY
    );
  });
});

// ============================================================================
// Touch ID (ADD-11, real via keychain.ts) + the persistent room server (still
// stubbed, rule 3)
// ============================================================================

/**
 * An in-memory stand-in for keychain.ts's `has`/`store`/`read`/`deleteEntry`,
 * injected via {@link RoomManagerDeps.keychain}. keychain.ts's OWN tests
 * already prove the real Security.framework FFI round-trips correctly (and
 * document exactly why `store`/`read`/`deleteEntry` cannot be exercised for
 * real from this sandbox — errSecMissingEntitlement / -34018, no Team ID to
 * derive a keychain access group from). This fake exists to prove
 * roomManager.ts's OWN wiring — which function each `touchId*` calls, with
 * which arguments, which errors propagate vs. get rewritten — independent of
 * that sandbox limitation, the same seam shape as `chatCommandsKnowledge.ts`'s
 * `CmdCtx.generate`.
 */
function fakeKeychain(): {
  entries: Map<string, string>;
  impl: NonNullable<RoomManagerDeps["keychain"]>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    impl: {
      has: (path: string) => entries.has(path),
      store: (path: string, password: string) => {
        entries.set(path, password);
      },
      read: (path: string) => {
        const password = entries.get(path);
        if (password === undefined) {
          throw new Error("No Touch ID entry for this room.");
        }
        return password;
      },
      deleteEntry: (path: string) => {
        entries.delete(path);
      },
    },
  };
}

const TOUCH_ID_UNAVAILABLE_MESSAGE =
  "Touch ID isn't available on this Mac right now. You can still unlock with your password.";

describe("touchIdHas", () => {
  it("is real by default (no override) -- hits keychain.ts's own has(), never throws", async () => {
    // keychain.test.ts documents has() as real, unconditional coverage even in
    // this sandbox (it never reaches the data-protection-keychain failure
    // mode the store/read/deleteEntry tests have to route around).
    await expect(
      touchIdHas(`/never-stored-${randomUUID()}.roomai`, baseDeps("/tmp"))
    ).resolves.toBe(false);
  });

  it("reflects the injected keychain instead of the real one, once overridden", async () => {
    const { impl, entries } = fakeKeychain();
    const deps = baseDeps("/tmp", { keychain: impl });
    const roomPath = "/fake-room.roomai";

    await expect(touchIdHas(roomPath, deps)).resolves.toBe(false);
    entries.set(roomPath, "irrelevant");
    await expect(touchIdHas(roomPath, deps)).resolves.toBe(true);
  });
});

describe("touchIdEnable", () => {
  it("refuses with NO_ROOM_OPEN before ever touching the Keychain", async () => {
    const { impl, entries } = fakeKeychain();
    await expect(
      touchIdEnable(createRoomManagerState(), baseDeps("/tmp", { keychain: impl }))
    ).rejects.toThrow(NO_ROOM_OPEN);
    expect(entries.size).toBe(0);
  });

  it("stores the OPEN room's own path and password, not anything passed some other way", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const { impl, entries } = fakeKeychain();
    const roomPath = roomPathIn(dir, "enable");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");

    await touchIdEnable(state, baseDeps(dir, { keychain: impl }));

    expect(entries.get(roomPath)).toBe(PASSWORD);
    state.room!.conn.close();
  });

  it("wraps a storage-shaped Keychain failure through humanizeStorageError, exactly as with_room does", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "enable-storage-fail");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");
    const deps = baseDeps(dir, {
      keychain: {
        ...fakeKeychain().impl,
        store: () => {
          throw new Error("database or disk is full (os error 28)");
        },
      },
    });

    await expect(touchIdEnable(state, deps)).rejects.toThrow(/disk holding this room is full/);
    state.room!.conn.close();
  });

  it("leaves a Touch-ID-shaped Keychain failure UNCHANGED -- humanizeStorageError only rewrites storage-shaped messages", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "enable-touchid-fail");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");
    const deps = baseDeps(dir, {
      keychain: {
        ...fakeKeychain().impl,
        store: () => {
          throw new Error(TOUCH_ID_UNAVAILABLE_MESSAGE);
        },
      },
    });

    await expect(touchIdEnable(state, deps)).rejects.toThrow(TOUCH_ID_UNAVAILABLE_MESSAGE);
    state.room!.conn.close();
  });
});

describe("touchIdDisable", () => {
  it("does not require a room open and does not even take a RoomManagerState -- Rust's touchid_disable takes a bare path only", async () => {
    const { impl, entries } = fakeKeychain();
    entries.set("/some-room.roomai", "whatever");

    await touchIdDisable("/some-room.roomai", baseDeps("/tmp", { keychain: impl }));

    expect(entries.has("/some-room.roomai")).toBe(false);
  });

  it("propagates a Keychain failure UNCHANGED -- touchid_disable does not route through with_room, so nothing humanizes it", async () => {
    const deps = baseDeps("/tmp", {
      keychain: {
        ...fakeKeychain().impl,
        deleteEntry: () => {
          throw new Error(TOUCH_ID_UNAVAILABLE_MESSAGE);
        },
      },
    });

    await expect(touchIdDisable("/x.roomai", deps)).rejects.toThrow(TOUCH_ID_UNAVAILABLE_MESSAGE);
  });
});

describe("touchIdOpen", () => {
  it("reads the stored password via the Keychain and unlocks through the REAL, guarded openRoom", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "touchid-open");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "Fingerprint Room");
    await closeRoom(state, baseDeps(dir));
    expect(state.room).toBeNull();

    const { impl, entries } = fakeKeychain();
    entries.set(roomPath, PASSWORD);

    const info = await touchIdOpen(state, baseDeps(dir, { keychain: impl }), roomPath);

    expect(info).toMatchObject({ name: "Fingerprint Room", path: roomPath });
    expect(state.room?.path).toBe(roomPath);
    state.room!.conn.close();
  });

  it("propagates a read failure (no entry / cancel / no match) as-is, never opening the room", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const { impl } = fakeKeychain(); // nothing stored -> read() throws "No Touch ID entry..."

    await expect(
      touchIdOpen(state, baseDeps(dir, { keychain: impl }), roomPathIn(dir, "never-enrolled"))
    ).rejects.toThrow("No Touch ID entry for this room.");
    expect(state.room).toBeNull();
  });

  it("a wrong stored password fails to unlock, same as a normal wrong-password open", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "touchid-wrong-pw");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");
    await closeRoom(state, baseDeps(dir));

    const { impl, entries } = fakeKeychain();
    entries.set(roomPath, "definitely not the password");

    await expect(
      touchIdOpen(state, baseDeps(dir, { keychain: impl }), roomPath)
    ).rejects.toThrow();
    expect(state.room).toBeNull();
  });

  it("still refuses mid-rollback -- proves it reuses the GUARDED openRoom, not the unguarded impl", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "touchid-rollback");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");
    await closeRoom(state, baseDeps(dir));

    const { impl, entries } = fakeKeychain();
    entries.set(roomPath, PASSWORD);
    state.rollingBack = true;

    await expect(
      touchIdOpen(state, baseDeps(dir, { keychain: impl }), roomPath)
    ).rejects.toThrow(ROLLBACK_BUSY);
  });
});

describe("the uninjected keychain seam", () => {
  /**
   * Every test above overrides {@link RoomManagerDeps.keychain}, and the four
   * `deps.keychain?.x ?? keychainX` fallbacks are this file's ONLY reference
   * to keychain.ts's `store`/`read`/`deleteEntry` — so nothing else here would
   * notice a default rebound to the wrong function, or dropped entirely for a
   * required dependency. (`touchIdHas` above is the one exception: keychain.ts
   * documents its real `has()` as unconditionally reachable even in this
   * sandbox.) Re-importing roomManager.ts against a mocked keychain.ts pins
   * all four defaults to keychain.ts's own module, and pins the ARGUMENTS —
   * without needing a real Keychain the sandbox cannot reach.
   */
  it("routes all four to keychain.ts's own has/store/read/deleteEntry, with the room's own path and password", async () => {
    const dir = freshDir();
    const roomPath = roomPathIn(dir, "uninjected-seam");
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock("./keychain.js", () => ({
      has: (p: string) => {
        calls.push(`has ${p}`);
        return true;
      },
      store: (p: string, password: string) => {
        calls.push(`store ${p} ${password}`);
      },
      read: (p: string) => {
        calls.push(`read ${p}`);
        return PASSWORD;
      },
      deleteEntry: (p: string) => {
        calls.push(`deleteEntry ${p}`);
      },
    }));
    try {
      const fresh = await import("./roomManager.js");
      const state = fresh.createRoomManagerState();
      const deps = baseDeps(dir);

      expect(await fresh.touchIdHas(roomPath, deps)).toBe(true);

      fresh.createRoom(state, deps, roomPath, PASSWORD, "Seam");
      await fresh.touchIdEnable(state, deps);
      await fresh.closeRoom(state, deps);

      const info = await fresh.touchIdOpen(state, deps, roomPath);
      expect(info).toMatchObject({ name: "Seam", path: roomPath });
      state.room!.conn.close();

      await fresh.touchIdDisable(roomPath, deps);

      expect(calls).toEqual([
        `has ${roomPath}`,
        `store ${roomPath} ${PASSWORD}`,
        `read ${roomPath}`,
        `deleteEntry ${roomPath}`,
      ]);
    } finally {
      vi.doUnmock("./keychain.js");
      vi.resetModules();
    }
  });
});

describe("spawnRoomServerIfEnabledNotImplemented (D9, the Leash)", () => {
  it("logs rather than throwing — Rust's own call site is a fire-and-forget spawn", () => {
    const room: Room = { conn: {} as Database.Database, path: "/x.roomai", name: "x", password: "x" };
    expect(() => spawnRoomServerIfEnabledNotImplemented(room)).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(ROOM_SERVER_NOT_IMPLEMENTED);
    expect(ROOM_SERVER_NOT_IMPLEMENTED).toContain("room_mcp.rs");
  });

  it("does not blow up the synchronous createRoom that fires it", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    expect(() => createRoom(state, baseDeps(dir), roomPathIn(dir), PASSWORD, "R")).not.toThrow();
    state.room!.conn.close();
  });
});

// ============================================================================
// room_info / rename_room / take_pending_open / take_rec_recovery_error
// ============================================================================

describe("roomInfo", () => {
  it("is null with no room open", () => {
    expect(roomInfo(createRoomManagerState(), baseDeps("/tmp"))).toBeNull();
  });

  it("reflects the open room", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    createRoom(state, baseDeps(dir), roomPathIn(dir, "info"), PASSWORD, "Info Room");
    expect(roomInfo(state, baseDeps(dir))?.name).toBe("Info Room");
    state.room!.conn.close();
  });
});

describe("renameRoom", () => {
  function opened(dir: string): RoomManagerState {
    const state = createRoomManagerState();
    createRoom(state, baseDeps(dir), path.join(dir, "to-rename.roomai"), PASSWORD, "Old Name");
    return state;
  }

  it("updates meta, the in-memory room, the returned info AND the recents file", () => {
    const dir = freshDir();
    const state = opened(dir);
    const roomPath = state.room!.path;

    const info = renameRoom(state, baseDeps(dir), "New Name");

    expect(info.name).toBe("New Name");
    expect(state.room?.name).toBe("New Name");
    expect(getMeta(state.room!.conn, "name")).toBe("New Name");
    expect(readRecent(dir).find((r) => r.path === roomPath)?.name).toBe("New Name");
    state.room!.conn.close();

    // Reopening reads the renamed meta value back.
    const reopened = createRoomManagerState();
    expect(openRoom(reopened, baseDeps(dir), roomPath, PASSWORD).name).toBe("New Name");
    reopened.room!.conn.close();
  });

  it("rejects an empty (or whitespace-only) name", () => {
    const dir = freshDir();
    const state = opened(dir);
    expect(() => renameRoom(state, baseDeps(dir), "   ")).toThrow("A room needs a name.");
    state.room!.conn.close();
  });

  it("rejects a name over MAX_ROOM_NAME_CHARS with the exact Rust wording, and accepts one at the limit", () => {
    const dir = freshDir();
    const state = opened(dir);
    expect(() => renameRoom(state, baseDeps(dir), "x".repeat(MAX_ROOM_NAME_CHARS + 1))).toThrow(
      `That name is too long — ${MAX_ROOM_NAME_CHARS} characters at most.`
    );
    expect(() => renameRoom(state, baseDeps(dir), "x".repeat(MAX_ROOM_NAME_CHARS))).not.toThrow();
    state.room!.conn.close();
  });

  it("counts a name in Unicode scalar values, not UTF-16 code units", () => {
    const dir = freshDir();
    const state = opened(dir);
    // 120 astral characters is 240 UTF-16 code units but exactly the limit in
    // the `chars().count()` Rust applies.
    expect(() => renameRoom(state, baseDeps(dir), "😀".repeat(MAX_ROOM_NAME_CHARS))).not.toThrow();
    state.room!.conn.close();
  });

  it("refuses while a rollback is in flight", () => {
    const dir = freshDir();
    const state = opened(dir);
    state.rollingBack = true;
    expect(() => renameRoom(state, baseDeps(dir), "New")).toThrow(ROLLBACK_BUSY);
    state.room!.conn.close();
  });

  it("refuses when no room is open — but only AFTER the name checks, as Rust does", () => {
    const state = createRoomManagerState();
    expect(() => renameRoom(state, baseDeps("/tmp"), "New")).toThrow(NO_ROOM_OPEN);
    expect(() => renameRoom(state, baseDeps("/tmp"), "  ")).toThrow("A room needs a name.");
  });
});

describe("takePendingOpen", () => {
  it("delegates entirely to pendingOpen.ts's process-global slot", () => {
    setPendingOpen("/some/room.roomai");
    expect(peekPendingOpen()).toBe("/some/room.roomai");
    expect(takePendingOpen()).toBe("/some/room.roomai");
    expect(takePendingOpen()).toBeNull();
  });
});

describe("takeRecRecoveryError (ported: a_failed_recording_rescue_waits_for_the_workspace_to_collect_it)", () => {
  it("is null when nothing failed, and collecting it clears it", () => {
    const state = createRoomManagerState();
    expect(takeRecRecoveryError(state)).toBeNull();

    state.recRecoveryError = "Audio from an interrupted recording could not be restored";
    expect(takeRecRecoveryError(state)).toContain("could not be restored");
    expect(takeRecRecoveryError(state)).toBeNull();
  });
});

// ============================================================================
// report_rec_recovery_failure
// ============================================================================

describe("reportRecRecoveryFailure / shouldEmitRecRecovery", () => {
  function openOn(state: RoomManagerState, roomPath: string): void {
    state.room = { conn: {} as Database.Database, path: roomPath, name: "R", password: "x" };
  }

  it("parks the message synchronously, with the exact Rust wording", () => {
    const state = createRoomManagerState();
    reportRecRecoveryFailure(state, baseDeps("/tmp"), "/r.roomai", "disk fell over", 100_000);
    expect(state.recRecoveryError).toBe(
      "Audio from an interrupted recording could not be restored: disk fell over " +
        "Nothing was lost — it is still stored in the room, and the rescue " +
        "runs again the next time you unlock it."
    );
  });

  it("should-emit is true only while the SAME room is open and the message is still parked", () => {
    const state = createRoomManagerState();
    openOn(state, "/r.roomai");
    state.recRecoveryError = "parked";
    expect(shouldEmitRecRecovery(state, "/r.roomai")).toBe(true);

    openOn(state, "/other.roomai");
    expect(shouldEmitRecRecovery(state, "/r.roomai")).toBe(false);

    openOn(state, "/r.roomai");
    state.recRecoveryError = null;
    expect(shouldEmitRecRecovery(state, "/r.roomai")).toBe(false);

    state.room = null;
    state.recRecoveryError = "parked";
    expect(shouldEmitRecRecovery(state, "/r.roomai")).toBe(false);
  });

  it("delivers a COPY of the delayed emit while both guards hold, leaving the park alone", async () => {
    const emit = vi.fn();
    const state = createRoomManagerState();
    openOn(state, "/r.roomai");
    reportRecRecoveryFailure(state, baseDeps("/tmp", { emit }), "/r.roomai", "boom", 5);
    const parked = state.recRecoveryError;

    await sleep(40);

    expect(emit).toHaveBeenCalledWith("rec-error", { fileId: "", message: parked });
    // The fallback emit must NOT consume the park — `takeRecRecoveryError` is
    // the message's only consumer.
    expect(state.recRecoveryError).toBe(parked);
  });

  it("does not deliver once the room changed before the delay elapsed", async () => {
    const emit = vi.fn();
    const state = createRoomManagerState();
    openOn(state, "/r.roomai");
    reportRecRecoveryFailure(state, baseDeps("/tmp", { emit }), "/r.roomai", "boom", 5);
    openOn(state, "/different.roomai");

    await sleep(40);

    expect(emit).not.toHaveBeenCalled();
  });

  it("does not deliver once the workspace has already collected it", async () => {
    const emit = vi.fn();
    const state = createRoomManagerState();
    openOn(state, "/r.roomai");
    reportRecRecoveryFailure(state, baseDeps("/tmp", { emit }), "/r.roomai", "boom", 5);
    takeRecRecoveryError(state);

    await sleep(40);

    expect(emit).not.toHaveBeenCalled();
  });
});

// ============================================================================
// park_inflight_jobs_for_teardown — ported 1:1 from the Rust suite
// ============================================================================

describe("parkInflightJobsForTeardown", () => {
  it("parks the job that was running inside the room being locked, and leaves a queued one alone", () => {
    const { state, reader } = roomWithReader("park-teardown-running");
    const plan = { workflow_id: "wf-1" };
    const running = createJob(state.room!.conn, "workflow", "Workflow — Digest", plan, 4);
    setJobStatus(state.room!.conn, running, "running", null);
    checkpointJob(state.room!.conn, running, 2, { done: [0, 1] });
    const queued = createJob(state.room!.conn, "file_pass", "Full pass", plan, 4);

    expect(parkInflightJobsForTeardown(state)).toBe(1);

    const job = getJob(reader, running);
    expect(job.status).toBe("paused");
    expect(job.parkedReason).toBe(PARKED_BY_LOCK);
    expect(job.cursor).toBe(2); // parked, not reset — Resume keeps its checkpoint
    expect(job.state).toEqual({ done: [0, 1] });
    // A queued job never started and is what `pump_on_open` auto-starts at the
    // next unlock; parking it here is what once made that path a dead no-op.
    expect(getJob(reader, queued).status).toBe("queued");
  });

  it("is a park, not a reset — done/paused/failed jobs keep their own story", () => {
    const { state, reader } = roomWithReader("park-teardown-terminal");
    const done = createJob(state.room!.conn, "studio", "Flashcards", {}, 1);
    setJobStatus(state.room!.conn, done, "done", null);
    const paused = createJob(state.room!.conn, "file_pass", "Full pass", {}, 4);
    setJobStatus(state.room!.conn, paused, "paused", null);
    const failed = createJob(state.room!.conn, "deep_summary", "Room summary", {}, 2);
    setJobStatus(state.room!.conn, failed, "error", "OLLAMA_DOWN");

    expect(parkInflightJobsForTeardown(state)).toBe(0);

    expect(getJob(reader, done).status).toBe("done");
    expect(getJob(reader, done).parkedReason).toBeNull();
    expect(getJob(reader, paused).status).toBe("paused");
    expect(getJob(reader, paused).parkedReason).toBeNull();
    expect(getJob(reader, failed).status).toBe("error");
    expect(getJob(reader, failed).error).toBe("OLLAMA_DOWN");
  });

  it("reports nothing rather than guessing when no room is open", () => {
    expect(parkInflightJobsForTeardown(createRoomManagerState())).toBe(0);
  });
});

// ============================================================================
// teardown_open_room
// ============================================================================

describe("teardownOpenRoom", () => {
  it("parks in-flight jobs while the room can still be written to (the call site, not just the rule)", () => {
    const { state, deps, reader } = roomWithReader("teardown-call-site");
    const running = createJob(state.room!.conn, "workflow", "Workflow — Digest", { workflow_id: "wf-1" }, 4);
    setJobStatus(state.room!.conn, running, "running", null);
    checkpointJob(state.room!.conn, running, 2, { done: [0, 1] });

    teardownOpenRoom(state, deps);

    expect(state.room).toBeNull();
    const job = getJob(reader, running);
    expect(job.status).toBe("paused");
    expect(job.parkedReason).toBe(PARKED_BY_LOCK);
    expect(job.cursor).toBe(2);
  });

  it("bumps the room epoch so stragglers cannot write after it", () => {
    const { state, deps } = roomWithReader("teardown-epoch");
    const before = state.roomEpoch;
    teardownOpenRoom(state, deps);
    expect(state.roomEpoch).toBeGreaterThan(before);
  });

  it("drops a parked recovery message with the room it belongs to", () => {
    const { state, deps } = roomWithReader("teardown-rec-recovery");
    state.recRecoveryError = "Audio from an interrupted recording could not be restored";
    teardownOpenRoom(state, deps);
    expect(takeRecRecoveryError(state)).toBeNull();
  });

  it("CLOSES the room's connection — Rust's `state.room = None` drops it", () => {
    const { state, deps } = roomWithReader("teardown-closes-db");
    const conn = state.room!.conn;
    expect(conn.open).toBe(true);

    teardownOpenRoom(state, deps);

    // A locked room must not leave its encrypted file open with its SQLCipher
    // key resident for the rest of the process.
    expect(conn.open).toBe(false);
  });

  it("signals every cancel flag WITHOUT removing it — a runner still owns its own entry", () => {
    const { state, deps } = roomWithReader("teardown-flags");
    const askFlag = new CancelFlag();
    const jobFlag = new CancelFlag();
    state.cancel.cancels.set("ask-1", askFlag);
    state.cancel.jobCancels.set("job-1", jobFlag);

    teardownOpenRoom(state, deps);

    expect(askFlag.load()).toBe(true);
    expect(jobFlag.load()).toBe(true);
    expect(state.cancel.cancels.has("ask-1")).toBe(true);
    expect(state.cancel.jobCancels.has("job-1")).toBe(true);
  });

  it("is a harmless no-op with no room open (a second teardown, or a failed unlock)", () => {
    const state = createRoomManagerState();
    expect(() => teardownOpenRoom(state, baseDeps("/tmp"))).not.toThrow();
    expect(parkInflightJobsForTeardown(state)).toBe(0);
  });

  it("calls every optional teardown hook exactly once when supplied", () => {
    const { state, dir } = roomWithReader("teardown-hooks");
    const calls: string[] = [];
    const emit = vi.fn();
    const deps = baseDeps(dir, {
      stopRecordingNoWait: () => calls.push("stopRecordingNoWait"),
      closeBrowser: () => calls.push("closeBrowser"),
      noteRoomClosed: () => calls.push("noteRoomClosed"),
      clearEphemeralCaches: () => calls.push("clearEphemeralCaches"),
      forgetRoomMemory: () => calls.push("forgetRoomMemory"),
      emit,
    });

    teardownOpenRoom(state, deps);

    for (const name of [
      "stopRecordingNoWait",
      "closeBrowser",
      "noteRoomClosed",
      "clearEphemeralCaches",
      "forgetRoomMemory",
    ]) {
      expect(calls.filter((c) => c === name)).toHaveLength(1);
    }
    // Ordering that is load-bearing: the browser's journal flushes while the
    // room DB is still open.
    expect(calls.indexOf("closeBrowser")).toBeLessThan(calls.indexOf("noteRoomClosed"));
    expect(emit).toHaveBeenCalledWith("mcp-status", []);
  });

  it("distinguishes a missing PORT from a missing WIRE in what it logs", () => {
    const { state, deps } = roomWithReader("teardown-hooks-absent");
    const spy = vi.spyOn(console, "error");

    teardownOpenRoom(state, deps);

    const messages = spy.mock.calls.map((c) => String(c[0]));
    // Bucket 2 — genuinely unported Rust subsystems.
    expect(messages.some((m) => m.includes("NOT_IMPLEMENTED") && m.includes("note_room_closed"))).toBe(true);
    expect(messages.some((m) => m.includes("NOT_IMPLEMENTED") && m.includes("forget_room_memory"))).toBe(true);
    // Bucket 1 — real ported code, just not handed over.
    expect(messages.some((m) => m.includes("SKIPPED") && m.includes("browser::close"))).toBe(true);
    expect(messages.some((m) => m.includes("SKIPPED") && m.includes("mcp manager teardown"))).toBe(true);
  });

  it("does not let a browser that refuses to close abandon the rest of the teardown", () => {
    const { state, dir } = roomWithReader("teardown-browser-throws");
    const forgetRoomMemory = vi.fn();
    const deps = baseDeps(dir, {
      closeBrowser: () => {
        throw new Error("the webview is gone");
      },
      forgetRoomMemory,
    });

    // Rust's call site is `let _ = crate::browser::close(app);`.
    expect(() => teardownOpenRoom(state, deps)).not.toThrow();
    expect(state.room).toBeNull();
    expect(forgetRoomMemory).toHaveBeenCalledTimes(1);
  });

  it("closes every MCP client, clears the list, and bumps the generation", () => {
    const { state, dir } = roomWithReader("teardown-mcp-manager");
    const mcp = new McpManager();
    const close = vi.fn();
    mcp.servers.push({
      name: "search",
      status: "connected",
      error: null,
      tools: [],
      remote: false,
      client: { callTool: vi.fn(), close },
      configKey: "k",
    });
    const generationBefore = mcp.generation;

    teardownOpenRoom(state, baseDeps(dir, { mcp }));

    expect(close).toHaveBeenCalledTimes(1);
    expect(mcp.servers).toEqual([]);
    expect(mcp.generation).toBe(generationBefore + 1);
  });

  it("DECLINES every in-flight approval before clearing the registries", () => {
    const { state, deps } = roomWithReader("teardown-pending-approvals");
    const mcpResolve = vi.fn();
    const editResolve = vi.fn();
    const scriptResolve = vi.fn();
    state.mcpSessionOk.add("server-a");
    state.mcpPending.set("req-1", mcpResolve);
    state.editPending.set("req-2", editResolve);
    state.scriptPending.set("req-3", scriptResolve);

    teardownOpenRoom(state, deps);

    // Rust gets this free by DROPPING each oneshot::Sender; a JS callback left
    // in a Map never fires on its own, so each is declined explicitly.
    expect(mcpResolve).toHaveBeenCalledWith({ approved: false, remember: false });
    expect(editResolve).toHaveBeenCalledWith({ approved: false, restOfTurn: false });
    expect(scriptResolve).toHaveBeenCalledWith({ approved: false, remember: false });
    expect(state.mcpSessionOk.size).toBe(0);
    expect(state.mcpPending.size).toBe(0);
    expect(state.editPending.size).toBe(0);
    expect(state.scriptPending.size).toBe(0);
  });

  it("stops and de-advertises a running room-server bridge", () => {
    const { state, dir } = roomWithReader("teardown-room-server");
    const stop = vi.fn();
    const removeDiscovery = vi.fn();
    state.roomServer = { stop };

    teardownOpenRoom(state, baseDeps(dir, { removeDiscovery }));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(removeDiscovery).toHaveBeenCalledTimes(1);
    expect(state.roomServer).toBeNull();
  });
});

// ============================================================================
// drain_inflight
// ============================================================================

describe("drainInflight", () => {
  const fast = { askPollMs: 1, askMaxPolls: 3, jobPollMs: 1, jobMaxPolls: 3 };

  it("reports both drained when nothing is in flight", async () => {
    const { state, deps } = roomWithReader("drain-empty");
    expect(await drainInflight(state, deps, fast)).toEqual({ asksDrained: true, jobsDrained: true });
  });

  it("reports NOT drained when a flag never clears within the bounded wait", async () => {
    const { state, deps } = roomWithReader("drain-stuck");
    state.cancel.cancels.set("ask-1", new CancelFlag());
    state.cancel.jobCancels.set("job-1", new CancelFlag());

    expect(await drainInflight(state, deps, fast)).toEqual({ asksDrained: false, jobsDrained: false });
  });

  it("reports drained once the runner removes its own entry mid-wait", async () => {
    const { state, deps } = roomWithReader("drain-eventually");
    state.cancel.cancels.set("quick", new CancelFlag());
    setTimeout(() => state.cancel.cancels.delete("quick"), 5);

    const report = await drainInflight(state, deps, { askPollMs: 2, askMaxPolls: 50, jobPollMs: 1, jobMaxPolls: 1 });
    expect(report.asksDrained).toBe(true);
  });

  it("flips every ask AND job flag it waited on", async () => {
    const { state, deps } = roomWithReader("drain-flips");
    const ask = new CancelFlag();
    const job = new CancelFlag();
    state.cancel.cancels.set("ask-1", ask);
    state.cancel.jobCancels.set("job-1", job);

    await drainInflight(state, deps, fast);

    expect(ask.load()).toBe(true);
    expect(job.load()).toBe(true);
  });

  it("stamps PARKED_BY_LOCK while the room is still open, before the jobs-drain wait", async () => {
    const { state, deps, reader } = roomWithReader("drain-marks-jobs");
    const running = createJob(state.room!.conn, "workflow", "Workflow — Digest", {}, 4);
    setJobStatus(state.room!.conn, running, "running", null);

    await drainInflight(state, deps, fast);

    // Recorded here, once, so the card can't read as a Stop the user chose.
    expect(getJob(reader, running).parkedReason).toBe(PARKED_BY_LOCK);
  });

  it("awaits an injected stopRecordingAndWait, with Rust's own 30s bound", async () => {
    const { state, dir } = roomWithReader("drain-recording");
    const stopRecordingAndWait = vi.fn(async () => {});
    await drainInflight(state, baseDeps(dir, { stopRecordingAndWait }), fast);
    expect(stopRecordingAndWait).toHaveBeenCalledWith(30_000);
  });
});

// ============================================================================
// close_room
// ============================================================================

describe("closeRoom", () => {
  it("refuses while a rollback is in flight and leaves the room open", async () => {
    const { state, deps } = roomWithReader("close-rollback-busy");
    state.rollingBack = true;
    await expect(closeRoom(state, deps)).rejects.toThrow(ROLLBACK_BUSY);
    expect(state.room).not.toBeNull();
    expect(state.room!.conn.open).toBe(true);
  });

  it("is a harmless no-op when no room is open", async () => {
    await expect(closeRoom(createRoomManagerState(), baseDeps("/tmp"))).resolves.toBeUndefined();
  });

  it("drains, tears down, and leaves nothing open", async () => {
    const { state, deps } = roomWithReader("close-happy-path");
    const conn = state.room!.conn;
    await closeRoom(state, deps);
    expect(state.room).toBeNull();
    expect(conn.open).toBe(false);
  });

  it("parks the job that was running inside the room being locked", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const roomPath = roomPathIn(dir, "close-parks");
    createRoom(state, baseDeps(dir), roomPath, PASSWORD, "R");
    const running = createJob(state.room!.conn, "workflow", "Workflow — Digest", { workflow_id: "wf-1" }, 4);
    setJobStatus(state.room!.conn, running, "running", null);
    checkpointJob(state.room!.conn, running, 2, { done: [0, 1] });

    await closeRoom(state, baseDeps(dir));

    expect(state.room).toBeNull();
    // Read the room the way the next unlock will — a fresh connection.
    const next = createRoomManagerState();
    openRoom(next, baseDeps(dir), roomPath, PASSWORD);
    const job = getJob(next.room!.conn, running);
    expect(job.status).toBe("paused");
    expect(job.parkedReason).toBe(PARKED_BY_LOCK);
    expect(job.cursor).toBe(2);
    next.room!.conn.close();
  });
});

// ============================================================================
// The two seams other ported modules already take
// ============================================================================

describe("toRoomPinSource / toRoomSource", () => {
  it("reflect the current room and epoch", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    createRoom(state, baseDeps(dir), roomPathIn(dir, "pin"), PASSWORD, "Pin");

    expect(toRoomPinSource(state).currentRoomPath()).toBe(state.room!.path);
    expect(toRoomPinSource(state).roomEpoch()).toBe(state.roomEpoch);
    expect(toRoomSource(state).current()).toEqual({ db: state.room!.conn, path: state.room!.path });
    state.room!.conn.close();
  });

  it("are null/empty when no room is open", () => {
    const state = createRoomManagerState();
    expect(toRoomPinSource(state).currentRoomPath()).toBeNull();
    expect(toRoomSource(state).current()).toBeNull();
  });
});

// ============================================================================
// roomManagerIpc.ts — the registration shim (rule 4: never a real round trip)
// ============================================================================

type Handler = (...args: unknown[]) => unknown;

/** Every channel `registerRoomManagerIpc` registers, in the exact names
 * `electron/shared/ipc-contract.ts` declares — pinned so a channel silently
 * dropped from the list fails here rather than shipping unnoticed. */
const EXPECTED_CHANNELS = [
  "create_room",
  "open_room",
  "open_room_with_recovery",
  "close_room",
  "room_info",
  "rename_room",
  "write_recovery_key",
  "has_recovery_key",
  "take_rec_recovery_error",
  "take_pending_open",
  "touchid_has",
  "touchid_enable",
  "touchid_disable",
  "touchid_open",
];

function register(state: RoomManagerState, deps: RoomManagerDeps): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeEvent = {} as never;
  const handle = vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
    handlers.set(channel, (...args: unknown[]) => listener(fakeEvent, ...args));
  });
  registerRoomManagerIpc({ handle }, state, deps);
  return handlers;
}

describe("registerRoomManagerIpc", () => {
  it("registers exactly the rooms.rs command surface, once each", () => {
    const handlers = register(createRoomManagerState(), baseDeps("/tmp"));
    expect([...handlers.keys()].sort()).toEqual([...EXPECTED_CHANNELS].sort());
    expect(handlers.size).toBe(EXPECTED_CHANNELS.length);
  });

  it("create_room / room_info / rename_room / close_room / open_room reach the real logic", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const handlers = register(state, baseDeps(dir));
    const roomPath = roomPathIn(dir, "ipc");

    expect(handlers.get("room_info")!()).toBeNull();

    const created = handlers.get("create_room")!({ path: roomPath, password: PASSWORD, name: "Handled" });
    expect(created).toMatchObject({ name: "Handled", path: roomPath });
    expect((handlers.get("room_info")!() as { name: string }).name).toBe("Handled");

    expect(handlers.get("rename_room")!({ name: "Renamed" })).toMatchObject({ name: "Renamed" });

    await handlers.get("close_room")!();
    expect(handlers.get("room_info")!()).toBeNull();

    expect(handlers.get("open_room")!({ path: roomPath, password: PASSWORD })).toMatchObject({
      name: "Renamed",
    });
    state.room!.conn.close();
  });

  it("create_room accepts the contract's `name: null` and falls back to the file name", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const handlers = register(state, baseDeps(dir));
    const roomPath = path.join(dir, "contract-null.roomai");

    const info = handlers.get("create_room")!({ path: roomPath, password: PASSWORD, name: null });

    expect(info).toMatchObject({ name: "contract-null" });
    state.room!.conn.close();
  });

  it("open_room honors the rollback guard through the shim", () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const handlers = register(state, baseDeps(dir));
    const roomPath = path.join(dir, "guarded.roomai");
    dbCreateRoom(roomPath, PASSWORD, "G").close();

    state.rollingBack = true;
    expect(() => handlers.get("open_room")!({ path: roomPath, password: PASSWORD })).toThrow(
      ROLLBACK_BUSY
    );
  });

  it("write_recovery_key / has_recovery_key / open_room_with_recovery round-trip for real", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const handlers = register(state, baseDeps(dir));
    const roomPath = roomPathIn(dir, "ipc-recovery");
    handlers.get("create_room")!({ path: roomPath, password: PASSWORD, name: "E" });

    expect(handlers.get("has_recovery_key")!({ path: roomPath })).toBe(false);
    const code = (await handlers.get("write_recovery_key")!()) as string;
    expect(handlers.get("has_recovery_key")!({ path: roomPath })).toBe(true);

    await handlers.get("close_room")!();
    const reopened = await handlers.get("open_room_with_recovery")!({ path: roomPath, code });
    expect(reopened).toMatchObject({ name: "E" });
    state.room!.conn.close();
  });

  it("take_pending_open / take_rec_recovery_error reach the real once-only slots", () => {
    const state = createRoomManagerState();
    const handlers = register(state, baseDeps("/tmp"));

    setPendingOpen("/rooms/dropped.roomai");
    expect(handlers.get("take_pending_open")!()).toBe("/rooms/dropped.roomai");
    expect(handlers.get("take_pending_open")!()).toBeNull();

    expect(handlers.get("take_rec_recovery_error")!()).toBeNull();
    state.recRecoveryError = "parked";
    expect(handlers.get("take_rec_recovery_error")!()).toBe("parked");
    expect(handlers.get("take_rec_recovery_error")!()).toBeNull();
  });

  it("every touchid_* channel reaches the real roomManager.ts logic, with args threaded correctly", async () => {
    const dir = freshDir();
    const state = createRoomManagerState();
    const { impl, entries } = fakeKeychain();
    const handlers = register(state, baseDeps(dir, { keychain: impl }));
    const roomPath = roomPathIn(dir, "ipc-touchid");

    handlers.get("create_room")!({ path: roomPath, password: PASSWORD, name: "IPC Touch ID" });

    expect(await handlers.get("touchid_has")!({ path: roomPath })).toBe(false);

    await handlers.get("touchid_enable")!();
    expect(entries.get(roomPath)).toBe(PASSWORD);
    expect(await handlers.get("touchid_has")!({ path: roomPath })).toBe(true);

    await handlers.get("close_room")!();

    const reopened = await handlers.get("touchid_open")!({ path: roomPath });
    expect(reopened).toMatchObject({ name: "IPC Touch ID", path: roomPath });
    state.room!.conn.close();

    await handlers.get("touchid_disable")!({ path: roomPath });
    expect(entries.has(roomPath)).toBe(false);
    expect(await handlers.get("touchid_has")!({ path: roomPath })).toBe(false);
  });
});
