/** Cohesive extraction from skillsCmds.ts; its public API remains on that module. */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  createSkill as createSkillDb,
  deleteSkill as deleteSkillDb,
  deleteSkillResource as deleteSkillResourceDb,
  findSkill as findSkillDb,
  getSkill as getSkillDb,
  getSkillResource as getSkillResourceDb,
  listSkillResources as listSkillResourcesDb,
  listSkills as listSkillsDb,
  setSkillEnabled as setSkillEnabledDb,
  updateSkill as updateSkillDb,
  upsertSkillResource as upsertSkillResourceDb,
  SKILL_GONE,
  type Skill,
  type SkillResource,
  type SkillSummary,
} from "./db-host/skills.js";
import { findFileLike, getFileExtractedText, getFileMeta } from "./db-host/files.js";
import { CancelFlag } from "./cancel.js";
import { executeScriptInWorkspace, type Runner, type ScriptManifest } from "./scriptRun.js";
import { approveScriptBytes as approveScriptBytesReal } from "./scriptConsent.js";
import { DELETE_DECLINED } from "./mcpConfig.js";
import { SKILL_AGENT_IDS } from "./toolSpecs.js";
import { clampBytes } from "./textClamp.js";
import type { OpenRoom } from "./turnEngine.js";
import { listModels } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { recoverJson } from "./ollamaGenerate.js";
import { defaultResolvedModel } from "./workflowModel.js";
import { generateTextAnyEngine, withRealOllamaGenerate } from "./workflowCompose.js";
import { createSkillCmd, deleteSkillCmd, deleteSkillResourceCmd, exportSkillFolderCmd, getSkillCmd, getSkillResourceCmd, importSkillFolderCmd, listSkillsCmd, saveSkillResourceCmd, setSkillEnabledCmd, skillImportConflict, updateSkillCmd } from "./skillsArchive.js";
import { EmitFn, asString, checkResourcePaths, normalizeSkillPath, skillAgentIds } from "./skillsCore.js";
import { ComposeSkillDeps, composeSkill } from "./skillsMutations.js";
// ---------------------------------------------------------- run_skill_script

/**
 * The workspaces this process is running a skill script in right now, so
 * {@link sweepOrphanSkillRuns} can tell a leftover from a live sibling —
 * ported from `live_skill_runs`/`SkillRunWorkspace`. Two chats can each be
 * running a skill script, and a sweep that took the whole folder would delete
 * the other run's decrypted tree from under it.
 */
export const liveSkillRuns = new Set<string>();

/** Ported from `SkillRunWorkspace`'s `Drop` impl — Node has no RAII, so every
 * claim MUST be released in a `finally`. */
export function releaseSkillRunWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort, matching Rust's `let _ = std::fs::remove_dir_all(...)`.
  }
  liveSkillRuns.delete(dir);
}

/**
 * Remove every run directory under `runs` that no live run of this process
 * owns. Ported from `sweep_orphan_skill_runs`. A skill run materializes
 * reference documents and source-file snapshots taken from encrypted room
 * files IN THE CLEAR, and only the release above removes them — a crash, a
 * force-quit or a SIGKILL left the decrypted copies on disk under a random
 * name that nothing ever looked for again. Failures are ignored on purpose: a
 * leftover we cannot delete must not stop the run the user just approved.
 */
export function sweepOrphanSkillRuns(runsDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = nodePath.join(runsDir, entry);
    if (liveSkillRuns.has(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // Best-effort; swept again on the next attempt.
    }
  }
}

/** Test-only: forget every tracked live workspace. A real process only grows
 * this set for the life of one run; a long-lived vitest process needs it reset
 * between tests. */
export function resetLiveSkillRunsForTests(): void {
  liveSkillRuns.clear();
}

/** What {@link AgentRunSkillScriptDeps.approveScriptBytes} resolves to once a
 * real consent surface exists — `approve_script_bytes`' `(runner, manifest)`. */
export interface SkillScriptConsent {
  runner: Runner;
  manifest: ScriptManifest;
}

