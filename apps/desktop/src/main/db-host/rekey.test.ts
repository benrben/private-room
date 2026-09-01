/**
 * Vitest port of the `versions.rs` tests that cover `verify_password`/
 * `rekey`/`rekey_copy` (`src-tauri/src/db/versions.rs` lines 155-185, plus the
 * `mod tests` cases that exercise them):
 *
 *   - all_four_open_paths_pin_the_cipher_parameters (db/versions.rs)
 *   - change_password_rekeys_checkpoints /
 *     a_checkpoint_that_missed_the_rekey_is_reported_not_silently_stranded
 *     (commands/safety.rs — ported here for the `verify_password`/
 *     `rekey_copy` round trip they exercise, minus the checkpoint-file
 *     bookkeeping which belongs to that module's own future port)
 *
 * Plus: the walk-up-attacker safety property in prose (a fresh connection to
 * a COPY never touches the caller's already-open live connection), the
 * quote-escaping the `rekey` pragma needs (mirroring `applyKey`'s), a real
 * Rust-produced fixture (`rekeyed.roomai`), and that a throwaway connection
 * is always closed — proven by
 * retrying immediately after a failure rather than hitting a stale lock.
 *
 * As of the `commands/safety.rs` batch, this file also covers
 * `reclaimableBytes`/`vacuum`/`vacuumInto` (`db/versions.rs` lines 399-433) —
 * see this file's own module doc on why they landed here.
 */

import Database from "better-sqlite3-multiple-ciphers";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoom, openRoom } from "./open.js";
import { insertFile, deleteFile } from "./files.js";
import { reclaimableBytes, rekey, rekeyCopy, vacuum, vacuumInto, verifyPassword } from "./rekey.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, "../../../../../tests/fixtures/sqlcipher");
const FIXTURE_REKEYED = path.join(fixturesDir, "rekeyed.roomai");

// A unique throwaway room path in a fresh temp dir per test.
let tmpDir: string;
function tempRoomPath(): string {
  return path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function withFreshTmpDir<T>(fn: () => T): T {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-rekey-"));
  return fn();
}

describe("verifyPassword", () => {
  it("succeeds_on_the_right_password_and_fails_cleanly_on_the_wrong_one", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      createRoom(p, "correct horse battery staple", "Room").close();

      expect(() => verifyPassword(p, "correct horse battery staple")).not.toThrow();
      expect(() => verifyPassword(p, "not-the-password")).toThrow(
        "The current password is not correct."
      );
    });
  });

  it("uses_a_fresh_connection_not_the_caller_s_live_one", () => {
    // The whole point of verifyPassword taking a PATH (not a Database) is
    // that it never touches an already-open handle. Prove the live
    // connection keeps working, untouched, across a verifyPassword call —
    // success and failure both — against the very same file.
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const live = createRoom(p, "the-live-password", "Room");
      live.prepare("INSERT INTO meta(key, value) VALUES ('probe', 'kept')").run();

      expect(() => verifyPassword(p, "the-live-password")).not.toThrow();
      expect(() => verifyPassword(p, "wrong")).toThrow();

      // The live connection is still open and still itself.
      const probe = live.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as
        | { value: string }
        | undefined;
      expect(probe?.value).toBe("kept");
      live.prepare("INSERT INTO meta(key, value) VALUES ('probe2', 'still-open')").run();
      live.close();
    });
  });

  it("a_failed_verify_does_not_leave_the_file_locked_for_the_next_attempt", () => {
    // The throwaway connection must close on the failure path too, or a
    // wrong password on attempt 1 would strand the file for attempt 2.
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      createRoom(p, "correct horse battery staple", "Room").close();

      expect(() => verifyPassword(p, "nope")).toThrow();
      // Immediately usable again, with the real password.
      expect(() => verifyPassword(p, "correct horse battery staple")).not.toThrow();
      const reopened = openRoom(p, "correct horse battery staple");
      reopened.close();
    });
  });

  it("verifies_against_a_real_rust_produced_fixture", () => {
    expect(existsSync(FIXTURE_REKEYED)).toBe(true);
    // rekeyed.roomai was created, then rekeyed, entirely on the Rust side
    // The old password must no longer work and the
    // post-rekey password must.
    expect(() => verifyPassword(FIXTURE_REKEYED, "original password 1")).toThrow(
      "The current password is not correct."
    );
    expect(() => verifyPassword(FIXTURE_REKEYED, "new password 2!!")).not.toThrow();
  });
});

