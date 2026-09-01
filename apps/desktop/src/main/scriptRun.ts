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

export { DEFAULT_TIMEOUT_SECS, MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS, RING_BYTES, MAX_HEAL_ROUNDS, MAX_NEW_FILES, MAX_IMPORT_BYTES, MAX_AUTO_MATERIALIZE, KILL_GRACE_MS, READER_FLUSH_GRACE_MS, TOTAL_TIMEOUT_MULTIPLE, STOPPED, type ScriptLang, type Shortcut, hasDeps, scriptLangOf, type ResolvedScriptFile, resolveScriptFile, scriptFingerprint, parseScriptManifest, type ScriptManifest } from "./scriptRunManifest.js";
export { type RunnerChoice, type Runner, interpreterPolicy, probeBin, firstExistingBin, type LoginShellResult, type LoginShellSpawn, loginShellBin, cachedPathPrefix, setCachedPathPrefix, uvBin, python3Bin, nodeBin, resetBinCachesForTests, resolveInterpreter } from "./scriptRunWorkspace.js";
export { scriptRunsRoot, sweepScriptWorkspaces, makeWorkspace, type Materialized, safeName, mentionsFileName, referencedRoomFiles, materializeInputs, materializeNamed, type NamedRoomMaterializationDeps, materializeNamedInRoomForTest } from "./scriptRunInterpreter.js";
export { type ExecOut, RingTail, exitedWithinForTests, killGroupForTests, type TerminateGroupTestDeps, terminateGroupForTests, executeScriptInWorkspace } from "./scriptRunProcess.js";
export { missingModule, guessMime, storeFileBytes, isModifiedUsedFile, type NewOutputImportDeps, type ModifiedOutputImportDeps, importOutputs } from "./scriptRunOutputs.js";
export { type ModifiedDbOutputImportDeps, importModifiedOutputsForTest, importOutputsInRoomForTest, importNewOutputsInRoomForTest, importModifiedOutputsInRoomForTest } from "./scriptRunRoomOutputs.js";
export { type ScriptRunReport, type ScriptRunDeps, runScriptProcess, removeScriptWorkspaceForTests } from "./scriptRunOrchestrator.js";
