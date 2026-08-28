/**
 * Wave 5 (Idea 13): the runnable/schedulable SCRIPT runner — spawns a real
 * child process (`uv`/`python3`/`node`) to execute a room's `.py`/`.js` file.
 *
 * Ported from `src-tauri/src/commands/jobs/script_run.rs` (1963 lines, read in
 * full, including its `#[cfg(test)] mod tests`). This file is the MERGE of two
 * independent candidate ports; the "MERGE FIXES" section below lists every
 * place the merged code deliberately departs from one or both of them.
 *
 * ============================================================================
 * THE SECURITY INVARIANT THIS FILE EXISTS TO ENFORCE
 * ============================================================================
 * Verbatim from the Rust module's own header: a spawned interpreter can NEVER
 * read the SQLCipher room DB. Every run therefore:
 *   1. materializes each declared room-input into a THROWAWAY workspace
 *      (`<cacheDir>/script-runs/<jobId>-<stepId>/`, mode 0700),
 *   2. runs the script there with `cwd` = that directory and a MINIMAL env
 *      that never carries the room path or key — see
 *      {@link executeScriptInWorkspace}: exactly `PATH`/`HOME`/`TMPDIR` and
 *      nothing else. No `env_clear()` equivalent is needed in Node because
 *      `spawn`'s `env` option REPLACES the child's environment rather than
 *      extending `process.env`, so never spreading `process.env` in IS the
 *      whole guarantee,
 *   3. imports declared + NEW outputs back through {@link storeFileBytes}
 *      ONLY after exit 0 (so a Stop/kill/timeout/crash never leaves a partial
 *      room write — the run is transactional from the room's point of view),
 *   4. kills the WHOLE PROCESS GROUP on cancel/timeout, SIGTERM then SIGKILL,
 *      so `uv`'s python child — and anything THAT spawned — dies with it
 *      rather than lingering as an orphan, and
 *   5. deletes the workspace on EVERY outcome ({@link runScriptProcess}'s
 *      `finally`); {@link sweepScriptWorkspaces} is the startup sweep that
 *      clears orphans left by a crash.
 *
 * WHAT "SANDBOXED" DOES **NOT** MEAN HERE — read this before treating a
 * symlink or `../` test as proof of a stronger boundary. Neither the Rust
 * source nor this port puts the child in a chroot, a container or any
 * OS-level filesystem jail: it is an ordinary process, run as the same OS
 * user, with an ordinary cwd. A script that does `open("../../etc/passwd")`,
 * or plants a symlink inside its own workspace and reads through it, succeeds
 * at the OS level — nothing here stops that and nothing in the Rust source did
 * either. Consequently a symlink NAMED as a declared output has its target's
 * bytes imported into the room (`Path::is_file()`/`fs::read` follow links, and
 * so do `fs.statSync`/`fs.readFileSync`): faithfully inherited, not introduced
 * here, and it grants a script no capability it did not already have — it can
 * read any file it likes and write those bytes into an ordinary output. What
 * IS guaranteed is narrower and load-bearing: the child's env and argv never
 * carry the room's file path or its SQLCipher key, and no name — a room file's,
 * a declared output's — can ever resolve OUTSIDE the workspace, because every
 * one of them passes through {@link safeName} first.
 *
 * ============================================================================
 * MERGE FIXES — defects found in the candidate ports (and, for the first
 * three, in the Rust source itself), fixed here rather than carried over.
 * ============================================================================
 * 1. CONSENT BYPASS (both candidates + Rust). `run_script_process` writes the
 *    consented script bytes into the workspace and THEN materializes declared
 *    `# room-inputs:`. A declared input resolves by FUZZY name to "the newest
 *    room file with a matching name" — so a script named `sync.py` that
 *    declares `# room-inputs: sync.py`, in a room that has a second, newer
 *    file of that name, had the interpreter's script file OVERWRITTEN with
 *    that other file's bytes and executed them. The fingerprint gate two
 *    steps earlier ("a mid-run edit never silently runs new code") then
 *    guaranteed nothing. {@link materializeInputs} now takes a `reserved` set
 *    seeded with the script's own workspace name and skips any collision —
 *    the same guard `materialize_named` already applied on the auto-reference
 *    path, which is what makes the omission on the declared path an oversight
 *    rather than a design.
 * 2. WORKSPACE LEAK (both candidates + Rust). The workspace was deleted in a
 *    `finally` around the spawn+import tail ONLY, so a throw while
 *    materializing inputs (an unreadable file, a room name colliding with the
 *    `tmp/` directory) left the directory — and every room byte already
 *    written into it — on disk until the next startup sweep. The `finally`
 *    now begins at {@link makeWorkspace}, which is what the module's own doc
 *    always claimed ("deletes the workspace in the epilogue on EVERY
 *    outcome").
 * 3. `process.kill(-pid)` GUARD (both candidates). Neither checked the pid
 *    before negating it. `process.kill(-0, …)` signals the CALLER's own
 *    process group — the whole Electron app — so a spawn that failed
 *    (`child.pid === undefined`) or any future refactor handing this a 0
 *    would have shot the app instead of the script. {@link killGroup} now
 *    refuses anything that is not an integer > 1.
 * 4. STDIN EPIPE CRASH (candidate A). `child.stdin.end(bytes)` with no
 *    `'error'` listener: a script that exits before reading its stdin closes
 *    the pipe, and the resulting EPIPE on a stream with no error listener is
 *    an UNHANDLED `'error'` event — a thrown exception in the Electron main
 *    process, from a script doing nothing worse than ignoring its input.
 *    Rust's dedicated writer thread ignores exactly this error
 *    (`let _ = si.write_all(&data)`); candidate B's `stdin.on("error", …)` is
 *    its faithful analogue and is what this merge keeps.
 * 5. SPAWN-FAILURE MESSAGE (candidate A) / SYNCHRONOUS SPAWN THROW
 *    (candidate B). A reported a missing interpreter as "Could not start the
 *    script: no pid" (it checked `child.pid === undefined` and threw before
 *    the real `'error'` event could arrive); B waited for the event but let a
 *    SYNCHRONOUS `spawn` throw (an invalid `program`) escape unwrapped. Both
 *    paths now produce Rust's `"Could not start the script: {e}"`.
 * 6. `safeName` (candidate B). `path.basename` is not `Path::file_name()`:
 *    Rust ELIDES `.` components, so `"foo.txt/."` names `"foo.txt"` while
 *    `basename` returns `"."` → the `"file"` fallback. Candidate A's
 *    hand-verified port (checked against real `rustc` output for 20 cases,
 *    table preserved in the test file) is what this merge keeps.
 * 7. UNICODE `trim_end` (candidate A). `withPrintedOutput` trimmed only
 *    `[ \t\r\n]`, where Rust's `str::trim_end` strips all Unicode
 *    whitespace — a script whose last line ended in a non-breaking space
 *    printed a trailing blank into the timeout message.
 * 8. TIMER HYGIENE (both candidates). Every `setTimeout`/`setInterval` this
 *    module creates is now cleared on the path that did not use it: A left a
 *    5s SIGKILL-grace timer and a 2s drain timer pending after every run
 *    (holding the event loop open past the work), B allocated a fresh 250ms
 *    timer per poll iteration for the life of the script. Neither is a
 *    correctness bug; both are the kind of thing that makes a suite hang for
 *    seconds per test and a main process look busy when it is idle.
 * 9. POST-SIGKILL WAIT (candidates A and B in opposite directions). A awaited
 *    the child's `'exit'` UNBOUNDED after SIGKILL — a process wedged in
 *    uninterruptible I/O would hold the single background job slot forever;
 *    B did not wait at all, so it could not tell a killed group from one that
 *    ignored the signal. {@link terminateGroup} now waits, bounded.
 *
 * Fixes 10–13 were found by the adversarial sandbox audit that followed the
 * merge (`scriptRunSandboxAudit.test.ts`), and 10 and 11 are the two that
 * matter — 10 is a broken security guarantee, not a leak of tidiness.
 * 10. TIMEOUT LEFT A LIVE PROCESS (both candidates + Rust). `terminate_group`
 *    returned the moment the DIRECT CHILD exited, so it never escalated to
 *    SIGKILL — and a descendant that ignores SIGTERM (`trap "" TERM`,
 *    `signal.SIG_IGN`; the common shape is `uv` exiting instantly while the
 *    python it spawned does not) survived the SIGTERM, outlived its parent,
 *    and ran FOREVER. Proven end to end: a `# room-timeout: 5` script whose
 *    subprocess ignores SIGTERM reported "timed out" while that subprocess was
 *    still alive afterwards, holding the run's stdio pipes open in the main
 *    process. {@link terminateGroup} now SIGKILLs the group whenever
 *    {@link groupAlive} says anything is still in it.
 * 11. UNSANITIZED JOB ID (both candidates + Rust). {@link makeWorkspace}
 *    `path.join`ed the job id straight into the path and then RECURSIVELY,
 *    FORCIBLY deleted the result: `makeWorkspace(cache, "../../..", 0)`
 *    resolved above the cache directory. Job ids are DB-generated UUIDs, so
 *    nothing reachable exploited it — but it was the one name in this module
 *    that skipped {@link safeName}, against the header's own invariant.
 * 12. DUPLICATE DECLARED OUTPUT (both candidates + Rust). Two `room-outputs:`
 *    entries collapsing to one workspace file (`out.csv` twice, or `../out.csv`
 *    beside `out.csv`) were imported once EACH — a fresh identical version cut
 *    per mention, and the file listed that many times in the report.
 * 13. CAP CHECKED AFTER THE READ (both candidates + Rust). A declared output
 *    was read WHOLE into the main process and only then measured against
 *    `MAX_IMPORT_BYTES`, so a script could make the app allocate gigabytes to
 *    learn it had to skip them — and past Node's buffer limit the read throws,
 *    failing the entire import instead of skipping the one file.
 *
 * ============================================================================
 * DEPENDENCIES REUSED, NOT RE-PORTED
 * ============================================================================
 *   - `db-host/files.ts`: `fileByExactName`, `findFileLike`, `getFileBytes`,
 *     `getFileBytesNamed`, `getFileMeta`, `insertFile`, `listFiles`,
 *     `inTransaction`, `updateFileContent`.
 *   - `db-host/versions.ts`: `snapshotFileVersion`.
 *   - `jobs.ts`: `RoomSource`/`pinnedDb` stand in for
 *     `tauri::State<'_, AppState>`'s room-pin discipline — the SAME seam
 *     `jobs.ts`'s own runners use, not a second one.
 *   - `cancel.ts`: `CancelFlag` stands in for `Arc<AtomicBool>`.
 *   - `textClamp.ts`: `clampBytesMarked` (`clamp_bytes_marked`).
 *   - `editMatchExtraction.ts`: `extensionOf` (`extraction::extension_of`).
 *   - `editMatch.ts`: `extractText` — a NARROWED stand-in for
 *     `extraction::extract_text` (text extensions + docx + html only, see that
 *     file's own doc). A script that writes a PDF/xlsx output is still
 *     imported; it simply carries no extracted text until the rest of
 *     `extraction.rs` is ported.
 *   - `shared/apiTypes.ts`: {@link ScriptManifest} is imported, not
 *     redeclared — that file already carries the exact camelCase shape as part
 *     of the frontend IPC contract, and a second near-copy here is precisely
 *     the drift `db-host/files.ts` warns about for `FileMeta`.
 *
 * PORTED FRESH, because nothing in this migration covers them yet:
 *   - {@link storeFileBytes} — `commands::files::store_file_bytes`, which is
 *     literally `in_transaction(|| { snapshot_file_version(); update_file_
 *     content(); })` over two already-ported primitives.
 *   - {@link cachedPathPrefix}/{@link setCachedPathPrefix} — the accessor
 *     `commands::runtimes::refresh_path_prefix` publishes to. `runtimes.rs`
 *     (pinned-version download + checksum + "Download runtime" UI) has no
 *     Electron port yet, so the cell starts and stays `""` — the exact value
 *     `cached_path_prefix()` returns on a fresh Rust process — until a future
 *     `runtimes.ts` batch calls the setter. The probes below already consult
 *     it first, so that batch needs no change here.
 *   - {@link guessMime} — a small, honest substitute for the `mime_guess`
 *     crate, the same convention `turnEngine.ts`'s own `MIME_BY_EXT` follows
 *     (real for the extensions a generated file actually uses, `text/plain`
 *     otherwise — never a fabricated specific type).
 *
 * NOT WIRED (an honest gap, not a silent one): {@link sweepScriptWorkspaces}.
 * Rust's `lib.rs` calls it once at startup, before any run is live, to remove
 * `script-runs/*` orphaned by a crash. No Electron `app.whenReady()` entry
 * point exists in this migration yet, so there is nowhere to place that call;
 * whichever batch writes it owes this module one line.
 *
 * DEVIATION — process groups. Rust sets `.process_group(0)` (POSIX
 * `setpgid(0,0)`) and kills with `kill -SIG -- -<pgid>`. Node's
 * `spawn(…, { detached: true })` does the equivalent under the hood on POSIX
 * (a new session + process group whose id is the child's pid — "detached" here
 * has nothing to do with whether the parent waits, which it still does via the
 * piped stdio and the `'exit'` event), and `process.kill(-pid, sig)` is the
 * negative-pid form of the same `kill(2)`.
 *
 * DEVIATION — stdin. Rust feeds stdin on a dedicated OS thread so a large
 * input cannot deadlock against an unread pipe while the parent drains
 * stdout/stderr. Node has no such hazard: `stdin.end(bytes)` is buffered by
 * libuv on the same event loop that is draining the other two pipes.
 *
 * DEVIATION — readers. Rust drains stdout/stderr on two blocking threads into
 * 32 KB ring tails and waits (bounded) for both to hit EOF after the child
 * exits. Node's streams are evented, so {@link RingTail} is filled by `'data'`
 * listeners and the bounded EOF wait becomes a bounded wait on the child's own
 * `'close'` event — which IS "every stdio stream has ended".
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";

import type { CancelFlag } from "./cancel.js";
import { extractText } from "./editMatch.js";
import { extensionOf } from "./editMatchExtraction.js";
import {
  fileByExactName,
  findFileLike,
  getFileBytes,
  getFileBytesNamed,
  getFileMeta,
  inTransaction,
  insertFile,
  listFiles,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { clampBytesMarked } from "./textClamp.js";
import type { ScriptManifest } from "../shared/apiTypes.js";
import { createRoomFile, readRoomFile, writeRoomFile } from "./workspace/roomContent.js";

export type { ScriptManifest };

// ============================================================================
// Constants — script_run.rs's own module-level `const`s, verbatim values.
// ============================================================================

/** Default script timeout (seconds) — the first `uv` run resolves and
 * downloads wheels, so the default is generous. */
