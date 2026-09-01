/** Cohesive extraction from scriptRun.ts; its public API remains on that module. */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
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
import { scriptFingerprint } from "./scriptRunManifest.js";
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
export function sweepScriptWorkspaces(
  cacheDir: string,
  removeTree: (target: string) => void = (target) => fs.rmSync(target, { recursive: true, force: true }),
): void {
  try {
    removeTree(scriptRunsRoot(cacheDir));
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
export function makeWorkspace(
  cacheDir: string,
  jobId: string,
  stepId: number,
  removeTree: (target: string) => void = (target) => fs.rmSync(target, { recursive: true, force: true }),
): string {
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
    removeTree(dir);
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
export const MIN_REFERENCE_NAME = 4;

/** A "name character" for {@link mentionsFileName}'s boundary check — Rust's
 * `char::is_alphanumeric()` (Unicode-aware, so Hebrew and accented names count
 * too) plus the three punctuation marks the Rust source also allows inside a
 * token. */
export function isNameChar(ch: string): boolean {
  return /[\p{L}\p{N}_.-]/u.test(ch);
}

/** Whether `name` occurs in `text` as a whole token — not glued to more name
 * characters on either side, so `data.csv` does not match `mydata.csv.bak`.
 * Non-overlapping scan, mirroring `str::match_indices`. */
export function mentionsFileName(text: string, name: string): boolean {
  if (name === "") return false;
  let from = 0;
  for (;;) {
    const at = nextFileNameOccurrence(text, name, from);
    if (at === null) return false;
    if (isWholeFileName(text, name, at)) return true;
    from = at + name.length;
  }
}

export function nextFileNameOccurrence(text: string, name: string, from: number): number | null {
  const at = text.indexOf(name, from);
  return at === -1 ? null : at;
}

export function isWholeFileName(text: string, name: string, at: number): boolean {
  const before = text[at - 1];
  const after = text[at + name.length];
  return isNameBoundary(before) && isNameBoundary(after);
}

export function isNameBoundary(character: string | undefined): boolean {
  return character === undefined || !isNameChar(character);
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
  const seen = new Set<string>();
  for (const name of roomFiles) {
    if (seen.has(name)) continue;
    seen.add(name);
    // `.length` counts UTF-16 code units; Rust's `chars().count()` counts
    // Unicode scalar values, which is what `[...name]` iterates.
    if (!canAutoMaterialize(name)) continue;
    if (!mentionsFileName(text, name)) continue;
    out.push(name);
    if (out.length >= cap) break;
  }
  return out;
}

export function canAutoMaterialize(name: string): boolean {
  return [...name].length >= MIN_REFERENCE_NAME && extensionOf(name) !== "";
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

export async function materializeInputsInRoom(
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

export async function materializeNamedInRoom(
  db: Database.Database,
  roomPath: string,
  ws: string,
  names: readonly string[],
  already: ReadonlySet<string>,
): Promise<Materialized[]> {
  return materializeNamedInRoomWithDeps(db, roomPath, ws, names, already, {
    findFile: fileByExactName,
    readRoomFile,
    writeWorkspaceFile: fs.writeFileSync,
  });
}

/** Test seam for named workspace-input materialization without disk access. */
export interface NamedRoomMaterializationDeps {
  readonly findFile: (db: Database.Database, name: string) => Pick<FileMeta, "id"> | null;
  readonly readRoomFile: (
    room: { db: Database.Database; path: string },
    id: string,
  ) => Promise<{ bytes: Buffer | null }>;
  readonly writeWorkspaceFile: (filePath: string, bytes: Buffer) => void;
}

export async function materializeNamedInRoomWithDeps(
  db: Database.Database,
  roomPath: string,
  ws: string,
  names: readonly string[],
  already: ReadonlySet<string>,
  deps: NamedRoomMaterializationDeps,
): Promise<Materialized[]> {
  const out: Materialized[] = [];
  for (const name of names) {
    const safe = safeName(name);
    if (already.has(safe) || out.some((item) => item.name === safe)) continue;
    const meta = deps.findFile(db, name);
    if (meta === null) continue;
    const file = await deps.readRoomFile({ db, path: roomPath }, meta.id);
    if (file.bytes === null) continue;
    deps.writeWorkspaceFile(path.join(ws, safe), file.bytes);
    out.push({ name: safe, sha: scriptFingerprint(file.bytes) });
  }
  return out;
}

/** Test-only entry point for named room-file materialization with fake I/O. */
export function materializeNamedInRoomForTest(
  db: Database.Database,
  roomPath: string,
  workspace: string,
  names: readonly string[],
  already: ReadonlySet<string>,
  deps: NamedRoomMaterializationDeps,
): Promise<Materialized[]> {
  return materializeNamedInRoomWithDeps(db, roomPath, workspace, names, already, deps);
}
