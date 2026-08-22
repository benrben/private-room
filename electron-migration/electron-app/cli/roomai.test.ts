/**
 * Vitest port of the `roomai.rs` tests (`mod tests` in
 * `src-tauri/src/bin/roomai.rs`):
 *
 *   - no_args_is_help
 *   - help_word_and_flags_are_help
 *   - unknown_command_is_rejected
 *   - verify_requires_a_path
 *   - a_secret_on_the_command_line_is_refused_by_name
 *   - verify_takes_only_a_path
 *   - info_parses
 *   - recover_takes_only_a_path
 *   - export_needs_two_positionals
 *   - unknown_flag_is_rejected
 *   - a_bare_secret_flag_errors_too
 *   - sanitize_strips_path_traversal
 *   - unique_name_disambiguates_collisions
 *   - unique_name_steps_past_preexisting_names
 *   - unique_name_is_case_insensitive
 *
 * Plus real (non-mocked) integration tests for doVerify/doInfo/doRecover/
 * doExport against fixture rooms created through the sibling `open.ts`'s
 * `createRoom`, with files inserted via raw SQL — including two regression
 * tests for divergences found while judging two independent ports against
 * each other and the Rust source (see the final report): the blank line
 * `print_meta_dump`'s `println!("\nMeta:")` puts between the OK banner and
 * "Meta:", and the "Could not create/read/write ..." wrapped error messages
 * `do_export` produces on a filesystem failure.
 */

import * as fsp from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRoom } from "../electron/main/db-host/open.js";
import { writeRecovery } from "../electron/main/db-host/recovery.js";
import {
  type Command,
  doExport,
  doInfo,
  doRecover,
  doVerify,
  parseArgs,
  resolveCode,
  resolvePassword,
  sanitize,
  uniqueName,
  USAGE,
} from "./roomai.js";

// --------------------------------------------------------------- fixtures

const ROOM_PASSWORD = "correct horse battery staple";

let tmpDir: string;
function tempRoomPath(): string {
  return path.join(tmpDir, `roomai-test-${Math.random().toString(36).slice(2)}.roomai`);
}

