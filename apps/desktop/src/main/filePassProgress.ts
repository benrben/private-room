import { createHash } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";
import { stopped, type CancelFlag } from "./cancel.js";
import {
  densePrefix,
  pinnedDb,
  runPlan,
  type Lane,
  type RoomHandle,
  type RoomSource,
  type Step,
  type StepResult,
} from "./jobs.js";
import { checkpointJob, createChildJob, getJobArtifact, putJobArtifact, setJobStatus } from "./db-host/jobs.js";
import {
  getFileExtractedText,
  getFileMeta,
  inTransaction,
  setDerivedFrom,
  updateFileContent,
  type FileMeta,
} from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { Artifact } from "./artifactBuilder.js";
import { writeRoomFile } from "./workspace/roomContent.js";
import { htmlDocument } from "./docsHtml.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import { byteLength, partitionWindows, sliceUtf8, smartFilter } from "./extractionWindow.js";
import {
  sidecarErrorSentinel,
  sidecarJsonCancellable,
  type SidecarError,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";
import { PASS_WINDOW_CHARS, PASS_WINDOW_OVERLAP, PassPlan, buildPassSteps } from "./filePassCore.js";
import { requireRoomDb, textDigest, FilePassStepDeps, PublishedRef, executePassStep, stepParams, u64Param } from "./filePassExecute.js";

// -------------------------------------------------------------- progress label

/** The human label for the progress card at `done` finished steps — names
 * the exact part being read (with its character span) so the pass is
 * watchable. Ported verbatim from `pass_progress_label`. */
export function passProgressLabel(plan: PassPlan, steps: readonly Step[], done: number): string {
  const n = plan.windows.length;
  if (done < n) {
    const span = plan.windows[done] as [number, number];
    const [start, end] = span;
    return `Reading part ${done + 1} of ${n} — characters ${start}–${end}`;
  }
  if (done < steps.length) {
    const step = steps[done] as Step;
    if (step.kind === "compose") {
      const params = stepParams(step);
      const sec = u64Param(params, "section", 0);
      const total = u64Param(params, "total", 1);
      return `Writing section ${sec + 1} of ${total}…`;
    }
    return "Saving the result into the room…";
  }
  return "Finishing…";
}

// --------------------------------------------------------------- resumable_child

/**
 * Deep, order-independent equality for parsed-JSON values — the TS stand-in
 * for `serde_json::Value`'s own `PartialEq` (its objects are maps, compared
 * by content; a naive string comparison of two independently-serialized
 * objects would be sensitive to key order, which `serde_json::Value` is
 * not). Object keys compared regardless of order; array elements compared
 * IN order, matching `Vec`'s own `PartialEq`.
 */
export function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function equalJsonArrays(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => deepEqualJson(value, right[index]));
}

export function equalJsonObjects(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqualJson(left[key], right[key]));
}

export function deepEqualJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return equalJsonArrays(left, right);
  if (jsonObject(left) && jsonObject(right)) return equalJsonObjects(left, right);
  return false;
}

/**
 * The child row a re-entered file_pass node should carry on with, and where
 * it left off — `null` when this node has never run, or ran against a
 * different file/instruction/mode.
 *
 * Identity is the PLAN: it is the whole definition of what a resume would
 * do, and it already carries the file's digest, so a file edited between the
 * two runs produces a different plan and correctly starts a fresh child
 * rather than resuming over text that moved. Compared via
 * {@link deepEqualJson}, never as stored text.
 *
 * Only unfinished children are eligible: a 'done' child is this node's
 * finished work (or an identical sibling node's), and re-driving it would
 * seed every step as done and publish nothing. Ported verbatim from
 * `resumable_child`.
 */
