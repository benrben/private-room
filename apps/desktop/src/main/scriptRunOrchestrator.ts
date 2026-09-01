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
import { Materialized, makeWorkspace, materializeInputs, materializeInputsInRoom, materializeNamedInRoom, referencedRoomFiles, safeName } from "./scriptRunInterpreter.js";
import { MAX_AUTO_MATERIALIZE, MAX_HEAL_ROUNDS, MIN_TIMEOUT_SECS, TOTAL_TIMEOUT_MULTIPLE, parseScriptManifest, scriptFingerprint } from "./scriptRunManifest.js";
import { importOutputs, missingModule } from "./scriptRunOutputs.js";
import { ExecOut, executeScriptInWorkspace } from "./scriptRunProcess.js";
import { importOutputsInRoom } from "./scriptRunRoomOutputs.js";
import { Runner, resolveInterpreter } from "./scriptRunWorkspace.js";
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

export const ROOM_GONE = "The room this script belongs to is no longer open.";

export function requireRoom(deps: ScriptRunDeps, roomPath: string): Database.Database {
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
  const script = await consentedScript(deps, roomPath, scriptFileId, consentedSha256);
  // (b) Parse the manifest + resolve the interpreter.
  const manifest = parseScriptManifest(script.name, script.text);
  const runner = resolveInterpreter(manifest);
  const report = await runScriptWorkspace(
    deps, jobId, stepId, roomPath, script, manifest, runner, stdin, cancel,
  );
  // room-files-changed after import (the publish-arm precedent).
  if (report.imported.length > 0) deps.notifyFilesChanged?.();
  return report;
}

export interface ConsentedScript {
  readonly name: string;
  readonly bytes: Buffer;
  readonly text: string;
}

export async function consentedScript(
  deps: ScriptRunDeps,
  roomPath: string,
  scriptFileId: string,
  consentedSha256: string,
): Promise<ConsentedScript> {
  const db = requireRoom(deps, roomPath);
  const file = await readRoomFile({ db, path: roomPath }, scriptFileId);
  const bytes = file.bytes ?? Buffer.alloc(0);
  verifyScriptConsent(bytes, consentedSha256);
  return { name: file.name, bytes, text: bytes.toString("utf8") };
}

export function verifyScriptConsent(bytes: Buffer, consentedSha256: string): void {
  if (scriptFingerprint(bytes) === consentedSha256) return;
  throw new Error(consentFailureMessage(consentedSha256));
}

export function consentFailureMessage(consentedSha256: string): string {
  return consentedSha256 === ""
    ? "This workflow runs a script that isn't approved on this Mac yet. Open it on the Scripts page and run it once to approve it."
    : "Script changed since it was approved — review it on the Scripts page.";
}

export async function runScriptWorkspace(
  deps: ScriptRunDeps,
  jobId: string,
  stepId: number,
  roomPath: string,
  script: ConsentedScript,
  manifest: ScriptManifest,
  runner: Runner,
  stdin: string | null,
  cancel: CancelFlag,
): Promise<ScriptRunReport> {
  const ws = makeWorkspace(deps.cacheDir, jobId, stepId);
  try {
    return await runInScriptWorkspace(deps, roomPath, ws, script, manifest, runner, stdin, cancel);
  } finally {
    removeScriptWorkspace(ws);
  }
}

export async function runInScriptWorkspace(
  deps: ScriptRunDeps,
  roomPath: string,
  ws: string,
  script: ConsentedScript,
  manifest: ScriptManifest,
  runner: Runner,
  stdin: string | null,
  cancel: CancelFlag,
): Promise<ScriptRunReport> {
  const safeScript = safeName(script.name);
  const materialized = await materializedScriptInputs(deps, roomPath, ws, script, manifest, safeScript);
  return runAndImport(
    deps, roomPath, ws, runner, safeScript, manifest, materialized, script.name, scriptStdin(stdin), cancel,
  );
}

