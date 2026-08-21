/**
 * Vitest port of the pure, non-`AppState` parts of
 * `src-tauri/src/commands/room_checkpoints.rs`'s `mod tests`
 * (`checkpoint_timestamps_match_every_other_timestamp_in_the_app` and
 * `a_checkpoint_id_that_escapes_the_checkpoints_folder_is_refused`, plus a
 * shape check ported from `a_checkpoint_refuses_before_it_fills_the_disk`),
 * plus real filesystem-level tests of `writeCheckpoint`/`reconcile`/
 * `pruneAutoCheckpoints`/`performSwap` against a real Rust-produced
 * `.roomai` fixture — the Rust file's remaining tests
 * (`checkpoint_swap_reopen_restores_old_content`,
 * `safety_copy_reopens_with_the_same_password`,
 * `reconcile_drops_missing_and_refreshes_sizes`,
 * `manifest_write_is_temp_then_rename`, `reconcile_adopts_orphan_payload`,
 * `checkpoint_path_with_a_quote_survives_vacuum_escaping`) are re-created
 * here directly against this port's own functions rather than copy-pasted,
 * since this port's `write_checkpoint` takes a `Database.Database` (not a
 * rusqlite `Connection`) and there is no `db::create_room`/`insert_file`
 * helper module to reuse — `open.ts`'s `createRoom`/`openRoom` stand in.
 *
 * A few tests below go beyond the Rust file's own suite, to pin down
 * behaviors that only show up once you write this port in a different
 * language runtime:
 *  - the `writeManifest`/`writeCheckpoint` error-message wrapping (the Rust
 *    side wraps every fs error in a sentence via `map_err`; a naive TS port
 *    can let a raw `Error: ENOENT: ...` escape instead), and
 *  - the "mode set twice" defense in `writeManifest` (ported from
 *    `recent::write_private`'s doc comment: Node's `writeFileSync({mode})`
 *    only applies the mode when it CREATES the file, so a leftover
 *    differently-permissioned temp file needs an unconditional `chmodSync`
 *    on top or it keeps its looser mode across a redeploy).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom, openRoom } from "./open.js";
import {
  checkpointCkPaths,
  checkpointFilePath,
  checkpointIdOk,
  checkpointsDir,
  checkRoomFor,
  formatEpoch,
  freeBytes,
  mtimeTimestamp,
  NOT_A_CHECKPOINT_ID,
  nowDate,
  nowTimestamp,
  performSwap,
  pruneAutoCheckpoints,
  readManifest,
  reconcile,
  roomSizeBytes,
  writeCheckpoint,
  writeManifest,
  type CheckpointManifest,
  type CheckpointMeta,
} from "./checkpoints.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../../../spikes/s1-db-compat/fixtures");
const FIXTURE_PLAIN = path.join(fixturesDir, "plain.roomai");
const FIXTURE_PASSWORD = "correct horse battery staple";

let tmpDir: string;
function tempRoomPath(): string {
  return path.join(tmpDir, `ckpt-test-${Math.random().toString(36).slice(2)}.roomai`);
}
function withFreshTmpDir<T>(fn: () => T): T {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-checkpoints-"));
  return fn();
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// A timestamp the app writes: ISO 8601, UTC, e.g. "2026-08-01T09:14:02Z" —
// ported verbatim from the Rust test's `is_app_timestamp` helper.
function isAppTimestamp(s: string): boolean {
  return s.length === 20 && s[10] === "T" && s.endsWith("Z");
}

describe("formatEpoch / timestamps (port of checkpoint_timestamps_match_every_other_timestamp_in_the_app)", () => {
  it("format_epoch_matches_the_rust_reference_values_exactly", () => {
    // The manifest used to write SQLite's older "YYYY-MM-DD HH:MM:SS", with no
    // Z, so a checkpoint date shown anywhere that didn't carry its own
    // patch-up rendered in the wrong hour. These two values are the Rust
    // test's own reference outputs, not just "looks like an ISO string".
    expect(formatEpoch(0)).toBe("1970-01-01T00:00:00Z");
    expect(formatEpoch(1_700_000_000)).toBe("2023-11-14T22:13:20Z");
  });

  it("now_timestamp_has_the_app_shape", () => {
    expect(isAppTimestamp(nowTimestamp())).toBe(true);
  });

  it("the_date_only_helper_is_unaffected", () => {
    expect(formatEpoch(1_700_000_000).slice(0, 10)).toBe("2023-11-14");
    const today = nowDate();
    expect(today.length).toBe(10);
    expect(today.includes("T")).toBe(false);
  });

  it("matches_the_same_shape_sqlite_itself_stamps_rows_with", () => {
    // The app has no chrono dependency; every DB timestamp comes from
    // `strftime('%Y-%m-%dT%H:%M:%SZ','now')`. Prove this port's format is the
    // SAME shape SQLite itself produces, via a real (unkeyed, in-memory)
    // connection — not just an assertion about our own code.
    const db = new Database(":memory:");
    const row = db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS ts")
      .get() as { ts: string };
    expect(isAppTimestamp(row.ts)).toBe(true);
    db.close();
  });

  it("mtime_timestamp_reads_a_real_files_mtime_and_falls_back_on_a_missing_one", () => {
    withFreshTmpDir(() => {
      const p = path.join(tmpDir, "probe.txt");
      writeFileSync(p, "hi");
      const ts = mtimeTimestamp(p);
      expect(isAppTimestamp(ts)).toBe(true);
      // A path that doesn't exist falls back to now_timestamp() rather than
      // throwing.
      const missing = mtimeTimestamp(path.join(tmpDir, "does-not-exist.txt"));
      expect(isAppTimestamp(missing)).toBe(true);
    });
  });
});

describe("checkpointIdOk / checkpointFilePath (port of a_checkpoint_id_that_escapes_the_checkpoints_folder_is_refused)", () => {
  it("a_real_uuid_shaped_id_is_accepted_and_stays_inside_the_folder", () => {
    const dir = "/tmp/room.checkpoints";
    for (const real of [
      "550e8400-e29b-41d4-a716-446655440000",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    ]) {
      expect(checkpointIdOk(real)).toBe(true);
      expect(checkpointFilePath(dir, real)).toBe(`/tmp/room.checkpoints/${real}.roomck`);
    }
  });

  it("everything_that_could_escape_the_folder_or_isnt_an_id_we_minted_is_refused", () => {
    const dir = "/tmp/room.checkpoints";
    const bad = [
      "../../../Users/someone/Documents/notes",
      "../../etc/passwd",
      "..",
      "sub/dir",
      "a/b",
      "/etc/passwd",
      "id\0trailer",
      "",
      "x".repeat(65),
    ];
    for (const id of bad) {
      expect(checkpointIdOk(id), `accepted ${JSON.stringify(id)}`).toBe(false);
      // And what it WOULD have built is outside the checkpoints folder,
      // which is the whole point of refusing it.
      if (id.includes("/")) {
        expect(checkpointFilePath(dir, id).startsWith(`${dir}/x`), id).toBe(false);
      }
    }
  });

  it("a_64_char_id_is_the_boundary_and_is_accepted", () => {
    expect(checkpointIdOk("x".repeat(64))).toBe(true);
    expect(checkpointIdOk("x".repeat(65))).toBe(false);
  });

  it("not_a_checkpoint_id_message_matches", () => {
    expect(NOT_A_CHECKPOINT_ID).toBe("That isn't a checkpoint of this room.");
  });
});

describe("disk space (port of a_checkpoint_refuses_before_it_fills_the_disk)", () => {
  it("free_bytes_reports_real_free_space_on_this_mac", () => {
    const free = freeBytes(os.tmpdir());
    expect(free).not.toBeNull();
    expect(free as number).toBeGreaterThan(0);
  });

  it("a_copy_that_cannot_possibly_fit_is_refused_in_words_before_any_bytes_are_written", () => {
    const dir = os.tmpdir();
    const free = freeBytes(dir) as number;
    expect(() => checkRoomFor(dir, free + 1, "to save a checkpoint")).toThrowError(
      /Not enough free disk space/
    );
    expect(() => checkRoomFor(dir, free + 1, "to save a checkpoint")).toThrowError(
      /to save a checkpoint/
    );
  });

  it("a_copy_that_fits_goes_ahead", () => {
    const dir = os.tmpdir();
    const free = freeBytes(dir) as number;
    if (free > 2 * 1024 * 1024 * 1024) {
      expect(() => checkRoomFor(dir, 1024, "to save a checkpoint")).not.toThrow();
    }
  });

  it("a_path_that_cannot_be_measured_never_blocks_a_checkpoint_that_would_have_worked", () => {
    expect(freeBytes("/no/such/volume")).toBeNull();
    expect(() => checkRoomFor("/no/such/volume", Number.MAX_SAFE_INTEGER, "to roll back")).not.toThrow();
  });

  it("room_size_bytes_is_the_rooms_own_page_budget", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(x)");
    db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(10_000));
    expect(roomSizeBytes(db)).toBeGreaterThan(0);
    db.close();
  });
});

describe("manifest I/O", () => {
  it("read_manifest_returns_the_default_on_a_missing_file", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "nope.checkpoints");
      const m = readManifest(dir);
      expect(m).toEqual({ v: 1, entries: [] });
    });
  });

  it("read_manifest_returns_the_default_on_invalid_json", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "manifest.json"), "{ not json");
      expect(readManifest(dir)).toEqual({ v: 1, entries: [] });
    });
  });

  it("read_manifest_returns_the_default_on_wrong_shaped_json", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ hello: "world" }));
      expect(readManifest(dir)).toEqual({ v: 1, entries: [] });
    });
  });

  it("read_manifest_returns_the_default_when_an_entry_is_missing_required_fields", () => {
    // A real `serde` `CheckpointManifest` has no `#[serde(default)]` on any
    // field of `CheckpointMeta`, so an entry missing e.g. `sizeBytes` fails
    // to deserialize AT ALL on the Rust side, and the WHOLE manifest reads
    // back as empty — not just that one entry silently missing a field (which
    // is what a shallow "is `entries` an array?" check would let through).
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({ v: 1, entries: [{ id: "x", name: "n" }] })
      );
      expect(readManifest(dir)).toEqual({ v: 1, entries: [] });
    });
  });

  it("manifest_write_is_temp_then_rename_and_leaves_no_tmp_behind", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      const manifest: CheckpointManifest = {
        v: 1,
        entries: [{ id: "x", name: "n", createdAt: nowTimestamp(), sizeBytes: 10, auto: false }],
      };
      writeManifest(dir, manifest);
      expect(existsSync(path.join(dir, "manifest.json"))).toBe(true);
      expect(existsSync(path.join(dir, "manifest.json.tmp"))).toBe(false);
      expect(readManifest(dir).entries.length).toBe(1);
    });
  });

  it("the_manifest_file_is_written_0600_not_the_default_mode", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      writeManifest(dir, { v: 1, entries: [] });
      const mode = statSync(path.join(dir, "manifest.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  it("writeManifest_forces_0600_even_over_a_stale_looser_permissioned_temp_file", () => {
    // Node's `writeFileSync(path, data, {mode})` only applies `mode` when it
    // CREATES the file — if a `.tmp` from an older, differently-permissioned
    // build is already sitting there, the option alone is a no-op and the
    // final manifest.json would inherit the looser mode after the rename.
    // `writeManifest` must `chmodSync` unconditionally on top, mirroring the
    // Rust `recent::write_private` helper's own "set twice on purpose".
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, "manifest.json.tmp");
      writeFileSync(tmp, "stale leftover from an older build", { mode: 0o644 });
      expect(statSync(tmp).mode & 0o777).toBe(0o644);

      writeManifest(dir, { v: 1, entries: [] });

      expect(statSync(path.join(dir, "manifest.json")).mode & 0o777).toBe(0o600);
    });
  });

  it("writeManifest_wraps_a_write_stage_failure_with_the_ruststyle_message", () => {
    withFreshTmpDir(() => {
      // The checkpoints dir never gets created, so the write of
      // `manifest.json.tmp` itself fails (ENOENT) — this is the FIRST
      // `map_err` in the Rust `write_manifest`.
      const dir = path.join(tmpDir, "does-not-exist.checkpoints");
      expect(() => writeManifest(dir, { v: 1, entries: [] })).toThrowError(
        /Could not write the checkpoint manifest:/
      );
    });
  });

  it("writeManifest_wraps_a_rename_stage_failure_with_the_ruststyle_message", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      // Pre-create the rename DESTINATION as a directory, so the write stage
      // succeeds but the file→directory rename fails distinctly — this is
      // the SECOND `map_err` in the Rust `write_manifest`.
      mkdirSync(path.join(dir, "manifest.json"));
      expect(() => writeManifest(dir, { v: 1, entries: [] })).toThrowError(
        /Could not save the checkpoint manifest:/
      );
    });
  });
});

describe("writeCheckpoint + reconcile + performSwap, real fixture room round trip", () => {
  it("writes_a_checkpoint_of_a_real_rust_produced_fixture_and_the_payload_reopens_with_the_same_password", () => {
    withFreshTmpDir(() => {
      // Work on a COPY of the checked-in fixture — openRoom/writeCheckpoint
      // both touch the filesystem beside it (-wal/-shm, the checkpoints dir).
      const roomPath = path.join(tmpDir, "plain-copy.roomai");
      copyFileSync(FIXTURE_PLAIN, roomPath);
      const dir = checkpointsDir(roomPath);

      const db = openRoom(roomPath, FIXTURE_PASSWORD);
      const meta = writeCheckpoint(db, dir, "  my checkpoint  ", false);
      db.close();

      // The name is trimmed.
      expect(meta.name).toBe("my checkpoint");
      expect(meta.auto).toBe(false);
      expect(meta.sizeBytes).toBeGreaterThan(0);
      expect(isAppTimestamp(meta.createdAt)).toBe(true);

      const ckPath = checkpointFilePath(dir, meta.id);
      expect(existsSync(ckPath)).toBe(true);
      // No leftover .tmp beside the final payload.
      expect(existsSync(`${dir}/${meta.id}.tmp`)).toBe(false);

      // The manifest was appended and persisted.
      const manifest = readManifest(dir);
      expect(manifest.entries.map((e) => e.id)).toContain(meta.id);

      // The payload itself is a real, openable copy under the SAME password.
      const reopened = openRoom(ckPath, FIXTURE_PASSWORD);
      const row = reopened.prepare("SELECT value FROM meta WHERE key = 'format'").get() as {
        value: string;
      };
      expect(row.value).toBe("roomai");
      reopened.close();
    });
  });

  it("checkpoint_and_swap_round_trip_restores_the_pre_edit_content", () => {
    // Port of `checkpoint_swap_reopen_restores_old_content`: create room →
    // write a value → checkpoint → mutate the value → swap → reopen with the
    // password → the checkpoint-era value is back.
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      const dir = checkpointsDir(roomPath);
      let ckId: string;

      {
        const db = createRoom(roomPath, FIXTURE_PASSWORD, "Room");
        db.prepare("INSERT INTO meta(key, value) VALUES ('probe', 'original')").run();
        ckId = writeCheckpoint(db, dir, "before edit", false).id;
        db.prepare("UPDATE meta SET value = 'changed' WHERE key = 'probe'").run();
        const row = db.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as {
          value: string;
        };
        expect(row.value).toBe("changed");
        db.close(); // drop the connection so the file can be swapped
      }

      // Simulate a stray -wal/-shm left behind by the live connection —
      // performSwap must clean these up before the swap.
      writeFileSync(`${roomPath}-wal`, "stale-wal");
      writeFileSync(`${roomPath}-shm`, "stale-shm");
      writeFileSync(`${roomPath}-journal`, "stale-journal");

      const ckPath = checkpointFilePath(dir, ckId);
      performSwap(roomPath, ckPath);

      expect(existsSync(`${roomPath}-wal`)).toBe(false);
      expect(existsSync(`${roomPath}-shm`)).toBe(false);
      expect(existsSync(`${roomPath}-journal`)).toBe(false);

      const reopened = openRoom(roomPath, FIXTURE_PASSWORD);
      const row = reopened.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as {
        value: string;
      };
      expect(row.value).toBe("original");
      reopened.close();
    });
  });

  it("performSwap_actually_replaces_the_targets_bytes_with_the_checkpoints", () => {
    withFreshTmpDir(() => {
      const target = path.join(tmpDir, "target.bin");
      const source = path.join(tmpDir, "source.bin");
      writeFileSync(target, "OLD CONTENT");
      writeFileSync(source, "NEW CONTENT FROM CHECKPOINT");
      performSwap(target, source);
      expect(readFileSync(target, "utf8")).toBe("NEW CONTENT FROM CHECKPOINT");
      // The source (checkpoint payload) itself is untouched.
      expect(readFileSync(source, "utf8")).toBe("NEW CONTENT FROM CHECKPOINT");
      // No leftover .swap-* temp file.
      const leftovers = readdirSync(tmpDir).filter((f) => f.includes(".swap-"));
      expect(leftovers).toEqual([]);
    });
  });

  it("performSwap_leaves_no_swap_tmp_file_and_the_original_room_untouched_when_the_copy_fails", () => {
    // The copy-stage failure path: ckPath does not exist, so copyFileSync
    // fails before anything is staged. Confirms the catch's cleanup doesn't
    // itself blow up when there was nothing to clean, AND that the target
    // (the live room file) was never touched.
    withFreshTmpDir(() => {
      const target = path.join(tmpDir, "target.bin");
      writeFileSync(target, "OLD CONTENT");
      const missingSource = path.join(tmpDir, "does-not-exist.roomck");
      expect(() => performSwap(target, missingSource)).toThrowError(
        /Could not stage the rollback copy:/
      );
      expect(readFileSync(target, "utf8")).toBe("OLD CONTENT");
      const leftovers = readdirSync(tmpDir).filter((f) => f.includes(".swap-"));
      expect(leftovers).toEqual([]);
    });
  });

  it("performSwap_cleans_up_the_staged_swap_tmp_file_when_the_final_rename_fails", () => {
    // The rename-stage failure path: the copy to `<room>.swap-<uuid>` DOES
    // succeed here (there is a real staged file on disk to clean up), and
    // then the rename over `roomPath` fails because roomPath is an existing
    // directory rather than a file — renaming a regular file onto a
    // directory always fails (EISDIR). This is the scenario the doc comment
    // on `performSwap` warns about: without cleanup, a room-sized staged
    // copy would be left beside the room on every failed retry.
    withFreshTmpDir(() => {
      const target = path.join(tmpDir, "target-is-a-directory");
      mkdirSync(target);
      const source = path.join(tmpDir, "source.bin");
      writeFileSync(source, "NEW CONTENT FROM CHECKPOINT");

      expect(() => performSwap(target, source)).toThrowError(/Could not swap in the checkpoint:/);

      // The staged copy must not survive the failure.
      const leftovers = readdirSync(tmpDir).filter((f) => f.includes(".swap-"));
      expect(leftovers).toEqual([]);
      // Nothing destructive happened to the (still-a-directory) target.
      expect(statSync(target).isDirectory()).toBe(true);
      // The checkpoint payload itself is untouched.
      expect(readFileSync(source, "utf8")).toBe("NEW CONTENT FROM CHECKPOINT");
    });
  });

  it("a_room_path_containing_a_quote_survives_vacuum_intos_escaping", () => {
    // Port of `checkpoint_path_with_a_quote_survives_vacuum_escaping`: a room
    // path with a single quote (which flows into the checkpoints dir and the
    // .tmp destination passed to `VACUUM INTO '...'`) must not break the
    // escaping.
    withFreshTmpDir(() => {
      const roomPath = path.join(tmpDir, "pr-ro'om.roomai");
      const dir = checkpointsDir(roomPath);
      const db = createRoom(roomPath, FIXTURE_PASSWORD, "Quoted");
      const ckId = writeCheckpoint(db, dir, "cp", false).id;
      db.close();

      const ckPath = checkpointFilePath(dir, ckId);
      const reopened = openRoom(ckPath, FIXTURE_PASSWORD);
      const row = reopened.prepare("SELECT value FROM meta WHERE key = 'name'").get() as {
        value: string;
      };
      expect(row.value).toBe("Quoted");
      reopened.close();
    });
  });

  it("writeCheckpoint_wraps_a_directory_creation_failure_with_a_descriptive_message", () => {
    // Block the checkpoints dir from ever being created by putting a PLAIN
    // FILE at that exact path first — `mkdirSync(dir, {recursive:true})` then
    // fails, and the raw Node error must not escape unwrapped.
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      const dir = checkpointsDir(roomPath);
      writeFileSync(dir, "not a directory");
      const db = createRoom(roomPath, FIXTURE_PASSWORD, "Room");
      expect(() => writeCheckpoint(db, dir, "x", false)).toThrowError(
        /Could not create the checkpoints folder:/
      );
      db.close();
    });
  });
});

describe("reconcile", () => {
  it("drops_a_manifest_entry_whose_payload_was_hand_deleted_and_refreshes_survivor_sizes", () => {
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      const dir = checkpointsDir(roomPath);
      const db = createRoom(roomPath, FIXTURE_PASSWORD, "Room");
      const keepId = writeCheckpoint(db, dir, "keep", false).id;
      const goneId = writeCheckpoint(db, dir, "gone", false).id;
      db.close();

      expect(readManifest(dir).entries.length).toBe(2);
      // Hand-delete one payload, as if removed in Finder.
      const goneStat = statSync(checkpointFilePath(dir, goneId));
      expect(goneStat.size).toBeGreaterThan(0);
      rmSync(checkpointFilePath(dir, goneId));

      const manifest = reconcile(dir);
      expect(manifest.entries.map((e) => e.id)).toEqual([keepId]);
      expect(manifest.entries[0]?.sizeBytes).toBeGreaterThan(0);
      // The heal was persisted too.
      expect(readManifest(dir).entries.map((e) => e.id)).toEqual([keepId]);
    });
  });

  it("adopts_an_orphan_payload_with_no_manifest_entry", () => {
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      const dir = checkpointsDir(roomPath);
      const db = createRoom(roomPath, FIXTURE_PASSWORD, "Room");
      // A real copy, then rip its entry out of the manifest to simulate a
      // crash between the tmp→final rename and the manifest append.
      const orphanId = writeCheckpoint(db, dir, "orphaned", false).id;
      db.close();

      writeManifest(dir, { v: 1, entries: [] });
      const healed = reconcile(dir);
      expect(healed.entries.length).toBe(1);
      expect(healed.entries[0]?.id).toBe(orphanId);
      expect(healed.entries[0]?.name).toBe("Recovered checkpoint");
      expect(healed.entries[0]?.auto).toBe(false);
      expect(healed.entries[0]?.sizeBytes).toBeGreaterThan(0);
      expect(isAppTimestamp(healed.entries[0]?.createdAt ?? "")).toBe(true);
      // Persisted, not just returned.
      expect(readManifest(dir).entries.map((e) => e.id)).toEqual([orphanId]);
    });
  });

  it("dedupes_entries_by_id_keeping_the_first", () => {
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      const dir = checkpointsDir(roomPath);
      const db = createRoom(roomPath, FIXTURE_PASSWORD, "Room");
      const id = writeCheckpoint(db, dir, "first", false).id;
      db.close();

      const manifest = readManifest(dir);
      const dupedEntry: CheckpointMeta = { ...manifest.entries[0]!, name: "duplicate" };
      writeManifest(dir, { v: 1, entries: [manifest.entries[0]!, dupedEntry] });

      const healed = reconcile(dir);
      expect(healed.entries.length).toBe(1);
      expect(healed.entries[0]?.id).toBe(id);
      expect(healed.entries[0]?.name).toBe("first");
    });
  });

  it("sweeps_stale_tmp_files_left_by_a_crash_mid_vacuum", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/dead-beef.tmp`, "torn payload");
      reconcile(dir);
      expect(existsSync(`${dir}/dead-beef.tmp`)).toBe(false);
    });
  });

  it("checkpoint_ck_paths_is_empty_when_the_checkpoints_dir_does_not_exist", () => {
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      expect(checkpointCkPaths(roomPath)).toEqual([]);
    });
  });

  it("checkpoint_ck_paths_lists_every_payload_via_reconcile", () => {
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      const dir = checkpointsDir(roomPath);
      const db = createRoom(roomPath, FIXTURE_PASSWORD, "Room");
      const id1 = writeCheckpoint(db, dir, "one", false).id;
      const id2 = writeCheckpoint(db, dir, "two", false).id;
      db.close();
      const paths = checkpointCkPaths(roomPath).sort();
      expect(paths).toEqual([checkpointFilePath(dir, id1), checkpointFilePath(dir, id2)].sort());
    });
  });
});

describe("pruneAutoCheckpoints", () => {
  it("keeps_exactly_n_newest_auto_entries_and_leaves_non_auto_entries_untouched", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });

      // Five auto entries at five distinct times (oldest → newest), plus two
      // non-auto entries — all with real dummy payload files so `reconcile`
      // (which prune runs first) doesn't drop them as missing.
      const entries: CheckpointMeta[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `auto-${i}`;
        writeFileSync(checkpointFilePath(dir, id), `payload-${i}`);
        entries.push({
          id,
          name: `auto ${i}`,
          createdAt: formatEpoch(1_700_000_000 + i * 3600),
          sizeBytes: 1,
          auto: true,
        });
      }
      for (const id of ["manual-a", "manual-b"]) {
        writeFileSync(checkpointFilePath(dir, id), "manual payload");
        entries.push({ id, name: id, createdAt: formatEpoch(1_700_000_000), sizeBytes: 1, auto: false });
      }
      writeManifest(dir, { v: 1, entries });

      pruneAutoCheckpoints(dir, 3);

      const survivors = readManifest(dir).entries;
      const survivingAutoIds = survivors.filter((e) => e.auto).map((e) => e.id).sort();
      // Newest 3 of auto-0..auto-4 are auto-2, auto-3, auto-4.
      expect(survivingAutoIds).toEqual(["auto-2", "auto-3", "auto-4"]);
      // The pruned autos' payload files are gone too.
      expect(existsSync(checkpointFilePath(dir, "auto-0"))).toBe(false);
      expect(existsSync(checkpointFilePath(dir, "auto-1"))).toBe(false);
      expect(existsSync(checkpointFilePath(dir, "auto-2"))).toBe(true);

      // Non-auto entries are completely untouched, regardless of count/age.
      const survivingManualIds = survivors.filter((e) => !e.auto).map((e) => e.id).sort();
      expect(survivingManualIds).toEqual(["manual-a", "manual-b"]);
      expect(existsSync(checkpointFilePath(dir, "manual-a"))).toBe(true);
      expect(existsSync(checkpointFilePath(dir, "manual-b"))).toBe(true);
    });
  });

  it("does_nothing_when_auto_count_is_already_at_or_under_the_cap", () => {
    withFreshTmpDir(() => {
      const dir = path.join(tmpDir, "room.checkpoints");
      mkdirSync(dir, { recursive: true });
      writeFileSync(checkpointFilePath(dir, "auto-only"), "payload");
      writeManifest(dir, {
        v: 1,
        entries: [{ id: "auto-only", name: "a", createdAt: nowTimestamp(), sizeBytes: 1, auto: true }],
      });
      pruneAutoCheckpoints(dir, 3);
      expect(readManifest(dir).entries.length).toBe(1);
      expect(existsSync(checkpointFilePath(dir, "auto-only"))).toBe(true);
    });
  });
});