export const DEFAULT_TIMEOUT_SECS = 600;
export const MIN_TIMEOUT_SECS = 5;
export const MAX_TIMEOUT_SECS = 3600;
/** Stdout/stderr are drained into 32 KB ring tails. */
export const RING_BYTES = 32 * 1024;
/** How many times the uv runner will auto-install a missing package and retry
 * before giving up (one new package per round). Bounds the loop; enough for a
 * typical data-science script (pandas + yfinance + a couple more). */
export const MAX_HEAL_ROUNDS = 8;
/** Auto-import caps for NEW (undeclared) files a script creates (decision 2). */
export const MAX_NEW_FILES = 20;
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
/** Cap on room files auto-materialized by name-reference (read side). Bounds
 * the pre-run copy so a room with a huge file list can't balloon the
 * workspace; matches beyond the cap are skipped (a script can still declare
 * them via `# room-inputs:`). */
export const MAX_AUTO_MATERIALIZE = 20;
/** Grace between SIGTERM and SIGKILL when killing the process group. */
export const KILL_GRACE_MS = 5_000;
/** How long to wait for the stdout/stderr streams to reach EOF after the
 * script exits, before reporting the tails we have. */
export const READER_FLUSH_GRACE_MS = 2_000;
/** Total wall-clock budget for one script node, as a multiple of the script's
 * own timeout. The auto-heal loop re-runs the whole script once per missing
 * package, and each attempt used to get the FULL timeout again with no overall
 * cap — eight rounds of a 10-minute script held the single background slot for
 * an hour and a half while everything else waited. */
export const TOTAL_TIMEOUT_MULTIPLE = 2;
/** How often the run loop notices a Stop, matching Rust's 250ms poll. */
const CANCEL_POLL_MS = 250;
/** The exact PATH handed to every script. Never `process.env.PATH`. */
const SPAWN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
/** The sentinel a cancelled run rejects with — callers compare by message,
 * exactly as the Rust source's `Err("STOPPED".into())` is compared. */
export const STOPPED = "STOPPED";

// ============================================================================
// Manifest
// ============================================================================

/** A script's language, from its file extension — the wire form of Rust's
 * `ScriptLang` (`#[serde(rename_all = "snake_case")]`), which is exactly
 * `ScriptManifest.interpreter`'s type in `apiTypes.ts`. */
export type ScriptLang = ScriptManifest["interpreter"];

/** Where a script surfaces as a one-click shortcut (decision 3). `file` = the
 * headers of its declared input/output files; `global` = the TopBar; `none` =
 * no shortcut (still runnable from the Scripts page + file header). */
export type Shortcut = ScriptManifest["shortcut"];

/** `ScriptManifest::has_deps` — a plain function, since a TS interface carries
 * no behaviour. */
export function hasDeps(manifest: ScriptManifest): boolean {
  return manifest.deps.length > 0;
}

/** Language for a file name; `null` if it isn't a script we run. */
export function scriptLangOf(name: string): ScriptLang | null {
  const ext = extensionOf(name);
  if (ext === "py") return "py";
  if (ext === "js") return "js";
  return null;
}

/**
 * Resolve a `script_run` node's `file` (a stored file id, OR a name) to
 * (id, real name, bytes).
 *
 * The ONE resolver. Consent stamping, the manual consent card and the executor
 * each grew their own copy in Rust, and because a name resolves to "the newest
 * file with a matching name" they could disagree the moment a similarly named
 * file arrived between approving a script and running it — the run then parked
 * with "isn't approved on this Mac yet" for a script just approved.
 */
export interface ResolvedScriptFile {
  id: string;
  name: string;
  bytes: Buffer;
}

export function resolveScriptFile(db: Database.Database, file: string): ResolvedScriptFile {
  // An exact id first, then a fuzzy name match (the agent passes names).
  let id: string;
  try {
    getFileBytesNamed(db, file);
    id = file;
  } catch {
    id = findFileLike(db, file)[0];
  }
  const [name, bytes] = getFileBytesNamed(db, id);
  return { id, name, bytes: bytes ?? Buffer.alloc(0) };
}