export interface AgentRunSkillScriptDeps {
  /** The app's cache directory (`app_cache_dir()`) — a RESOLVED path, this
   * codebase's established convention (`scriptRun.ts`'s own `scriptRunsRoot`,
   * `execTool.ts`'s `downloadJob`) rather than reaching for an Electron API
   * from inside a ported module. Required: there is no safe default. */
  cacheDir: string;
  /**
   * Rust builds `Arc::new(AtomicBool::new(false))` FRESH for every skill-script
   * run rather than threading the turn's own Stop flag through, so today a
   * skill script cannot be interrupted by Stop, only by its own timeout. That
   * quirk is ported as the DEFAULT (an equally fresh, never-set flag) rather
   * than quietly "fixed" — but the flag is injectable, and when a caller
   * supplies the turn's real one a Stop surfaces as `scriptRun.ts`'s `STOPPED`
   * sentinel, propagated unchanged, never re-labelled as a script failure.
   */
  cancel?: CancelFlag;
  /**
   * `approve_script_bytes` — parse the manifest, resolve the interpreter, get
   * the user's consent for these exact bytes. Defaults to the real (currently
   * `NOT_IMPLEMENTED`) `scriptConsent.ts` export. Injectable so a caller with
   * a real consent surface can supply one, and so everything BELOW this seam
   * is fully exercised today.
   */
  approveScriptBytes?: (displayName: string, bytes: Uint8Array) => Promise<SkillScriptConsent>;
}

/**
 * Ported from `agent_run_skill_script`. Executes a bundled Python/JavaScript
 * helper after the same per-content human consent room scripts use: only the
 * SKILL tree is materialized, into a throwaway 0700 workspace — the encrypted
 * room, the room's files and the database key are never exposed.
 */
export async function agentRunSkillScript(
  db: Database.Database,
  args: Record<string, unknown>,
  deps: AgentRunSkillScriptDeps
): Promise<string> {
  const run = await approvedSkillScriptRun(db, args, deps);

  // Both filesystem seams materialize the same tree, so the export's rule is
  // the run's rule — and saying so before the workspace exists beats a raw
  // EEXIST from the middle of the copy loop.
  checkResourcePaths(run.resources.map((resource) => resource.path));

  const runsDir = prepareSkillRunsDirectory(deps.cacheDir);

  // Claimed BEFORE it exists, so a concurrent run's sweep can never mistake a
  // directory being created for a leftover.
  const ws = nodePath.join(runsDir, randomUUID());
  liveSkillRuns.add(ws);
  try {
    materializeSkillRunWorkspace(ws, run.resources);
    const cancel = deps.cancel ?? new CancelFlag();
    // A cancel REJECTS with `scriptRun.ts`'s `STOPPED` sentinel, and this
    // function deliberately does not catch it: a user-initiated Stop must stay
    // distinguishable from a script that genuinely failed, which is what the
    // non-zero-exit branch below reports.
    const output = await executeScriptInWorkspace(
      ws,
      run.runner,
      run.path,
      run.manifest.timeoutSecs,
      cancel,
      skillScriptInput(args)
    );
    return skillScriptOutput(output, run.displayName);
  } finally {
    releaseSkillRunWorkspace(ws);
  }
}

export interface SkillScriptRun {
  readonly path: string;
  readonly resources: SkillResource[];
  readonly script: SkillResource;
  readonly displayName: string;
}

export interface ApprovedSkillScriptRun extends SkillScriptRun {
  readonly runner: Runner;
  readonly manifest: ScriptManifest;
}

export function runnableSkillScript(db: Database.Database, args: Record<string, unknown>): SkillScriptRun {
  const key = asString(args["skill"]);
  const path = normalizeSkillPath(asString(args["path"]));
  if (!path.startsWith("scripts/")) throw new Error("Only resources inside scripts/ can be executed.");
  const skill = findSkillDb(db, key);
  if (skill === null) throw new Error(`No skill named "${key}" exists.`);
  if (!skill.enabled) throw new Error("Enable and review this skill before running its scripts.");
  const resources = listSkillResourcesDb(db, skill.id);
  const script = resources.find((resource) => resource.path === path);
  if (script === undefined) throw new Error(`The skill has no resource at ${path}.`);
  return { path, resources, script, displayName: `${skill.name}/${path}` };
}

export async function approvedSkillScriptRun(
  db: Database.Database,
  args: Record<string, unknown>,
  deps: AgentRunSkillScriptDeps
): Promise<ApprovedSkillScriptRun> {
  const run = runnableSkillScript(db, args);
  const approve = deps.approveScriptBytes ?? approveScriptBytesReal;
  const { runner, manifest } = await approve(run.displayName, run.script.content);
  return { ...run, runner, manifest };
}

export function prepareSkillRunsDirectory(cacheDir: string): string {
  const runsDir = nodePath.join(cacheDir, "skill-runs");
  fs.mkdirSync(runsDir, { recursive: true });
  sweepOrphanSkillRuns(runsDir);
  fs.chmodSync(runsDir, 0o700);
  return runsDir;
}

