/**
 * ADVERSARIAL SANDBOX AUDIT for `scriptRun.ts`.
 *
 * Independent of `scriptRun.test.ts` (which was written alongside the port):
 * this file re-derives the security boundary from `script_run.rs` and attacks
 * it with REAL child processes, REAL rooms and REAL symlinks. Every test here
 * either proves a guarantee the module claims, or PINS a behaviour that is
 * deliberately weaker than a reader might assume.
 *
 * The five properties under audit:
 *   1. no name — a room file's, a declared output's, a job id's — can resolve
 *      outside the workspace, and a script's own escapes (`../`, absolute
 *      paths, symlinks) reach the OS but never the ROOM;
 *   2. the child's environment, argv, cwd and INHERITED FILE DESCRIPTORS carry
 *      no trace of the room path or its SQLCipher key;
 *   3. a hung script and every descendant it forked are dead when the timeout
 *      returns — including a descendant that ignores SIGTERM;
 *   4. the workspace is gone on every outcome, setup and import-back throws
 *      included;
 *   5. nothing reaches the room unless the process really exited 0.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import { CancelFlag } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { getFileBytes, insertFile, listFiles } from "./db-host/files.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  KILL_GRACE_MS,
  type ExecOut,
  type Runner,
  type ScriptRunDeps,
  executeScriptInWorkspace,
  importOutputs,
  makeWorkspace,
  materializeInputs,
  python3Bin,
  runScriptProcess,
  scriptFingerprint,
} from "./scriptRun.js";

// ---------------------------------------------------------------- fixtures

const SH: Runner = { program: "/bin/sh", argvPrefix: [] };

let tmpDirs: string[] = [];
let openDbs: Database.Database[] = [];
let strayPids: number[] = [];

afterEach(() => {
  // Kill anything a kill-path test left behind BEFORE asserting cleanup, so a
  // failing test cannot leak a `while true` loop into the rest of the suite.
  for (const pid of strayPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone — which is what the tests assert
    }
  }
  strayPids = [];
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  openDbs = [];
  for (const d of tmpDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function freshRoom(): { db: Database.Database; path: string } {
  const dir = tmpDir("audit-room");
  const roomPath = path.join(dir, `pr-audit-${randomUUID()}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Audit Room");
  openDbs.push(db);
  return { db, path: roomPath };
}

class OneRoom implements RoomSource {
  handle: RoomHandle | null;
  constructor(handle: RoomHandle | null) {
    this.handle = handle;
  }
  current(): RoomHandle | null {
    return this.handle;
  }
}

function depsFor(
  room: { db: Database.Database; path: string },
  cacheDir: string,
  extra: Partial<ScriptRunDeps> = {}
): ScriptRunDeps {
  return {
    rooms: new OneRoom({ db: room.db, path: room.path }),
    cacheDir,
    ...extra,
  };
}

function wsPathFor(cache: string, jobId: string, stepId: number): string {
  return path.join(cache, "script-runs", `${jobId}-${stepId}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is gone within `budgetMs`.
 *
 * Polled rather than sampled once, because `kill(pid, 0)` still succeeds for a
 * ZOMBIE: an orphaned descendant is reparented to launchd and only then reaped,
 * so a process SIGKILLed microseconds ago can still answer for a few
 * milliseconds. The budget is what makes this an assertion and not a shrug — a
 * descendant that merely ignored SIGTERM is in a real `while` loop and stays
 * alive for the whole budget, so the pre-fix behaviour still fails this.
 */
async function goneWithin(pid: number, budgetMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!alive(pid)) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

/** Poll until `p` holds a non-empty line, or give up. */
async function pidFromFile(p: string, budgetMs = 5_000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const text = fs.readFileSync(p, "utf8").trim();
      if (text !== "") {
        const n = Number(text);
        if (Number.isInteger(n) && n > 1) return n;
      }
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`${p} never carried a pid`);
    await sleep(20);
  }
}

/** Run a whole script through the real runner, from real room bytes. */
function seedScript(
  room: { db: Database.Database; path: string },
  name: string,
  src: string
): { id: string; sha: string } {
  const bytes = Buffer.from(src);
  const meta = insertFile(room.db, name, "text/x-python", bytes, src, "upload");
  return { id: meta.id, sha: scriptFingerprint(bytes) };
}

function roomFileNames(db: Database.Database): string[] {
  return listFiles(db).map((f) => f.name);
}

// ============================================================================
// 2. The child's environment, argv, cwd and inherited descriptors
// ============================================================================

