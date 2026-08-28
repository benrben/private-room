/**
 * Vitest coverage for `scriptRun.ts` — the merge of two independent candidate
 * ports of `src-tauri/src/commands/jobs/script_run.rs`, and of their two test
 * suites.
 *
 * It carries every case from the Rust module's own `#[cfg(test)] mod tests`
 * (manifest grammar, the interpreter matrix, `missing_module`, the referenced-
 * file scan, the ring tail, every import-back rule, and the real-subprocess
 * cancel/timeout/stdin/nonzero/e2e set), PLUS the adversarial coverage the Rust
 * suite never had:
 *
 *   - `safeName` against the 20-case table verified line-for-line against real
 *     `rustc` `Path::file_name()` output, and proof that neither a hostile room
 *     name nor a traversal-shaped declared OUTPUT name can read or write
 *     outside the workspace;
 *   - REGRESSION for the consent bypass both candidates inherited from Rust: a
 *     declared `room-inputs:` entry overwriting the consented script in the
 *     workspace (see `scriptRun.ts`'s MERGE FIXES #1);
 *   - REGRESSION for the workspace leak on a materialization failure (#2);
 *   - REGRESSION for the stdin EPIPE crash (#4);
 *   - cancel AND timeout proven to kill a background GRANDCHILD, by pid, not
 *     just the immediate child — the "lingering orphaned process" bug;
 *   - the child's environment enumerated in full, with a canary secret planted
 *     on `process.env` that must never appear under either its name or value;
 *   - the uv auto-heal loop driven both deterministically (a fake executor: the
 *     round cap, the same-package bail-out, the wall-clock budget) and for real
 *     (a hand-written fake `uv` binary on the runtime-probe path, so
 *     `runScriptProcess` resolves and spawns it end to end);
 *   - the workspace proven GONE from disk after success, non-zero exit,
 *     timeout, cancel, an arbitrary crash, and a room that closes mid-run.
 *
 * The symlink cases DOCUMENT inherited behaviour rather than assert a boundary
 * — read `scriptRun.ts`'s header on what "sandboxed" does and does not mean
 * before reading them as either a pass or a failure.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import { CancelFlag } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { getFileBytes, insertFile } from "./db-host/files.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  DEFAULT_TIMEOUT_SECS,
  MAX_AUTO_MATERIALIZE,
  MAX_NEW_FILES,
  MAX_TIMEOUT_SECS,
  MIN_TIMEOUT_SECS,
  RING_BYTES,
  RingTail,
  type ExecOut,
  type Materialized,
  type Runner,
  type ScriptManifest,
  type ScriptRunDeps,
  cachedPathPrefix,
  executeScriptInWorkspace,
  guessMime,
  hasDeps,
  importOutputs,
  interpreterPolicy,
  isModifiedUsedFile,
  makeWorkspace,
  materializeInputs,
  materializeNamed,
  mentionsFileName,
  missingModule,
  parseScriptManifest,
  python3Bin,
  referencedRoomFiles,
  resetBinCachesForTests,
  resolveInterpreter,
  resolveScriptFile,
  runScriptProcess,
  safeName,
  scriptFingerprint,
  scriptLangOf,
  scriptRunsRoot,
  setCachedPathPrefix,
  sweepScriptWorkspaces,
  uvBin,
} from "./scriptRun.js";

// ---------------------------------------------------------------- fixtures

const SH: Runner = { program: "/bin/sh", argvPrefix: [] };

let tmpDirs: string[] = [];
let openDbs: Database.Database[] = [];

afterEach(() => {
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
  // The probe cache and the published path prefix are MODULE state, shared by
  // every test in this file (vitest isolates by file, not by test): a fake
  // `uv` left "installed" would silently hijack every later python test.
  setCachedPathPrefix("");
  resetBinCachesForTests();
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function tmpWs(): string {
  return tmpDir("script-run-ws");
}

function freshRoom(): { db: Database.Database; path: string } {
  const dir = tmpDir("script-run-room");
  const roomPath = path.join(dir, `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  openDbs.push(db);
  return { db, path: roomPath };
}

/** `RoomSource` test double — a mutable single slot, matching `jobs.ts`'s own
 * `RoomSource`/`RoomHandle` contract exactly. */
class OneRoom implements RoomSource {
  handle: RoomHandle | null;
  constructor(handle: RoomHandle | null) {
    this.handle = handle;
  }
  current(): RoomHandle | null {
    return this.handle;
  }
}

function manifestOut(outputs: string[]): ScriptManifest {
  return { interpreter: "py", deps: [], inputs: [], outputs, timeoutSecs: 600, shortcut: "none" };
}

/** `list_file_versions` (`db/versions.rs`) has no port in this migration yet
 * (`versions.ts`'s header names it as deliberately deferred). Read
 * `file_versions` back with raw SQL instead — the same stand-in convention
 * `db-host/files.test.ts` documents for the identical gap. */
function listFileVersionsRaw(db: Database.Database, fileId: string): Array<{ cause: string }> {
  return db
    .prepare("SELECT cause FROM file_versions WHERE file_id = ? ORDER BY saved_at DESC, rowid DESC")
    .all(fileId) as Array<{ cause: string }>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll briefly for a file to be written and non-empty. */
async function readWhenPresent(filePath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const text = fs.readFileSync(filePath, "utf8").trim();
      if (text !== "") return text;
    } catch {
      // not written yet
    }
    if (Date.now() > deadline) throw new Error(`${filePath} never appeared`);
    await sleep(20);
  }
}

// ============================================================================
// Manifest
// ============================================================================

describe("parseScriptManifest", () => {
  it("parses PEP-723 deps and room-* keys together", () => {
    const src =
      "# /// script\n" +
      '# dependencies = ["yfinance", "pandas"]\n' +
      "# ///\n" +
      "# room-inputs: portfolio.csv, holdings.xlsx\n" +
      "# room-outputs: portfolio.csv\n" +
      "# room-timeout: 300\n" +
      "# room-shortcut: global\n" +
      "import sys\n";
    const m = parseScriptManifest("update.py", src);
    expect(m.interpreter).toBe("py");
    expect(m.deps).toEqual(["yfinance", "pandas"]);
    expect(m.inputs).toEqual(["portfolio.csv", "holdings.xlsx"]);
    expect(m.outputs).toEqual(["portfolio.csv"]);
    expect(m.timeoutSecs).toBe(300);
    expect(m.shortcut).toBe("global");
    expect(hasDeps(m)).toBe(true);
  });

  it("uses the `//` prefix for JS and defaults shortcut to file when I/O is declared", () => {
    const m = parseScriptManifest(
      "tool.js",
      "// room-inputs: data.json\n// room-outputs: out.json\nconsole.log(1)\n"
    );
    expect(m.interpreter).toBe("js");
    expect(m.deps).toEqual([]);
    expect(m.inputs).toEqual(["data.json"]);
    expect(m.shortcut).toBe("file");
    // A `#`-prefixed line is NOT a JS comment → ignored.
    expect(parseScriptManifest("tool.js", "# room-inputs: ignored.txt\n").inputs).toEqual([]);
  });

  it("treats a script with no manifest block as self-contained, shortcut none", () => {
    const m = parseScriptManifest("hello.py", "print('hi')\n");
    expect(hasDeps(m)).toBe(false);
    expect(m.inputs).toEqual([]);
    expect(m.outputs).toEqual([]);
    expect(m.timeoutSecs).toBe(DEFAULT_TIMEOUT_SECS);
    expect(m.shortcut).toBe("none");
  });

  it("clamps the timeout and lets the first occurrence of a key win", () => {
    expect(parseScriptManifest("a.py", "# room-timeout: 1\n").timeoutSecs).toBe(MIN_TIMEOUT_SECS);
    expect(parseScriptManifest("a.py", "# room-timeout: 99999\n").timeoutSecs).toBe(MAX_TIMEOUT_SECS);
    expect(
      parseScriptManifest("a.py", "# room-inputs: first.csv\n# room-inputs: second.csv\n").inputs
    ).toEqual(["first.csv"]);
  });

  it("rejects a timeout that isn't pure digits, the way Rust's u64 parse does", () => {
    // `Number.parseInt("12abc")` would silently accept 12.
    expect(parseScriptManifest("a.py", "# room-timeout: 12abc\n").timeoutSecs).toBe(DEFAULT_TIMEOUT_SECS);
    expect(parseScriptManifest("a.py", "# room-timeout: -5\n").timeoutSecs).toBe(DEFAULT_TIMEOUT_SECS);
  });

  it("only scans the first 64 lines", () => {
    expect(parseScriptManifest("a.py", "x = 1\n".repeat(70) + "# room-inputs: late.csv\n").inputs).toEqual(
      []
    );
  });

  it("treats keys case-insensitively", () => {
    const m = parseScriptManifest("a.py", "# Room-Inputs: A.csv\n# ROOM-SHORTCUT: none\n");
    expect(m.inputs).toEqual(["A.csv"]);
    expect(m.shortcut).toBe("none");
  });
});

