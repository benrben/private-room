/**
 * ADD-32: the whole-file pass — an exhaustive, durable map/fold/reduce job
 * that guarantees EVERY character of a file passes through the model, no
 * matter how large the file is. Ported from
 * `src-tauri/src/commands/jobs/file_pass.rs` (1660 lines, read in full,
 * including its `#[cfg(test)] mod tests`).
 *
 * Shape (all control flow is deterministic code — the model only fills the
 * fuzzy nodes):
 *   1. {@link partitionWindows} (`extractionWindow.ts`) splits the filtered
 *      text into N consecutive windows (plan-time, pure).
 *   2. N chained `map` steps walk the file IN ORDER, each receiving its
 *      window plus a short `thread` carried from the previous step — the
 *      long, monotonic read. Each writes an artifact row.
 *   3. Merge mode: `compose` steps each write ONE ordered HTML section from a
 *      group of {@link PASS_SECTION_WINDOWS} consecutive windows' notes — no
 *      global fold, so no single call must hold the whole file (a small
 *      model collapsed the old whole-file merge: an 850 KB book's chapters
 *      got lost this way). Stitch mode has no compose — its deliverable is
 *      the ordered concatenation of the map outputs.
 *   4. A `publish` step (no model) writes the result into the room: merge
 *      mode concatenates the section HTML in order; stitch joins the map
 *      outputs. Both carry an honest coverage line.
 *
 * PRESERVED EXACTLY, on the owner's explicit instruction: the per-SECTION
 * compose, never a single global fold over the whole file's notes. Do not
 * "simplify" this into one fold — that is the exact defect this design
 * fixes.
 *
 * Every step is checkpointed via `jobs.ts`'s ADD-30 job runner
 * ({@link runPlan}/{@link densePrefix}), so a pass survives Stop, app quit,
 * and crashes, and resumes from its cursor. The plan (the window list) is
 * IMMUTABLE in the jobs row — artifacts align with step ids, so a resume must
 * never re-derive different windows.
 *
 * DEPENDENCIES GENUINELY MISSING, ported as small new files alongside this one
 * rather than re-porting anything already committed:
 *   - `extraction::smart_filter`/`partition_windows` -> `extractionWindow.ts`
 *     (`jobs.ts`'s own module doc names this exact gap).
 *   - `sidecar::sidecar_json_cancellable`/`SidecarError::sentinel` ->
 *     `sidecarJsonCancellable.ts` (a new file, not an addition to the
 *     already-committed `sidecar.ts`).
 *   - `commands::artifact::Artifact` (the ART-1 write-funnel builder) ->
 *     `artifactBuilder.ts`, composed from the already-ported
 *     `db-host/artifacts.ts` staging primitives.
 *   - `db::list_file_versions` -> `db-host/fileVersionsList.ts` (the one
 *     reader off `versions.rs`'s otherwise out-of-scope read/pin/delete
 *     surface that this batch's own tests call).
 *
 * REUSED AS-IS, never re-implemented (both were hand-rolled stand-ins in an
 * earlier draft of this port, and both stand-ins were WRONG):
 *   - `docs_html.rs::html_document` -> `docsHtml.ts`'s already-ported
 *     {@link htmlDocument}. A minimal "same observable contract" stand-in
 *     satisfies file_pass.rs's own tests (`starts_with("<!doctype html>")`,
 *     `contains("<hr/>")`) while silently publishing every merge deliverable
 *     with NO stylesheet and NO `Arcelle · generated on this Mac` footer.
 *   - `ollama::resolved_base_url()` -> `engineRouting.ts`'s already-ported
 *     {@link resolvedBaseUrl}, which layers the C1 runtime override over
 *     `ARCELLE_OLLAMA_URL` over the local default. Hard-coding the local
 *     default here would send every window of a pass to 127.0.0.1 in a room
 *     the owner pointed at a LAN Ollama box.
 *
 * DEVIATION — no `tauri::AppHandle<R>`/`AppState`. Ported as an injected
 * `FilePassStepDeps`/`DriveFilePassDeps` shape, following the exact
 * convention `jobs.ts` established (`RoomSource`, `ProgressSink`,
 * `JobRunnerDeps`) rather than inventing a second one.
 *
 * DEVIATION — `resolve_pass_engine` (model_setting + `ollama::list_models` +
 * `capabilities::runs_on_this_mac`) has no Electron port anywhere in this
 * migration yet; {@link driveFilePass} takes it as an injectable
 * {@link ResolvePassEngine}, defaulting to a clearly-labeled
 * `NOT_IMPLEMENTED:` stub — the same "stub, don't fake" seam `jobs.ts`'s own
 * `RenderPodcastAudio` establishes for `spawn_podcast_audio`'s one unported
 * dependency. It is the ONLY seam left in this file: everything else
 * `drive_file_pass` needs is now really ported, so `filePass.test.ts` drives
 * the whole map -> per-section compose -> publish pipeline for real against a
 * fake sidecar.
 *
 * DEVIATION — `PassArtifact`'s wire shape stays SNAKE_CASE (`file_id`, not
 * `fileId`) even though the rest of this port is camelCase throughout. The
 * Rust struct carries no `#[serde(rename_all = "camelCase")]` (unlike
 * `PassPlan`, which does), and its JSON is a cross-language contract: a
 * Python sidecar step writes `job_artifacts` rows in this exact shape (see
 * `pass_artifact_wire_format_is_the_migration_contract`). The TS-internal
 * {@link PassArtifact} type is camelCase (`fileId`); the wire boundary is
 * {@link passArtifactToWireValue}/{@link passArtifactFromWireValue} — the
 * same explicit-adapter pattern `jobs.ts`'s own `Step.dependsOn` deviation
 * note documents for the identical reason.
 */

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