describe("throwaway connection cleanup", () => {
  it("does not turn a close failure into a failed password verification or copy rekey", () => {
    withFreshTmpDir(() => {
      const roomPath = tempRoomPath();
      const db = createRoom(roomPath, "the-password", "Room");
      db.close();
      const copyPath = path.join(tmpDir, "copy.roomai");
      copyFileSync(roomPath, copyPath);
      const realClose = Database.prototype.close;
      const close = vi.spyOn(Database.prototype, "close").mockImplementation(function () {
        realClose.call(this);
        throw new Error("fabricated close failure after close");
      });
      try {
        expect(() => verifyPassword(roomPath, "the-password")).not.toThrow();
        expect(() => rekeyCopy(copyPath, "the-password", "new-password")).not.toThrow();
      } finally {
        close.mockRestore();
      }
      const reopened = openRoom(copyPath, "new-password");
      reopened.close();
    });
  });
});

describe("rekey (already-open connection)", () => {
  it("rekeys_an_open_connection_then_a_fresh_open_with_the_new_password_succeeds_and_the_old_fails", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "old-password", "Room");
      db.prepare("INSERT INTO meta(key, value) VALUES ('probe', 'kept')").run();

      rekey(db, "new-password-xx");
      db.close();

      const reopened = openRoom(p, "new-password-xx");
      const probe = reopened.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as
        | { value: string }
        | undefined;
      expect(probe?.value).toBe("kept");
      reopened.close();

      expect(() => openRoom(p, "old-password")).toThrow("WRONG_PASSWORD");
    });
  });

  it("doubles_single_quotes_in_the_new_password_exactly_like_applyKey_does", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "old-password", "Room");
      const trickyPassword = "it's a trap' -- ";

      rekey(db, trickyPassword);
      db.close();

      const reopened = openRoom(p, trickyPassword);
      reopened.close();
      expect(() => openRoom(p, "it is NOT a trap")).toThrow("WRONG_PASSWORD");
    });
  });
});