describe("scriptLangOf", () => {
  it("recognizes .py and .js, and nothing else", () => {
    expect(scriptLangOf("a.py")).toBe("py");
    expect(scriptLangOf("a.js")).toBe("js");
    expect(scriptLangOf("a.ts")).toBeNull();
    expect(scriptLangOf("noext")).toBeNull();
  });
});

describe("scriptFingerprint", () => {
  it("is stable, content-sensitive, and 64 hex chars", () => {
    const a = Buffer.from("print('a')");
    expect(scriptFingerprint(a)).toBe(scriptFingerprint(a));
    expect(scriptFingerprint(a)).not.toBe(scriptFingerprint(Buffer.from("print('b')")));
    expect(scriptFingerprint(a)).toHaveLength(64);
  });
});

describe("resolveScriptFile", () => {
  it("resolves an exact id first, then falls back to a fuzzy name", () => {
    const room = freshRoom();
    const file = insertFile(room.db, "market sync.py", "text/x-python", Buffer.from("print(1)"), "print(1)", "upload");
    const byId = resolveScriptFile(room.db, file.id);
    expect(byId.id).toBe(file.id);
    expect(byId.name).toBe("market sync.py");
    expect(byId.bytes.toString()).toBe("print(1)");
    expect(resolveScriptFile(room.db, "market sync").id).toBe(file.id);
  });

  it("throws when neither an id nor a fuzzy name matches", () => {
    const room = freshRoom();
    expect(() => resolveScriptFile(room.db, "nope.py")).toThrow();
  });
});

// ============================================================================
// Interpreter policy + probes
// ============================================================================

describe("interpreterPolicy", () => {
  it("matches the Rust matrix exactly", () => {
    // Python: uv wins whenever present (deps or not).
    expect(interpreterPolicy(true, true, false, "py", true)).toBe("uv");
    expect(interpreterPolicy(true, false, false, "py", false)).toBe("uv");
    // No uv, no deps → python3.
    expect(interpreterPolicy(false, true, false, "py", false)).toBe("python3");
    // No uv, has deps → actionable error mentioning uv.
    expect(() => interpreterPolicy(false, true, false, "py", true)).toThrow(/uv/);
    // No uv, no python3, no deps → error.
    expect(() => interpreterPolicy(false, false, false, "py", false)).toThrow();
    // JS: dependency-free + node → node.
    expect(interpreterPolicy(false, false, true, "js", false)).toBe("node");
    // JS with deps → unsupported; JS with no node → install-node.
    expect(() => interpreterPolicy(false, false, true, "js", true)).toThrow();
    expect(() => interpreterPolicy(false, false, false, "js", false)).toThrow();
  });
});