export function resumableChild(
  db: Database.Database,
  parentJobId: string,
  planJson: unknown
): { id: string; cursor: number } | null {
  const rows = db
    .prepare(
      "SELECT id, plan, cursor FROM jobs " +
        "WHERE parent_job_id = ? AND kind = 'file_pass' " +
        "AND status IN ('queued','paused','error','running') " +
        "ORDER BY created_at DESC, rowid DESC"
    )
    .raw()
    .all(parentJobId) as Array<[string, string, number]>;
  for (const [id, plan, cursor] of rows) {
    // An unreadable plan is not evidence of sameness — skip it rather than
    // resume a row whose windows we cannot confirm are these windows.
    let stored: unknown;
    try {
      stored = JSON.parse(plan);
    } catch {
      continue;
    }
    if (deepEqualJson(stored, planJson)) {
      return { id, cursor: Math.max(0, cursor) };
    }
  }
  return null;
}

// --------------------------------------------------------------- drive_file_pass

/** What `resolve_pass_engine` (`model_setting` + `ollama::list_models` +
 * `capabilities::runs_on_this_mac`) would resolve — no Electron port exists
 * for any of those yet. Injected rather than invented. */
export type ResolvePassEngine = () => Promise<{ model: string; lane: Lane }>;

export const RESOLVE_PASS_ENGINE_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: resolve_pass_engine (the room's model setting, " +
  "ollama::list_models, and capabilities::runs_on_this_mac routing) has no " +
  "Electron port yet.";

/** The stub {@link driveFilePass} falls back to when no real engine resolver
 * is supplied — "stub, don't fake", the same convention `jobs.ts`'s
 * `renderPodcastAudioNotImplemented` establishes. */
export const resolvePassEngineNotImplemented: ResolvePassEngine = () =>
  Promise.reject(new Error(RESOLVE_PASS_ENGINE_NOT_IMPLEMENTED));

/** {@link FilePassStepDeps} plus the one seam {@link driveFilePass} needs
 * beyond running an already-planned step. */
export interface DriveFilePassDeps extends FilePassStepDeps {
  resolveEngine?: ResolvePassEngine;
}

export function passModeAndInstruction(mode: string, instruction: string): { instruction: string; mode: string } {
  const trimmed = instruction.trim();
  return {
    mode: mode === "stitch" ? "stitch" : "merge",
    instruction: trimmed === "" ? "Summarize this file completely and thoroughly." : trimmed,
  };
}

export function readablePassText(
  deps: DriveFilePassDeps,
  roomPath: string,
  fileId: string,
  fileName: string,
): { filtered: string; windows: Array<[number, number]> } {
  const rawText = getFileExtractedText(requireRoomDb(deps.rooms, roomPath), fileId);
  if (rawText === null) throw new Error(`"${fileName}" has no readable text for a pass.`);
  const filtered = smartFilter(rawText);
  const windows = partitionWindows(filtered, PASS_WINDOW_CHARS, PASS_WINDOW_OVERLAP);
  if (windows.length === 0) throw new Error(`"${fileName}" has no readable text after filtering.`);
  return { filtered, windows };
}

export function drivePassPlan(
  fileId: string,
  fileName: string,
  instruction: string,
  mode: string,
  filtered: string,
  windows: Array<[number, number]>,
): PassPlan {
  return {
    fileId,
    fileName,
    instruction,
    mode,
    textLen: byteLength(filtered),
    textSha256: textDigest(filtered),
    windows,
  };
}

export function passChild(
  deps: DriveFilePassDeps,
  roomPath: string,
  parentJobId: string,
  planJson: unknown,
  steps: readonly Step[],
  title: string,
): { childId: string; startCursor: number } {
  const db = requireRoomDb(deps.rooms, roomPath);
  const resumable = resumableChild(db, parentJobId, planJson);
  if (resumable !== null) return { childId: resumable.id, startCursor: Math.min(resumable.cursor, steps.length) };
  return {
    childId: createChildJob(db, "file_pass", title, planJson, steps.length, parentJobId),
    startCursor: 0,
  };
}

export function updatePassChildStatus(
  deps: DriveFilePassDeps,
  roomPath: string,
  childId: string,
  status: string,
  error: string | null,
): void {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) return;
  try {
    setJobStatus(db, childId, status, error);
  } catch {
    // Best effort: a room can close after the final pin check.
  }
}