/** SHA-256 (hex) of the script's raw bytes — the content-addressed consent key
 * (the `text_digest` idea, over bytes). Any edit changes the hash → the old
 * approval no longer counts, so a changed script re-prompts for free. */
export function scriptFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** If `content` (with `lower` its lowercase) begins with `key:`, return the raw
 * value after the colon (original case preserved for file names). */
function stripKey(lower: string, content: string, key: string): string | null {
  const want = `${key}:`;
  return lower.startsWith(want) ? content.slice(want.length) : null;
}

/** Comma-separated file names → trimmed, non-empty list. */
function splitNames(v: string): string[] {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Pull the quoted strings out of a `dependencies = ["a", "b"]` line.
 * Tolerant: it does not require valid TOML, just the quoted tokens. */
function extractQuoted(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const quote = c;
      let token = "";
      i += 1;
      while (i < s.length && s[i] !== quote) {
        token += s[i];
        i += 1;
      }
      // `i` now sits on the closing quote, or ran off the end — which is also
      // what Rust's `chars.by_ref()` loop does with an unterminated quote.
      i += 1;
      const t = token.trim();
      if (t !== "") out.push(t);
    } else {
      i += 1;
    }
  }
  return out;
}

/** Strict base-10 unsigned parse mirroring Rust's `str::parse::<u64>()`: every
 * character must be a digit or the whole parse fails — unlike
 * `Number.parseInt`, which happily reads the numeric PREFIX off "12abc". */
function parseU64(s: string): number | null {
  const t = s.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse the manifest from a script's text (decision 3's grammar). Pure — no
 * I/O. Scans the first 64 lines; comment prefix `#` for `.py`, `//` for `.js`;
 * first occurrence of each key wins; keys are case-insensitive. A missing
 * PEP-723 block means self-contained (no deps).
 */
export function parseScriptManifest(name: string, text: string): ScriptManifest {
  const lang: ScriptLang = scriptLangOf(name) ?? "py";
  const prefix = lang === "py" ? "#" : "//";
  let deps: string[] = [];
  let inputs: string[] = [];
  let outputs: string[] = [];
  let timeoutSecs: number | null = null;
  let shortcut: Shortcut | null = null;
  let depsSeen = false;
  let inputsSeen = false;
  let outputsSeen = false;

  for (const raw of text.split("\n").slice(0, 64)) {
    const line = raw.trimStart();
    if (!line.startsWith(prefix)) continue;
    const content = line.slice(prefix.length).trim();
    const lower = content.toLowerCase();

    // PEP-723 inline dependencies line — read tolerantly, for display and the
    // has-deps decision (uv is the authoritative parser at run time).
    if (!depsSeen && lower.startsWith("dependencies") && content.includes("=")) {
      deps = extractQuoted(content);
      depsSeen = true;
      continue;
    }
    const inputsVal = stripKey(lower, content, "room-inputs");
    const outputsVal = stripKey(lower, content, "room-outputs");
    const timeoutVal = stripKey(lower, content, "room-timeout");
    const shortcutVal = stripKey(lower, content, "room-shortcut");
    if (inputsVal !== null) {
      if (!inputsSeen) {
        inputs = splitNames(inputsVal);
        inputsSeen = true;
      }
    } else if (outputsVal !== null) {
      if (!outputsSeen) {
        outputs = splitNames(outputsVal);
        outputsSeen = true;
      }
    } else if (timeoutVal !== null) {
      if (timeoutSecs === null) {
        const n = parseU64(timeoutVal);
        if (n !== null) {
          timeoutSecs = Math.min(Math.max(n, MIN_TIMEOUT_SECS), MAX_TIMEOUT_SECS);
        }
      }
    } else if (shortcutVal !== null) {
      if (shortcut === null) {
        const v = shortcutVal.trim().toLowerCase();
        if (v === "global" || v === "file" || v === "none") {
          shortcut = v;
        }
      }
    }
  }

  // Default shortcut: file when the script touches room files, else none.
  const resolvedShortcut: Shortcut =
    shortcut ?? (inputs.length === 0 && outputs.length === 0 ? "none" : "file");

  return {
    interpreter: lang,
    deps,
    inputs,
    outputs,
    timeoutSecs: timeoutSecs ?? DEFAULT_TIMEOUT_SECS,
    shortcut: resolvedShortcut,
  };
}

// ============================================================================
// Interpreter selection — pure policy + the real-machine probes
// ============================================================================

/** Which runtime a script runs on. Pure policy output (decision 4). */
export type RunnerChoice = "uv" | "python3" | "node";

/** A resolved runtime: the program path + the argv prefix before the script. */
export interface Runner {
  readonly program: string;
  readonly argvPrefix: string[];
}

/**
 * Pure runtime-selection policy (decision 4), split out for the unit-test
 * matrix (uv/no-uv × deps/no-deps × py/js). `uv`/`py3`/`node` say whether each
 * is installed. Throws with the exact user-facing sentence Rust's
 * `Result<RunnerChoice, String>` carries; {@link resolveInterpreter} is the
 * only caller that enriches it.
 */
export function interpreterPolicy(
  uv: boolean,
  py3: boolean,
  node: boolean,
  lang: ScriptLang,
  scriptHasDeps: boolean
): RunnerChoice {
  if (lang === "py") {
    // uv handles both dependency-free and PEP-723 scripts.
    if (uv) return "uv";
    if (scriptHasDeps) {
      throw new Error(
        "This script needs extra Python packages. Install uv (run `brew install uv`) to run scripts with dependencies."
      );
    }
    if (py3) return "python3";
    throw new Error(
      "No Python interpreter was found. Install Python 3, or uv (`brew install uv`), to run this script."
    );
  }
  if (scriptHasDeps) {
    throw new Error(
      "JavaScript scripts with dependencies aren't supported yet — remove the dependency declaration to run this script."
    );
  }
  if (node) return "node";
  throw new Error("Node.js isn't installed. Install it (`brew install node`) to run JavaScript scripts.");
}

function home(): string {
  return process.env["HOME"] ?? "";
}

/** Probe a binary by an absolute-path candidate list, then a login-shell
 * fallback (a GUI launch has only a bare launchd PATH; user tools live in PATH
 * via `.zshrc`). Mirrors `ollama_lifecycle::ollama_bin`. */
function probeBin(candidates: readonly string[], loginProbe: string): string | null {
  for (const cand of candidates) {
    if (cand !== "" && fs.existsSync(cand)) return cand;
  }
  try {
    const res = spawnSync("zsh", ["-ilc", loginProbe], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    // Rust reads `lines().next()` — the FIRST line only, non-empty or nothing.
    const first = res.stdout.split("\n")[0]?.trim() ?? "";
    return first === "" ? null : first;
  } catch {
    return null;
  }
}

/**
 * What `commands::runtimes::refresh_path_prefix` publishes for readers with no
 * app handle. No provisioning system exists in this migration yet (see the
 * module header), so the cell starts and stays empty until a future
 * `runtimes.ts` batch calls {@link setCachedPathPrefix}.
 */
let pathPrefixCell = "";

export function cachedPathPrefix(): string {
  return pathPrefixCell;
}

/** For a future `runtimes.ts` port — or a test — to publish a prefix. */
export function setCachedPathPrefix(prefix: string): void {
  pathPrefixCell = prefix;
}

/** `<dir>/<leaf>` for every directory in the app's published runtime prefix —
 * the copies the app downloaded, ahead of anything on the system. */
function provisionedFirst(prefix: string, leaf: string, system: readonly string[]): string[] {
  return [
    ...prefix
      .split(":")
      .filter((d) => d !== "")
      .map((d) => `${d}/${leaf}`),
    ...system,
  ];
}

/**
 * One binary's probe result, cached against the runtime PATH prefix it was
 * probed under.
 *
 * Rust used a plain `OnceLock` and cached the FIRST answer for the life of the
 * process, so a `uv` downloaded mid-session for an MCP connector was invisible
 * here and a script with dependencies was refused with "install uv" while uv
 * sat in the app's own data folder. Keying on the published prefix picks up a
 * mid-session download on the next run without re-running the `zsh -ilc` probe
 * every time.
 */
interface BinCache {
  prefix: string;
  found: string | null;
}

function cachedBin(
  cell: { value: BinCache | null },
  candidates: (prefix: string) => string[],
  loginProbe: string
): string | null {
  const prefix = cachedPathPrefix();
  if (cell.value !== null && cell.value.prefix === prefix) {
    return cell.value.found;
  }
  const found = probeBin(candidates(prefix), loginProbe);
  cell.value = { prefix, found };
  return found;
}

const uvCache: { value: BinCache | null } = { value: null };
export function uvBin(): string | null {
  return cachedBin(
    uvCache,
    (prefix) => {
      const c = provisionedFirst(prefix, "uv", []);
      c.push(`${home()}/.local/bin/uv`);
      c.push("/opt/homebrew/bin/uv");
      c.push("/usr/local/bin/uv");
      return c;
    },
    "command -v uv"
  );
}

const python3Cache: { value: BinCache | null } = { value: null };
export function python3Bin(): string | null {
  return cachedBin(
    python3Cache,
    () => ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"],
    "command -v python3"
  );
}

const nodeCache: { value: BinCache | null } = { value: null };
export function nodeBin(): string | null {
  return cachedBin(
    nodeCache,
    (prefix) =>
      provisionedFirst(prefix, "node", ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]),
    "command -v node"
  );
}