describe("resolveInterpreter + the runtime-probe seam", () => {
  it("passes declared deps to uv as explicit `--with <pkg>` pairs", () => {
    // Point the probe at a directory holding a file literally named `uv`, so
    // this asserts the argv contract on every machine rather than only where a
    // real uv happens to be installed.
    const binDir = tmpDir("script-run-bin");
    fs.writeFileSync(path.join(binDir, "uv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    setCachedPathPrefix(binDir);
    resetBinCachesForTests();

    const m = parseScriptManifest("sync.py", '# dependencies = ["pandas", "yfinance"]\nimport pandas\n');
    expect(m.deps).toEqual(["pandas", "yfinance"]);
    const runner = resolveInterpreter(m);
    expect(runner.program).toBe(path.join(binDir, "uv"));
    expect(runner.argvPrefix.slice(0, 2)).toEqual(["run", "--no-project"]);
    for (const dep of ["pandas", "yfinance"]) {
      const at = runner.argvPrefix.indexOf(dep);
      expect(at).toBeGreaterThan(0);
      expect(runner.argvPrefix[at - 1]).toBe("--with");
    }
  });

  it("prefers a downloaded runtime over the system copy, and re-probes when the prefix changes", () => {
    const binDir = tmpDir("script-run-bin");
    expect(cachedPathPrefix()).toBe(""); // fresh default: nothing downloaded
    setCachedPathPrefix(binDir);
    resetBinCachesForTests();
    // Nothing named `uv` in there yet → falls through to the system list.
    expect(uvBin()).not.toBe(path.join(binDir, "uv"));

    fs.writeFileSync(path.join(binDir, "uv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    resetBinCachesForTests();
    expect(uvBin()).toBe(path.join(binDir, "uv"));
  });

  it("python3 resolves to an absolute path when present on this machine", () => {
    const p = python3Bin();
    if (p === null) return; // the Rust test gates on presence the same way
    expect(p.startsWith("/")).toBe(true);
  });
});

// ============================================================================
// safeName — the load-bearing traversal defence
// ============================================================================

describe("safeName — SECURITY-CRITICAL", () => {
  it("verified line-for-line against real rustc Path::file_name() output (20-case table)", () => {
    const table: Array<[string, string]> = [
      ["../../etc/passwd", "passwd"],
      ["..", "file"],
      [".", "file"],
      ["a/../b", "b"],
      ["/usr/bin/", "bin"],
      ["foo.txt/.", "foo.txt"],
      ["foo.txt/.//", "foo.txt"],
      ["foo.txt/..", "file"],
      ["/", "file"],
      ["", "file"],
      ["  ", "  "],
      ["a.txt", "a.txt"],
      ["..hidden", "..hidden"],
      ["./a.txt", "a.txt"],
      ["a/b/c.txt", "c.txt"],
      ["~/.ssh/id_rsa", "id_rsa"],
      ["a/./b", "b"],
      ["a/./.", "a"],
      ["...", "..."],
      ["a/..b", "..b"],
    ];
    for (const [input, expected] of table) {
      expect(safeName(input), `safeName(${JSON.stringify(input)})`).toBe(expected);
    }
  });

  it("never returns a separator, `.`/`..`, or an empty string — whatever it is given", () => {
    const hostile = [
      "../../../../../../etc/passwd",
      "/etc/passwd",
      "a//b.txt",
      "a\\b.txt", // a backslash is NOT a separator on Unix
      "café.txt",
      "\u0000weird",
      "../".repeat(50) + "shadow",
    ];
    for (const name of hostile) {
      const safe = safeName(name);
      expect(safe.includes("/"), name).toBe(false);
      expect(safe === "" || safe === "." || safe === "..").toBe(false);
      // `path.join(ws, safe)` therefore always stays a direct child.
      expect(path.dirname(path.join("/ws", safe))).toBe("/ws");
    }
    expect(safeName("a\\b.txt")).toBe("a\\b.txt");
    expect(safeName("a//b.txt")).toBe("b.txt");
  });
});

// ============================================================================
// The auto-reference scan
// ============================================================================

describe("mentionsFileName / referencedRoomFiles", () => {
  it("matches a whole token, never a substring glued to more name characters", () => {
    expect(mentionsFileName("open('mydata.csv.bak')", "data.csv")).toBe(false);
    expect(mentionsFileName("open('data.csv')", "data.csv")).toBe(true);
    expect(mentionsFileName("anything", "")).toBe(false);
  });

  it("matches exact names appearing verbatim in the script, dedups, and caps", () => {
    const text =
      "import pandas as pd\n" +
      "df = pd.read_csv('ETF Tracker — AI Full Stack.csv')\n" +
      "notes = open('meeting notes.md').read()\n" +
      "df.to_csv('ETF Tracker — AI Full Stack.csv')\n";
    const room = ["ETF Tracker — AI Full Stack.csv", "meeting notes.md", "unrelated.pdf"];
    const hit = referencedRoomFiles(text, room, 20);
    expect(hit).toContain("ETF Tracker — AI Full Stack.csv");
    expect(hit).toContain("meeting notes.md");
    expect(hit).not.toContain("unrelated.pdf");
    expect(hit.filter((n) => n === "ETF Tracker — AI Full Stack.csv")).toHaveLength(1);
    expect(referencedRoomFiles("a b c", [""], 20)).toEqual([]);

    const many = Array.from({ length: 30 }, (_, i) => `f${i}.csv`);
    expect(referencedRoomFiles(many.join(" "), many, 5)).toHaveLength(5);
    expect(MAX_AUTO_MATERIALIZE).toBe(20);
  });

  it("never auto-materializes a very short or extensionless name ('s'/'df')", () => {
    const text = "import pandas as pd\ndf = pd.read_csv('prices.csv')\ns = df.sum()\n";
    expect(referencedRoomFiles(text, ["df", "s", "a.py", "prices.csv"], 20)).toEqual(["prices.csv"]);
    expect(referencedRoomFiles("open('mydata.csv.bak')", ["data.csv"], 20)).toEqual([]);
    expect(referencedRoomFiles("open('data.csv')", ["data.csv"], 20)).toEqual(["data.csv"]);
    // A short name is still reachable by DECLARING it — a different path.
    expect(referencedRoomFiles("df", ["df"], 20)).toEqual([]);
  });

  it("treats Hebrew letters as name characters (Unicode-aware boundary)", () => {
    expect(referencedRoomFiles("טען את הקובץ דוח.csv ותסתכל עליו", ["דוח.csv"], 20)).toEqual(["דוח.csv"]);
  });
});

// ============================================================================
// Workspace lifecycle
// ============================================================================

describe("makeWorkspace / sweepScriptWorkspaces", () => {
  it("creates a 0700 directory plus a tmp/ subdir", () => {
    const cache = tmpDir("script-run-cache");
    const ws = makeWorkspace(cache, "job-1", 0);
    const st = fs.statSync(ws);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(ws, "tmp")).isDirectory()).toBe(true);
  });

  it("gives two script steps of one job SEPARATE workspaces, and a resumed step starts clean", () => {
    const cache = tmpDir("script-run-cache");
    const job = `job-${randomUUID()}`;
    const first = makeWorkspace(cache, job, 0);
    fs.writeFileSync(path.join(first, "step0-output.csv"), "mine");
    const second = makeWorkspace(cache, job, 1);
    expect(second).not.toBe(first);
    expect(fs.existsSync(path.join(first, "step0-output.csv"))).toBe(true);

    fs.writeFileSync(path.join(second, "stale.txt"), "old");
    const again = makeWorkspace(cache, job, 1);
    expect(again).toBe(second);
    expect(fs.existsSync(path.join(again, "stale.txt"))).toBe(false);
  });

  it("sweeps every workspace under script-runs/ and nothing above it", () => {
    const cache = tmpDir("script-run-cache");
    const ws = makeWorkspace(cache, "job-a", 0);
    const sentinel = path.join(cache, "sentinel.txt");
    fs.writeFileSync(sentinel, "keep me");
    sweepScriptWorkspaces(cache);
    expect(fs.existsSync(ws)).toBe(false);
    expect(fs.existsSync(scriptRunsRoot(cache))).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    // Sweeping a cache dir with no script-runs/ at all is a harmless no-op.
    expect(() => sweepScriptWorkspaces(cache)).not.toThrow();
  });
});

describe("materializeInputs / materializeNamed — SECURITY", () => {
  it("writes a declared input under its safeName basename, INSIDE the workspace only", () => {
    const room = freshRoom();
    const ws = tmpWs();
    // A room file whose real NAME is a traversal string: the room permits
    // almost any name, the workspace materializer must not.
    insertFile(room.db, "../../../../tmp/escaped.txt", "text/plain", Buffer.from("leaked"), "leaked", "upload");
    const mats = materializeInputs(room.db, ws, ["escaped.txt"]);
    expect(mats).toHaveLength(1);
    expect(mats[0]!.name).toBe("escaped.txt");
    expect(fs.readFileSync(path.join(ws, "escaped.txt"), "utf8")).toBe("leaked");
    expect(fs.existsSync("/tmp/escaped.txt")).toBe(false);
  });

  it("REGRESSION: a declared input can never overwrite the consented script in the workspace", () => {
    // MERGE FIX #1. `# room-inputs:` resolves FUZZILY to "the newest room file
    // with a matching name". A room holding a second, newer file named like
    // the script therefore replaced the script's own consented bytes on disk,
    // and the interpreter ran the impostor — with the fingerprint gate two
    // steps earlier reporting all clear.
    const room = freshRoom();
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "sync.py"), "print('consented')");
    insertFile(room.db, "sync.py", "text/x-python", Buffer.from("print('IMPOSTOR')"), "x", "upload");
    const mats = materializeInputs(room.db, ws, ["sync.py"], new Set(["sync.py"]));
    expect(mats).toEqual([]);
    expect(fs.readFileSync(path.join(ws, "sync.py"), "utf8")).toBe("print('consented')");
  });

  it("skips a declared input with no match in the room — its absence is honest", () => {
    const room = freshRoom();
    expect(materializeInputs(room.db, tmpWs(), ["nope.csv"])).toEqual([]);
  });

  it("materializeNamed resolves by EXACT name and never overwrites what is already there", () => {
    const room = freshRoom();
    const ws = tmpWs();
    insertFile(room.db, "data.csv", "text/csv", Buffer.from("room-version"), "room-version", "upload");
    insertFile(room.db, "prices.csv", "text/csv", Buffer.from("a,b\n"), "a,b", "upload");
    fs.writeFileSync(path.join(ws, "data.csv"), "already-here");
    expect(materializeNamed(room.db, ws, ["data.csv"], new Set(["data.csv"]))).toEqual([]);
    expect(fs.readFileSync(path.join(ws, "data.csv"), "utf8")).toBe("already-here");

    const extra = materializeNamed(room.db, ws, ["prices.csv"], new Set());
    expect(extra).toHaveLength(1);
    expect(fs.readFileSync(path.join(ws, "prices.csv"), "utf8")).toBe("a,b\n");
  });
});

// ============================================================================
// RingTail
// ============================================================================

describe("RingTail", () => {
  it("keeps the last RING_BYTES and names how much fell out of the FRONT", () => {
    const ring = new RingTail();
    const filler = Buffer.from("A".repeat(RING_BYTES * 2));
    const marker = Buffer.from("\nTOTAL: 42\n");
    const dropped = filler.length + marker.length - RING_BYTES;
    ring.push(filler);
    ring.push(marker);
    const tail = ring.tailString();
    expect(tail).toContain("TOTAL: 42");
    expect(tail.startsWith(`[earlier output omitted — ${dropped} bytes]`)).toBe(true);
    expect(ring.dropped).toBe(dropped);
  });

  it("claims nothing missing, and adds no marker, under the ring", () => {
    const ring = new RingTail();
    ring.push(Buffer.from("TOTAL: 42\n"));
    expect(ring.tailString()).toBe("TOTAL: 42\n");
    expect(ring.dropped).toBe(0);
  });

  it("trims a multi-byte character cut in half rather than emit U+FFFD", () => {
    const ring = new RingTail();
    ring.push(Buffer.from("מ".repeat(RING_BYTES)));
    ring.push(Buffer.from("end"));
    const tail = ring.tailString();
    expect(tail).not.toContain("\u{fffd}");
    expect(tail.endsWith("end")).toBe(true);
  });
});

// ============================================================================
// missingModule
// ============================================================================

