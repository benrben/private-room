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
import { KEEP_ALIVE_WARM, PassPlan, PassArtifact, defaultArtifact, passArtifactFromWireValue, loadArtifact, storeArtifact, isFatal } from "./filePassCore.js";


// --------------------------------------------------------------- room / emit

export const ROOM_GONE = "The room this job belongs to is no longer open.";

/** Best-effort UI notification — the same narrow contract `organizeTools.ts`/
 * `fileTools.ts` already establish locally (until the day these collapse
 * onto one shared module). */
export type EmitFn = (event: string, payload: unknown) => void;

export function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = w.emit(...)`.
  }
}

/** `room.db` only if the room currently open is STILL the one this step's job
 * started in, THROWING the exact sentence every Rust runner returns from
 * `.ok_or("The room this job belongs to is no longer open.")?` otherwise —
 * the room-pin discipline `jobs.ts`'s own `pinnedDb` implements as a `null`
 * return; this is the "hard requirement" wrapper around it. */
export function requireRoomDb(rooms: RoomSource, roomPath: string): Database.Database {
  const db = pinnedDb(rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  return db;
}

export function requireRoom(rooms: RoomSource, roomPath: string): RoomHandle {
  const room = rooms.current();
  if (room === null || room.path !== roomPath) throw new Error(ROOM_GONE);
  return room;
}

/** `store_file_bytes` (`commands/files.rs`) — snapshot the file's current
 * state into history, then overwrite it. Small enough to inline rather than
 * pull in the rest of `files.rs`, which this batch does not otherwise need. */
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

/** SHA-256 (hex) of the smart-filtered pass text — ported from `text_digest`. */
export function textDigest(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

// --------------------------------------------------------------- step execution

/** POST one cancellable sidecar request — the injectable seam `execute_pass_step`
 * needs, defaulting to the real {@link sidecarJsonCancellable}. Overridable
 * for tests only, exactly like `deliverCancel`'s own `post` parameter in
 * `sidecar.ts`. */
export type SidecarPostFn = (path: string, body: unknown, cancel: CancelFlag) => Promise<SidecarPostOutcome>;

/** Everything one pass step needs beyond its own arguments: where the open
 * room is, and where to send a best-effort UI notification. Follows
 * `jobs.ts`'s established `RoomSource`/`ProgressSink` seam convention rather
 * than inventing a second one. */
export interface FilePassStepDeps {
  rooms: RoomSource;
  emit?: EmitFn;
  post?: SidecarPostFn;
}

/** A mutable box for the file `execute_pass_step`'s `publish` kind writes —
 * the TS stand-in for Rust's `&std::sync::Mutex<Option<FileMeta>>` (there are
 * no threads here to guard against, so a plain object is the whole story). */
export interface PublishedRef {
  value: FileMeta | null;
}

/**
 * Execute one pass step. `filtered` is the smart-filtered file text the
 * plan's windows index into, fetched once per run and shared across steps.
 * `roomPath` pins the step to the room the pass was started in: every room
 * access re-checks the CURRENT room against it and throws on a mismatch, so a
 * room closed or swapped mid-run parks the job instead of receiving another
 * room's artifacts. Ported verbatim from `execute_pass_step`.
 */
export async function executePassStep(
  deps: FilePassStepDeps,
  jobId: string,
  roomPath: string,
  plan: PassPlan,
  model: string,
  filtered: string,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef
): Promise<StepResult> {
  const post = deps.post ?? sidecarJsonCancellable;
  const n = plan.windows.length;
  try {
    return await executePassKind(deps, jobId, roomPath, plan, model, filtered, step, cancel, published, post, n);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executePassKind(
  deps: FilePassStepDeps,
  jobId: string,
  roomPath: string,
  plan: PassPlan,
  model: string,
  filtered: string,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef,
  post: SidecarPostFn,
  n: number,
): Promise<StepResult> {
  switch (step.kind) {
    case "map":
      return executeMapStep(deps, jobId, roomPath, plan, model, filtered, step, cancel, post, n);
    case "compose":
      return executeComposeStep(deps, jobId, roomPath, plan, model, step, cancel, post);
    case "publish":
      return executePublishStep(deps, jobId, roomPath, plan, step, cancel, published, n);
    default:
      return { ok: false, error: `unknown pass step kind: ${step.kind}` };
  }
}

export function stepParams(step: Step): Record<string, unknown> {
  return typeof step.params === "object" && step.params !== null && !Array.isArray(step.params)
    ? (step.params as Record<string, unknown>)
    : {};
}

/** `serde_json::Value::as_u64()`: a value is a step-param index only if it is a
 * non-negative INTEGER. A float or a negative number reads as `None` in Rust
 * and must read as absent here too, or a malformed plan silently addresses a
 * window that does not exist instead of falling back the way Rust does. */
export function asU64(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** `step.params[key].as_u64().unwrap_or(fallback)`. */
export function u64Param(params: Record<string, unknown>, key: string, fallback: number): number {
  return asU64(params[key]) ?? fallback;
}

/**
 * `step.params[key].as_array().map(|a| a.iter().filter_map(as_u64)...)` —
 * `null` when the key is MISSING OR NOT AN ARRAY (Rust's `as_array()` returns
 * `None` for both), so the caller can apply the same `unwrap_or`/
 * `unwrap_or_else` fallback the Rust arm does. Within a real array, non-u64
 * entries are dropped, exactly as `filter_map` drops them.
 */
export function u64ArrayParam(params: Record<string, unknown>, key: string): number[] | null {
  const raw = params[key];
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: number[] = [];
  for (const v of raw) {
    const n = asU64(v);
    if (n !== null) {
      out.push(n);
    }
  }
  return out;
}

export type ResolvedArtifact = PassArtifact | { ok: false; error: string };

export function resolvedArtifact(
  outcome: SidecarPostOutcome,
  model: string,
  fallback: PassArtifact,
): ResolvedArtifact {
  if (outcome.kind === "value") return passArtifactFromWireValue(outcome.value) ?? defaultArtifact();
  if (outcome.kind === "stopped") return { ok: false, error: "STOPPED" };
  const sentinel = sidecarErrorSentinel(outcome.error, model);
  return isFatal(sentinel) ? { ok: false, error: sentinel } : fallback;
}

export function failedArtifact(result: ResolvedArtifact): result is { ok: false; error: string } {
  return "ok" in result;
}

export function mapWindowInput(plan: PassPlan, step: Step, filtered: string): {
  end: number;
  index: number;
  start: number;
  text: string;
} {
  const index = u64Param(stepParams(step), "window", 0);
  const span = plan.windows[index];
  if (span === undefined) throw new Error(`window ${index} is not in the plan`);
  const [start, end] = span;
  const text = sliceUtf8(filtered, start, end);
  if (text === null) throw new Error("the file's text no longer matches this pass — start a new pass");
  return { index, start, end, text };
}

export function priorMapThread(
  deps: FilePassStepDeps,
  roomPath: string,
  jobId: string,
  index: number,
): string {
  if (index === 0) return "";
  return loadArtifact(requireRoomDb(deps.rooms, roomPath), jobId, index - 1)?.thread ?? "";
}

export function mapRequestBody(
  plan: PassPlan,
  model: string,
  input: ReturnType<typeof mapWindowInput>,
  thread: string,
  total: number,
): Record<string, unknown> {
  return {
    model,
    base_url: resolvedBaseUrl(),
    mode: plan.mode,
    file_name: plan.fileName,
    instruction: plan.instruction,
    part: input.index,
    total,
    start: input.start,
    end: input.end,
    text_len: plan.textLen,
    thread,
    window_text: input.text,
    keep_alive: KEEP_ALIVE_WARM,
  };
}

export async function executeMapStep(
  deps: FilePassStepDeps,
  jobId: string,
  roomPath: string,
  plan: PassPlan,
  model: string,
  filtered: string,
  step: Step,
  cancel: CancelFlag,
  post: SidecarPostFn,
  n: number
): Promise<StepResult> {
  const input = mapWindowInput(plan, step, filtered);
  const thread = priorMapThread(deps, roomPath, jobId, input.index);
  // MIGRATION Phase 3: the prompts, the result-key/cap choice, the schema, the
  // retrying model call and the clamps all live in the sidecar's own
  // `/file_pass_map`; it returns the full `{result, thread, skipped}` artifact.
  // This keeps only the plan, the window slice, and the thread it loaded from
  // the prior artifact.
  const outcome = await post("/file_pass_map", mapRequestBody(plan, model, input, thread, n), cancel);
  const artifact = resolvedArtifact(outcome, model, { result: "", thread, skipped: true });
  if (failedArtifact(artifact)) return artifact;
  const db = requireRoomDb(deps.rooms, roomPath);
  storeArtifact(db, jobId, step.id, artifact);
  return { ok: true };
}

export function composeSections(
  db: Database.Database,
  jobId: string,
  windowIds: readonly number[],
): { missing: number; sections: string[] } {
  const sections: string[] = [];
  let missing = 0;
  for (const windowId of windowIds) {
    const artifact = loadArtifact(db, jobId, windowId);
    if (artifact !== null && !artifact.skipped && artifact.result.trim() !== "") sections.push(artifact.result);
    else missing += 1;
  }
  return { sections, missing };
}

export function composeRequestBody(
  plan: PassPlan,
  model: string,
  section: number,
  total: number,
  gathered: ReturnType<typeof composeSections>,
): Record<string, unknown> {
  return {
    model,
    base_url: resolvedBaseUrl(),
    instruction: plan.instruction,
    file_name: plan.fileName,
    section,
    total,
    sections: gathered.sections,
    missing: gathered.missing,
    keep_alive: KEEP_ALIVE_WARM,
  };
}

export async function executeComposeStep(
  deps: FilePassStepDeps,
  jobId: string,
  roomPath: string,
  plan: PassPlan,
  model: string,
  step: Step,
  cancel: CancelFlag,
  post: SidecarPostFn
): Promise<StepResult> {
  // Sectioned compose: gather this section-group's window notes (in order,
  // skipping empties) and write ONE ordered HTML section from them. Publish
  // concatenates the sections, so — unlike the old global fold — no single
  // call holds the whole file.
  const params = stepParams(step);
  const windowIds = u64ArrayParam(params, "windows") ?? [];
  const section = u64Param(params, "section", 0);
  const total = u64Param(params, "total", 1);

  const gathered = composeSections(requireRoomDb(deps.rooms, roomPath), jobId, windowIds);

  if (gathered.sections.length === 0) {
    // The whole group was unreadable — a skipped section. Publish marks it
    // in place, and coverage still counts the skipped windows.
    const db = requireRoomDb(deps.rooms, roomPath);
    storeArtifact(db, jobId, step.id, { result: "", thread: "", skipped: true });
    return { ok: true };
  }

  // The section prompt, schema, retrying call, the clamp AND the
  // empty/double-failure fallback (publish the group's raw notes) live in the
  // sidecar's `/file_pass_section`. This gathers the section's windows'
  // notes + the missing count and stores the returned HTML artifact.
  const outcome = await post("/file_pass_section", composeRequestBody(plan, model, section, total, gathered), cancel);
  const artifact = resolvedArtifact(outcome, model, {
    result: gathered.sections.join("\n\n"), thread: "", skipped: false,
  });
  if (failedArtifact(artifact)) return artifact;
  const db = requireRoomDb(deps.rooms, roomPath);
  storeArtifact(db, jobId, step.id, artifact);
  return { ok: true };
}

export function publishCoverage(
  db: Database.Database,
  jobId: string,
  plan: PassPlan,
  n: number,
): string {
  let skipped = 0;
  for (let index = 0; index < n; index++) {
    const artifact = loadArtifact(db, jobId, index);
    if (artifact === null || artifact.skipped) skipped += 1;
  }
  return skipped === 0
    ? `Read all ${n} parts of “${plan.fileName}” — ${plan.textLen} characters, complete coverage.`
    : `Read ${n - skipped} of ${n} parts of “${plan.fileName}” (${plan.textLen} characters); ${skipped} part(s) could not be processed and are marked in place.`;
}

export type PublishWriteContext = {
  cancel: CancelFlag;
  db: Database.Database;
  jobId: string;
  plan: PassPlan;
  room: RoomHandle;
  roomPath: string;
};

export function priorPublishExists(db: Database.Database, prior: string | null): prior is string {
  if (prior === null) return false;
  try {
    getFileMeta(db, prior);
    return true;
  } catch {
    return false;
  }
}

export async function rewritePriorPublish(
  context: PublishWriteContext,
  prior: string,
  content: string,
): Promise<FileMeta> {
  const bytes = Buffer.from(content, "utf8");
  const cause = `Full pass re-run — ${context.plan.fileName}`;
  if (context.room.workspace !== undefined) {
    await writeRoomFile({ db: context.db, path: context.roomPath }, prior, bytes, content, cause);
  } else {
    storeFileBytes(context.db, prior, bytes, content, cause);
  }
  setDerivedFrom(context.db, prior, context.plan.fileId);
  return getFileMeta(context.db, prior);
}

export async function createPublishFile(
  context: PublishWriteContext,
  name: string,
  mime: string,
  content: string,
): Promise<FileMeta> {
  const artifact = Artifact.new(name, mime, content)
    .by("Full pass")
    .duringRun(context.jobId)
    .fromFiles([context.plan.fileId])
    .cancelWith(context.cancel);
  const written = context.room.workspace === undefined
    ? artifact.commit(context.db)
    : await artifact.commitToWorkspace(context.room.workspace);
  setDerivedFrom(context.db, written.meta.id, context.plan.fileId);
  return written.meta;
}

export async function writePublishDeliverable(
  context: PublishWriteContext,
  prior: string | null,
  name: string,
  mime: string,
  content: string,
): Promise<FileMeta> {
  if (stopped(context.cancel)) throw new Error("STOPPED");
  if (priorPublishExists(context.db, prior)) return rewritePriorPublish(context, prior, content);
  return createPublishFile(context, name, mime, content);
}

export type PublishContent = { content: string; mime: string; name: string };

export function stitchPublishContent(
  db: Database.Database,
  jobId: string,
  plan: PassPlan,
  step: Step,
  coverage: string,
  n: number,
): PublishContent {
  const inputs = u64ArrayParam(stepParams(step), "inputs") ?? Array.from({ length: n }, (_, index) => index);
  let body = "";
  for (const input of inputs) {
    const artifact = loadArtifact(db, jobId, input);
    body += artifact !== null && !artifact.skipped && artifact.result.trim() !== ""
      ? `${artifact.result.trim()}\n\n`
      : `[part ${input + 1} could not be processed]\n\n`;
  }
  body += `---\n\n_${coverage}_\n`;
  return { name: `Full pass — ${plan.fileName}.md`, mime: "text/markdown", content: body };
}

export function publishSection(artifact: PassArtifact | null): string {
  if (artifact === null || artifact.skipped || artifact.result.trim() === "") {
    return "<p><em>[a section could not be composed]</em></p>\n";
  }
  return `${artifact.result.trim()}\n`;
}

export function mergePublishContent(
  db: Database.Database,
  jobId: string,
  plan: PassPlan,
  step: Step,
  coverage: string,
): PublishContent {
  const sectionIds = u64ArrayParam(stepParams(step), "sections") ?? [];
  let htmlBody = "";
  for (const sectionId of sectionIds) {
    htmlBody += publishSection(loadArtifact(db, jobId, sectionId));
  }
  if (htmlBody.trim() === "") throw new Error("the pass produced no readable sections to publish");
  const name = `Full pass — ${plan.fileName}.html`;
  const body = `${htmlBody}\n<hr/>\n<p><em>${coverage}</em></p>`;
  return { name, mime: "text/html", content: htmlDocument(name, body) };
}

export function publishContent(
  db: Database.Database,
  jobId: string,
  plan: PassPlan,
  step: Step,
  coverage: string,
  n: number,
): PublishContent {
  return plan.mode === "stitch"
    ? stitchPublishContent(db, jobId, plan, step, coverage, n)
    : mergePublishContent(db, jobId, plan, step, coverage);
}

export function finishPublish(
  deps: FilePassStepDeps,
  db: Database.Database,
  jobId: string,
  step: Step,
  coverage: string,
  meta: FileMeta,
  published: PublishedRef,
): StepResult {
  storeArtifact(db, jobId, step.id, { result: coverage, thread: "", skipped: false, fileId: meta.id });
  emitSafely(deps.emit, "room-files-changed", undefined);
  published.value = meta;
  return { ok: true };
}

export async function executePublishStep(
  deps: FilePassStepDeps,
  jobId: string,
  roomPath: string,
  plan: PassPlan,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef,
  n: number
): Promise<StepResult> {
  // Owner replacement #3: the commit gate, at the moment of the commit. Every
  // other cancel check on this path lives inside the sidecar POST — i.e. it
  // guards a MODEL CALL. Publish makes no model call at all: it gathers the
  // stored windows and writes the deliverable, so a Stop landing anywhere in
  // this step used to produce exactly the artifact the user was told had not
  // been made. `STOPPED` rather than `guardCommit`'s message because this
  // runner's protocol parks the job for Resume on that sentinel — which is
  // exactly the case `cancel.ts`'s own doc points at `stopped()` for.
  if (stopped(cancel)) {
    return { ok: false, error: "STOPPED" };
  }
  const room = requireRoom(deps.rooms, roomPath);
  const db = room.db;

  const coverage = publishCoverage(db, jobId, plan, n);

  // Idempotent publish: this step re-runs whenever the app died in the split
  // second between writing the deliverable and saving the checkpoint. Reuse
  // the file it already wrote (a versioned overwrite, undoable) instead of
  // minting a second identical one.
  const prior = loadArtifact(db, jobId, step.id)?.fileId ?? null;

  const output = publishContent(db, jobId, plan, step, coverage, n);
  const meta = await writePublishDeliverable(
    { cancel, db, jobId, plan, room, roomPath }, prior, output.name, output.mime, output.content,
  );
  return finishPublish(deps, db, jobId, step, coverage, meta, published);
}