/** Test-only: forget every cached probe result. Rust needs no such reset —
 * each `#[test]` gets its own process — but a single long-lived vitest process
 * does, or one test's stubbed candidate path silently answers the next one. */
export function resetBinCachesForTests(): void {
  uvCache.value = null;
  python3Cache.value = null;
  nodeCache.value = null;
}

/** Resolve the runtime for a script, per {@link interpreterPolicy} + the
 * probes. Enriches the deps-need-uv error with the actual package names. */
export function resolveInterpreter(manifest: ScriptManifest): Runner {
  const needsDeps = hasDeps(manifest);
  let choice: RunnerChoice;
  try {
    choice = interpreterPolicy(
      uvBin() !== null,
      python3Bin() !== null,
      nodeBin() !== null,
      manifest.interpreter,
      needsDeps
    );
  } catch (e) {
    if (manifest.interpreter === "py" && needsDeps && uvBin() === null) {
      throw new Error(
        `This script needs ${manifest.deps.join(", ")}. Install uv (\`brew install uv\`) to run scripts with dependencies.`
      );
    }
    throw e;
  }
  if (choice === "uv") {
    // Install declared deps via explicit `--with` flags rather than relying on
    // uv's own PEP-723 parse: a bare `# dependencies = [...]` line (no full
    // `# /// script … # ///` fence) then still installs, so the assistant only
    // has to list the packages — uv does the rest, no manual pip. `--with` is
    // idempotent and cached across runs.
    const argv = ["run", "--no-project"];
    for (const d of manifest.deps) {
      argv.push("--with", d);
    }
    return { program: uvBin() ?? "", argvPrefix: argv };
  }
  if (choice === "python3") {
    return { program: python3Bin() ?? "", argvPrefix: [] };
  }
  return { program: nodeBin() ?? "", argvPrefix: [] };
}

// ============================================================================
// Workspace
// ============================================================================

/** The root under which every run's throwaway workspace lives. `cacheDir` is
 * the caller-resolved `app_cache_dir()` equivalent — this migration's
 * established convention (see `windowGeometry.ts`/`mcpConfig.ts`) of taking a
 * resolved path rather than reaching for Electron's `app.getPath()` from
 * inside a ported module. */
export function scriptRunsRoot(cacheDir: string): string {
  return path.join(cacheDir, "script-runs");
}

/** Remove every orphaned `script-runs/*` workspace left by a crash. Called at
 * startup (the `quiesce_stale_jobs` spirit) — at startup no run is live. See
 * the module header: nothing calls this yet. */
export function sweepScriptWorkspaces(cacheDir: string): void {
  try {
    fs.rmSync(scriptRunsRoot(cacheDir), { recursive: true, force: true });
  } catch {
    // best-effort, mirrors Rust's `let _ = std::fs::remove_dir_all(...)`
  }
}

/**
 * Create `script-runs/<jobId>-<stepId>/` at mode 0700, plus a `tmp/` for
 * TMPDIR. The STEP is part of the name, not just the job: two script steps of
 * one workflow can be ready in the same wave and run side by side, and a
 * workspace named after the job alone meant the second one's "start clean"
 * wiped the first one's inputs and outputs mid-run.
 *
 * 0700 is forced by an explicit `chmod` AFTER creation, not by `mkdir`'s own
 * mode argument: the mode requested through `mkdir(2)` is masked by the
 * process umask, `chmod(2)` is not. (Rust's `set_permissions` call is separate
 * for the same reason.)
 */
export function makeWorkspace(cacheDir: string, jobId: string, stepId: number): string {
  // The leaf goes through `safeName` for the same reason every room name does
  // (merge fix 11). `path.join` is not a boundary: a job id of `../../..` made
  // `dir` resolve ABOVE the cache directory, and the very next statement is a
  // recursive, forced delete of whatever is there. Job ids are database-
  // generated UUIDs today, so this is defence in depth — but it was also the
  // one user-shaped name in this module that did not pass through `safeName`,
  // which is exactly the inconsistency the header's invariant rules out.
  const dir = path.join(scriptRunsRoot(cacheDir), safeName(`${jobId}-${stepId}`));
  // Start clean (a resumed step reuses the same directory name).
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, "tmp"), { recursive: true });
  return dir;
}

/** A file we placed in the workspace before the run: its name and content
 * hash, so import-back can tell an untouched input from one modified in
 * place. */
export interface Materialized {
  readonly name: string;
  readonly sha: string;
}

/**
 * Keep a file name to its basename so a room name can never escape the
 * workspace (defence in depth — room names are user-controlled).
 *
 * A port of `Path::new(name).file_name()` (Unix), which — unlike a naive
 * `split("/").pop()` or Node's `path.basename` — elides `.` components
 * anywhere in the string and reports "no file name" (here: the `"file"`
 * fallback) whenever the LAST remaining component is empty, `.` or `..`.
 * Earlier `..` components are NOT resolved against anything before them (a
 * Rust `Path` never touches the filesystem or lexically collapses `..`), so
 * `"a/../b"` still names `"b"`.
 *
 * Verified against real `rustc` output for 20 cases, the table kept as an
 * executable artifact in `scriptRun.test.ts`: `"../../etc/passwd"` →
 * `"passwd"`, `"foo.txt/.."` → `"file"` (Rust: `None`), `"foo.txt/."` →
 * `"foo.txt"`, `"/"`/`""`/`".."`/`"."` → `"file"`, a literal backslash is NOT
 * a separator (`"a\\b.txt"` stays whole — Unix `Path` semantics, and this is a
 * Mac-only app), and non-ASCII/space-only names pass through unchanged.
 *
 * The one guarantee that matters: the result never contains a `/`, is never
 * `.`/`..`/empty, so `path.join(ws, safeName(x))` is always a direct child of
 * the workspace.
 */
export function safeName(name: string): string {
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  const last = parts[parts.length - 1];
  if (last === undefined || last === "" || last === "." || last === "..") {
    return "file";
  }
  return last;
}

/** Shortest room-file name that may auto-materialize by being MENTIONED, and
 * the rule that it must look like a file name. Without them a room file called
 * "s" or "df" appeared inside almost any program text and was copied into
 * every script's workspace — where the script writing its own `df` would
 * overwrite it. */
const MIN_REFERENCE_NAME = 4;

/** A "name character" for {@link mentionsFileName}'s boundary check — Rust's
 * `char::is_alphanumeric()` (Unicode-aware, so Hebrew and accented names count
 * too) plus the three punctuation marks the Rust source also allows inside a
 * token. */
function isNameChar(ch: string): boolean {
  return /[\p{L}\p{N}_.-]/u.test(ch);
}

/** Whether `name` occurs in `text` as a whole token — not glued to more name
 * characters on either side, so `data.csv` does not match `mydata.csv.bak`.
 * Non-overlapping scan, mirroring `str::match_indices`. */
export function mentionsFileName(text: string, name: string): boolean {
  if (name === "") return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at === -1) return false;
    const beforeChar = at > 0 ? text[at - 1] : undefined;
    const afterChar = text[at + name.length];
    const before = beforeChar === undefined || !isNameChar(beforeChar);
    const after = afterChar === undefined || !isNameChar(afterChar);
    if (before && after) return true;
    from = at + name.length;
  }
}

/**
 * Room-file names that appear VERBATIM in the script text, in the room's
 * listing order, capped at `cap`. Pure — no I/O, and no dedup against declared
 * inputs (the caller handles that). This lets
 * `pd.read_csv('ETF Tracker — AI Full Stack.csv')` find its file even when the
 * script declared no `# room-inputs:`.
 *
 * A name only qualifies if it reads like a file name — at least
 * {@link MIN_REFERENCE_NAME} Unicode scalar values, carrying an extension, and
 * appearing as a whole token. A script can still reach anything else by
 * declaring it in `# room-inputs:`.
 */