describe("missingModule", () => {
  it("extracts the top-level package name and rejects anything odd", () => {
    expect(missingModule("Traceback...\nModuleNotFoundError: No module named 'pandas'")).toBe("pandas");
    expect(missingModule("No module named 'yfinance.utils'")).toBe("yfinance");
    expect(missingModule("ValueError: bad input")).toBeNull();
    // Never shell out with something odd.
    expect(missingModule("No module named '../evil'")).toBeNull();
    expect(missingModule("No module named 'a; rm -rf /'")).toBeNull();
  });
});

// ============================================================================
// Import-back
// ============================================================================

describe("importOutputs", () => {
  it("makes a declared existing output a VERSIONED overwrite, undoable via Time Machine", () => {
    const room = freshRoom();
    const existing = insertFile(room.db, "report.csv", "text/csv", Buffer.from("old"), "old", "upload");
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "report.csv"), "new,data\n1,2\n");
    const { imported, skipped } = importOutputs(
      room.db,
      ws,
      manifestOut(["report.csv"]),
      [],
      "s.py",
      "Script ran — s.py"
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]!.id).toBe(existing.id);
    expect(skipped).toEqual([]);
    const versions = listFileVersionsRaw(room.db, existing.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.cause).toBe("Script ran — s.py");
    expect(getFileBytes(room.db, existing.id)?.toString()).toBe("new,data\n1,2\n");
  });

  it("inserts a declared-new and an undeclared-new file, both source='script'", () => {
    const room = freshRoom();
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "prices-2026.csv"), "a,b\n");
    fs.writeFileSync(path.join(ws, "extra.txt"), "note");
    const { imported, skipped } = importOutputs(room.db, ws, manifestOut(["prices-2026.csv"]), [], "s.py", "c");
    expect(imported).toHaveLength(2);
    expect(skipped).toEqual([]);
    expect(imported.every((f) => f.source === "script")).toBe(true);
    expect(imported.some((f) => f.name === "prices-2026.csv")).toBe(true);
    expect(imported.some((f) => f.name === "extra.txt")).toBe(true);
  });

  it("counts declared outputs separately from the undeclared-extras cap", () => {
    const room = freshRoom();
    const ws = tmpWs();
    const declared = Array.from({ length: MAX_NEW_FILES }, (_, i) => `declared${String(i).padStart(3, "0")}.csv`);
    for (const name of declared) fs.writeFileSync(path.join(ws, name), "x");
    fs.writeFileSync(path.join(ws, "surprise.txt"), "y");
    const { imported, skipped } = importOutputs(room.db, ws, manifestOut(declared), [], "s.py", "c");
    expect(imported).toHaveLength(MAX_NEW_FILES + 1);
    expect(imported.some((m) => m.name === "surprise.txt")).toBe(true);
    expect(skipped).toEqual([]);
  });

  it("caps undeclared new files and names the overflow", () => {
    const room = freshRoom();
    const ws = tmpWs();
    for (let i = 0; i < MAX_NEW_FILES + 5; i += 1) {
      fs.writeFileSync(path.join(ws, `f${String(i).padStart(3, "0")}.txt`), "x");
    }
    const { imported, skipped } = importOutputs(room.db, ws, manifestOut([]), [], "s.py", "c");
    expect(imported).toHaveLength(MAX_NEW_FILES);
    expect(skipped).toHaveLength(5);
  });

  it("does not re-import a declared output the script never wrote — but does once it does", () => {
    // The ScriptsPage empty state teaches `room-inputs: portfolio.csv` +
    // `room-outputs: portfolio.csv`. The RUNNER puts that file in the
    // workspace, so "it exists" proves nothing: a body of `pass` still added a
    // byte-identical version on every run and reported "Created".
    const room = freshRoom();
    const file = insertFile(room.db, "portfolio.csv", "text/csv", Buffer.from("a,b\n"), "a,b", "upload");
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "portfolio.csv"), "a,b\n");
    const materialized: Materialized[] = [
      { name: "portfolio.csv", sha: scriptFingerprint(Buffer.from("a,b\n")) },
    ];
    const first = importOutputs(room.db, ws, manifestOut(["portfolio.csv"]), materialized, "sync.py", "c");
    expect(first.imported).toEqual([]);
    expect(first.skipped.some((s) => s.includes("portfolio.csv") && s.includes("unchanged"))).toBe(true);
    expect(listFileVersionsRaw(room.db, file.id)).toEqual([]);

    fs.writeFileSync(path.join(ws, "portfolio.csv"), "a,b\n1,2\n");
    const second = importOutputs(room.db, ws, manifestOut(["portfolio.csv"]), materialized, "sync.py", "c");
    expect(second.imported).toHaveLength(1);
    expect(second.imported[0]!.id).toBe(file.id);
  });

  it("saves a modified-in-place materialized input back as a new version, and notes it", () => {
    const room = freshRoom();
    const input = insertFile(room.db, "in.csv", "text/csv", Buffer.from("orig"), "orig", "upload");
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "in.csv"), "updated");
    const materialized: Materialized[] = [{ name: "in.csv", sha: scriptFingerprint(Buffer.from("orig")) }];
    const { imported, skipped } = importOutputs(
      room.db,
      ws,
      manifestOut([]),
      materialized,
      "s.py",
      "Script ran — s.py"
    );
    expect(imported).toHaveLength(1);
    expect(imported[0]!.id).toBe(input.id);
    expect(getFileBytes(room.db, input.id)?.toString()).toBe("updated");
    expect(listFileVersionsRaw(room.db, input.id)).toHaveLength(1);
    expect(skipped.some((s) => s.includes("in.csv") && s.includes("updated in place"))).toBe(true);
  });

  it("does not re-import an untouched materialized input", () => {
    const room = freshRoom();
    const input = insertFile(room.db, "keep.csv", "text/csv", Buffer.from("same"), "same", "upload");
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "keep.csv"), "same");
    const materialized: Materialized[] = [{ name: "keep.csv", sha: scriptFingerprint(Buffer.from("same")) }];
    const { imported, skipped } = importOutputs(room.db, ws, manifestOut([]), materialized, "s.py", "c");
    expect(imported).toEqual([]);
    expect(skipped).toEqual([]);
    expect(listFileVersionsRaw(room.db, input.id)).toEqual([]);
  });

  it("reports an undeclared write over an existing room file as a replacement, not 'Created'", () => {
    const room = freshRoom();
    const existing = insertFile(room.db, "notes.md", "text/markdown", Buffer.from("mine"), "mine", "upload");
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "notes.md"), "x");
    fs.writeFileSync(path.join(ws, "brand-new.md"), "y");
    const { imported, skipped } = importOutputs(room.db, ws, manifestOut([]), [], "s.py", "c");
    expect(imported).toHaveLength(2);
    expect(skipped.some((s) => s.startsWith("notes.md:") && s.includes("already existed"))).toBe(true);
    expect(skipped.some((s) => s.startsWith("brand-new.md:"))).toBe(false);
    expect(getFileBytes(room.db, existing.id)?.toString()).toBe("x");
  });

  it("never imports the script itself back into the room", () => {
    const room = freshRoom();
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "s.py"), "print(1)");
    fs.writeFileSync(path.join(ws, "out.txt"), "real output");
    const { imported } = importOutputs(room.db, ws, manifestOut([]), [], "s.py", "c");
    expect(imported.map((f) => f.name)).toEqual(["out.txt"]);
  });

  it("SECURITY: a traversal-shaped declared output name reads and writes inside the workspace only", () => {
    const room = freshRoom();
    const ws = tmpWs();
    const outsideTarget = path.join(tmpDir("script-run-outside"), "secret.txt");
    fs.writeFileSync(outsideTarget, "should never be read or overwritten");
    const traversal = "../".repeat(20) + outsideTarget.replace(/^\//, "");
    const { imported, skipped } = importOutputs(room.db, ws, manifestOut([traversal]), [], "s.py", "c");
    // The script never wrote `ws/<basename>`, so nothing is imported — proving
    // the lookup happened INSIDE the workspace, not at the path named.
    expect(imported).toEqual([]);
    expect(skipped.some((s) => s.includes("did not write this declared output"))).toBe(true);
    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("should never be read or overwritten");
  });

  it("DOCUMENTS (does not defend against) a symlinked declared output importing its target's bytes", () => {
    // `Path::is_file()`/`std::fs::read` in Rust both follow symlinks, and so do
    // `fs.statSync`/`fs.readFileSync` here — faithfully ported, not "fixed".
    // The script could equally have read the file and written its bytes into
    // an ordinary output, so this grants it nothing it did not already have.
    // Recorded so nobody mistakes the workspace for a filesystem jail.
    const room = freshRoom();
    const ws = tmpWs();
    const secret = path.join(tmpDir("script-run-outside"), "not-a-script-output.txt");
    fs.writeFileSync(secret, "arbitrary local file content");
    fs.symlinkSync(secret, path.join(ws, "result.csv"));
    const { imported } = importOutputs(room.db, ws, manifestOut(["result.csv"]), [], "s.py", "c");
    expect(imported).toHaveLength(1);
    expect(getFileBytes(room.db, imported[0]!.id)?.toString()).toBe("arbitrary local file content");
  });
});