// ---------------------------------------------------------------- constants

/** One window of file text per map call (~10K tokens). A 44-document,
 * 116-run sweep across window sizes 16K–64K found 32K the sweet spot: it
 * roughly HALVES the window count (so ~40% less map-phase time) for only ~4%
 * recall loss, and stays well inside the job's num_ctx. */
export const PASS_WINDOW_CHARS = 32_000;
/** Carried back from the previous window so nothing straddling a cut is lost. */
export const PASS_WINDOW_OVERLAP = 400;
/** Windows composed per section (merge mode). Each section is written from
 * just these windows' notes and the sections are concatenated in order — so
 * no single model call ever holds the whole file. A global fold DID (map ->
 * merge tree -> one compose), and a small local model collapsed the big
 * folds (an 850 KB book's merge came back empty), losing most chapters. Six
 * windows (~2–3 chapters) is well within reach and was the size validated on
 * the real book. DO NOT collapse this back into a single global fold. */
export const PASS_SECTION_WINDOWS = 6;

/** `commands::models::KEEP_ALIVE_WARM` — a plain literal, not a re-port of
 * `models.rs` (unported): every job endpoint sends this so the resident model
 * stays warm across the pass's many sequential calls. */
const KEEP_ALIVE_WARM = "30m";

// ------------------------------------------------------------------ PassPlan

/** The immutable plan stored on the jobs row. `windows` are BYTE spans (see
 * `extractionWindow.ts`'s own module doc) into the `smartFilter`ed text;
 * `textLen` and `textSha256` let a resume detect that the file changed
 * underneath the plan instead of silently mis-slicing. Mirrors the Rust
 * `PassPlan` (`#[serde(rename_all = "camelCase")]`) field-for-field, so
 * `JSON.stringify`/`JSON.parse` round-trip it with no adapter needed (unlike
 * {@link PassArtifact} — see this file's own module doc). */