export async function materializedScriptInputs(
  deps: ScriptRunDeps,
  roomPath: string,
  ws: string,
  script: ConsentedScript,
  manifest: ScriptManifest,
  safeScript: string,
): Promise<Materialized[]> {
  const room = requireRoom(deps, roomPath);
  // Write the script itself so `<runtime> <script>` can run it. Nothing
  // materialized afterwards may overwrite it — see `materializeInputs`.
  fs.writeFileSync(path.join(ws, safeScript), script.bytes);
  const declared = await materializeInputsInRoom(room, roomPath, ws, manifest.inputs, new Set([safeScript]));
  const names = listFiles(room).map((file) => file.name);
  const referenced = referencedRoomFiles(script.text, names, MAX_AUTO_MATERIALIZE);
  const already = new Set<string>([...declared.map((item) => item.name), safeScript]);
  const named = await materializeNamedInRoom(room, roomPath, ws, referenced, already);
  return [...declared, ...named];
}

export function scriptStdin(stdin: string | null): Buffer | null {
  return stdin === null ? null : Buffer.from(stdin, "utf8");
}

export function removeScriptWorkspace(
  ws: string,
  removeTree: (target: string) => void = (target) => fs.rmSync(target, { recursive: true, force: true }),
): void {
  try {
    removeTree(ws);
  } catch {
    // best-effort, mirrors Rust's `let _ = std::fs::remove_dir_all(&ws);`
  }
}

/** Test seam for best-effort cleanup failures. */
export function removeScriptWorkspaceForTests(ws: string, removeTree?: (target: string) => void): void {
  removeScriptWorkspace(ws, removeTree);
}

export function isUvRunner(runner: Runner): boolean {
  return runner.argvPrefix[0] === "run";
}

export function nextAutoHealPackage(out: ExecOut, cancel: CancelFlag, healed: readonly string[]): string | null {
  if (out.exitCode === 0 || cancel.load()) return null;
  const missing = missingModule(out.stderrTail);
  if (missing === null || healed.includes(missing)) return null;
  return missing;
}

export function healingAttemptSeconds(deadlineMs: number, timeoutSecs: number): number | null {
  const leftSecs = Math.floor((deadlineMs - Date.now()) / 1000);
  return leftSecs < MIN_TIMEOUT_SECS ? null : Math.min(leftSecs, timeoutSecs);
}

export function runnerWithHealedPackages(runner: Runner, healed: readonly string[]): Runner {
  const argvPrefix = [...runner.argvPrefix];
  for (const pkg of healed) argvPrefix.push("--with", pkg);
  return { program: runner.program, argvPrefix };
}

/** Run the initial attempt and the bounded uv-only retry sequence. */
export async function executeWithAutoHealing(
  execute: typeof executeScriptInWorkspace,
  ws: string,
  runner: Runner,
  safeScript: string,
  manifest: ScriptManifest,
  cancel: CancelFlag,
  stdin: Buffer | null,
): Promise<{ out: ExecOut; healed: string[] }> {
  // One budget for the FIRST attempt plus every heal retry together.
  const deadlineMs = Date.now() + manifest.timeoutSecs * TOTAL_TIMEOUT_MULTIPLE * 1000;
  let out = await execute(ws, runner, safeScript, manifest.timeoutSecs, cancel, stdin);
  const healed: string[] = [];
  if (!isUvRunner(runner)) return { out, healed };

  // Auto-heal is bounded, uv-only, and stops once adding a module fails to
  // clear its error (for example, PIL → Pillow).
  for (let round = 0; round < MAX_HEAL_ROUNDS; round += 1) {
    const missing = nextAutoHealPackage(out, cancel, healed);
    if (missing === null) break;
    const attemptSecs = healingAttemptSeconds(deadlineMs, manifest.timeoutSecs);
    if (attemptSecs === null) break;
    healed.push(missing);
    out = await execute(
      ws,
      runnerWithHealedPackages(runner, healed),
      safeScript,
      attemptSecs,
      cancel,
      stdin,
    );
  }
  return { out, healed };
}