describe("isModifiedUsedFile", () => {
  it("selects a changed, undeclared file and nothing else", () => {
    const orig = scriptFingerprint(Buffer.from("orig"));
    const changed = scriptFingerprint(Buffer.from("changed"));
    expect(isModifiedUsedFile(orig, changed, "in.csv", [])).toBe(true);
    expect(isModifiedUsedFile(orig, orig, "in.csv", [])).toBe(false);
    // Changed but ALSO declared → the declared-output path owns it.
    expect(isModifiedUsedFile(orig, changed, "in.csv", ["in.csv"])).toBe(false);
  });
});

describe("guessMime", () => {
  it("knows the common script-output extensions and defaults to text/plain", () => {
    expect(guessMime("out.csv")).toBe("text/csv");
    expect(guessMime("out.png")).toBe("image/png");
    expect(guessMime("out.unknownext")).toBe("text/plain");
    expect(guessMime("out")).toBe("text/plain");
  });
});

// ============================================================================
// executeScriptInWorkspace — real subprocesses
// ============================================================================

describe("executeScriptInWorkspace — environment isolation (SECURITY-CRITICAL)", () => {
  it("hands the child EXACTLY {PATH, HOME, TMPDIR}; nothing from this process leaks", async () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "dump_env.sh"), "#!/bin/sh\nenv | sort\n");
    // A canary that looks exactly like what must never be forwarded — a room
    // path, a SQLCipher key — planted directly on `process.env`.
    const canaryKey = "PR_TEST_ROOM_SECRET";
    const canaryValue = `sqlcipher-key-${randomUUID()}`;
    process.env[canaryKey] = canaryValue;
    try {
      const out = await executeScriptInWorkspace(ws, SH, "dump_env.sh", 15, new CancelFlag());
      expect(out.exitCode).toBe(0);
      expect(out.stdoutTail).not.toContain(canaryKey);
      expect(out.stdoutTail).not.toContain(canaryValue);
      const envMap = new Map(
        out.stdoutTail
          .trim()
          .split("\n")
          .map((line) => {
            const idx = line.indexOf("=");
            return [line.slice(0, idx), line.slice(idx + 1)] as const;
          })
      );
      expect(envMap.get("PATH")).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
      expect(envMap.get("HOME")).toBe(process.env["HOME"] ?? "");
      expect(envMap.get("TMPDIR")).toBe(path.join(ws, "tmp"));
      // Anything else can ONLY be housekeeping `/bin/sh` sets on its own when
      // it starts — never a value carried over from the parent process.
      const shellOwnHousekeeping = new Set(["PWD", "SHLVL", "_"]);
      expect(
        [...envMap.keys()].filter(
          (k) => k !== "PATH" && k !== "HOME" && k !== "TMPDIR" && !shellOwnHousekeeping.has(k)
        )
      ).toEqual([]);
    } finally {
      delete process.env[canaryKey];
    }
  });
});

describe("executeScriptInWorkspace — cancel and timeout kill the WHOLE process tree", () => {
  it("cancel terminates the script AND a background grandchild it forked", async () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "sleep.sh"), "#!/bin/sh\nsleep 30 &\necho $! > child.pid\nwait\n");
    const cancel = new CancelFlag();
    setTimeout(() => cancel.store(true), 300);
    const start = Date.now();
    await expect(executeScriptInWorkspace(ws, SH, "sleep.sh", 60, cancel)).rejects.toThrow("STOPPED");
    expect(Date.now() - start).toBeLessThan(20_000);

    const childPid = Number.parseInt(await readWhenPresent(path.join(ws, "child.pid")), 10);
    expect(Number.isFinite(childPid)).toBe(true);
    // Killing only the immediate child (rather than the process GROUP) is
    // exactly the lingering-orphan bug this module exists to avoid.
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it("timeout terminates the tree and reports what the script printed", async () => {
    const ws = tmpWs();
    fs.writeFileSync(
      path.join(ws, "sleep.sh"),
      "#!/bin/sh\necho 'step 1 of 3'\necho 'reading ledger' 1>&2\nsleep 30 &\necho $! > child.pid\nwait\n"
    );
    const start = Date.now();
    const err = await executeScriptInWorkspace(ws, SH, "sleep.sh", 1, new CancelFlag()).catch(
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("timed out");
    // A timeout used to be one sentence, with the progress thrown away.
    expect(message).toContain("step 1 of 3");
    expect(message).toContain("reading ledger");
    expect(Date.now() - start).toBeLessThan(20_000);

    const childPid = Number.parseInt(await readWhenPresent(path.join(ws, "child.pid")), 10);
    expect(isProcessAlive(childPid)).toBe(false);
  });
});

describe("executeScriptInWorkspace — stdin, exit codes, spawn failures", () => {
  it("pipes stdin to the script and captures stdout", async () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "echo.sh"), "#!/bin/sh\ncat\n");
    const out = await executeScriptInWorkspace(
      ws,
      SH,
      "echo.sh",
      30,
      new CancelFlag(),
      Buffer.from("piped-in payload")
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdoutTail).toContain("piped-in payload");
  });

  it("REGRESSION: a script that exits without reading a large stdin does not crash the process", async () => {
    // MERGE FIX #4. `stdin.end(bytes)` on a pipe whose reader is gone raises
    // EPIPE, and an 'error' event with no listener is an UNHANDLED error — a
    // thrown exception in the Electron main process, over a script doing
    // nothing worse than ignoring its input. 1 MB is comfortably past the
    // ~64 KB pipe buffer, so the write cannot complete before the child exits.
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "ignore.sh"), "#!/bin/sh\nexit 0\n");
    const out = await executeScriptInWorkspace(
      ws,
      SH,
      "ignore.sh",
      30,
      new CancelFlag(),
      Buffer.alloc(1024 * 1024, 0x61)
    );
    expect(out.exitCode).toBe(0);
  });

  it("surfaces the stderr tail on a nonzero exit, without rejecting", async () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "fail.sh"), "#!/bin/sh\necho boom 1>&2\nexit 3\n");
    const out = await executeScriptInWorkspace(ws, SH, "fail.sh", 30, new CancelFlag());
    expect(out.exitCode).toBe(3);
    expect(out.stderrTail).toContain("boom");
  });

  it("does not hang or throw when the script prints nothing at all", async () => {
    const ws = tmpWs();
    fs.writeFileSync(path.join(ws, "quiet.sh"), "#!/bin/sh\ntrue\n");
    const out = await executeScriptInWorkspace(ws, SH, "quiet.sh", 30, new CancelFlag());
    expect(out.exitCode).toBe(0);
    expect(out.stdoutTail).toBe("");
  });

  it("rejects a missing interpreter with an actionable message, promptly", async () => {
    // Also the only honest end-to-end check of the `pid > 1` guard in
    // `killGroup`: a failed spawn has `child.pid === undefined`, and a port
    // that negated it anyway would signal THIS process's own group — killing
    // the test runner rather than reaching this assertion.
    const ws = tmpWs();
    const runner: Runner = { program: path.join(ws, "does-not-exist-binary"), argvPrefix: [] };
    const start = Date.now();
    await expect(executeScriptInWorkspace(ws, runner, "whatever.sh", 30, new CancelFlag())).rejects.toThrow(
      /Could not start the script/
    );
    expect(Date.now() - start).toBeLessThan(10_000);
  });
});