export interface PassPlan {
  fileId: string;
  fileName: string;
  instruction: string;
  /** "merge" (notes -> composed per-section -> concatenated document) or
   * "stitch" (each window transformed; outputs concatenated in order —
   * translation, rewriting). */
  mode: string;
  textLen: number;
  /** SHA-256 (hex) of the filtered text. Optional — omitted on the wire
   * (`JSON.stringify` drops an `undefined` field) exactly as Rust's
   * `#[serde(default)]` `Option<String>` deserializes an ABSENT key as
   * `None` — so a plan persisted before the digest existed still loads. */
  textSha256?: string;
  windows: Array<[number, number]>;
}

/** Parse a `PassPlan` off an arbitrary JSON value — the wire-contract half of
 * `#[derive(Deserialize)]`, exercised directly by
 * `plan_without_digest_still_deserializes`. Throws on a genuinely malformed
 * shape (never used to smuggle a bad plan past a resume). */
export function parsePassPlan(v: unknown): PassPlan {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("invalid PassPlan: not an object");
  }
  const o = v as Record<string, unknown>;
  const str = (key: string): string => {
    const val = o[key];
    if (typeof val !== "string") {
      throw new Error(`invalid PassPlan: "${key}" is not a string`);
    }
    return val;
  };
  const num = (key: string): number => {
    const val = o[key];
    if (typeof val !== "number") {
      throw new Error(`invalid PassPlan: "${key}" is not a number`);
    }
    return val;
  };
  const rawWindows = o.windows;
  if (!Array.isArray(rawWindows)) {
    throw new Error('invalid PassPlan: "windows" is not an array');
  }
  const windows: Array<[number, number]> = rawWindows.map((w) => {
    if (!Array.isArray(w) || w.length !== 2 || typeof w[0] !== "number" || typeof w[1] !== "number") {
      throw new Error('invalid PassPlan: a window is not a [number, number] pair');
    }
    return [w[0], w[1]];
  });
  const textSha256 = "textSha256" in o && o.textSha256 !== null && o.textSha256 !== undefined ? str("textSha256") : undefined;
  const plan: PassPlan = {
    fileId: str("fileId"),
    fileName: str("fileName"),
    instruction: str("instruction"),
    mode: str("mode"),
    textLen: num("textLen"),
    windows,
  };
  if (textSha256 !== undefined) {
    plan.textSha256 = textSha256;
  }
  return plan;
}

// --------------------------------------------------------------- step plan

/**
 * Build the full step DAG for a pass — pure and deterministic, so start and
 * resume derive the identical plan from the same inputs. Ids are topological
 * (every dependency has a lower id), which is what makes the job runner's
 * `0..cursor` resume seeding valid. Ported verbatim from `build_pass_steps`.
 */
export function buildPassSteps(nWindows: number, mode: string, modelLane: Lane): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < nWindows; i++) {
    steps.push({
      id: i,
      lane: modelLane,
      kind: "map",
      params: { window: i },
      // The chain: window i waits for i-1, receiving its thread — the
      // monotonic read that walks the whole file in order.
      dependsOn: i === 0 ? [] : [i - 1],
    });
  }
  let nextId = nWindows;
  if (mode === "stitch") {
    // The chain already orders everything; publish rides on the last map.
    steps.push({
      id: nextId,
      lane: "cpu",
      kind: "publish",
      params: { inputs: Array.from({ length: nWindows }, (_, i) => i) },
      dependsOn: [nWindows - 1],
    });
    return steps;
  }
  // Sectioned compose: group consecutive windows into sections of
  // PASS_SECTION_WINDOWS, compose EACH section's HTML from just its windows'
  // notes, and let publish concatenate the sections in order. No global
  // fold — every compose sees at most PASS_SECTION_WINDOWS windows, which a
  // small local model can hold, so a big file stays complete instead of
  // collapsing in a whole-file merge.
  const totalSections = Math.ceil(nWindows / PASS_SECTION_WINDOWS);
  const sectionIds: number[] = [];
  for (let sec = 0; sec < totalSections; sec++) {
    const start = sec * PASS_SECTION_WINDOWS;
    const end = Math.min(start + PASS_SECTION_WINDOWS, nWindows);
    const windowIds = Array.from({ length: end - start }, (_, k) => start + k);
    steps.push({
      id: nextId,
      lane: modelLane,
      kind: "compose",
      params: { windows: windowIds, section: sec, total: totalSections },
      dependsOn: windowIds,
    });
    sectionIds.push(nextId);
    nextId += 1;
  }
  steps.push({
    id: nextId,
    lane: "cpu",
    kind: "publish",
    params: { sections: sectionIds },
    dependsOn: sectionIds,
  });
  return steps;
}