export function materializeSkillRunWorkspace(workspace: string, resources: readonly SkillResource[]): void {
  fs.mkdirSync(nodePath.join(workspace, "tmp"), { recursive: true });
  fs.chmodSync(workspace, 0o700);
  for (const resource of resources) {
    const target = nodePath.join(workspace, normalizeSkillPath(resource.path));
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    fs.writeFileSync(target, resource.content);
  }
}

export function skillScriptInput(args: Record<string, unknown>): Buffer | null {
  const input = args["input"];
  return typeof input === "string" ? Buffer.from(input, "utf8") : null;
}

export function skillScriptOutput(output: Awaited<ReturnType<typeof executeScriptInWorkspace>>, displayName: string): string {
  if (output.exitCode !== 0) {
    const detail = output.stderrTail.trim() === "" ? output.stdoutTail : output.stderrTail;
    throw new Error(`The skill script failed (exit ${output.exitCode}):\n${clampBytes(detail, 12_000)}`);
  }
  const text = output.stdoutTail.trim() === "" ? `${displayName} finished successfully (no stdout).` : output.stdoutTail;
  return clampBytes(text, 20_000);
}

// ============================================================================
// registerSkillsIpc — thin `ipcMain.handle` registration, per `recIpc.ts`'s
// precedent. NOT wired into any bootstrap yet: it exists, and it is tested
// directly.
// ============================================================================

/** The slice of room state every skills IPC handler needs — whichever room is
 * open RIGHT NOW, not whatever was open when {@link registerSkillsIpc} ran.
 * Mirrors `recIpc.ts`'s own `RoomSource` rather than importing it, so this
 * module has no runtime dependency on that one. */
export interface RoomSource {
  currentRoom(): OpenRoom | null;
}

export const NO_ROOM_OPEN = "No room is open.";

export function openDb(room: RoomSource): Database.Database {
  const open = room.currentRoom();
  if (open === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  return open.db;
}

/**
 * Register every Skills-screen channel on `ipcMain`. Channel names are the
 * Rust `#[tauri::command]` names the renderer's `api.ts` already invokes, so a
 * future renderer needs no rename. Every handler is THIN: resolve the open
 * room's `db`, forward to the real logic above (which owns its own
 * `skills-changed` emit, exactly as Rust's commands do), done.
 */
export function registerSkillsIpc(
  ipcMain: Pick<IpcMain, "handle">,
  room: RoomSource,
  emit?: EmitFn,
  composeDeps: Omit<ComposeSkillDeps, "emit"> = {}
): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R): void => {
    ipcMain.handle(channel, (_event: IpcMainInvokeEvent, ...args: A) => fn(...args));
  };

  handle("skill_agent_ids", () => skillAgentIds());
  handle("list_skills", () => listSkillsCmd(openDb(room)));
  handle("get_skill", (args: { id: string }) => getSkillCmd(openDb(room), args.id));
  handle(
    "create_skill",
    (args: { name: string; description: string; instructions: string; agent?: string | null }) =>
      createSkillCmd(openDb(room), args.name, args.description, args.instructions, args.agent, emit)
  );
  handle(
    "update_skill",
    (args: {
      id: string;
      name: string;
      description: string;
      instructions: string;
      agent?: string | null;
    }) => updateSkillCmd(openDb(room), args.id, args.name, args.description, args.instructions, args.agent, emit)
  );
  handle("set_skill_enabled", (args: { id: string; enabled: boolean }) =>
    setSkillEnabledCmd(openDb(room), args.id, args.enabled, emit)
  );
  handle("delete_skill", (args: { id: string }) => deleteSkillCmd(openDb(room), args.id, emit));
  handle("get_skill_resource", (args: { skillId: string; path: string }) =>
    getSkillResourceCmd(openDb(room), args.skillId, args.path)
  );
  handle(
    "save_skill_resource",
    (args: { skillId: string; path: string; text?: string | null; dataB64?: string | null }) =>
      saveSkillResourceCmd(openDb(room), args.skillId, args.path, args.text, args.dataB64, emit)
  );
  handle("delete_skill_resource", (args: { skillId: string; path: string }) =>
    deleteSkillResourceCmd(openDb(room), args.skillId, args.path, emit)
  );
  handle("import_skill_folder", (args: { path: string; replace?: boolean | null }) =>
    importSkillFolderCmd(openDb(room), args.path, args.replace, emit)
  );
  handle("skill_import_conflict", (args: { path: string }) => skillImportConflict(openDb(room), args.path));
  handle("export_skill_folder", (args: { id: string; destination: string }) =>
    exportSkillFolderCmd(openDb(room), args.id, args.destination)
  );
  handle("compose_skill", (args: { description: string; fileIds?: string[] | null }) =>
    composeSkill(openDb(room), args.description, args.fileIds, { ...composeDeps, emit })
  );
}