/** Variables macOS's own toolchain adds INSIDE the child, after our spawn:
 * `/usr/bin/python3` is an xcrun stub that re-execs the real interpreter with
 * an SDK environment, and anything linking CoreFoundation gets the last two.
 * None of them exist in this process's environment with these values — proven
 * by the `/usr/bin/env` passthrough test below, which sees exactly three. */
const XCRUN_SHIM_KEYS = [
  "SDKROOT",
  "CPATH",
  "LIBRARY_PATH",
  "MANPATH",
  "LC_CTYPE",
  "__CF_USER_TEXT_ENCODING",
];

describe("AUDIT: nothing about the room reaches the child process", () => {
  it("the environment HANDED OVER is exactly three variables — measured with a passthrough, not an interpreter", async () => {
    const keyCanary = `ROOMKEY-${randomUUID()}`;
    const saved = { ...process.env };
    process.env["ARCELLE_ROOM_KEY"] = keyCanary;
    process.env["ARCELLE_ROOM_PATH"] = "/Users/someone/Private Room.roomai";
    const ws = tmpDir("audit-ws");
    fs.mkdirSync(path.join(ws, "tmp"), { recursive: true });
    // `env printenv` is a pure passthrough: neither binary adds a variable of
    // its own (a shell would add PWD/SHLVL/_), so what it prints IS exactly
    // what `spawn` handed the child. The "script name" slot carries the
    // command because `executeScriptInWorkspace` always appends it last.
    try {
      const out = await executeScriptInWorkspace(
        ws,
        { program: "/usr/bin/env", argvPrefix: [] },
        "printenv",
        30,
        new CancelFlag()
      );
      expect(out.exitCode).toBe(0);
      const keys = out.stdoutTail
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => l.slice(0, l.indexOf("=")))
        .sort();
      expect(keys).toEqual(["HOME", "PATH", "TMPDIR"]);
      expect(out.stdoutTail).not.toContain(keyCanary);
      expect(out.stdoutTail).not.toContain(".roomai");
    } finally {
      process.env = saved;
    }
  }, 30_000);

  it(
    "env is EXACTLY {PATH,HOME,TMPDIR}, argv/cwd name only the workspace, and NO inherited fd points at the room DB",
    async () => {
      const py = python3Bin();
      if (py === null) throw new Error("this audit requires a system python3");
      const room = freshRoom();
      // Force the room DB to have real pages on disk and a live handle, so an
      // fd leak would be a leak of an OPEN database file, not of a stub.
      insertFile(room.db, "secret.txt", "text/plain", Buffer.from("x".repeat(4096)), "x", "upload");
      const roomStat = fs.statSync(room.path);

      // Canaries: a room path and a key, planted on the PARENT's environment,
      // in the two shapes a leak could take — the variable NAME and its VALUE.
      const keyCanary = `ROOMKEY-${randomUUID()}`;
      const pathCanary = room.path;
      const pathEntryCanary = `/nonexistent/canary-${randomUUID()}`;
      const saved = { ...process.env };
      process.env["ARCELLE_ROOM_KEY"] = keyCanary;
      process.env["ARCELLE_ROOM_PATH"] = pathCanary;
      process.env["PATH"] = `${pathEntryCanary}:${process.env["PATH"] ?? ""}`;

      const ws = tmpDir("audit-ws");
      fs.mkdirSync(path.join(ws, "tmp"), { recursive: true });
      const probe = [
        "import json, os, sys",
        "fds = []",
        "for e in os.listdir('/dev/fd'):",
        "    try:",
        "        st = os.fstat(int(e))",
        "        fds.append([int(e), st.st_dev, st.st_ino])",
        "    except Exception:",
        "        pass",
        "json.dump({'env': dict(os.environ), 'argv': sys.argv, 'cwd': os.getcwd(), 'fds': fds},",
        "          open('probe.json', 'w'))",
      ].join("\n");
      fs.writeFileSync(path.join(ws, "probe.py"), probe);

      try {
        const out = await executeScriptInWorkspace(
          ws,
          { program: py, argvPrefix: [] },
          "probe.py",
          30,
          new CancelFlag()
        );
        expect(out.exitCode).toBe(0);
      } finally {
        process.env = saved;
      }

      const seen = JSON.parse(fs.readFileSync(path.join(ws, "probe.json"), "utf8")) as {
        env: Record<string, string>;
        argv: string[];
        cwd: string;
        fds: Array<[number, number, number]>;
      };

      // (a) The environment is a WHITELIST, not a filtered copy. `/usr/bin/
      //     python3` is macOS's xcrun SHIM: it re-execs the real interpreter
      //     and injects SDKROOT/CPATH/LIBRARY_PATH/MANPATH itself, and
      //     CoreFoundation adds LC_CTYPE/__CF_USER_TEXT_ENCODING — all AFTER
      //     our spawn, from values that are not in this process's environment
      //     at all. `envPassthrough` below pins what we actually hand over.
      for (const key of Object.keys(seen.env)) {
        expect(["HOME", "PATH", "TMPDIR", ...XCRUN_SHIM_KEYS]).toContain(key);
      }
      expect(seen.env["PATH"]).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
      expect(seen.env["TMPDIR"]).toBe(path.join(ws, "tmp"));
      // Proof the PATH was REPLACED, not inherited-and-extended.
      expect(seen.env["PATH"]).not.toContain(pathEntryCanary);
      // (b) No canary survives anywhere in the environment, under any name.
      const flat = JSON.stringify(seen.env);
      expect(flat).not.toContain(keyCanary);
      expect(flat).not.toContain(pathCanary);
      expect(flat).not.toContain(".roomai");

      // (c) argv carries the BARE script name — never a path into the room.
      expect(seen.argv).toEqual(["probe.py"]);
      // (d) cwd is the workspace (realpath: macOS /var → /private/var).
      expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(ws));

      // (e) NO inherited descriptor is the room database. Compared by
      //     (device, inode), so a hard link or a second path cannot hide one.
      const roomIdentity = `${roomStat.dev}:${roomStat.ino}`;
      const seenIdentities = seen.fds.map(([, dev, ino]) => `${dev}:${ino}`);
      expect(seenIdentities).not.toContain(roomIdentity);
      // Nothing above stderr is a regular file at all: stdio is 3 pipes, and
      // whatever python holds open for its own script is inside the workspace.
      for (const [fd, dev, ino] of seen.fds) {
        if (fd <= 2) continue;
        expect(`${dev}:${ino}`).not.toBe(roomIdentity);
      }
    },
    60_000
  );
});