describe("rekeyCopy", () => {
  it("changes_a_copy_s_password_without_affecting_the_original", () => {
    // Ported from versions.rs all_four_open_paths_pin_the_cipher_parameters.
    withFreshTmpDir(() => {
      const original = tempRoomPath();
      createRoom(original, "the-password", "Pinned").close();

      const copy = `${original}.copy`;
      copyFileSync(original, copy);

      rekeyCopy(copy, "the-password", "another-password");

      // The original is untouched: still opens with its old password only.
      expect(() => verifyPassword(original, "the-password")).not.toThrow();
      expect(() => verifyPassword(original, "another-password")).toThrow();

      // The copy opens ONLY with the new password, on the ordinary open path
      // (proving rekeyCopy's pragma set matches what openRoom expects).
      expect(() => openRoom(copy, "the-password")).toThrow("WRONG_PASSWORD");
      const reopened = openRoom(copy, "another-password");
      const name = reopened.prepare("SELECT value FROM meta WHERE key = 'name'").get() as
        | { value: string }
        | undefined;
      expect(name?.value).toBe("Pinned");
      reopened.close();
    });
  });

  it("throws_the_right_message_when_the_current_password_is_wrong", () => {
    withFreshTmpDir(() => {
      const original = tempRoomPath();
      createRoom(original, "the-password", "Room").close();
      const copy = `${original}.copy`;
      copyFileSync(original, copy);

      expect(() => rekeyCopy(copy, "wrong-current-password", "new-password")).toThrow(
        "Could not open the copied room to set its password."
      );
      // The copy is unchanged — the original password still opens it.
      const reopened = openRoom(copy, "the-password");
      reopened.close();
    });
  });

  it("a_failed_rekeyCopy_does_not_leave_the_file_locked_for_a_retry_with_the_right_password", () => {
    withFreshTmpDir(() => {
      const original = tempRoomPath();
      createRoom(original, "the-password", "Room").close();
      const copy = `${original}.copy`;
      copyFileSync(original, copy);

      expect(() => rekeyCopy(copy, "wrong", "new-password")).toThrow();
      // Retry, this time with the right current password — must not be
      // blocked by a stale handle/lock the failed attempt left behind.
      expect(() => rekeyCopy(copy, "the-password", "new-password")).not.toThrow();
      const reopened = openRoom(copy, "new-password");
      reopened.close();
    });
  });

  it("supports_a_quote_containing_new_password", () => {
    withFreshTmpDir(() => {
      const original = tempRoomPath();
      createRoom(original, "the-password", "Room").close();
      const copy = `${original}.copy`;
      copyFileSync(original, copy);

      const trickyPassword = "it's a trap' -- ";
      rekeyCopy(copy, "the-password", trickyPassword);

      const reopened = openRoom(copy, trickyPassword);
      reopened.close();
      expect(() => openRoom(copy, "the-password")).toThrow("WRONG_PASSWORD");
    });
  });

  it("does_not_touch_the_live_connection_to_a_different_path_ie_the_walk_up_attacker_property", () => {
    // The safety property the module doc describes in prose: rekeyCopy opens
    // its OWN fresh connection to `path`. A live, already-open connection to
    // a DIFFERENT file (standing in for "the app's currently-open room")
    // must be completely unaffected by re-keying a copy.
    withFreshTmpDir(() => {
      const original = tempRoomPath();
      const live = createRoom(original, "the-live-password", "Live Room");
      live.prepare("INSERT INTO meta(key, value) VALUES ('probe', 'kept')").run();

      const copy = `${original}.copy`;
      copyFileSync(original, copy);
      rekeyCopy(copy, "the-live-password", "another-password");

      // The live connection is still keyed with its original password and
      // still fully usable — rekeyCopy never reached it.
      const probe = live.prepare("SELECT value FROM meta WHERE key = 'probe'").get() as
        | { value: string }
        | undefined;
      expect(probe?.value).toBe("kept");
      live.prepare("INSERT INTO meta(key, value) VALUES ('probe2', 'still-open')").run();
      live.close();

      const reopenedOriginal = openRoom(original, "the-live-password");
      reopenedOriginal.close();
    });
  });
});

describe("reclaimableBytes / vacuum", () => {
  it("a freshly created room has nothing worth reclaiming", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "the-password", "Room");
      expect(reclaimableBytes(db)).toBe(0);
      db.close();
    });
  });

  it("deleting a large blob frees pages that vacuum reclaims", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "the-password", "Room");
      const big = Buffer.alloc(2 * 1024 * 1024, 7);
      const id = insertFile(db, "big.bin", "application/octet-stream", big, null, "upload").id;
      deleteFile(db, id);

      const reclaimable = reclaimableBytes(db);
      expect(reclaimable).toBeGreaterThan(0);

      const sizeBefore = db.pragma("page_count", { simple: true }) as number;
      vacuum(db);
      const sizeAfter = db.pragma("page_count", { simple: true }) as number;
      expect(sizeAfter).toBeLessThan(sizeBefore);
      expect(reclaimableBytes(db)).toBe(0);
      db.close();
    });
  });
});

describe("vacuumInto", () => {
  it("writes a consistent copy at the SAME key, leaving the original untouched", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "the-password", "Pinned");
      insertFile(db, "a.txt", "text/plain", Buffer.from("hi", "utf8"), "hi", "upload");

      const dest = `${p}.dup`;
      vacuumInto(db, dest);
      db.close();

      expect(existsSync(dest)).toBe(true);
      const copy = openRoom(dest, "the-password");
      const row = copy.prepare("SELECT value FROM meta WHERE key = 'name'").get() as
        | { value: string }
        | undefined;
      expect(row?.value).toBe("Pinned");
      copy.close();

      // The original still opens with its own password, unaffected.
      expect(() => openRoom(p, "the-password").close()).not.toThrow();
    });
  });

  it("single-quote-escapes the destination path, matching the rekey pragma's own escaping", () => {
    withFreshTmpDir(() => {
      const p = tempRoomPath();
      const db = createRoom(p, "the-password", "Room");
      const dest = path.join(tmpDir, "it's a room.roomai");
      expect(() => vacuumInto(db, dest)).not.toThrow();
      expect(existsSync(dest)).toBe(true);
      db.close();
    });
  });
});