describe("executeScriptInWorkspace — the workspace is not a filesystem jail (documented)", () => {
  it("a `../` read from inside the workspace reaches outside it, exactly as in Rust", async () => {
    // No chroot/container exists at either layer. The secret sits OUTSIDE any
    // workspace: this is proof of the ABSENCE of a filesystem jail, which the
    // Rust source never claimed to provide. The real guarantee is the env test
    // above — the room path and key are unreachable.
    const secretDir = tmpDir("script-run-secret");
    fs.writeFileSync(path.join(secretDir, "secret.txt"), "outside-the-workspace");
    const ws = tmpWs();
    const rel = path.relative(ws, path.join(secretDir, "secret.txt"));
    fs.writeFileSync(path.join(ws, "escape.sh"), `#!/bin/sh\ncat "${rel}"\n`);
    const out = await executeScriptInWorkspace(ws, SH, "escape.sh", 15, new CancelFlag());
    expect(out.exitCode).toBe(0);
    expect(out.stdoutTail).toContain("outside-the-workspace");
  });
});

// ============================================================================
// runScriptProcess — orchestration
// ============================================================================

function depsFor(
  room: { db: Database.Database; path: string },
  cacheDir: string,
  extra: Partial<ScriptRunDeps> = {}
): ScriptRunDeps {
  return { rooms: new OneRoom({ db: room.db, path: room.path }), cacheDir, ...extra };
}

function wsPathFor(cache: string, jobId: string, stepId: number): string {
  return path.join(scriptRunsRoot(cache), `${jobId}-${stepId}`);
}

const OK: ExecOut = { exitCode: 0, stdoutTail: "", stderrTail: "" };

describe("runScriptProcess — the consent gate", () => {
  it("parks with an actionable message when the consent hash is EMPTY (never approved)", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "s.py", "text/x-python", Buffer.from("print(1)"), "print(1)", "upload");
    const deps = depsFor(room, tmpDir("script-run-cache"), { execute: async () => OK });
    await expect(
      runScriptProcess(deps, "job1", 0, room.path, file.id, "", null, new CancelFlag())
    ).rejects.toThrow(/isn't approved on this Mac yet/);
  });

  it("parks with a DIFFERENT message when the script changed since it was approved", async () => {
    const room = freshRoom();
    const file = insertFile(room.db, "s.py", "text/x-python", Buffer.from("print(1)"), "print(1)", "upload");
    const deps = depsFor(room, tmpDir("script-run-cache"), { execute: async () => OK });
    await expect(
      runScriptProcess(deps, "job1", 0, room.path, file.id, "not-the-real-hash", null, new CancelFlag())
    ).rejects.toThrow(/changed since it was approved/);
  });

  it("refuses when the room is closed or swapped at read time", async () => {
    const deps: ScriptRunDeps = { rooms: new OneRoom(null), cacheDir: tmpDir("script-run-cache") };
    await expect(
      runScriptProcess(deps, "job3", 0, "/some/room.roomai", "file-id", "", null, new CancelFlag())
    ).rejects.toThrow(/no longer open/);
  });

  it("REGRESSION: the interpreter runs the CONSENTED bytes even when a room-input names the script", async () => {
    // MERGE FIX #1, end to end. The room holds a newer, unrelated file with
    // the same name as the script; the script declares itself as an input.
    const room = freshRoom();
    const src = "# room-inputs: sync.py\nprint('consented')\n";
    const bytes = Buffer.from(src);
    const file = insertFile(room.db, "sync.py", "text/x-python", bytes, src, "upload");
    insertFile(room.db, "sync.py", "text/x-python", Buffer.from("print('IMPOSTOR')"), "x", "upload");

    let ranBytes = "";
    const deps = depsFor(room, tmpDir("script-run-cache"), {
      execute: async (ws, _runner, scriptName) => {
        ranBytes = fs.readFileSync(path.join(ws, scriptName), "utf8");
        return OK;
      },
    });
    await runScriptProcess(deps, "job-consent", 0, room.path, file.id, scriptFingerprint(bytes), null, new CancelFlag());
    expect(ranBytes).toBe(src);
    expect(ranBytes).not.toContain("IMPOSTOR");
  });
});

describe("runScriptProcess — the workspace is deleted on EVERY outcome", () => {
  function scriptRoom(source: string): {
    room: { db: Database.Database; path: string };
    fileId: string;
    sha: string;
  } {
    const room = freshRoom();
    const bytes = Buffer.from(source);
    const file = insertFile(room.db, "s.py", "text/x-python", bytes, source, "upload");
    return { room, fileId: file.id, sha: scriptFingerprint(bytes) };
  }

  it("after a clean success", async () => {
    const { room, fileId, sha } = scriptRoom("print(1)\n");
    const cache = tmpDir("script-run-cache");
    const deps = depsFor(room, cache, { execute: async () => ({ ...OK, stdoutTail: "ok" }) });
    await runScriptProcess(deps, "job-ok", 0, room.path, fileId, sha, null, new CancelFlag());
    expect(fs.existsSync(wsPathFor(cache, "job-ok", 0))).toBe(false);
  });

  it("after a nonzero exit", async () => {
    const { room, fileId, sha } = scriptRoom("print(1)\n");
    const cache = tmpDir("script-run-cache");
    const deps = depsFor(room, cache, {
      execute: async () => ({ exitCode: 1, stdoutTail: "", stderrTail: "boom" }),
    });
    await expect(
      runScriptProcess(deps, "job-fail", 0, room.path, fileId, sha, null, new CancelFlag())
    ).rejects.toThrow(/boom/);
    expect(fs.existsSync(wsPathFor(cache, "job-fail", 0))).toBe(false);
  });

  it("after a timeout", async () => {
    const { room, fileId, sha } = scriptRoom("print(1)\n");
    const cache = tmpDir("script-run-cache");
    const deps = depsFor(room, cache, {
      execute: async () => {
        throw new Error("This script timed out after 5s.");
      },
    });
    await expect(
      runScriptProcess(deps, "job-timeout", 0, room.path, fileId, sha, null, new CancelFlag())
    ).rejects.toThrow(/timed out/);
    expect(fs.existsSync(wsPathFor(cache, "job-timeout", 0))).toBe(false);
  });

  it("after a Stop", async () => {
    const { room, fileId, sha } = scriptRoom("print(1)\n");
    const cache = tmpDir("script-run-cache");
    const deps = depsFor(room, cache, {
      execute: async () => {
        throw new Error("STOPPED");
      },
    });
    await expect(
      runScriptProcess(deps, "job-stop", 0, room.path, fileId, sha, null, new CancelFlag())
    ).rejects.toThrow("STOPPED");
    expect(fs.existsSync(wsPathFor(cache, "job-stop", 0))).toBe(false);
  });

  it("after a genuinely unexpected crash deep in the executor", async () => {
    const { room, fileId, sha } = scriptRoom("print(1)\n");
    const cache = tmpDir("script-run-cache");
    const deps = depsFor(room, cache, {
      execute: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'pid') — simulated crash");
      },
    });
    await expect(
      runScriptProcess(deps, "job-crash", 0, room.path, fileId, sha, null, new CancelFlag())
    ).rejects.toThrow(/simulated crash/);
    expect(fs.existsSync(wsPathFor(cache, "job-crash", 0))).toBe(false);
  });

  it("REGRESSION: after a failure while MATERIALIZING, before anything is spawned", async () => {
    // MERGE FIX #2. Both candidates (and the Rust source) wrapped only the
    // spawn+import tail, so a throw during materialization left the workspace
    // — and every room byte already copied into it — on disk until the next
    // startup sweep. A room file named `tmp` collides with the workspace's own
    // TMPDIR directory, so writing it raises EISDIR.
    const room = freshRoom();
    const src = "# room-inputs: tmp\nprint(1)\n";
    const bytes = Buffer.from(src);
    const file = insertFile(room.db, "s.py", "text/x-python", bytes, src, "upload");
    insertFile(room.db, "tmp", "text/plain", Buffer.from("collides with TMPDIR"), "x", "upload");
    const cache = tmpDir("script-run-cache");
    let spawned = false;
    const deps = depsFor(room, cache, {
      execute: async () => {
        spawned = true;
        return OK;
      },
    });
    await expect(
      runScriptProcess(deps, "job-materialize", 0, room.path, file.id, scriptFingerprint(bytes), null, new CancelFlag())
    ).rejects.toThrow();
    expect(spawned).toBe(false);
    expect(fs.existsSync(wsPathFor(cache, "job-materialize", 0))).toBe(false);
  });
});