// ============================================================================
// 1. Filesystem escape — what reaches the OS vs what reaches the ROOM
// ============================================================================

describe("AUDIT: a script's filesystem escapes never reach the room", () => {
  it(
    "relative traversal and absolute writes land on disk but import NOTHING into the room",
    async () => {
      const py = python3Bin();
      if (py === null) throw new Error("this audit requires a system python3");
      const room = freshRoom();
      const outside = tmpDir("audit-outside");
      const absTarget = path.join(outside, "absolute-write.txt");
      const src = [
        "# room-outputs: ../escaped.txt, " + absTarget + ", ../../two-up.txt",
        "open('../escaped.txt', 'w').write('parent')",
        "open('../../two-up.txt', 'w').write('two-up')",
        `open(${JSON.stringify(absTarget)}, 'w').write('absolute')`,
        "open('legit.txt', 'w').write('inside')",
      ].join("\n");
      const script = seedScript(room, "escape.py", src);
      const cache = tmpDir("audit-cache");
      const before = roomFileNames(room.db).sort();

      const report = await runScriptProcess(
        depsFor(room, cache),
        "job-escape",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      );
      expect(report.exitCode).toBe(0);

      // The OS let every write through — this is NOT a jail, and pretending
      // otherwise is the misreading this test exists to prevent.
      expect(fs.existsSync(absTarget)).toBe(true);
      expect(fs.existsSync(path.join(cache, "script-runs", "escaped.txt"))).toBe(true);
      expect(fs.existsSync(path.join(cache, "two-up.txt"))).toBe(true);

      // But the ROOM saw only the file written INSIDE the workspace. Each
      // traversal-shaped declared output was looked for at its basename inside
      // the workspace, found nothing, and was honestly reported as unwritten.
      const after = roomFileNames(room.db).sort();
      expect(after).toEqual([...before, "legit.txt"].sort());
      expect(report.imported.map((f) => f.name)).toEqual(["legit.txt"]);
      for (const name of after) {
        expect(name).not.toContain("/");
      }
      expect(report.skipped.filter((s) => s.includes("did not write this declared output"))).toHaveLength(3);
      expect(fs.existsSync(wsPathFor(cache, "job-escape", 0))).toBe(false);
    },
    60_000
  );

  it("a room file NAMED as a traversal is materialized inside the workspace and overwrites nothing outside", () => {
    const room = freshRoom();
    const outside = tmpDir("audit-outside");
    const sentinelDir = path.join(outside, "deep");
    fs.mkdirSync(sentinelDir, { recursive: true });
    const sentinel = path.join(sentinelDir, "pwned.csv");
    fs.writeFileSync(sentinel, "ORIGINAL");

    // A room name is user-controlled. Give it every escape shape at once.
    for (const hostile of [
      "../../../../pwned.csv",
      `${sentinelDir}/pwned.csv`,
      "../../pwned.csv",
    ]) {
      insertFile(room.db, hostile, "text/csv", Buffer.from("ATTACKER"), "ATTACKER", "upload");
    }
    const ws = tmpDir("audit-ws");
    const mats = materializeInputs(room.db, ws, [`${sentinelDir}/pwned.csv`], new Set(["script.py"]));

    expect(mats).toHaveLength(1);
    expect(mats[0]!.name).toBe("pwned.csv");
    expect(fs.readFileSync(path.join(ws, "pwned.csv"), "utf8")).toBe("ATTACKER");
    // The only thing that matters: the real file is untouched.
    expect(fs.readFileSync(sentinel, "utf8")).toBe("ORIGINAL");
    // And nothing was created above the workspace.
    expect(fs.readdirSync(ws)).toEqual(["pwned.csv"]);
  });

  it("a traversal-shaped DECLARED OUTPUT reads and writes at its basename inside the workspace only", () => {
    const room = freshRoom();
    const outside = tmpDir("audit-outside");
    const sentinel = path.join(outside, "stolen.txt");
    fs.writeFileSync(sentinel, "SECRET");
    const ws = tmpDir("audit-ws");
    fs.writeFileSync(path.join(ws, "stolen.txt"), "from-the-workspace");

    const { imported } = importOutputs(
      room.db,
      ws,
      {
        interpreter: "py",
        deps: [],
        inputs: [],
        outputs: [`${outside}/stolen.txt`, "../../../stolen.txt"],
        timeoutSecs: 600,
        shortcut: "none",
      },
      [],
      "s.py",
      "audit"
    );
    // Both hostile names collapsed onto the same in-workspace basename; the
    // second is a duplicate of the first, so exactly ONE import happened —
    // not one version per mention (merge fix 12).
    expect(imported.map((f) => f.name)).toEqual(["stolen.txt"]);
    expect(getFileBytes(room.db, imported[0]!.id)?.toString()).toBe("from-the-workspace");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("SECRET");
  });

  it("REGRESSION: an over-cap declared output is measured from its metadata, and one bad output never loses the rest", () => {
    const room = freshRoom();
    const ws = tmpDir("audit-ws");
    fs.writeFileSync(path.join(ws, "small.txt"), "kept");
    // A sparse file past the 64 MB cap that the process CANNOT read. `stat`
    // still answers (it needs no read permission), so a size check taken from
    // metadata skips it cleanly — whereas reading first raises EACCES and, in
    // the pre-fix shape, took the whole import down with it, losing `small.txt`
    // as collateral. The same ordering is what stops a script from making the
    // main process allocate gigabytes just to discover it must skip them.
    const big = path.join(ws, "big.bin");
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    fs.chmodSync(big, 0o000);

    const { imported, skipped } = importOutputs(
      room.db,
      ws,
      {
        interpreter: "py",
        deps: [],
        inputs: [],
        outputs: ["big.bin", "small.txt"],
        timeoutSecs: 600,
        shortcut: "none",
      },
      [],
      "s.py",
      "audit"
    );
    expect(imported.map((f) => f.name)).toEqual(["small.txt"]);
    expect(skipped.some((s) => s.startsWith("big.bin: over the 64MB import cap"))).toBe(true);
    expect(roomFileNames(room.db)).toEqual(["small.txt"]);
    fs.chmodSync(big, 0o600); // so afterEach can remove the workspace
  });

  it(
    "REGRESSION: a symlinked DIRECTORY in the workspace is not followed when the workspace is deleted",
    async () => {
      const py = python3Bin();
      if (py === null) throw new Error("this audit requires a system python3");
      const room = freshRoom();
      const outside = tmpDir("audit-outside");
      const precious = path.join(outside, "precious");
      fs.mkdirSync(precious, { recursive: true });
      fs.writeFileSync(path.join(precious, "keep.txt"), "DO NOT DELETE");

      const src = [
        "import os",
        `os.symlink(${JSON.stringify(precious)}, 'escape-dir')`,
        "open('ok.txt','w').write('done')",
      ].join("\n");
      const script = seedScript(room, "symlinkdir.py", src);
      const cache = tmpDir("audit-cache");

      const report = await runScriptProcess(
        depsFor(room, cache),
        "job-symdir",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      );
      expect(report.exitCode).toBe(0);

      // The workspace teardown must unlink the symlink, never recurse THROUGH it.
      expect(fs.existsSync(wsPathFor(cache, "job-symdir", 0))).toBe(false);
      expect(fs.existsSync(precious)).toBe(true);
      expect(fs.readFileSync(path.join(precious, "keep.txt"), "utf8")).toBe("DO NOT DELETE");
      // A directory symlink is not a file, so it is not imported either.
      expect(report.imported.map((f) => f.name)).toEqual(["ok.txt"]);
    },
    60_000
  );

  it(
    "PINS the documented weakness: a symlink to an outside FILE has its target's bytes imported",
    async () => {
      const py = python3Bin();
      if (py === null) throw new Error("this audit requires a system python3");
      const room = freshRoom();
      const outside = tmpDir("audit-outside");
      const target = path.join(outside, "outside-secret.txt");
      fs.writeFileSync(target, "TARGET BYTES");

      const src = [
        "import os",
        `os.symlink(${JSON.stringify(target)}, 'grabbed.txt')`,
      ].join("\n");
      const script = seedScript(room, "symlinkfile.py", src);
      const cache = tmpDir("audit-cache");
      const report = await runScriptProcess(
        depsFor(room, cache),
        "job-symfile",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      );

      // This is INHERITED from the Rust source (`Path::is_file()` + `fs::read`
      // both follow links) and grants a script nothing it could not do with
      // two lines of `open()`. Pinned so a future change to the import path is
      // a deliberate decision rather than an accident.
      const grabbed = report.imported.find((f) => f.name === "grabbed.txt");
      expect(grabbed).toBeDefined();
      expect(getFileBytes(room.db, grabbed!.id)?.toString()).toBe("TARGET BYTES");
      // The target itself is untouched, and the link did not survive teardown.
      expect(fs.readFileSync(target, "utf8")).toBe("TARGET BYTES");
      expect(fs.existsSync(wsPathFor(cache, "job-symfile", 0))).toBe(false);
    },
    60_000
  );

  it(
    "a script cannot rewrite its own room bytes and so cannot escape the consent fingerprint",
    async () => {
      const py = python3Bin();
      if (py === null) throw new Error("this audit requires a system python3");
      const room = freshRoom();
      const src = ["open('selfmod.py','w').write('# OWNED\\n')", "open('ok.txt','w').write('x')"].join("\n");
      const script = seedScript(room, "selfmod.py", src);
      const cache = tmpDir("audit-cache");

      const report = await runScriptProcess(
        depsFor(room, cache),
        "job-selfmod",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      );
      expect(report.exitCode).toBe(0);
      // The script's own name is `handled` before the new-file scan, so its
      // rewritten body is never imported: the stored bytes still hash to the
      // consented fingerprint and the next run does not park.
      expect(getFileBytes(room.db, script.id)?.toString()).toBe(src);
      expect(scriptFingerprint(getFileBytes(room.db, script.id)!)).toBe(script.sha);
      expect(report.imported.map((f) => f.name)).toEqual(["ok.txt"]);
    },
    60_000
  );
});