export function referencedRoomFiles(
  text: string,
  roomFiles: readonly string[],
  cap: number
): string[] {
  const out: string[] = [];
  for (const name of roomFiles) {
    if (out.includes(name)) continue;
    // `.length` counts UTF-16 code units; Rust's `chars().count()` counts
    // Unicode scalar values, which is what `[...name]` iterates.
    if ([...name].length < MIN_REFERENCE_NAME || extensionOf(name) === "") continue;
    if (mentionsFileName(text, name)) {
      out.push(name);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/**
 * Write each declared input's bytes into the workspace under its real room
 * name (`findFileLike` — newest match wins, same as the agent's tools). A
 * declared input that has no match in the room is skipped (its absence is
 * honest).
 *
 * SECURITY (merge fix 1, see the module header): `reserved` names files
 * already in the workspace that a declared input must never overwrite — above
 * all THE SCRIPT ITSELF, whose bytes were fingerprint-checked against the
 * user's consent moments earlier. Without it, `# room-inputs: <the script's
 * own name>` in a room holding a newer file of that name replaced the
 * consented bytes on disk and the interpreter ran the other file.
 */
export function materializeInputs(
  db: Database.Database,
  ws: string,
  inputs: readonly string[],
  reserved: ReadonlySet<string> = new Set()
): Materialized[] {
  const out: Materialized[] = [];
  for (const want of inputs) {
    let id: string;
    let realName: string;
    try {
      [id, realName] = findFileLike(db, want);
    } catch {
      continue;
    }
    const safe = safeName(realName);
    if (reserved.has(safe) || out.some((m) => m.name === safe)) continue;
    const bytes = getFileBytes(db, id);
    if (bytes === null) continue;
    fs.writeFileSync(path.join(ws, safe), bytes);
    out.push({ name: safe, sha: scriptFingerprint(bytes) });
  }
  return out;
}

/**
 * Materialize specific room files by their EXACT name into the workspace,
 * skipping any whose {@link safeName} collides with a file already
 * materialized (a declared input, or the script). Used for the
 * auto-materialized name-referenced files, which we resolve precisely
 * (`fileByExactName`) rather than fuzzily. Records each as
 * {@link Materialized} so import-back knows it was "used" and can save it if
 * the script modified it in place.
 */
export function materializeNamed(
  db: Database.Database,
  ws: string,
  names: readonly string[],
  already: ReadonlySet<string>
): Materialized[] {
  const out: Materialized[] = [];
  for (const name of names) {
    const safe = safeName(name);
    if (already.has(safe) || out.some((m) => m.name === safe)) continue;
    const meta = fileByExactName(db, name);
    if (meta === null) continue;
    const bytes = getFileBytes(db, meta.id);
    if (bytes === null) continue;
    fs.writeFileSync(path.join(ws, safe), bytes);
    out.push({ name: safe, sha: scriptFingerprint(bytes) });
  }
  return out;
}

async function materializeInputsInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  inputs: readonly string[],
  reserved: ReadonlySet<string>,
): Promise<Materialized[]> {
  const out: Materialized[] = [];
  for (const want of inputs) {
    let id: string;
    let realName: string;
    try { [id, realName] = findFileLike(db, want); } catch { continue; }
    const safe = safeName(realName);
    if (reserved.has(safe) || out.some((item) => item.name === safe)) continue;
    const file = await readRoomFile({ db, path: roomPath }, id);
    if (file.bytes === null) continue;
    fs.writeFileSync(path.join(ws, safe), file.bytes);
    out.push({ name: safe, sha: scriptFingerprint(file.bytes) });
  }
  return out;
}

async function materializeNamedInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  names: readonly string[],
  already: ReadonlySet<string>,
): Promise<Materialized[]> {
  const out: Materialized[] = [];
  for (const name of names) {
    const safe = safeName(name);
    if (already.has(safe) || out.some((item) => item.name === safe)) continue;
    const meta = fileByExactName(db, name);
    if (meta === null) continue;
    const file = await readRoomFile({ db, path: roomPath }, meta.id);
    if (file.bytes === null) continue;
    fs.writeFileSync(path.join(ws, safe), file.bytes);
    out.push({ name: safe, sha: scriptFingerprint(file.bytes) });
  }
  return out;
}

// ============================================================================
// Execution
// ============================================================================

/** One process run's raw result. */
export interface ExecOut {
  readonly exitCode: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

/**
 * The last {@link RING_BYTES} of a stream, plus how many bytes fell out of the
 * FRONT of it. Without the counter a chatty script's output was silently cut
 * at the beginning and then labelled "(output truncated)" at the end, so the
 * assistant — told to quote the output as the answer — could not tell that the
 * figure it was looking for had been dropped.
 */
export class RingTail {
  private buf: Buffer = Buffer.alloc(0);
  private droppedBytes = 0;

  /** Append a chunk, evicting from the front once past {@link RING_BYTES}. */
  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    if (this.buf.length > RING_BYTES) {
      const drop = this.buf.length - RING_BYTES;
      this.droppedBytes += drop;
      // Copy rather than retain a view onto the larger concatenation.
      this.buf = Buffer.from(this.buf.subarray(drop));
    }
  }

  get dropped(): number {
    return this.droppedBytes;
  }

  /** What survived the ring, with the missing beginning named when there is
   * one. Ported from `tail_string`. */
  tailString(): string {
    if (this.droppedBytes === 0) {
      return this.buf.toString("utf8");
    }
    // The ring cuts on a byte, so what survives can begin mid-character. Drop
    // the orphaned continuation bytes rather than emit a stray U+FFFD.
    let start = this.buf.length;
    for (let i = 0; i < this.buf.length; i += 1) {
      if ((this.buf[i]! & 0xc0) !== 0x80) {
        start = i;
        break;
      }
    }
    return `[earlier output omitted — ${this.droppedBytes} bytes]\n${this.buf.subarray(start).toString("utf8")}`;
  }
}

/**
 * Attach what the script printed to a message that ends the run without an
 * exit code. A timeout used to be a single sentence: a script that printed its
 * progress and then hung left the user and the assistant nothing to diagnose
 * with, while an ordinary non-zero exit surfaces its stderr tail.
 */
function withPrintedOutput(msg: string, out: RingTail, err: RingTail): string {
  let printed = "";
  for (const raw of [out.tailString(), err.tailString()]) {
    // Rust's `str::trim_end` strips ALL Unicode whitespace, not just ASCII.
    const trimmed = raw.replace(/\s+$/u, "");
    if (trimmed.trim() === "") continue;
    if (printed !== "") printed += "\n";
    printed += trimmed;
  }
  if (printed !== "") {
    msg += "\n\nOutput before it was stopped:\n";
    // Marked, not silently clamped: two 32 KB tails do not fit in 4 KB, and an
    // unmarked cut reads to the model — and the user — as the whole of what
    // the script printed before it hung.
    msg += clampBytesMarked(printed, 4_000, "\n… (the rest of what it printed is not shown)");
  }
  return msg;
}

/** Whether the OS has reported this child as finished (Node sets one of these
 * before it emits `'exit'`). The analogue of a successful `try_wait()`. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolve when the child exits, or after `ms` — whichever comes first, with
 * the timer cleared either way so a finished run never holds the event loop
 * open. Returns whether the child had exited. */
function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const onExit = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
    timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, ms);
  });
}

/** Await `promise`, giving up after `ms` — with the timer cleared on the fast
 * path. */
function within(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * `kill -SIG -- -<pgid>`: signal the WHOLE process group (a negative pid to
 * `process.kill`, exactly as to the POSIX `kill(2)` Rust shells out to).
 *
 * The `pid > 1` guard is not decoration: `process.kill(-0, sig)` signals the
 * CALLER's own process group — this whole app — and `child.pid` is `undefined`
 * whenever a spawn failed. Best-effort otherwise: a group that has already
 * exited raises ESRCH, swallowed like Rust's `let _ = Command::new("kill")…`.
 */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already dead, or no permission — best-effort
  }
}

/**
 * Whether the process GROUP led by `pid` still has any member. Signal `0`
 * performs `kill(2)`'s existence/permission check without delivering anything.
 * Only `ESRCH` — "no such process group" — proves the group is empty; `EPERM`
 * means it exists but is not ours, which cannot happen for our own descendants
 * and is reported as "still there" rather than assumed away.
 */
function groupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Wait until POSIX reports that the whole process group is gone. Signal
 * delivery is asynchronous: immediately returning after `kill(-pgid,
 * SIGKILL)` leaves a small but real window where a cancelled grandchild still
 * exists. Keep the wait bounded so a process wedged in uninterruptible I/O
 * can never pin Arcelle's single script slot forever. */
async function groupGoneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/**
 * SIGTERM the group, wait a grace period, then SIGKILL and confirm — the
 * `ollama_lifecycle` kill pattern, applied to the whole group so `uv`'s python
 * child, and anything THAT spawned, dies with it.
 *
 * The post-SIGKILL wait is BOUNDED (merge fix 9): SIGKILL cannot be caught, so
 * it settles immediately in every real case, but a process wedged in
 * uninterruptible I/O must not hold the single background job slot forever.
 *
 * The group is swept even when the DIRECT CHILD died on the SIGTERM (merge fix
 * 10): "the child exited" is not "the tree is gone", and a descendant that
 * ignores SIGTERM outlives its parent by definition.
 */
async function terminateGroup(child: ChildProcess, pid: number): Promise<void> {
  killGroup(pid, "SIGTERM");
  if (!(await exitedWithin(child, KILL_GRACE_MS))) {
    killGroup(pid, "SIGKILL");
    await exitedWithin(child, KILL_GRACE_MS);
    await groupGoneWithin(pid, KILL_GRACE_MS);
    return;
  }
  // The direct child is gone — the GROUP may not be. `uv` exits on SIGTERM
  // while the python it spawned is free to have installed a handler that
  // ignores it (`signal.SIG_IGN`, `trap "" TERM`); returning here left that
  // grandchild running FOREVER as an orphan — burning CPU, holding this run's
  // stdio pipes open in the main process, and outliving the timeout that was
  // supposed to end it. SIGKILL cannot be ignored.
  if (groupAlive(pid)) {
    killGroup(pid, "SIGKILL");
    await groupGoneWithin(pid, KILL_GRACE_MS);
  }
}

/**
 * Spawn the script in its own process group and drive it to completion,
 * honoring cancel + timeout via SIGTERM→SIGKILL of the whole group. App-free
 * (only `Runner`/`CancelFlag`), so it is directly unit-testable.
 *
 * Rejects with `Error("STOPPED")` on cancel — the sentinel callers compare
 * against by message, exactly like Rust's `Err("STOPPED".into())` — or with
 * the timeout message plus whatever the script had printed on timeout. A
 * non-zero exit is NOT a rejection: it comes back as {@link ExecOut} so the
 * heal loop can read the stderr tail.
 */