async function withFreshTmpDir<T>(fn: () => Promise<T>): Promise<T> {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "roomai-cli-"));
  return fn();
}

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/** Temporarily set/unset env vars, restoring whatever was there before. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    const v = vars[key];
    if (v === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = v;
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const prev = previous[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

// ----------------------------------------------------------------- parsing

describe("parseArgs", () => {
  it("no_args_is_help", () => {
    expect(parseArgs([])).toEqual<Command>({ kind: "help" });
  });

  it("help_word_and_flags_are_help", () => {
    expect(parseArgs(["help"])).toEqual<Command>({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual<Command>({ kind: "help" });
    expect(parseArgs(["--help"])).toEqual<Command>({ kind: "help" });
  });

  it("unknown_command_is_rejected", () => {
    expect(() => parseArgs(["frobnicate", "room.room"])).toThrow();
  });

  it("verify_requires_a_path", () => {
    expect(() => parseArgs(["verify"])).toThrow();
  });

  // A room password on the command line is readable by every other process
  // running as you (`ps -ww`), and lands in shell history. The flag that
  // accepted one is refused BY NAME in every position, with a message that
  // says where to put the secret instead — an old script must not fail with
  // a bare "Unknown flag" and must certainly not silently keep working.
  it("a_secret_on_the_command_line_is_refused_by_name", () => {
    const cases: string[][] = [
      ["verify", "room.room", "--password", "hunter2"],
      ["verify", "--password", "hunter2", "room.room"],
      ["info", "room.room", "--password", "hunter2"],
      ["export", "room.room", "out", "--password", "hunter2"],
      ["recover", "room.room", "--code", "AAAA-BBBB"],
    ];
    for (const args of cases) {
      let caught: unknown;
      try {
        parseArgs(args);
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected an error for ${JSON.stringify(args)}`).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      expect(
        msg.includes("ROOMAI_PASSWORD") || msg.includes("ROOMAI_RECOVERY"),
        msg
      ).toBe(true);
    }
  });

  it("verify_takes_only_a_path", () => {
    expect(parseArgs(["verify", "room.room"])).toEqual<Command>({
      kind: "verify",
      path: "room.room",
    });
  });

  it("info_parses", () => {
    expect(parseArgs(["info", "room.room"])).toEqual<Command>({
      kind: "info",
      path: "room.room",
    });
  });

  it("recover_takes_only_a_path", () => {
    expect(parseArgs(["recover", "room.room"])).toEqual<Command>({
      kind: "recover",
      path: "room.room",
    });
  });

  it("export_needs_two_positionals", () => {
    expect(() => parseArgs(["export", "room.room"])).toThrow();
    expect(() => parseArgs(["export", "room.room", "out", "extra"])).toThrow();
    expect(parseArgs(["export", "room.room", "out"])).toEqual<Command>({
      kind: "export",
      path: "room.room",
      outdir: "out",
    });
  });

  it("unknown_flag_is_rejected", () => {
    expect(() => parseArgs(["verify", "room.room", "--nope"])).toThrow();
    expect(() => parseArgs(["verify", "--passwrod", "x", "room.room"])).toThrow();
  });

  it("a_bare_secret_flag_errors_too", () => {
    // No value to take, so this must not fall through to "<path>".
    expect(() => parseArgs(["verify", "room.room", "--password"])).toThrow();
  });
});

describe("USAGE", () => {
  it("mentions every subcommand and both env vars", () => {
    for (const token of ["verify", "info", "recover", "export", "ROOMAI_PASSWORD", "ROOMAI_RECOVERY"]) {
      expect(USAGE).toContain(token);
    }
  });
});

// ---------------------------------------------------------------- sanitize

describe("sanitize", () => {
  it("sanitize_strips_path_traversal", () => {
    expect(sanitize("../../etc/passwd")).toBe("passwd");
    expect(sanitize("a/b/c.txt")).toBe("c.txt");
    expect(sanitize("plain.pdf")).toBe("plain.pdf");
    expect(sanitize("")).toBe("unnamed");
    expect(sanitize("   ")).toBe("unnamed");
    expect(sanitize("..")).toBe("unnamed");
  });
});

describe("uniqueName", () => {
  it("unique_name_disambiguates_collisions", () => {
    const used = new Set<string>();
    expect(uniqueName(used, "a.txt")).toBe("a.txt");
    expect(uniqueName(used, "a.txt")).toBe("a (2).txt");
    expect(uniqueName(used, "a.txt")).toBe("a (3).txt");
    expect(uniqueName(used, "noext")).toBe("noext");
    expect(uniqueName(used, "noext")).toBe("noext (2)");
  });

  it("unique_name_steps_past_preexisting_names", () => {
    // Names seeded from the destination directory must not be reused.
    const used = new Set<string>();
    used.add("report.pdf");
    expect(uniqueName(used, "report.pdf")).toBe("report (2).pdf");
  });

  it("unique_name_is_case_insensitive", () => {
    // APFS is case-insensitive by default: "Report.pdf" would clobber a
    // pre-existing "report.pdf". Keys are compared lowercased, but the
    // returned name keeps the caller's case.
    const used = new Set<string>();
    used.add("report.pdf"); // seeded (already lowercased)
    expect(uniqueName(used, "Report.pdf")).toBe("Report (2).pdf");
    expect(uniqueName(used, "REPORT.PDF")).toBe("REPORT (3).PDF");
    expect(uniqueName(used, "Fresh.pdf")).toBe("Fresh.pdf");
    expect(uniqueName(used, "fresh.pdf")).toBe("fresh (2).pdf");
  });
});

// --------------------------------------------------------------- secrets

describe("resolvePassword / resolveCode", () => {
  it("throws the exact no-password message when ROOMAI_PASSWORD is unset or empty", async () => {
    await withEnv({ ROOMAI_PASSWORD: undefined }, async () => {
      await expect(resolvePassword()).rejects.toThrow(
        "No password. Set ROOMAI_PASSWORD (never pass it as an argument — other programs on this Mac can read a process's arguments)."
      );
    });
    await withEnv({ ROOMAI_PASSWORD: "" }, async () => {
      await expect(resolvePassword()).rejects.toThrow("No password. Set ROOMAI_PASSWORD");
    });
  });

  it("returns the password when set", async () => {
    await withEnv({ ROOMAI_PASSWORD: "hunter2" }, async () => {
      await expect(resolvePassword()).resolves.toBe("hunter2");
    });
  });

  it("throws the exact no-code message when ROOMAI_RECOVERY is unset or empty", async () => {
    await withEnv({ ROOMAI_RECOVERY: undefined }, async () => {
      await expect(resolveCode()).rejects.toThrow(
        "No recovery code. Set ROOMAI_RECOVERY (never pass it as an argument — other programs on this Mac can read a process's arguments)."
      );
    });
  });

  it("returns the code when set", async () => {
    await withEnv({ ROOMAI_RECOVERY: "AAAA-BBBB" }, async () => {
      await expect(resolveCode()).resolves.toBe("AAAA-BBBB");
    });
  });
});

// --------------------------------------------------------- integration: db

describe("doVerify (real fixture room)", () => {
  it("returns the OK banner with counts from a real room", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      const db = createRoom(roomPath, ROOM_PASSWORD, "Test Room");
      db.prepare("INSERT INTO chats (id, title) VALUES ('c1', 'Chat One')").run();
      db.close();

      const output = await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, () => doVerify(roomPath));
      expect(output).toContain("OK: decrypts and is a valid Arcelle file.");
      expect(output).toContain("format:         roomai");
      expect(output).toContain("format_version: 1");
      expect(output).toContain("files:          0");
      expect(output).toContain("chats:          1");
    });
  });

  it("propagates the no-password error without touching the filesystem again", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();

      await withEnv({ ROOMAI_PASSWORD: undefined }, async () => {
        await expect(doVerify(roomPath)).rejects.toThrow("No password. Set ROOMAI_PASSWORD");
      });
    });
  });

  it("rejects a wrong password cleanly with WRONG_PASSWORD", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();

      await withEnv({ ROOMAI_PASSWORD: "definitely wrong" }, async () => {
        await expect(doVerify(roomPath)).rejects.toThrow("WRONG_PASSWORD");
      });
    });
  });
});

describe("doInfo (real fixture room)", () => {
  it("includes the OK banner plus the meta dump, unset keys shown as (not set)", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();

      const output = await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, () => doInfo(roomPath));
      expect(output).toContain("OK: decrypts and is a valid Arcelle file.");
      expect(output).toContain("Meta:");
      expect(output).toContain("  format: roomai");
      expect(output).toContain("  format_version: 1");
      expect(output).toContain("  name: Test Room");
      expect(output).toContain("  embed_model: (not set)");
      expect(output).toContain("  embed_dim: (not set)");
    });
  });

  // Regression test: Rust's `print_meta_dump` starts with `println!("\nMeta:")`,
  // so a BLANK LINE separates the OK banner from the "Meta:" section — a
  // detail one of the two candidate ports dropped by concatenating the two
  // blocks with no separator. Pin the exact shape here.
  it("puts a blank line between the OK banner and the Meta: section", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();

      const output = await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, () => doInfo(roomPath));
      expect(output).toContain("chats:          0\n\nMeta:");
    });
  });
});

describe("doRecover (real fixture room + real recovery sidecar)", () => {
  it("opens the room via a recovery code and returns the same OK banner", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();
      const code = await writeRecovery(roomPath, ROOM_PASSWORD);

      const output = await withEnv({ ROOMAI_RECOVERY: code }, () => doRecover(roomPath));
      expect(output).toContain("OK: decrypts and is a valid Arcelle file.");
      expect(output).toContain("format:         roomai");
    });
  });

  it("rejects a wrong recovery code without crashing", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();
      await writeRecovery(roomPath, ROOM_PASSWORD);

      await withEnv({ ROOMAI_RECOVERY: "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ" }, async () => {
        await expect(doRecover(roomPath)).rejects.toThrow("That recovery code is not correct.");
      });
    });
  });

  it("propagates the no-code error when ROOMAI_RECOVERY is unset", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();

      await withEnv({ ROOMAI_RECOVERY: undefined }, async () => {
        await expect(doRecover(roomPath)).rejects.toThrow("No recovery code. Set ROOMAI_RECOVERY");
      });
    });
  });
});

describe("doExport (real fixture room, round trip through the real filesystem)", () => {
  it("writes non-trashed files with sanitized, deduped names and skips byteless rows", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      const db = createRoom(roomPath, ROOM_PASSWORD, "Test Room");
      const insert = db.prepare(
        "INSERT INTO files (id, name, original_bytes, trashed_at) VALUES (?, ?, ?, ?)"
      );
      // Ordinary file.
      insert.run("f1", "hello.txt", Buffer.from("hello world"), null);
      // Path-traversal name: sanitize() must reduce it to its final component,
      // which then collides with a name already sitting in outdir.
      insert.run("f2", "../../etc/passwd", Buffer.from("sneaky bytes"), null);
      // Trashed: must be excluded entirely, never reach the output folder.
      insert.run("f3", "trashed.txt", Buffer.from("should not appear"), "2020-01-01T00:00:00Z");
      // No stored bytes (e.g. an app-generated note): counted as skipped, no
      // file written for it.
      insert.run("f4", "no-bytes.txt", null, null);
      db.close();

      const outdir = path.join(tmpDir, "out");
      await fsp.mkdir(outdir, { recursive: true });
      // Pre-existing file in the destination: uniqueName must step past it
      // rather than clobber it (and it is seeded case-insensitively).
      await fsp.writeFile(path.join(outdir, "passwd"), "pre-existing");

      const summary = await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, () =>
        doExport(roomPath, outdir)
      );

      expect(summary).toContain("Wrote 2 file(s) to");
      expect(summary).toContain("Skipped 1 row(s) with no stored bytes.");

      const entries = (await fsp.readdir(outdir)).sort();
      expect(entries).toEqual(["hello.txt", "passwd", "passwd (2)"].sort());

      expect((await fsp.readFile(path.join(outdir, "hello.txt"))).toString("utf8")).toBe(
        "hello world"
      );
      expect((await fsp.readFile(path.join(outdir, "passwd (2)"))).toString("utf8")).toBe(
        "sneaky bytes"
      );
      // Untouched pre-existing file.
      expect((await fsp.readFile(path.join(outdir, "passwd"))).toString("utf8")).toBe(
        "pre-existing"
      );
      // Trashed file never reached disk under any name.
      const allContents = await Promise.all(
        entries.map((name) => fsp.readFile(path.join(outdir, name), "utf8"))
      );
      expect(allContents.some((c) => c.includes("should not appear"))).toBe(false);
    });
  });

  it("creates outdir recursively when it does not exist yet", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      const db = createRoom(roomPath, ROOM_PASSWORD, "Test Room");
      db.prepare(
        "INSERT INTO files (id, name, original_bytes, trashed_at) VALUES (?, ?, ?, ?)"
      ).run("f1", "a.txt", Buffer.from("A"), null);
      db.close();

      const outdir = path.join(tmpDir, "nested", "does", "not", "exist");
      const summary = await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, () =>
        doExport(roomPath, outdir)
      );
      expect(summary).toContain("Wrote 1 file(s) to");
      expect((await fsp.readFile(path.join(outdir, "a.txt"))).toString("utf8")).toBe("A");
    });
  });

  it("reports zero written and no skipped line when the room has no files", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Empty Room").close();

      const outdir = path.join(tmpDir, "out-empty");
      const summary = await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, () =>
        doExport(roomPath, outdir)
      );
      expect(summary).toBe(`Wrote 0 file(s) to ${outdir}.`);
      expect(summary).not.toContain("Skipped");
    });
  });

  it("dedupes against a pre-existing name case-insensitively", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      const db = createRoom(roomPath, ROOM_PASSWORD, "Collide");
      db.prepare(
        "INSERT INTO files (id, name, original_bytes, trashed_at) VALUES (?, ?, ?, ?)"
      ).run("f1", "Report.pdf", Buffer.from("new bytes"), null);
      db.close();

      const outdir = path.join(tmpDir, "out2");
      await fsp.mkdir(outdir, { recursive: true });
      writeFileSync(path.join(outdir, "report.pdf"), "preexisting");

      const summary = await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, () =>
        doExport(roomPath, outdir)
      );
      expect(summary).toBe(`Wrote 1 file(s) to ${outdir}.`);

      const written = new Set(await fsp.readdir(outdir));
      expect(written).toEqual(new Set(["report.pdf", "Report (2).pdf"]));
      expect(readFileSync(path.join(outdir, "report.pdf"), "utf8")).toBe("preexisting");
      expect(readFileSync(path.join(outdir, "Report (2).pdf"), "utf8")).toBe("new bytes");
    });
  });

  // Regression test: Rust's `do_export` wraps every filesystem failure with
  // a friendly "Could not create/read/write <path>: <cause>" message
  // (`.map_err(...)` on create_dir_all / read_dir / write). One of the two
  // candidate ports dropped that wrapping entirely, which would have leaked
  // a raw Node error straight to the user on a real failure (permission
  // denied, disk full, read-only volume, ...). Force a real mkdir failure
  // (a plain FILE already sitting where outdir should be, so recursive
  // mkdir cannot create a directory there) and check the wrapped message.
  it("wraps a real mkdir failure with 'Could not create <outdir>: ...'", async () => {
    await withFreshTmpDir(async () => {
      const roomPath = tempRoomPath();
      createRoom(roomPath, ROOM_PASSWORD, "Test Room").close();

      const outdir = path.join(tmpDir, "blocked-by-a-file");
      await fsp.writeFile(outdir, "not a directory");

      await withEnv({ ROOMAI_PASSWORD: ROOM_PASSWORD }, async () => {
        await expect(doExport(roomPath, outdir)).rejects.toThrow(
          `Could not create ${outdir}:`
        );
      });
    });
  });
});
