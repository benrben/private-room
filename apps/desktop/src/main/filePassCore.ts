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
export const KEEP_ALIVE_WARM = "30m";

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
export function passPlanObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid PassPlan: not an object");
  }
  return value as Record<string, unknown>;
}

export function passPlanString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`invalid PassPlan: "${key}" is not a string`);
  return value;
}

export function passPlanNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`invalid PassPlan: "${key}" is not a number`);
  return value;
}

export function passPlanWindows(record: Record<string, unknown>): Array<[number, number]> {
  const rawWindows = record.windows;
  if (!Array.isArray(rawWindows)) {
    throw new Error('invalid PassPlan: "windows" is not an array');
  }
  return rawWindows.map((window) => {
    const [start, end] = Array.isArray(window) ? window : [];
    if (!Array.isArray(window) || window.length !== 2 || typeof start !== "number" || typeof end !== "number") {
      throw new Error('invalid PassPlan: a window is not a [number, number] pair');
    }
    return [start, end];
  });
}

export function optionalPlanDigest(record: Record<string, unknown>): string | undefined {
  const value = record.textSha256;
  if (value === null || value === undefined) return undefined;
  return passPlanString(record, "textSha256");
}

export function parsePassPlan(value: unknown): PassPlan {
  const record = passPlanObject(value);
  const textSha256 = optionalPlanDigest(record);
  const plan: PassPlan = {
    fileId: passPlanString(record, "fileId"),
    fileName: passPlanString(record, "fileName"),
    instruction: passPlanString(record, "instruction"),
    mode: passPlanString(record, "mode"),
    textLen: passPlanNumber(record, "textLen"),
    windows: passPlanWindows(record),
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

export function defaultArtifact(): PassArtifact {
  return { result: "", thread: "", skipped: false };
}

/** `PassArtifact`'s wire shape — see this file's module doc. `null`/absent
 * behave exactly as Rust's `#[serde(default)]` on a MISSING key (never on a
 * present-but-wrong-typed one, which is a deserialize FAILURE, same as
 * Rust); a wrong-typed field returns `null` here, mirroring
 * `serde_json::from_value::<PassArtifact>(v)` returning `Err`. */
export function artifactRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function artifactString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}

export function artifactSkipped(record: Record<string, unknown>): boolean | null {
  const value = record.skipped;
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
}

export function artifactFileId(record: Record<string, unknown>): string | null | undefined {
  const value = record.file_id;
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : null;
}

export function artifactFieldsAreValid(
  result: string | null,
  thread: string | null,
  skipped: boolean | null,
  fileId: string | null | undefined,
): result is string {
  return result !== null && thread !== null && skipped !== null && fileId !== null;
}

export function passArtifactFromWireValue(value: unknown): PassArtifact | null {
  const record = artifactRecord(value);
  if (record === null) return null;
  const result = artifactString(record, "result");
  const thread = artifactString(record, "thread");
  const skipped = artifactSkipped(record);
  const fileId = artifactFileId(record);
  if (!artifactFieldsAreValid(result, thread, skipped, fileId)) return null;
  const out: PassArtifact = { result: result!, thread: thread!, skipped: skipped! };
  if (fileId !== undefined) {
    out.fileId = fileId!;
  }
  return out;
}

/** The inverse of {@link passArtifactFromWireValue} — `file_id` OMITTED when
 * absent, matching the Rust field's `skip_serializing_if = "Option::is_none"`. */
export function passArtifactToWireValue(a: PassArtifact): Record<string, unknown> {
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