describe("runScriptProcess — notifyFilesChanged", () => {
  it("fires once when something was imported, and not at all when nothing was", async () => {
    const room = freshRoom();
    const src = "# room-outputs: out.csv\nprint(1)\n";
    const bytes = Buffer.from(src);
    const file = insertFile(room.db, "s.py", "text/x-python", bytes, src, "upload");
    const notify = vi.fn();
    const deps = depsFor(room, tmpDir("script-run-cache"), {
      notifyFilesChanged: notify,
      execute: async (ws) => {
        fs.writeFileSync(path.join(ws, "out.csv"), "a,b\n");
        return OK;
      },
    });
    const report = await runScriptProcess(
      deps,
      "job-notify",
      0,
      room.path,
      file.id,
      scriptFingerprint(bytes),
      null,
      new CancelFlag()
    );
    expect(report.imported).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);

    const quietRoom = freshRoom();
    const quietBytes = Buffer.from("print(1)\n");
    const quietFile = insertFile(quietRoom.db, "q.py", "text/x-python", quietBytes, "print(1)", "upload");
    const quietNotify = vi.fn();
    const quietDeps = depsFor(quietRoom, tmpDir("script-run-cache"), {
      notifyFilesChanged: quietNotify,
      execute: async () => OK,
    });
    const quiet = await runScriptProcess(
      quietDeps,
      "job-no-notify",
      0,
      quietRoom.path,
      quietFile.id,
      scriptFingerprint(quietBytes),
      null,
      new CancelFlag()
    );
    expect(quiet.imported).toEqual([]);
    expect(quietNotify).not.toHaveBeenCalled();
  });

  it("still deletes the workspace when the room closes between spawn and import-back", async () => {
    // A room can close or swap out from under a long-running script; the
    // import-back phase re-pins and refuses — but the cleanup must not depend
    // on that phase having succeeded.
    const room = freshRoom();
    const bytes = Buffer.from("print(1)\n");
    const file = insertFile(room.db, "s.py", "text/x-python", bytes, "print(1)", "upload");
    const cache = tmpDir("script-run-cache");
    const rooms = new OneRoom({ db: room.db, path: room.path });
    const deps: ScriptRunDeps = {
      rooms,
      cacheDir: cache,
      execute: async () => {
        rooms.handle = null; // the room closes mid-run
        return OK;
      },
    };
    await expect(
      runScriptProcess(deps, "job-roomgone", 0, room.path, file.id, scriptFingerprint(bytes), null, new CancelFlag())
    ).rejects.toThrow(/no longer open/);
    expect(fs.existsSync(wsPathFor(cache, "job-roomgone", 0))).toBe(false);
  });
});

// ============================================================================
// The uv auto-heal retry loop
// ============================================================================

/** Publish a directory holding a file named `uv` as the runtime prefix, so
 * `resolveInterpreter` picks it as the runner on any machine — with or without
 * a real uv installed. (Never spawned: these tests supply their own executor.) */