// --------------------------------------------------------------- PassArtifact

/** The artifact one step leaves for later steps: the window's output plus
 * the thread handed to the next window. `skipped` marks a window the model
 * could not process (after a retry) — publish counts these honestly.
 * `fileId` (publish only) is the deliverable it wrote — see this file's own
 * module doc on why the WIRE field is `file_id`, not `fileId`. */
export interface PassArtifact {
  result: string;
  thread: string;
  skipped: boolean;
  fileId?: string;
}

function defaultArtifact(): PassArtifact {
  return { result: "", thread: "", skipped: false };
}

/** `PassArtifact`'s wire shape — see this file's module doc. `null`/absent
 * behave exactly as Rust's `#[serde(default)]` on a MISSING key (never on a
 * present-but-wrong-typed one, which is a deserialize FAILURE, same as
 * Rust); a wrong-typed field returns `null` here, mirroring
 * `serde_json::from_value::<PassArtifact>(v)` returning `Err`. */
function passArtifactFromWireValue(v: unknown): PassArtifact | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return null;
  }
  const o = v as Record<string, unknown>;
  let result = "";
  if ("result" in o && o.result !== undefined) {
    if (typeof o.result !== "string") return null;
    result = o.result;
  }
  let thread = "";
  if ("thread" in o && o.thread !== undefined) {
    if (typeof o.thread !== "string") return null;
    thread = o.thread;
  }
  let skipped = false;
  if ("skipped" in o && o.skipped !== undefined) {
    if (typeof o.skipped !== "boolean") return null;
    skipped = o.skipped;
  }
  let fileId: string | undefined;
  if ("file_id" in o && o.file_id !== undefined && o.file_id !== null) {
    if (typeof o.file_id !== "string") return null;
    fileId = o.file_id;
  }
  const out: PassArtifact = { result, thread, skipped };
  if (fileId !== undefined) {
    out.fileId = fileId;
  }
  return out;
}

/** The inverse of {@link passArtifactFromWireValue} — `file_id` OMITTED when
 * absent, matching the Rust field's `skip_serializing_if = "Option::is_none"`. */
function passArtifactToWireValue(a: PassArtifact): Record<string, unknown> {
  const out: Record<string, unknown> = { result: a.result, thread: a.thread, skipped: a.skipped };
  if (a.fileId !== undefined) {
    out.file_id = a.fileId;
  }
  return out;
}

/** Exported (unlike Rust's private `load_artifact`) purely so this module's
 * own test suite can whitebox-inspect/seed a step's stored artifact directly
 * — the same access the Rust `#[cfg(test)] mod tests` gets for free by
 * living inside the same file. Not part of the public port surface any
 * caller outside this file's own tests should reach for. */
export function loadArtifact(db: Database.Database, jobId: string, stepId: number): PassArtifact | null {
  const raw = getJobArtifact(db, jobId, stepId);
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return passArtifactFromWireValue(parsed);
}

/** See {@link loadArtifact}'s own note on why this is exported. */
export function storeArtifact(db: Database.Database, jobId: string, stepId: number, artifact: PassArtifact): void {
  putJobArtifact(db, jobId, stepId, JSON.stringify(passArtifactToWireValue(artifact)));
}

/** A hard engine failure parks the job for Resume; anything else is a
 * one-off the pass survives (the window is marked skipped, coverage stays
 * honest). Ported verbatim from `is_fatal`. */