export function completedPassSteps(cursor: number): Set<number> {
  return new Set(Array.from({ length: cursor }, (_, index) => index));
}

export function checkpointPassChild(
  deps: DriveFilePassDeps,
  roomPath: string,
  childId: string,
  done: ReadonlySet<number>,
): void {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) return;
  try {
    checkpointJob(db, childId, densePrefix(done), {});
  } catch {
    // Best effort: the next completed step checkpoints again.
  }
}

export type PassRunOutcome = Awaited<ReturnType<typeof runPlan>>;

export function passOutcomeStatus(outcome: PassRunOutcome): { error: string | null; status: string } {
  if (outcome.kind === "done") return { status: "done", error: null };
  if (outcome.kind === "paused") return { status: "paused", error: null };
  return { status: "error", error: outcome.error };
}

export function drivePassResult(
  outcome: PassRunOutcome,
  published: PublishedRef,
  fileName: string,
): { message: string; meta: FileMeta | null } {
  if (outcome.kind === "done") {
    const meta = published.value;
    return { message: `Saved a full pass of "${fileName}" as "${meta?.name ?? ""}".`, meta };
  }
  if (outcome.kind === "paused") throw new Error("STOPPED");
  throw new Error(outcome.error);
}

/**
 * Wave 4a: drive a whole-file pass INLINE as a workflow node's child job.
 * Creates a CHILD job row (parent-tagged, so pump/resume/quiesce skip it —
 * the parent workflow holds the lane slot and re-drives this node on its own
 * resume), runs the pass on the PARENT's cancel flag, and returns the
 * published file plus an honest coverage line. Throws `"STOPPED"` when the
 * parent was cancelled mid-pass, so the workflow parks and resumes cleanly.
 * Ported from `drive_file_pass`.
 */
export async function driveFilePass(
  deps: DriveFilePassDeps,
  parentJobId: string,
  roomPath: string,
  fileId: string,
  fileName: string,
  instruction: string,
  mode: string,
  cancel: CancelFlag
): Promise<{ message: string; meta: FileMeta | null }> {
  const settings = passModeAndInstruction(mode, instruction);
  const { filtered, windows } = readablePassText(deps, roomPath, fileId, fileName);

  const resolveEngine = deps.resolveEngine ?? resolvePassEngineNotImplemented;
  const { model: chatModel, lane } = await resolveEngine();
  const steps = buildPassSteps(windows.length, settings.mode, lane);
  const plan = drivePassPlan(fileId, fileName, settings.instruction, settings.mode, filtered, windows);
  // Round-tripped through JSON exactly once, matching what a stored jobs row
  // actually holds and what `resumableChild` compares against.
  const planJson = JSON.parse(JSON.stringify(plan)) as unknown;
  const title = `Full pass — ${fileName}`;

  // A parent that was stopped re-drives this node from the top, so without
  // this lookup every pause/resume minted a SECOND child row and re-read the
  // whole file from window 0.
  const { childId, startCursor } = passChild(deps, roomPath, parentJobId, planJson, steps, title);
  updatePassChildStatus(deps, roomPath, childId, "running", null);

  const published: PublishedRef = { value: null };
  const startDone = completedPassSteps(startCursor);

  const outcome = await runPlan(
    steps,
    startDone,
    cancel,
    (s) => executePassStep(deps, childId, roomPath, plan, chatModel, filtered, s, cancel, published),
    (done) => checkpointPassChild(deps, roomPath, childId, done),
    () => {},
  );

  const status = passOutcomeStatus(outcome);
  updatePassChildStatus(deps, roomPath, childId, status.status, status.error);
  return drivePassResult(outcome, published, fileName);
}

export type { SidecarError };