function publishFakeUv(): string {
  const binDir = tmpDir("script-run-bin");
  fs.writeFileSync(path.join(binDir, "uv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  setCachedPathPrefix(binDir);
  resetBinCachesForTests();
  return binDir;
}

describe("the uv auto-heal retry loop (deterministic, fake executor)", () => {
  function healRoom(source: string): {
    room: { db: Database.Database; path: string };
    fileId: string;
    sha: string;
  } {
    const room = freshRoom();
    const bytes = Buffer.from(source);
    const file = insertFile(room.db, "s.py", "text/x-python", bytes, source, "upload");
    publishFakeUv();
    return { room, fileId: file.id, sha: scriptFingerprint(bytes) };
  }

  it("installs a missing package on the first retry and names it in the report", async () => {
    const { room, fileId, sha } = healRoom("import fakepkg\n");
    const calls: Array<{ timeoutSecs: number; argvPrefix: string[] }> = [];
    const deps = depsFor(room, tmpDir("script-run-cache"), {
      execute: async (_ws, runner, _script, timeoutSecs) => {
        calls.push({ timeoutSecs, argvPrefix: [...runner.argvPrefix] });
        if (calls.length === 1) {
          return { exitCode: 1, stdoutTail: "", stderrTail: "ModuleNotFoundError: No module named 'fakepkg'" };
        }
        return { ...OK, stdoutTail: "ok" };
      },
    });
    const report = await runScriptProcess(deps, "job-heal", 0, room.path, fileId, sha, null, new CancelFlag());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argvPrefix).toContain("--with");
    expect(calls[1]!.argvPrefix[calls[1]!.argvPrefix.indexOf("--with") + 1]).toBe("fakepkg");
    // Every attempt is bounded by the script's OWN declared timeout, never the
    // whole remaining budget.
    expect(calls[1]!.timeoutSecs).toBeLessThanOrEqual(DEFAULT_TIMEOUT_SECS);
    expect(report.exitCode).toBe(0);
    expect(report.skipped.some((s) => s.includes("installed fakepkg from PyPI"))).toBe(true);
  });

  it("gives up when the SAME package is still missing after installing it (PyPI-name mismatch)", async () => {
    const { room, fileId, sha } = healRoom("import cv2\n");
    let calls = 0;
    const deps = depsFor(room, tmpDir("script-run-cache"), {
      execute: async () => {
        calls += 1;
        // `cv2`'s PyPI package is `opencv-python`; installing the import name
        // never clears the error — exactly what the bail-out exists for.
        return { exitCode: 1, stdoutTail: "", stderrTail: "ModuleNotFoundError: No module named 'cv2'" };
      },
    });
    await expect(
      runScriptProcess(deps, "job-stuck", 0, room.path, fileId, sha, null, new CancelFlag())
    ).rejects.toThrow(/Couldn't auto-install 'cv2'/);
    expect(calls).toBe(2); // one attempt + exactly one retry, then it stops
  });

  it("never exceeds MAX_HEAL_ROUNDS even when every round names a NEW missing package", async () => {
    const { room, fileId, sha } = healRoom("import manypkgs\n");
    let calls = 0;
    const deps = depsFor(room, tmpDir("script-run-cache"), {
      execute: async () => {
        calls += 1;
        return {
          exitCode: 1,
          stdoutTail: "",
          stderrTail: `ModuleNotFoundError: No module named 'pkg${calls}'`,
        };
      },
    });
    await expect(
      runScriptProcess(deps, "job-bounded", 0, room.path, fileId, sha, null, new CancelFlag())
    ).rejects.toThrow();
    expect(calls).toBe(9); // 1 initial attempt + exactly MAX_HEAL_ROUNDS (8)
  });

  it("stops healing once the OVERALL wall-clock budget (2× the declared timeout) is spent", async () => {
    vi.useFakeTimers();
    try {
      // `# room-timeout: 10` → total budget 20s; the first attempt burns 19.
      const { room, fileId, sha } = healRoom("# room-timeout: 10\nimport slowpkg\n");
      let calls = 0;
      const deps = depsFor(room, tmpDir("script-run-cache"), {
        execute: async () => {
          calls += 1;
          vi.advanceTimersByTime(19_000);
          return { exitCode: 1, stdoutTail: "", stderrTail: "ModuleNotFoundError: No module named 'slowpkg'" };
        },
      });
      await expect(
        runScriptProcess(deps, "job-deadline", 0, room.path, fileId, sha, null, new CancelFlag())
      ).rejects.toThrow();
      // The 1s left was already under MIN_TIMEOUT_SECS when the loop checked.
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not heal at all for a non-uv runner — only uv can install on the fly", async () => {
    // A `.js` script resolves to node whatever else is installed (JS never
    // reaches the uv branch), so `isUv` is false and the loop must not run:
    // one attempt, then the actionable "declare it" message instead.
    const binDir = tmpDir("script-run-bin");
    fs.writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    setCachedPathPrefix(binDir);
    resetBinCachesForTests();

    const room = freshRoom();
    const src = "console.log(require('left-pad'))\n";
    const bytes = Buffer.from(src);
    const file = insertFile(room.db, "s.js", "text/javascript", bytes, src, "upload");
    let calls = 0;
    const deps = depsFor(room, tmpDir("script-run-cache"), {
      execute: async (_ws, runner) => {
        calls += 1;
        expect(runner.argvPrefix).toEqual([]);
        return { exitCode: 1, stdoutTail: "", stderrTail: "Error: Cannot find module 'left-pad'" };
      },
    });
    await expect(
      runScriptProcess(deps, "job-nouv", 0, room.path, file.id, scriptFingerprint(bytes), null, new CancelFlag())
    ).rejects.toThrow(/dependencies line/);
    expect(calls).toBe(1);
  });
});

describe("the uv auto-heal retry loop (real subprocess, fake package resolution)", () => {
  /**
   * A stand-in for `uv run --no-project [--with pkg]… <script>`: no real uv or
   * network. uv's OWN calling convention puts every flag BEFORE the script
   * name, which `/bin/sh` cannot imitate — so this reproduces uv's argv shape
   * and lets the REAL heal loop run end to end (spawn → parse stderr → retry
   * with `--with` → re-spawn).
   */
  function writeFakeUv(dir: string, resolvablePkg: string | null, pkg: string): void {
    const body =
      resolvablePkg === null
        ? `#!/bin/sh\necho "ModuleNotFoundError: No module named '${pkg}'" 1>&2\nexit 1\n`
        : "#!/bin/sh\n" +
          'args=" $* "\n' +
          'case "$args" in\n' +
          `  *" --with ${resolvablePkg} "*)\n` +
          '    echo "healed ok"\n' +
          "    exit 0\n" +
          "    ;;\n" +
          "  *)\n" +
          `    echo "ModuleNotFoundError: No module named '${pkg}'" 1>&2\n` +
          "    exit 1\n" +
          "    ;;\n" +
          "esac\n";
    fs.writeFileSync(path.join(dir, "uv"), body, { mode: 0o755 });
  }

  it("end to end through runScriptProcess: an undeclared import is auto-installed and the run succeeds", async () => {
    const binDir = tmpDir("script-run-bin");
    writeFakeUv(binDir, "fakepkg", "fakepkg");
    setCachedPathPrefix(binDir);
    resetBinCachesForTests();

    const room = freshRoom();
    const src = "print('ok')\n";
    const bytes = Buffer.from(src);
    const file = insertFile(room.db, "heal.py", "text/x-python", bytes, src, "upload");
    const cache = tmpDir("script-run-cache");
    let notified = 0;
    const deps = depsFor(room, cache, { notifyFilesChanged: () => (notified += 1) });

    const report = await runScriptProcess(
      deps,
      "job-heal-real",
      0,
      room.path,
      file.id,
      scriptFingerprint(bytes),
      null,
      new CancelFlag()
    );
    expect(report.exitCode).toBe(0);
    expect(report.stdoutTail).toContain("healed ok");
    // The report says what was installed behind the user's back — the consent
    // card could not have named an undeclared import.
    expect(report.skipped.some((s) => s.includes("installed fakepkg from PyPI"))).toBe(true);
    expect(fs.existsSync(wsPathFor(cache, "job-heal-real", 0))).toBe(false);
    expect(notified).toBe(0); // nothing written → no broadcast
  });

  it("end to end: a package that never resolves gives up with the PyPI-name hint", async () => {
    const binDir = tmpDir("script-run-bin");
    writeFakeUv(binDir, null, "fakepkg");
    setCachedPathPrefix(binDir);
    resetBinCachesForTests();

    const room = freshRoom();
    const bytes = Buffer.from("print('ok')\n");
    const file = insertFile(room.db, "stuck.py", "text/x-python", bytes, "print('ok')", "upload");
    const deps = depsFor(room, tmpDir("script-run-cache"));
    await expect(
      runScriptProcess(deps, "job-stuck-real", 0, room.path, file.id, scriptFingerprint(bytes), null, new CancelFlag())
    ).rejects.toThrow(/Couldn't auto-install 'fakepkg'/);
  });
});

// ============================================================================
// Real end-to-end through the machine's own interpreter
// ============================================================================

describe("runScriptProcess — real end-to-end", () => {
  it(
    "materializes a declared input, runs the real interpreter, imports the output, cleans up",
    async () => {
      if (python3Bin() === null && uvBin() === null) return; // as the Rust test gates
      const room = freshRoom();
      insertFile(room.db, "in.txt", "text/plain", Buffer.from("hello"), "hello", "upload");
      const src =
        "# room-inputs: in.txt\n" +
        "# room-outputs: out.csv\n" +
        "open('out.csv','w').write('col\\n' + open('in.txt').read().strip() + '\\n')\n";
      const bytes = Buffer.from(src);
      const file = insertFile(room.db, "sync.py", "text/x-python", bytes, src, "upload");
      const cache = tmpDir("script-run-cache");
      let notified = 0;
      const deps = depsFor(room, cache, { notifyFilesChanged: () => (notified += 1) });

      const report = await runScriptProcess(
        deps,
        "job-e2e",
        0,
        room.path,
        file.id,
        scriptFingerprint(bytes),
        null,
        new CancelFlag()
      );
      expect(report.exitCode).toBe(0);
      const out = report.imported.find((f) => f.name === "out.csv");
      expect(out).toBeDefined();
      expect(getFileBytes(room.db, out!.id)?.toString()).toBe("col\nhello\n");
      expect(notified).toBe(1);
      expect(fs.existsSync(wsPathFor(cache, "job-e2e", 0))).toBe(false);
    },
    60_000
  );

  it(
    "a real script that hangs is timed out, its tree killed, and its workspace removed",
    async () => {
      const py = python3Bin();
      if (py === null) return;
      const room = freshRoom();
      const src = "# room-timeout: 5\nimport time\ntime.sleep(60)\n";
      const bytes = Buffer.from(src);
      const file = insertFile(room.db, "hangs.py", "text/x-python", bytes, src, "upload");
      const cache = tmpDir("script-run-cache");
      const deps = depsFor(room, cache);
      await expect(
        runScriptProcess(deps, "job-hang", 0, room.path, file.id, scriptFingerprint(bytes), null, new CancelFlag())
      ).rejects.toThrow(/timed out/);
      expect(fs.existsSync(wsPathFor(cache, "job-hang", 0))).toBe(false);
    },
    30_000
  );

  it(
    "a real script that is Stopped mid-run imports nothing and leaves no workspace",
    async () => {
      const py = python3Bin();
      if (py === null) return;
      const room = freshRoom();
      const src =
        "# room-outputs: out.csv\n" +
        "import time\n" +
        "time.sleep(30)\n" +
        "open('out.csv','w').write('never\\n')\n";
      const bytes = Buffer.from(src);
      const file = insertFile(room.db, "cancelme.py", "text/x-python", bytes, src, "upload");
      const cache = tmpDir("script-run-cache");
      const deps = depsFor(room, cache);
      const cancel = new CancelFlag();
      setTimeout(() => cancel.store(true), 500);
      await expect(
        runScriptProcess(deps, "job-cancel", 0, room.path, file.id, scriptFingerprint(bytes), null, cancel)
      ).rejects.toThrow("STOPPED");
      expect(fs.existsSync(wsPathFor(cache, "job-cancel", 0))).toBe(false);
      // The transactional guarantee: a killed run never writes to the room.
      expect(fs.existsSync(path.join(cache, "out.csv"))).toBe(false);
      expect(() => resolveScriptFile(room.db, "out.csv")).toThrow();
    },
    30_000
  );
});