export function isFatal(e: string): boolean {
  return e === "OLLAMA_DOWN" || e.startsWith("MODEL_MISSING");
}

// --------------------------------------------------------------- room / emit

const ROOM_GONE = "The room this job belongs to is no longer open.";

/** Best-effort UI notification — the same narrow contract `organizeTools.ts`/
 * `fileTools.ts` already establish locally (until the day these collapse
 * onto one shared module). */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
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
function requireRoomDb(rooms: RoomSource, roomPath: string): Database.Database {
  const db = pinnedDb(rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  return db;
}

function requireRoom(rooms: RoomSource, roomPath: string): RoomHandle {
  const room = rooms.current();
  if (room === null || room.path !== roomPath) throw new Error(ROOM_GONE);
  return room;
}

/** `store_file_bytes` (`commands/files.rs`) — snapshot the file's current
 * state into history, then overwrite it. Small enough to inline rather than
 * pull in the rest of `files.rs`, which this batch does not otherwise need. */
function storeFileBytes(
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
function textDigest(s: string): string {
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
    switch (step.kind) {
      case "map":
        return await executeMapStep(deps, jobId, roomPath, plan, model, filtered, step, cancel, post, n);
      case "compose":
        return await executeComposeStep(deps, jobId, roomPath, plan, model, step, cancel, post);
      case "publish":
        return await executePublishStep(deps, jobId, roomPath, plan, step, cancel, published, n);
      default:
        return { ok: false, error: `unknown pass step kind: ${step.kind}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stepParams(step: Step): Record<string, unknown> {
  return typeof step.params === "object" && step.params !== null && !Array.isArray(step.params)
    ? (step.params as Record<string, unknown>)
    : {};
}

/** `serde_json::Value::as_u64()`: a value is a step-param index only if it is a
 * non-negative INTEGER. A float or a negative number reads as `None` in Rust
 * and must read as absent here too, or a malformed plan silently addresses a
 * window that does not exist instead of falling back the way Rust does. */
function asU64(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** `step.params[key].as_u64().unwrap_or(fallback)`. */
function u64Param(params: Record<string, unknown>, key: string, fallback: number): number {
  return asU64(params[key]) ?? fallback;
}

/**
 * `step.params[key].as_array().map(|a| a.iter().filter_map(as_u64)...)` —
 * `null` when the key is MISSING OR NOT AN ARRAY (Rust's `as_array()` returns
 * `None` for both), so the caller can apply the same `unwrap_or`/
 * `unwrap_or_else` fallback the Rust arm does. Within a real array, non-u64
 * entries are dropped, exactly as `filter_map` drops them.
 */
function u64ArrayParam(params: Record<string, unknown>, key: string): number[] | null {
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

async function executeMapStep(
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
  const params = stepParams(step);
  const i = u64Param(params, "window", 0);
  const span = plan.windows[i];
  if (span === undefined) {
    throw new Error(`window ${i} is not in the plan`);
  }
  const [start, end] = span;
  const windowText = sliceUtf8(filtered, start, end);
  if (windowText === null) {
    throw new Error("the file's text no longer matches this pass — start a new pass");
  }
  // The thread from the previous window keeps the read continuous.
  let thread = "";
  if (i !== 0) {
    const db = requireRoomDb(deps.rooms, roomPath);
    thread = loadArtifact(db, jobId, i - 1)?.thread ?? "";
  }
  // MIGRATION Phase 3: the prompts, the result-key/cap choice, the schema, the
  // retrying model call and the clamps all live in the sidecar's own
  // `/file_pass_map`; it returns the full `{result, thread, skipped}` artifact.
  // This keeps only the plan, the window slice, and the thread it loaded from
  // the prior artifact.
  const body = {
    model,
    base_url: resolvedBaseUrl(),
    mode: plan.mode,
    file_name: plan.fileName,
    instruction: plan.instruction,
    part: i,
    total: n,
    start,
    end,
    text_len: plan.textLen,
    thread,
    window_text: windowText,
    keep_alive: KEEP_ALIVE_WARM,
  };
  let artifact: PassArtifact;
  const outcome = await post("/file_pass_map", body, cancel);
  if (outcome.kind === "value") {
    artifact = passArtifactFromWireValue(outcome.value) ?? defaultArtifact();
  } else if (outcome.kind === "stopped") {
    return { ok: false, error: "STOPPED" };
  } else {
    // A FATAL engine failure parks the job for Resume; any other transient
    // client error degrades this window like the old double-failure — keep
    // the thread flowing, mark skipped.
    const sentinel = sidecarErrorSentinel(outcome.error, model);
    if (isFatal(sentinel)) {
      return { ok: false, error: sentinel };
    }
    artifact = { result: "", thread, skipped: true };
  }
  const db = requireRoomDb(deps.rooms, roomPath);
  storeArtifact(db, jobId, step.id, artifact);
  return { ok: true };
}

async function executeComposeStep(
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

  const gatherDb = requireRoomDb(deps.rooms, roomPath);
  const sections: string[] = [];
  let missing = 0;
  for (const w of windowIds) {
    const a = loadArtifact(gatherDb, jobId, w);
    if (a !== null && !a.skipped && a.result.trim() !== "") {
      sections.push(a.result);
    } else {
      missing += 1;
    }
  }

  if (sections.length === 0) {
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
  const body = {
    model,
    base_url: resolvedBaseUrl(),
    instruction: plan.instruction,
    file_name: plan.fileName,
    section,
    total,
    sections,
    missing,
    keep_alive: KEEP_ALIVE_WARM,
  };
  let artifact: PassArtifact;
  const outcome = await post("/file_pass_section", body, cancel);
  if (outcome.kind === "value") {
    artifact = passArtifactFromWireValue(outcome.value) ?? defaultArtifact();
  } else if (outcome.kind === "stopped") {
    return { ok: false, error: "STOPPED" };
  } else {
    const sentinel = sidecarErrorSentinel(outcome.error, model);
    if (isFatal(sentinel)) {
      return { ok: false, error: sentinel };
    }
    // Transient client failure: keep the reading by publishing the group's
    // raw notes rather than dropping the section.
    artifact = { result: sections.join("\n\n"), thread: "", skipped: false };
  }
  const db = requireRoomDb(deps.rooms, roomPath);
  storeArtifact(db, jobId, step.id, artifact);
  return { ok: true };
}

async function executePublishStep(
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

  // Honest coverage: count skipped map windows straight from the rows.
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const a = loadArtifact(db, jobId, i);
    if (a === null || a.skipped) {
      skipped += 1;
    }
  }
  const coverage =
    skipped === 0
      ? `Read all ${n} parts of “${plan.fileName}” — ${plan.textLen} characters, complete coverage.`
      : `Read ${n - skipped} of ${n} parts of “${plan.fileName}” (${plan.textLen} characters); ${skipped} part(s) could not be processed and are marked in place.`;

  // Idempotent publish: this step re-runs whenever the app died in the split
  // second between writing the deliverable and saving the checkpoint. Reuse
  // the file it already wrote (a versioned overwrite, undoable) instead of
  // minting a second identical one.
  const prior = loadArtifact(db, jobId, step.id)?.fileId ?? null;

  const writeDeliverable = async (name: string, mime: string, content: string): Promise<FileMeta> => {
    // Owner replacement #3, at the moment of the commit — the gate above
    // guards the DECISION; the stitch/merge between there and here is real
    // work, and the re-run branch below writes straight through
    // `storeFileBytes` — it does not pass the funnel that re-reads the flag,
    // so without this a Stop landing mid-publish still rewrote the user's
    // deliverable.
    if (stopped(cancel)) {
      throw new Error("STOPPED");
    }
    if (prior !== null) {
      let priorExists = true;
      try {
        getFileMeta(db, prior);
      } catch {
        priorExists = false;
      }
      if (priorExists) {
        if (room.workspace !== undefined) {
          await writeRoomFile(
            { db, path: roomPath },
            prior,
            Buffer.from(content, "utf8"),
            content,
            `Full pass re-run — ${plan.fileName}`,
          );
        } else {
          storeFileBytes(db, prior, Buffer.from(content, "utf8"), content, `Full pass re-run — ${plan.fileName}`);
        }
        // Room map: a replay rewrites the same file, so its provenance has to
        // be (re)stated here too — the insert branch below is skipped on
        // this path.
        setDerivedFrom(db, prior, plan.fileId);
        return getFileMeta(db, prior);
      }
    }
    // ART-1: no recorded prior — this is a first write (or one whose file the
    // user deleted). Through the staging funnel, so a crash between here and
    // the commit leaves nothing behind, and a SECOND pass over the same
    // source becomes a version of the first deliverable rather than a
    // "Full pass — lease.pdf (2).html".
    const artifact = Artifact.new(name, mime, content)
      .by("Full pass")
      .duringRun(jobId)
      .fromFiles([plan.fileId])
      .cancelWith(cancel);
    const written = room.workspace === undefined
      ? artifact.commit(db)
      : await artifact.commitToWorkspace(room.workspace);
    // Room map: this deliverable IS the pass's source file, rewritten.
    setDerivedFrom(db, written.meta.id, plan.fileId);
    return written.meta;
  };

  let meta: FileMeta;
  if (plan.mode === "stitch") {
    const params = stepParams(step);
    // Rust: `.as_array().map(..).unwrap_or_else(|| (0..n).collect())` — a
    // MISSING `inputs` and a MISSHAPEN one (a number, a string, an object)
    // both fall back to every window in order. Treating only "missing" as the
    // fallback published a stitch deliverable that was nothing but the
    // coverage line whenever a re-derived plan's params drifted.
    const inputs = u64ArrayParam(params, "inputs") ?? Array.from({ length: n }, (_, i) => i);
    let body = "";
    for (const i of inputs) {
      const a = loadArtifact(db, jobId, i);
      if (a !== null && !a.skipped && a.result.trim() !== "") {
        body += `${a.result.trim()}\n\n`;
      } else {
        body += `[part ${i + 1} could not be processed]\n\n`;
      }
    }
    body += `---\n\n_${coverage}_\n`;
    const name = `Full pass — ${plan.fileName}.md`;
    meta = await writeDeliverable(name, "text/markdown", body);
  } else {
    // Sectioned: concatenate each section's composed HTML in order. Rust:
    // `.as_array().map(..).unwrap_or_default()` — an absent or misshapen
    // `sections` is the EMPTY list, which is the one reachable half of the
    // "no readable sections" guard below.
    const params = stepParams(step);
    const sectionIds = u64ArrayParam(params, "sections") ?? [];
    let htmlBody = "";
    for (const sid of sectionIds) {
      const a = loadArtifact(db, jobId, sid);
      if (a !== null && !a.skipped && a.result.trim() !== "") {
        htmlBody += `${a.result.trim()}\n`;
      } else {
        htmlBody += "<p><em>[a section could not be composed]</em></p>\n";
      }
    }
    if (htmlBody.trim() === "") {
      throw new Error("the pass produced no readable sections to publish");
    }
    const name = `Full pass — ${plan.fileName}.html`;
    const body = `${htmlBody}\n<hr/>\n<p><em>${coverage}</em></p>`;
    const content = htmlDocument(name, body);
    meta = await writeDeliverable(name, "text/html", content);
  }

  // Record what was written BEFORE the runner's checkpoint, so a replay from
  // any later crash finds it.
  storeArtifact(db, jobId, step.id, { result: coverage, thread: "", skipped: false, fileId: meta.id });
  emitSafely(deps.emit, "room-files-changed", undefined);
  published.value = meta;
  return { ok: true };
}

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
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqualJson(v, b[i]));
  }
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    return aKeys.length === bKeys.length && aKeys.every((k, i) => k === bKeys[i] && deepEqualJson(a[k], b[k]));
  }
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
  const resolvedMode = mode === "stitch" ? "stitch" : "merge";
  const trimmed = instruction.trim();
  const finalInstruction = trimmed === "" ? "Summarize this file completely and thoroughly." : trimmed;

  const readDb = requireRoomDb(deps.rooms, roomPath);
  const rawText = getFileExtractedText(readDb, fileId);
  if (rawText === null) {
    throw new Error(`"${fileName}" has no readable text for a pass.`);
  }
  const filtered = smartFilter(rawText);

  const windows = partitionWindows(filtered, PASS_WINDOW_CHARS, PASS_WINDOW_OVERLAP);
  if (windows.length === 0) {
    throw new Error(`"${fileName}" has no readable text after filtering.`);
  }

  const resolveEngine = deps.resolveEngine ?? resolvePassEngineNotImplemented;
  const { model: chatModel, lane } = await resolveEngine();
  const steps = buildPassSteps(windows.length, resolvedMode, lane);
  const plan: PassPlan = {
    fileId,
    fileName,
    instruction: finalInstruction,
    mode: resolvedMode,
    textLen: byteLength(filtered),
    textSha256: textDigest(filtered),
    windows,
  };
  // Round-tripped through JSON exactly once, matching what a stored jobs row
  // actually holds and what `resumableChild` compares against.
  const planJson = JSON.parse(JSON.stringify(plan)) as unknown;
  const title = `Full pass — ${fileName}`;

  // A parent that was stopped re-drives this node from the top, so without
  // this lookup every pause/resume minted a SECOND child row and re-read the
  // whole file from window 0.
  let childId: string;
  let startCursor: number;
  {
    const db = requireRoomDb(deps.rooms, roomPath);
    const resumable = resumableChild(db, parentJobId, planJson);
    if (resumable !== null) {
      childId = resumable.id;
      startCursor = Math.min(resumable.cursor, steps.length);
    } else {
      childId = createChildJob(db, "file_pass", title, planJson, steps.length, parentJobId);
      startCursor = 0;
    }
  }
  {
    const db = pinnedDb(deps.rooms, roomPath);
    if (db !== null) {
      try {
        setJobStatus(db, childId, "running", null);
      } catch {
        // best-effort, mirrors Rust's `let _ = db::set_job_status(...)`
      }
    }
  }

  const published: PublishedRef = { value: null };
  const startDone = new Set<number>();
  for (let i = 0; i < startCursor; i++) {
    startDone.add(i);
  }

  const outcome = await runPlan(
    steps,
    startDone,
    cancel,
    (s) => executePassStep(deps, childId, roomPath, plan, chatModel, filtered, s, cancel, published),
    (done) => {
      const db = pinnedDb(deps.rooms, roomPath);
      if (db !== null) {
        try {
          checkpointJob(db, childId, densePrefix(done), {});
        } catch {
          // best-effort
        }
      }
    },
    () => {
      // No per-wave progress card here — the parent workflow's own progress
      // event covers this node (matches Rust's `|_, _| {}`).
    }
  );

  let status: string;
  let err: string | null;
  if (outcome.kind === "done") {
    status = "done";
    err = null;
  } else if (outcome.kind === "paused") {
    status = "paused";
    err = null;
  } else {
    status = "error";
    err = outcome.error;
  }
  {
    const db = pinnedDb(deps.rooms, roomPath);
    if (db !== null) {
      try {
        setJobStatus(db, childId, status, err);
      } catch {
        // best-effort
      }
    }
  }

  if (outcome.kind === "done") {
    const meta = published.value;
    const name = meta?.name ?? "";
    return { message: `Saved a full pass of "${fileName}" as "${name}".`, meta };
  }
  // The parent's cancel tripped — surface STOPPED so the workflow parks and
  // re-drives this node on resume.
  if (outcome.kind === "paused") {
    throw new Error("STOPPED");
  }
  throw new Error(outcome.error);
}

export type { SidecarError };