export async function executeScriptInWorkspace(
  ws: string,
  runner: Runner,
  scriptName: string,
  timeoutSecs: number,
  cancel: CancelFlag,
  stdin: Uint8Array | null = null
): Promise<ExecOut> {
  const outRing = new RingTail();
  const errRing = new RingTail();

  let child: ChildProcess;
  try {
    child = spawn(runner.program, [...runner.argvPrefix, scriptName], {
      cwd: ws,
      // Minimal env — NEVER the room path or key. `env` REPLACES the child's
      // environment (this is `env_clear()`), and a workspace-local TMPDIR
      // keeps any scratch the script writes inside the sweepable folder.
      env: {
        PATH: SPAWN_PATH,
        HOME: home(),
        TMPDIR: path.join(ws, "tmp"),
      },
      // A `transform`-mode workflow node feeds the upstream {{input}} on
      // stdin; otherwise stdin is /dev/null (a script never blocks on a tty).
      stdio: [stdin !== null ? "pipe" : "ignore", "pipe", "pipe"],
      // Its own process group so `kill -- -<pgid>` reaches every descendant.
      detached: true,
    });
  } catch (e) {
    // `spawn` throws synchronously for an invalid program/arguments; a missing
    // binary surfaces asynchronously as an 'error' event, handled below.
    throw new Error(`Could not start the script: ${(e as Error).message}`);
  }

  // Every listener is registered UP FRONT, before anything can fire: an
  // 'error'/'exit'/'close' that arrives before we race it must not be missed.
  const spawnFailure: { error: Error | null } = { error: null };
  const spawnFailed = new Promise<void>((resolve) => {
    child.once("error", (err: Error) => {
      spawnFailure.error = new Error(`Could not start the script: ${err.message}`);
      resolve();
    });
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  // `'close'` is "every stdio stream has ended" — Node's own equivalent of
  // joining Rust's two reader threads.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  child.stdout?.on("data", (chunk: Buffer) => outRing.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => errRing.push(chunk));
  if (stdin !== null && child.stdin !== null) {
    // Best-effort, mirroring Rust's ignored `write_all`: a script that exits
    // before reading its stdin closes the pipe under us, and an EPIPE on a
    // stream with no 'error' listener is an unhandled event — i.e. a crash of
    // the whole main process over a script ignoring its input.
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(stdin));
  }

  const pid = child.pid;

  type Outcome = "exited" | "cancelled" | "timedout" | "spawn-failed";
  let cancelPoll: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let outcome: Outcome;
  try {
    outcome = await Promise.race<Outcome>([
      exited.then((): Outcome => "exited"),
      spawnFailed.then((): Outcome => "spawn-failed"),
      new Promise<Outcome>((resolve) => {
        cancelPoll = setInterval(() => {
          if (cancel.load()) resolve("cancelled");
        }, CANCEL_POLL_MS);
      }),
      new Promise<Outcome>((resolve) => {
        timeoutTimer = setTimeout(() => resolve("timedout"), timeoutSecs * 1000);
      }),
    ]);
  } finally {
    if (cancelPoll !== undefined) clearInterval(cancelPoll);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  }

  if (outcome === "spawn-failed") {
    throw spawnFailure.error ?? new Error("Could not start the script.");
  }
  // Rust's loop checks `try_wait()` FIRST on every iteration, so a process that
  // had in fact already finished always beats a cancel/timeout that fired in
  // the same tick. Node's events are ordinary macrotasks, so re-check here.
  if (outcome !== "exited" && hasExited(child)) {
    outcome = "exited";
  }

  if (outcome === "cancelled" || outcome === "timedout") {
    if (pid !== undefined) await terminateGroup(child, pid);
    if (outcome === "cancelled") throw new Error(STOPPED);
    throw new Error(withPrintedOutput(`This script timed out after ${timeoutSecs}s.`, outRing, errRing));
  }

  // Exited on its own. WAIT for the stdio to finish draining rather than
  // guessing at a delay: the assistant is told to quote a script's output as
  // the answer, so a last line lost on a loaded machine is a wrong answer.
  // Bounded, because a lingering grandchild can hold the pipe open after the
  // script itself exited — then the tail we already have is what there is.
  await within(closed, READER_FLUSH_GRACE_MS);

  return {
    exitCode: child.exitCode ?? -1,
    stdoutTail: outRing.tailString(),
    stderrTail: errRing.tailString(),
  };
}

// ============================================================================
// Auto-heal
// ============================================================================

/**
 * The top-level package name from a Python `ModuleNotFoundError` stderr, if
 * any. `No module named 'pandas.core'` → `pandas`. Used to auto-install a
 * package the script imported but never declared, so the user never has to pip
 * install.
 */
export function missingModule(stderr: string): string | null {
  const marker = "No module named '";
  const at = stderr.indexOf(marker);
  if (at === -1) return null;
  const rest = stderr.slice(at + marker.length);
  // The text up to the first apostrophe, or the whole remainder when there is
  // none — Rust's `rest.split('\'').next()` behaves the same way.
  const name = rest.split("'")[0] ?? "";
  const top = (name.split(".")[0] ?? "").trim();
  // Only plain package tokens — never shell out with something odd.
  if (top === "" || !/^[A-Za-z0-9_-]+$/.test(top)) return null;
  return top;
}

// ============================================================================
// Import-back
// ============================================================================

/** A small, honest substitute for the `mime_guess` crate — real for every
 * extension a script's declared/undeclared output commonly uses, defaulting to
 * `text/plain` exactly as `mime_guess::from_path(..).first_or(TEXT_PLAIN)`
 * does for anything it has no entry for either. Same per-file convention
 * `turnEngine.ts`/`organize.ts` already carry. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  sql: "application/sql",
  py: "text/x-python",
  js: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

export function guessMime(name: string): string {
  return MIME_BY_EXT[extensionOf(name)] ?? "text/plain";
}

/**
 * The single write path for changing an existing file's bytes — ported from
 * `commands::files::store_file_bytes`, which is exactly this composition of
 * two already-ported primitives: snapshot the CURRENT bytes into version
 * history tagged with `cause`, then overwrite, as ONE transaction (a failed
 * overwrite must not still cut a version).
 */
export function storeFileBytes(
  db: Database.Database,
  id: string,
  bytes: Uint8Array,
  text: string | null,
  cause: string
): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

/**
 * Whether a materialized file (a declared input OR one auto-materialized
 * because the script referenced its name) should be saved back: its bytes
 * CHANGED during the run (`currentSha` differs from the hash at
 * materialization) AND it was not a declared output (declared outputs already
 * write back via the output path). Pure — the caller reads the file and hashes
 * it.
 */
export function isModifiedUsedFile(
  originalSha: string,
  currentSha: string,
  name: string,
  declaredOutputs: readonly string[]
): boolean {
  return currentSha !== originalSha && !declaredOutputs.some((o) => safeName(o) === safeName(name));
}

/**
 * Write one output into the room: a versioned overwrite when the name already
 * exists (undo via Time Machine), else a new `source='script'` file. The bool
 * says which happened — an overwrite the user was never told about is the one
 * case the report must not call "Created".
 */
function writeOutput(
  db: Database.Database,
  name: string,
  bytes: Buffer,
  cause: string
): { meta: FileMeta; replaced: boolean } {
  const display = safeName(name);
  const text = extractText(display, bytes);
  const existing = fileByExactName(db, display);
  if (existing !== null) {
    // Snapshot-then-overwrite: every script run is undoable for free.
    storeFileBytes(db, existing.id, bytes, text, cause);
    return { meta: getFileMeta(db, existing.id), replaced: true };
  }
  return { meta: insertFile(db, display, guessMime(display), bytes, text, "script"), replaced: false };
}

async function writeOutputInRoom(
  db: Database.Database,
  roomPath: string,
  name: string,
  bytes: Buffer,
  cause: string,
): Promise<{ meta: FileMeta; replaced: boolean }> {
  const display = safeName(name);
  const text = extractText(display, bytes);
  const existing = fileByExactName(db, display);
  if (existing !== null) {
    return {
      meta: await writeRoomFile({ db, path: roomPath }, existing.id, bytes, text, cause),
      replaced: true,
    };
  }
  return {
    meta: await createRoomFile(
      { db, path: roomPath }, display, guessMime(display), bytes, text, "script",
    ),
    replaced: false,
  };
}

/** `statSync` without the throw — `null` when the path does not exist. */
function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Import the script's outputs back into the room after a clean exit
 * (decision 2). Returns the imported files (for the report + terminal
 * auto-open) and a list of human-readable skip notes. All writes are versioned
 * via {@link storeFileBytes}, so every script run is undoable through Time
 * Machine.
 *
 * FOLLOWS SYMLINKS, deliberately matching the Rust source (`Path::is_file()`
 * and `std::fs::read` both resolve them). See the module header: a script that
 * names a symlink as its declared output has the TARGET's bytes imported —
 * documented, not silently "fixed", because refusing it would deviate from the
 * source while granting no protection a script cannot trivially route around.
 */
export function importOutputs(
  db: Database.Database,
  ws: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  cause: string
): { imported: FileMeta[]; skipped: string[] } {
  const imported: FileMeta[] = [];
  const skipped: string[] = [];
  // Names already accounted for: the materialized inputs + the script itself.
  const handled = new Set<string>(materialized.map((m) => m.name));
  handled.add(safeName(scriptName));

  // 1. Declared outputs: an existing room file → versioned overwrite; a new
  //    name → insert (source='script').
  // Two declared outputs can name the SAME workspace file — `out.csv` twice,
  // or `../out.csv` alongside `out.csv`, since every name collapses through
  // `safeName`. Importing it once per mention cut a fresh (identical) version
  // per mention and listed the file that many times in the report (merge fix
  // 12); `handled` cannot serve here because a declared output that is also a
  // materialized input is already in it and must still be processed.
  const declaredSeen = new Set<string>();
  for (const want of manifest.outputs) {
    const safe = safeName(want);
    const filePath = path.join(ws, safe);
    handled.add(safe);
    if (declaredSeen.has(safe)) continue;
    declaredSeen.add(safe);
    const stat = statOrNull(filePath);
    if (stat === null || !stat.isFile()) {
      skipped.push(`${want}: the script did not write this declared output`);
      continue;
    }
    // Size-checked from the stat we already have, BEFORE the read (merge fix
    // 13): `readFileSync` on a 3 GB output a script chose to write allocated
    // 3 GB in the main process just to discover it was over the cap, and above
    // Node's buffer limit it throws `ERR_FS_FILE_TOO_LARGE`, failing the whole
    // import — and every other output with it — instead of skipping this one.
    if (stat.size > MAX_IMPORT_BYTES) {
      skipped.push(`${want}: over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB import cap`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    // The input==output shape the empty state itself teaches
    // (`# room-inputs: portfolio.csv` + `# room-outputs: portfolio.csv`) means
    // the RUNNER put this file here, so "it exists" proved nothing: a script
    // that wrote nothing still added an identical version on every run and was
    // reported as having created it.
    if (materialized.some((m) => m.name === safe && m.sha === scriptFingerprint(bytes))) {
      skipped.push(`${want}: unchanged from the room's copy — no new version was saved`);
      continue;
    }
    const { meta } = writeOutput(db, want, bytes, cause);
    imported.push(meta);
  }

  // 2. Any NEW file the script created (present after exit, not materialized,
  //    not a declared output) — additive, capped (20 files / 64 MB). The cap
  //    counts only these UNDECLARED extras: charging a script's own promised
  //    outputs against the allowance for surprises left a script that declares
  //    many outputs with no room for any, dropping them with a message that
  //    read like a limit hit for no reason.
  let newBytes = 0;
  let newCount = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(ws);
  } catch {
    entries = [];
  }
  // Deterministic order so the cap drops the same files across runs.
  const names = entries.filter((n) => statOrNull(path.join(ws, n))?.isFile() === true).sort();
  for (const name of names) {
    if (handled.has(name)) continue;
    handled.add(name);
    const filePath = path.join(ws, name);
    const len = statOrNull(filePath)?.size ?? 0;
    if (newCount >= MAX_NEW_FILES || newBytes + len > MAX_IMPORT_BYTES) {
      skipped.push(`${name}: skipped (new-file import cap reached)`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    newBytes += bytes.length;
    newCount += 1;
    const { meta, replaced } = writeOutput(db, name, bytes, cause);
    imported.push(meta);
    if (replaced) {
      // A room file of this name existed, and NOTHING said so: the name is in
      // no `room-outputs:` header, on no line of the consent card, and (a
      // script can compose the name at run time) possibly nowhere in the
      // script text either. The report would otherwise hand the assistant
      // "Created: <name>" for a file it replaced.
      skipped.push(
        `${name}: a room file of that name already existed — the script's version was saved over it as a new version (undo via Time Machine); declare it in room-outputs to make that explicit`
      );
    }
  }

  // 3. A materialized file (a declared input OR one auto-materialized because
  //    the script referenced its name) that the script MODIFIED IN PLACE but
  //    did not declare as an output. This intentionally RELAXES the old rule
  //    ("a modified undeclared input is never written back") so a
  //    read→modify→write "sync" script just works without the user declaring
  //    room-outputs. It is safe because: the script demonstrably READ the file
  //    (we materialized it only because it was declared or its name appears in
  //    the script), running it at all required consent, and every write is
  //    versioned via {@link storeFileBytes} → fully undoable through Time
  //    Machine.
  for (const m of materialized) {
    const filePath = path.join(ws, m.name);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(filePath);
    } catch {
      continue;
    }
    const current = scriptFingerprint(bytes);
    if (!isModifiedUsedFile(m.sha, current, m.name, manifest.outputs)) continue;
    if (bytes.length > MAX_IMPORT_BYTES) {
      skipped.push(
        `${m.name}: over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB import cap — not saved back`
      );
      continue;
    }
    const { meta } = writeOutput(db, m.name, bytes, cause);
    imported.push(meta);
    // Surfaced in the report's notes so the user sees it was an in-place
    // overwrite (a new version they can undo), not a brand-new file.
    skipped.push(
      `${m.name}: updated in place by the script — saved back as a new version (undo via Time Machine)`
    );
  }

  return { imported, skipped };
}

/** Async twin used by workspace rooms so accepted output bytes land as normal files. */
async function importOutputsInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  cause: string,
): Promise<{ imported: FileMeta[]; skipped: string[] }> {
  const imported: FileMeta[] = [];
  const skipped: string[] = [];
  const handled = new Set<string>(materialized.map((item) => item.name));
  handled.add(safeName(scriptName));
  const declaredSeen = new Set<string>();

  for (const want of manifest.outputs) {
    const safe = safeName(want);
    const filePath = path.join(ws, safe);
    handled.add(safe);
    if (declaredSeen.has(safe)) continue;
    declaredSeen.add(safe);
    const stat = statOrNull(filePath);
    if (stat === null || !stat.isFile()) {
      skipped.push(`${want}: the script did not write this declared output`);
      continue;
    }
    if (stat.size > MAX_IMPORT_BYTES) {
      skipped.push(`${want}: over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB import cap`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    if (materialized.some((item) => item.name === safe && item.sha === scriptFingerprint(bytes))) {
      skipped.push(`${want}: unchanged from the room's copy — no new version was saved`);
      continue;
    }
    imported.push((await writeOutputInRoom(db, roomPath, want, bytes, cause)).meta);
  }

  let newBytes = 0;
  let newCount = 0;
  let entries: string[];
  try { entries = fs.readdirSync(ws); } catch { entries = []; }
  const names = entries.filter((name) => statOrNull(path.join(ws, name))?.isFile() === true).sort();
  for (const name of names) {
    if (handled.has(name)) continue;
    handled.add(name);
    const filePath = path.join(ws, name);
    const len = statOrNull(filePath)?.size ?? 0;
    if (newCount >= MAX_NEW_FILES || newBytes + len > MAX_IMPORT_BYTES) {
      skipped.push(`${name}: skipped (new-file import cap reached)`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    newBytes += bytes.length;
    newCount += 1;
    const written = await writeOutputInRoom(db, roomPath, name, bytes, cause);
    imported.push(written.meta);
    if (written.replaced) {
      skipped.push(
        `${name}: a room file of that name already existed — the script's version was saved over it as a new version (undo via Time Machine); declare it in room-outputs to make that explicit`,
      );
    }
  }

  for (const item of materialized) {
    const filePath = path.join(ws, item.name);
    let bytes: Buffer;
    try { bytes = fs.readFileSync(filePath); } catch { continue; }
    if (!isModifiedUsedFile(item.sha, scriptFingerprint(bytes), item.name, manifest.outputs)) continue;
    if (bytes.length > MAX_IMPORT_BYTES) {
      skipped.push(`${item.name}: over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB import cap — not saved back`);
      continue;
    }
    imported.push((await writeOutputInRoom(db, roomPath, item.name, bytes, cause)).meta);
    skipped.push(
      `${item.name}: updated in place by the script — saved back as a new version (undo via Time Machine)`,
    );
  }
  return { imported, skipped };
}

// ============================================================================
// Runner core
// ============================================================================

/** One run's report — surfaced as the workflow step artifact (JSON) and drives
 * the terminal auto-open (first imported output, MANUAL runs only). */
export interface ScriptRunReport {
  readonly exitCode: number;
  readonly imported: FileMeta[];
  readonly skipped: string[];
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

/**
 * Everything {@link runScriptProcess} needs beyond its own arguments — the
 * "no AppState port exists yet" convention `jobs.ts`/`turnEngine.ts` already
 * establish, not a second one.
 */
export interface ScriptRunDeps {
  /** Stands in for `tauri::State<AppState>`'s room lock; every phase re-pins
   * through it, because an `await` is exactly where something else can swap
   * the open room out from under this run. */
  rooms: RoomSource;
  /** `app.path().app_cache_dir()` — `script-runs/` is created underneath it. */
  cacheDir: string;
  /** `main_window(app).emit("room-files-changed", ())` — the same optional
   * callback shape `turnEngine.ts`'s `AskDeps` uses for the identical Rust
   * broadcast, since no `BrowserWindow` wiring exists in this migration yet. */
  notifyFilesChanged?: () => void;
  /** Test seam: substitute a fake process executor so the uv auto-heal retry
   * loop can be driven deterministically without a real `uv`, a network
   * round-trip, or a wall-clock wait. Defaults to the real
   * {@link executeScriptInWorkspace}. Rust's own suite never exercises that
   * loop end to end either (only `missing_module`'s extraction is unit
   * tested), so this is a genuine gap the port's tests close. */
  execute?: typeof executeScriptInWorkspace;
}

const ROOM_GONE = "The room this script belongs to is no longer open.";

function requireRoom(deps: ScriptRunDeps, roomPath: string): Database.Database {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) throw new Error(ROOM_GONE);
  return db;
}

/**
 * The full runner phase for one `script_run` node (decisions 1/5/6). Every DB
 * touch re-pins the room by path, the `execute_pass_step` discipline.
 *
 * `consentedSha256` is the hash approved when this run was enqueued (the
 * immutable snapshot). If the script's CURRENT bytes don't match, the run
 * PARKS — a mid-run edit never silently runs new code.
 *
 * The workspace is deleted in a `finally` around EVERYTHING after it is
 * created — a clean exit, a non-zero exit, a timeout, a Stop, a room closing
 * mid-run, an unexpected throw while materializing inputs. Room mutations
 * happen only in {@link importOutputs} after a real exit 0, so no outcome
 * except that one can leave a partial room write.
 */
export async function runScriptProcess(
  deps: ScriptRunDeps,
  jobId: string,
  stepId: number,
  roomPath: string,
  scriptFileId: string,
  consentedSha256: string,
  stdin: string | null,
  cancel: CancelFlag
): Promise<ScriptRunReport> {
  // (a) Read the script bytes + name under the room pin; verify the consent
  //     hash.
  const initialDb = requireRoom(deps, roomPath);
  const scriptFile = await readRoomFile({ db: initialDb, path: roomPath }, scriptFileId);
  const scriptName = scriptFile.name;
  const scriptBytes = scriptFile.bytes ?? Buffer.alloc(0);
  if (scriptFingerprint(scriptBytes) !== consentedSha256) {
    // Aligns with the approval-gates policy: park, never silently run new
    // code. Distinguish the two cases so the message is actionable: an EMPTY
    // consent means this script was never approved for this run (e.g. a
    // scheduled or agent-triggered workflow embedding a script that isn't
    // pre-approved), whereas a non-empty mismatch means it was approved but
    // has since changed.
    throw new Error(
      consentedSha256 === ""
        ? "This workflow runs a script that isn't approved on this Mac yet. Open it on the Scripts page and run it once to approve it."
        : "Script changed since it was approved — review it on the Scripts page."
    );
  }

  // (b) Parse the manifest + resolve the interpreter.
  const text = scriptBytes.toString("utf8");
  const manifest = parseScriptManifest(scriptName, text);
  const runner = resolveInterpreter(manifest);

  // (c) Workspace + materialize inputs (record hashes for modified detection).
  const ws = makeWorkspace(deps.cacheDir, jobId, stepId);
  const safeScript = safeName(scriptName);
  let report: ScriptRunReport;
  try {
    const room = requireRoom(deps, roomPath);
    // Write the script itself so `<runtime> <script>` can run it. Nothing
    // materialized afterwards may overwrite it — see `materializeInputs`.
    fs.writeFileSync(path.join(ws, safeScript), scriptBytes);
    const reserved = new Set<string>([safeScript]);
    const declared = await materializeInputsInRoom(room, roomPath, ws, manifest.inputs, reserved);
    // Auto-materialize any room file whose exact name appears in the script
    // text (e.g. `read_csv('ETF Tracker — AI Full Stack.csv')`), even if it
    // was never declared as a room-input — so scripts "just work". Read-only
    // copy; capped so a huge room can't balloon the workspace. Deduped against
    // the declared inputs already written above; recorded as Materialized so
    // the write-back phase knows these were used.
    const roomNames = listFiles(room).map((f) => f.name);
    const referenced = referencedRoomFiles(text, roomNames, MAX_AUTO_MATERIALIZE);
    const already = new Set<string>([...declared.map((m) => m.name), safeScript]);
    const materialized = [
      ...declared,
      ...await materializeNamedInRoom(room, roomPath, ws, referenced, already),
    ];

    // (d/e/f/g) Spawn + watch + drain + import back.
    report = await runAndImport(
      deps,
      roomPath,
      ws,
      runner,
      safeScript,
      manifest,
      materialized,
      scriptName,
      stdin !== null ? Buffer.from(stdin, "utf8") : null,
      cancel
    );
  } finally {
    try {
      fs.rmSync(ws, { recursive: true, force: true });
    } catch {
      // best-effort, mirrors Rust's `let _ = std::fs::remove_dir_all(&ws);`
    }
  }

  // room-files-changed after import (the publish-arm precedent).
  if (report.imported.length > 0) {
    deps.notifyFilesChanged?.();
  }
  return report;
}

/**
 * The spawn + import-back tail, split out so {@link runScriptProcess} can
 * delete the workspace on every path around it.
 */
async function runAndImport(
  deps: ScriptRunDeps,
  roomPath: string,
  ws: string,
  runner: Runner,
  safeScript: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  stdin: Buffer | null,
  cancel: CancelFlag
): Promise<ScriptRunReport> {
  const execute = deps.execute ?? executeScriptInWorkspace;
  // uv is detected by its `run` argv prefix; only it can install on the fly.
  const isUv = runner.argvPrefix[0] === "run";
  // One budget for the FIRST attempt plus every heal retry together.
  const deadlineMs = Date.now() + manifest.timeoutSecs * TOTAL_TIMEOUT_MULTIPLE * 1000;
  let out = await execute(ws, runner, safeScript, manifest.timeoutSecs, cancel, stdin);

  // Auto-heal: if the script imports a package it never declared, install it
  // and retry — the user should never have to pip install or declare anything
  // for a script to run. Bounded, uv-only, and it stops the moment adding a
  // module fails to clear the error (its PyPI package name differs from the
  // import name, e.g. PIL→Pillow), which then falls through to the actionable
  // message below.
  const healed: string[] = [];
  if (isUv) {
    for (let round = 0; round < MAX_HEAL_ROUNDS; round += 1) {
      if (out.exitCode === 0 || cancel.load()) break;
      const missing = missingModule(out.stderrTail);
      if (missing === null) break;
      if (healed.includes(missing)) break; // added last round, still missing → can't heal
      // No time left in the overall budget — stop healing and report the
      // failure we have rather than holding the slot for another attempt.
      const leftSecs = Math.floor((deadlineMs - Date.now()) / 1000);
      if (leftSecs < MIN_TIMEOUT_SECS) break;
      healed.push(missing);
      const argv = [...runner.argvPrefix];
      for (const pkg of healed) {
        argv.push("--with", pkg);
      }
      // The script's OWN declared timeout bounds every attempt;
      // TOTAL_TIMEOUT_MULTIPLE bounds only their sum. Handing the retry the
      // whole remaining budget let a `# room-timeout: 300` script run for 595s
      // and then report a limit that is in no manifest.
      const attemptSecs = Math.min(leftSecs, manifest.timeoutSecs);
      out = await execute(
        ws,
        { program: runner.program, argvPrefix: argv },
        safeScript,
        attemptSecs,
        cancel,
        stdin
      );
    }
  }

  if (out.exitCode !== 0) {
    // Nonzero exit → surface the stderr tail as the parking error.
    const tail = out.stderrTail.trim();
    let msg =
      tail === ""
        ? `The script exited with code ${out.exitCode}.`
        : `The script failed (exit ${out.exitCode}):\n${tail}`;
    const lastHealed = healed[healed.length - 1];
    const stuck = lastHealed !== undefined && out.stderrTail.includes(lastHealed) ? lastHealed : null;
    if (stuck !== null) {
      // Auto-install tried but couldn't resolve this one: its PyPI package
      // name differs from the import name. Name it so it can be declared.
      msg +=
        `\n\nCouldn't auto-install '${stuck}' — its package name on PyPI probably ` +
        "differs from the import name (e.g. PIL → Pillow, cv2 → opencv-python). " +
        "Declare it explicitly in a dependencies line, or ask the assistant to.";
    } else if (
      tail.includes("ModuleNotFoundError") ||
      tail.includes("No module named") ||
      tail.includes("Cannot find module")
    ) {
      // A missing package auto-heal didn't engage on (JS, or an odd trace).
      // Point at declaring deps rather than leaving a raw traceback.
      msg +=
        "\n\nThis script imports a package that isn't installed. Declare it in a " +
        "dependencies line near the top and it installs automatically on the next " +
        'run — no manual pip. For example:\n    # dependencies = ["pandas", "yfinance"]\n' +
        "Or ask the assistant to declare the script's dependencies.";
    }
    throw new Error(msg);
  }

  // (g) exit 0 → import back, room-pinned.
  const cause = `Script ran — ${scriptName}`;
  const room = requireRoom(deps, roomPath);
  const workspaceRoom = room.prepare(
    "SELECT 1 FROM meta WHERE key = 'room_kind' AND value = 'workspace-folder'",
  ).get() !== undefined;
  const { imported, skipped } = workspaceRoom
    ? await importOutputsInRoom(room, roomPath, ws, manifest, materialized, scriptName, cause)
    : importOutputs(room, ws, manifest, materialized, scriptName, cause);
  if (healed.length > 0) {
    // The consent card's "Installs" row is the script's DECLARED list, so
    // these were downloaded from PyPI and executed without ever being named to
    // the user. Say so where the other after-the-fact notes are said — and say
    // only that, because a script CAN declare some dependencies and still
    // import one it never named.
    skipped.unshift(
      `installed ${healed.join(", ")} from PyPI: the script imports these without declaring them, so the run-consent card could not name them`
    );
  }
  return {
    exitCode: out.exitCode,
    imported,
    skipped,
    stdoutTail: out.stdoutTail,
    stderrTail: out.stderrTail,
  };
}