// ============================================================================
// 3. A hung script and EVERY descendant are dead when the run returns
// ============================================================================

/** A script whose direct child dies promptly on SIGTERM while the grandchild
 * it forked ignores SIGTERM entirely — the shape that tells a group kill from
 * a child kill. `trap "" TERM` survives `exec`, so the grandchild's own
 * `sleep` ignores it too. */
function grandchildScript(ignoreTerm: boolean): string {
  const trap = ignoreTerm ? 'trap "" TERM; ' : "";
  return [
    `sh -c '${trap}echo $$ > gc.pid; while :; do sleep 1; done' &`,
    "echo $$ > child.pid",
    "while :; do sleep 1; done",
  ].join("\n");
}

async function runUntilKilled(
  ignoreTerm: boolean,
  mode: "timeout" | "cancel"
): Promise<{ child: number; grandchild: number; err: Error }> {
  const ws = tmpDir("audit-kill-ws");
  fs.mkdirSync(path.join(ws, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(ws, "hang.sh"), grandchildScript(ignoreTerm));
  const cancel = new CancelFlag();
  const timeoutSecs = mode === "timeout" ? 2 : 60;
  const run = executeScriptInWorkspace(ws, SH, "hang.sh", timeoutSecs, cancel);

  const grandchild = await pidFromFile(path.join(ws, "gc.pid"));
  const child = await pidFromFile(path.join(ws, "child.pid"));
  strayPids.push(child, grandchild);
  expect(alive(grandchild)).toBe(true);
  if (mode === "cancel") cancel.store(true);

  let err: Error | null = null;
  try {
    await run;
  } catch (e) {
    err = e as Error;
  }
  if (err === null) throw new Error("the hung script was expected to reject");
  return { child, grandchild, err };
}

describe("AUDIT: timeout and Stop kill the WHOLE tree, not just the direct child", () => {
  it(
    "timeout: an ordinary grandchild is dead when the rejection lands",
    async () => {
      const { child, grandchild, err } = await runUntilKilled(false, "timeout");
      expect(err.message).toMatch(/timed out after 2s/);
      expect(await goneWithin(child)).toBe(true);
      expect(await goneWithin(grandchild)).toBe(true);
    },
    KILL_GRACE_MS * 4
  );

  it(
    "REGRESSION: timeout leaves NO lingering process even when a grandchild ignores SIGTERM",
    async () => {
      const { child, grandchild, err } = await runUntilKilled(true, "timeout");
      expect(err.message).toMatch(/timed out after 2s/);
      expect(await goneWithin(child)).toBe(true);
      // The direct child exits on SIGTERM within the grace period, so a
      // terminate that stops there never escalates — and this grandchild,
      // which ignores SIGTERM, outlived the entire run as an orphan.
      expect(await goneWithin(grandchild)).toBe(true);
    },
    KILL_GRACE_MS * 4
  );

  it(
    "REGRESSION: Stop leaves NO lingering process even when a grandchild ignores SIGTERM",
    async () => {
      const { child, grandchild, err } = await runUntilKilled(true, "cancel");
      expect(err.message).toBe("STOPPED");
      expect(await goneWithin(child)).toBe(true);
      expect(await goneWithin(grandchild)).toBe(true);
    },
    KILL_GRACE_MS * 4
  );

  it(
    "end to end: a hung real script's whole tree is dead and its workspace gone",
    async () => {
      const py = python3Bin();
      if (py === null) throw new Error("this audit requires a system python3");
      const room = freshRoom();
      const outside = tmpDir("audit-outside");
      const pidFile = path.join(outside, "gc.pid");
      const src = [
        "# room-timeout: 5",
        "# room-outputs: never.txt",
        "import os, signal, subprocess, sys, time",
        "p = subprocess.Popen([sys.executable, '-c',",
        "  'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN);'",
        "  ' time.sleep(600)'])",
        `open(${JSON.stringify(pidFile)}, 'w').write(str(p.pid))`,
        "open('never.txt','w').write('written before the hang')",
        "time.sleep(600)",
      ].join("\n");
      const script = seedScript(room, "hangs.py", src);
      const cache = tmpDir("audit-cache");

      const run = runScriptProcess(
        depsFor(room, cache),
        "job-tree",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      );
      const grandchild = await pidFromFile(pidFile, 15_000);
      strayPids.push(grandchild);
      await expect(run).rejects.toThrow(/timed out after 5s/);

      expect(await goneWithin(grandchild)).toBe(true);
      expect(fs.existsSync(wsPathFor(cache, "job-tree", 0))).toBe(false);
      // …and the file it wrote BEFORE hanging never reached the room.
      expect(roomFileNames(room.db)).not.toContain("never.txt");
    },
    120_000
  );
});

// ============================================================================
// 4. The workspace is gone on EVERY outcome
// ============================================================================

describe("AUDIT: the workspace is deleted on every outcome", () => {
  const src = "# room-outputs: out.txt\nopen('out.txt','w').write('x')\n";

  async function attempt(
    jobId: string,
    execute: ScriptRunDeps["execute"],
    extra: Partial<ScriptRunDeps> = {}
  ): Promise<{ cache: string; error: Error | null; room: { db: Database.Database; path: string } }> {
    const room = freshRoom();
    const script = seedScript(room, "s.py", src);
    const cache = tmpDir("audit-cache");
    let error: Error | null = null;
    try {
      await runScriptProcess(
        depsFor(room, cache, { execute, ...extra }),
        jobId,
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      );
    } catch (e) {
      error = e as Error;
    }
    return { cache, error, room };
  }

  const ok: ExecOut = { exitCode: 0, stdoutTail: "", stderrTail: "" };

  it("normal exit 0", async () => {
    const { cache, error } = await attempt("ws-ok", async (ws) => {
      fs.writeFileSync(path.join(ws, "out.txt"), "x");
      return ok;
    });
    expect(error).toBeNull();
    expect(fs.existsSync(wsPathFor(cache, "ws-ok", 0))).toBe(false);
  });

  it("non-zero exit", async () => {
    const { cache, error } = await attempt("ws-fail", async () => ({
      exitCode: 3,
      stdoutTail: "",
      stderrTail: "boom",
    }));
    expect(error?.message).toContain("exit 3");
    expect(fs.existsSync(wsPathFor(cache, "ws-fail", 0))).toBe(false);
  });

  it("timeout", async () => {
    const { cache, error } = await attempt("ws-timeout", async () => {
      throw new Error("This script timed out after 5s.");
    });
    expect(error?.message).toMatch(/timed out/);
    expect(fs.existsSync(wsPathFor(cache, "ws-timeout", 0))).toBe(false);
  });

  it("Stop", async () => {
    const { cache, error } = await attempt("ws-stop", async () => {
      throw new Error("STOPPED");
    });
    expect(error?.message).toBe("STOPPED");
    expect(fs.existsSync(wsPathFor(cache, "ws-stop", 0))).toBe(false);
  });

  it("a throw during SETUP, before anything is spawned", async () => {
    const room = freshRoom();
    // A room file whose safeName is `tmp` collides with the TMPDIR directory
    // the workspace already contains: materializing it throws EISDIR — a real
    // failure between `makeWorkspace` and the spawn.
    insertFile(room.db, "tmp", "text/plain", Buffer.from("collide"), "collide", "upload");
    const script = seedScript(room, "setupfail.py", "# room-inputs: tmp\nprint('never')\n");
    const cache = tmpDir("audit-cache");
    let spawned = false;
    await expect(
      runScriptProcess(
        depsFor(room, cache, {
          execute: async () => {
            spawned = true;
            return ok;
          },
        }),
        "ws-setup",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      )
    ).rejects.toThrow();
    expect(spawned).toBe(false);
    expect(fs.existsSync(wsPathFor(cache, "ws-setup", 0))).toBe(false);
    // Nothing the setup had already copied into the workspace survives on disk.
    expect(fs.existsSync(path.join(cache, "script-runs"))).toBe(true);
    expect(fs.readdirSync(path.join(cache, "script-runs"))).toEqual([]);
  });

  it("a throw during IMPORT-BACK", async () => {
    const room = freshRoom();
    const script = seedScript(room, "s.py", src);
    const cache = tmpDir("audit-cache");
    await expect(
      runScriptProcess(
        depsFor(room, cache, {
          execute: async (ws) => {
            fs.writeFileSync(path.join(ws, "out.txt"), "x");
            // Pull the database out from under the import phase: every write
            // path throws from here on.
            room.db.close();
            return ok;
          },
        }),
        "ws-import",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      )
    ).rejects.toThrow();
    expect(fs.existsSync(wsPathFor(cache, "ws-import", 0))).toBe(false);
  });

  it("a room that closes between the spawn and the import", async () => {
    const room = freshRoom();
    const script = seedScript(room, "s.py", src);
    const cache = tmpDir("audit-cache");
    const rooms = new OneRoom({ db: room.db, path: room.path });
    await expect(
      runScriptProcess(
        {
          rooms,
          cacheDir: cache,
          execute: async (ws) => {
            fs.writeFileSync(path.join(ws, "out.txt"), "x");
            rooms.handle = null;
            return ok;
          },
        },
        "ws-roomgone",
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      )
    ).rejects.toThrow("no longer open");
    expect(fs.existsSync(wsPathFor(cache, "ws-roomgone", 0))).toBe(false);
  });

  it("REGRESSION: a hostile job id cannot aim the teardown's recursive delete outside script-runs/", () => {
    const cache = tmpDir("audit-cache");
    const root = path.resolve(path.join(cache, "script-runs"));
    // `makeWorkspace` deletes `dir` recursively and forcibly before creating
    // it, so an unsanitized id would be an arbitrary-directory delete. Job ids
    // are DB-generated UUIDs today; this pins the containment regardless.
    for (const hostile of ["../../../../..", "..", "a/../../../..", "/etc", "../.."]) {
      const ws = makeWorkspace(cache, hostile, 0);
      expect(path.resolve(ws).startsWith(`${root}${path.sep}`)).toBe(true);
      // A direct CHILD of the root, never a deeper path.
      expect(path.dirname(path.resolve(ws))).toBe(root);
      expect(fs.statSync(ws).isDirectory()).toBe(true);
    }
    // A normal id is untouched — the guard is not renaming ordinary runs.
    expect(makeWorkspace(cache, "3f1b0c7e-2a11-4d5e-9c33-0a1b2c3d4e5f", 2)).toBe(
      path.join(root, "3f1b0c7e-2a11-4d5e-9c33-0a1b2c3d4e5f-2")
    );
  });
});

// ============================================================================
// 5. Nothing reaches the room without a real exit 0
// ============================================================================

describe("AUDIT: the room is written only after a genuine exit 0", () => {
  const writesThenEnds = (ending: string): string =>
    [
      "# room-outputs: declared.txt",
      "import os, signal, sys",
      "open('declared.txt','w').write('declared')",
      "open('undeclared.txt','w').write('undeclared')",
      ending,
    ].join("\n");

  async function runReal(
    jobId: string,
    ending: string
  ): Promise<{ room: { db: Database.Database; path: string }; error: Error | null; cache: string }> {
    const room = freshRoom();
    const script = seedScript(room, "writes.py", writesThenEnds(ending));
    const cache = tmpDir("audit-cache");
    let error: Error | null = null;
    try {
      await runScriptProcess(
        depsFor(room, cache),
        jobId,
        0,
        room.path,
        script.id,
        script.sha,
        null,
        new CancelFlag()
      );
    } catch (e) {
      error = e as Error;
    }
    return { room, error, cache };
  }

  it(
    "a script that writes both outputs and THEN exits non-zero lands nothing in the room",
    async () => {
      if (python3Bin() === null) throw new Error("this audit requires a system python3");
      const { room, error, cache } = await runReal("t-nonzero", "sys.exit(7)");
      expect(error?.message).toMatch(/exit(ed with code)? 7/);
      expect(roomFileNames(room.db)).toEqual(["writes.py"]);
      expect(fs.existsSync(wsPathFor(cache, "t-nonzero", 0))).toBe(false);
    },
    60_000
  );

  it(
    "a script that writes both outputs and THEN dies to an uncatchable signal lands nothing",
    async () => {
      if (python3Bin() === null) throw new Error("this audit requires a system python3");
      // SIGKILL to itself: never a clean exit, so nothing may be imported.
      // (On a machine with `uv` the runner is `uv run`, which converts the
      // signal death of the python it spawned into 128+9; the -1 case is
      // covered directly below, where the DIRECT child is the one that dies.)
      const { room, error } = await runReal("t-signal", "os.kill(os.getpid(), signal.SIGKILL)");
      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/exit(ed with code)? (-1|137)/);
      expect(roomFileNames(room.db)).toEqual(["writes.py"]);
    },
    60_000
  );

  it(
    "a DIRECT child killed by a signal reports exit -1, never 0 — the value the import gate reads",
    async () => {
      const ws = tmpDir("audit-ws");
      fs.mkdirSync(path.join(ws, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(ws, "die.sh"), "echo wrote-something\nkill -9 $$\n");
      const out = await executeScriptInWorkspace(ws, SH, "die.sh", 30, new CancelFlag());
      expect(out.exitCode).toBe(-1);
      expect(out.exitCode).not.toBe(0);
      expect(out.stdoutTail).toContain("wrote-something");
    },
    30_000
  );

  it(
    "a script that writes both outputs and THEN raises lands nothing",
    async () => {
      if (python3Bin() === null) throw new Error("this audit requires a system python3");
      const { room, error } = await runReal("t-raise", "raise RuntimeError('after the writes')");
      expect(error?.message).toContain("RuntimeError");
      expect(roomFileNames(room.db)).toEqual(["writes.py"]);
    },
    60_000
  );

  it(
    "the same script exiting 0 DOES import both — so the tests above prove the gate, not a broken path",
    async () => {
      if (python3Bin() === null) throw new Error("this audit requires a system python3");
      const { room, error } = await runReal("t-zero", "sys.exit(0)");
      expect(error).toBeNull();
      expect(roomFileNames(room.db).sort()).toEqual(["declared.txt", "undeclared.txt", "writes.py"]);
    },
    60_000
  );
});