export function failureSummary(out: ExecOut): string {
  const tail = out.stderrTail.trim();
  return tail === ""
    ? `The script exited with code ${out.exitCode}.`
    : `The script failed (exit ${out.exitCode}):\n${tail}`;
}

export function unresolvedAutoInstall(out: ExecOut, healed: readonly string[]): string | null {
  const lastHealed = healed[healed.length - 1];
  if (lastHealed === undefined) return null;
  return out.stderrTail.includes(lastHealed) ? lastHealed : null;
}

export function missingPackageAdvice(tail: string): string {
  const isMissingPackage =
    tail.includes("ModuleNotFoundError") ||
    tail.includes("No module named") ||
    tail.includes("Cannot find module");
  if (!isMissingPackage) return "";
  return (
    "\n\nThis script imports a package that isn't installed. Declare it in a " +
    "dependencies line near the top and it installs automatically on the next " +
    'run — no manual pip. For example:\n    # dependencies = ["pandas", "yfinance"]\n' +
    "Or ask the assistant to declare the script's dependencies."
  );
}

export function failureMessage(out: ExecOut, healed: readonly string[]): string {
  const stuck = unresolvedAutoInstall(out, healed);
  if (stuck !== null) {
    return (
      failureSummary(out) +
      `\n\nCouldn't auto-install '${stuck}' — its package name on PyPI probably ` +
      "differs from the import name (e.g. PIL → Pillow, cv2 → opencv-python). " +
      "Declare it explicitly in a dependencies line, or ask the assistant to."
    );
  }
  return failureSummary(out) + missingPackageAdvice(out.stderrTail.trim());
}

export function isWorkspaceRoom(room: Database.Database): boolean {
  return room.prepare(
    "SELECT 1 FROM meta WHERE key = 'room_kind' AND value = 'workspace-folder'",
  ).get() !== undefined;
}

export async function importScriptOutputs(
  room: Database.Database,
  roomPath: string,
  ws: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
): Promise<{ imported: FileMeta[]; skipped: string[] }> {
  const cause = `Script ran — ${scriptName}`;
  return isWorkspaceRoom(room)
    ? importOutputsInRoom(room, roomPath, ws, manifest, materialized, scriptName, cause)
    : importOutputs(room, ws, manifest, materialized, scriptName, cause);
}

export function noteInstalledPackages(skipped: string[], healed: readonly string[]): void {
  if (healed.length === 0) return;
  skipped.unshift(
    `installed ${healed.join(", ")} from PyPI: the script imports these without declaring them, so the run-consent card could not name them`,
  );
}

export async function successfulRunReport(
  deps: ScriptRunDeps,
  roomPath: string,
  ws: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  out: ExecOut,
  healed: readonly string[],
): Promise<ScriptRunReport> {
  const room = requireRoom(deps, roomPath);
  const { imported, skipped } = await importScriptOutputs(room, roomPath, ws, manifest, materialized, scriptName);
  noteInstalledPackages(skipped, healed);
  return { exitCode: out.exitCode, imported, skipped, stdoutTail: out.stdoutTail, stderrTail: out.stderrTail };
}

/**
 * The spawn + import-back tail, split out so {@link runScriptProcess} can
 * delete the workspace on every path around it.
 */
export async function runAndImport(
  deps: ScriptRunDeps,
  roomPath: string,
  ws: string,
  runner: Runner,
  safeScript: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  stdin: Buffer | null,
  cancel: CancelFlag,
): Promise<ScriptRunReport> {
  const execute = deps.execute ?? executeScriptInWorkspace;
  const { out, healed } = await executeWithAutoHealing(
    execute,
    ws,
    runner,
    safeScript,
    manifest,
    cancel,
    stdin,
  );
  if (out.exitCode !== 0) throw new Error(failureMessage(out, healed));
  return successfulRunReport(deps, roomPath, ws, manifest, materialized, scriptName, out, healed);
}
