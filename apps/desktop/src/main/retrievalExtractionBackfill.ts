import type Database from "better-sqlite3-multiple-ciphers";
import { extensionOf, isImage } from "./editMatchExtraction.js";
import { mediaKind } from "./peaksTools.js";
import { isOcrCandidate } from "./ocrTools.js";
import { getFileFull } from "./db-host/files.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import { pinnedDb, type RoomSource } from "./jobs.js";
import { ExtractionCandidate, OpenRoom, REPAIRED_EXTENSIONS, REPAIR_STAMP, commitExtractedText, extractionCandidates } from "./retrievalBackfill.js";



// ============================================================================
// spawn_reextract_backfill / spawn_legacy_text_repair
// ============================================================================

/**
 * The one `extraction.rs` dependency neither sweep can do without. REQUIRED,
 * never defaulted — see this file's module doc for what is already ported
 * (`extensionOf`/`isImage`/`mediaKind`/`isOcrCandidate`, all imported or
 * ported here for real), what a partial port would buy, and why the stamp
 * hazard makes "pick an extractor" a decision for the call site.
 */
export interface ExtractionDeps {
  /** `extraction::extract_text(name, bytes)`. `null` = could not extract — a
   * real, expected Rust outcome (`Option<String>`) both sweeps skip a file
   * on, not an error. */
  extractText: (name: string, bytes: Buffer) => string | null | Promise<string | null>;
}
export const EXTRACT_TEXT_NOT_IMPLEMENTED_REASON =
  "NOT_IMPLEMENTED: extraction::extract_text (the full pdf/xlsx/pptx/legacy " +
  ".doc/.ppt/epub/rtf/... dispatcher, src-tauri/src/extraction.rs) has no " +
  "Electron port — this backfill pass has nothing to re-extract this file " +
  "with. editMatch.ts's extractText is a NARROWED port (text extensions + " +
  ".docx + .html) and reads none of the formats either sweep exists for.";


/**
 * The stub to wire into {@link ExtractionDeps.extractText} until a real
 * extractor exists — the field is required, so nothing falls back to this on
 * its own. Answers `null` ("could not extract"), which is a real Rust outcome
 * rather than a fabricated one: the caller skips the file exactly as it would
 * for a genuine extraction miss, and the labeled reason is logged so a
 * forgotten wiring is never mistaken for a room that had nothing to fix.
 *
 * Do NOT wire this into {@link runLegacyTextRepair} in production — see this
 * file's module doc on the stamp hazard.
 */
export const extractTextNotImplemented: ExtractionDeps["extractText"] = () => {
  console.error(EXTRACT_TEXT_NOT_IMPLEMENTED_REASON);
  return null;
};


/** Everything {@link runReextractBackfill} needs beyond the room. */
export interface ReextractBackfillDeps extends ExtractionDeps {
  rooms: RoomSource;
  /** `AppState::room_epoch()` — bumped by every room open/teardown/rollback.
   * A SEPARATE counter from {@link EmbedBackfillState.generation}; see this
   * file's module doc. */
  roomEpoch: () => number;
  /** Best-effort `app.emit("room-files-changed", ())`, mirroring Rust's
   * `let _ = app.emit(...)` — the same optional seam `scriptRun.ts` and
   * `recBridge.ts` already declare for this identical event. */
  notifyFilesChanged?: () => void;
}
export

/**
 * One-shot re-extraction pass for files imported before an extractor
 * improvement, which therefore carry no text at all (the motivating case:
 * all-numeric `.xlsx` files stored when the extractor only read shared
 * strings). Ported from `spawn_reextract_backfill`'s closure body. Runs the
 * current extractor over their stored bytes and re-indexes any that now yield
 * text. Scans, photos and recordings are left to the OCR/STT workers.
 *
 * Pinned at (path, epoch) captured BEFORE the loop and re-checked before every
 * write. A mismatch is a bare `return` from the WHOLE pass, not a `continue`:
 * a rollback mid-pass means every remaining candidate's bytes are also
 * pre-rollback, so the rest of the batch is abandoned too. That is Rust's own
 * control flow, and it also means an abandoned pass never reaches its own
 * trailing `room-files-changed` — a pass cut off mid-flight has nothing of its
 * own to report.
 */
interface ExtractionSweepStart {
  room: OpenRoom;
  path: string;
  epoch: number;
}
export type SweepCandidateOutcome = "skipped" | "fixed" | "stale";
export function startExtractionSweep(
  rooms: RoomSource,
  roomEpoch: () => number,
): ExtractionSweepStart | null {
  const room = rooms.current();
  if (room === null) {
    return null;
  }
  return { room, path: room.path, epoch: roomEpoch() };
}
export async function availableExtractionCandidates(
  room: OpenRoom,
  missingOnly: boolean,
): Promise<ExtractionCandidate[]> {
  try {
    return await extractionCandidates(room, missingOnly);
  } catch {
    return []; // matches Rust's `.unwrap_or_default()`
  }
}
export function isDocumentExtractionCandidate(candidate: ExtractionCandidate): boolean {
  const extension = extensionOf(candidate.name);
  return !isImage(candidate.mime)
    && !isOcrCandidate(candidate.mime, extension)
    && mediaKind(candidate.mime, extension) === null;
}
export function pinnedSweepDb(
  rooms: RoomSource,
  sweep: ExtractionSweepStart,
  roomEpoch: () => number,
): Database.Database | null {
  const db = pinnedDb(rooms, sweep.path);
  if (db === null || roomEpoch() !== sweep.epoch) {
    return null;
  }
  return db;
}
export function commitExtractionCandidate(
  db: Database.Database,
  candidate: ExtractionCandidate,
  text: string,
): boolean {
  try {
    return commitExtractedText(db, candidate, text);
  } catch {
    // A failed write did not fix this file — not counted, and not fatal to
    // the rest of the pass. Matches Rust's `if ....is_ok() { fixed += 1 }`.
    return false;
  }
}
export async function reextractCandidate(
  deps: ReextractBackfillDeps,
  sweep: ExtractionSweepStart,
  candidate: ExtractionCandidate,
): Promise<SweepCandidateOutcome> {
  if (!isDocumentExtractionCandidate(candidate)) {
    return "skipped";
  }
  const text = await deps.extractText(candidate.name, candidate.bytes);
  if (text === null) {
    return "skipped";
  }
  const db = pinnedSweepDb(deps.rooms, sweep, deps.roomEpoch);
  if (db === null) {
    return "stale";
  }
  return commitExtractionCandidate(db, candidate, text) ? "fixed" : "skipped";
}


export async function runReextractBackfill(deps: ReextractBackfillDeps): Promise<void> {
  const sweep = startExtractionSweep(deps.rooms, deps.roomEpoch);
  if (sweep === null) {
    return;
  }
  let fixed = 0;
  for (const candidate of await availableExtractionCandidates(sweep.room, true)) {
    const outcome = await reextractCandidate(deps, sweep, candidate);
    if (outcome === "stale") {
      return;
    }
    if (outcome === "fixed") {
      fixed += 1;
    }
  }
  if (fixed > 0) {
    deps.notifyFilesChanged?.();
  }
}


/** Fire-and-forget wrapper for {@link runReextractBackfill} —
 * `tauri::async_runtime::spawn`'s analogue, with the same `.catch` floor
 * {@link spawnEmbeddingBackfill} explains. */
export function spawnReextractBackfill(deps: ReextractBackfillDeps): void {
  void runReextractBackfill(deps).catch((err: unknown) => {
    console.error("reextract backfill failed:", err);
  });
}


/** Everything {@link runLegacyTextRepair} needs beyond the room. */
export interface LegacyTextRepairDeps extends ExtractionDeps {
  rooms: RoomSource;
  /** See {@link ReextractBackfillDeps.roomEpoch}. */
  roomEpoch: () => number;
  /** See {@link ReextractBackfillDeps.notifyFilesChanged}. */
  notifyFilesChanged?: () => void;
}
export

/**
 * Re-read the files whose extractor was WRONG rather than merely incomplete,
 * once per room. Ported from `spawn_legacy_text_repair`'s closure body.
 *
 * Only files whose text actually CHANGES are written, so a room that was
 * already correct is untouched — no version churn, no `room-files-changed`
 * storm, and nothing in History pretending the user edited anything.
 *
 * Stamps {@link REPAIR_STAMP} on exit (room-pin permitting) so the sweep runs
 * once per room and never again — including when it repaired nothing. See this
 * file's module doc before wiring an extractor that cannot read `.doc`/`.ppt`.
 */
function legacyTextIsStamped(db: Database.Database): boolean {
  try {
    return getSetting(db, REPAIR_STAMP) !== null;
  } catch {
    // Rust's `db::get_setting` hands back an Option, so an unreadable settings
    // table reads as "not stamped yet" rather than aborting the sweep.
    return false;
  }
}
export function legacyRepairCandidates(candidates: readonly ExtractionCandidate[]): ExtractionCandidate[] {
  return candidates.filter(({ name }) => REPAIRED_EXTENSIONS.has(extensionOf(name)));
}
export function currentExtractedText(db: Database.Database, fileId: string): string | null {
  try {
    return getFileFull(db, fileId)[3];
  } catch {
    // Rust's `.ok().and_then(...)` treats a failed read like missing text.
    return null;
  }
}
export async function repairLegacyCandidate(
  deps: LegacyTextRepairDeps,
  sweep: ExtractionSweepStart,
  candidate: ExtractionCandidate,
): Promise<SweepCandidateOutcome> {
  const text = await deps.extractText(candidate.name, candidate.bytes);
  if (text === null) {
    return "skipped";
  }
  const db = pinnedSweepDb(deps.rooms, sweep, deps.roomEpoch);
  if (db === null) {
    return "stale";
  }
  if (currentExtractedText(db, candidate.id) === text) {
    return "skipped";
  }
  return commitExtractionCandidate(db, candidate, text) ? "fixed" : "skipped";
}
export function stampLegacyRepair(db: Database.Database): void {
  try {
    setSetting(db, REPAIR_STAMP, "1");
  } catch {
    // best-effort, mirrors Rust's `let _ = db::set_setting(...)`.
  }
}
export async function repairLegacyCandidates(
  deps: LegacyTextRepairDeps,
  sweep: ExtractionSweepStart,
  candidates: readonly ExtractionCandidate[],
): Promise<number | null> {
  let fixed = 0;
  for (const candidate of candidates) {
    const outcome = await repairLegacyCandidate(deps, sweep, candidate);
    if (outcome === "stale") {
      return null;
    }
    if (outcome === "fixed") {
      fixed += 1;
    }
  }
  return fixed;
}
export function finishLegacyRepair(
  deps: LegacyTextRepairDeps,
  sweep: ExtractionSweepStart,
  fixed: number,
): void {
  const finalDb = pinnedSweepDb(deps.rooms, sweep, deps.roomEpoch);
  if (finalDb === null) {
    return;
  }
  stampLegacyRepair(finalDb);
  if (fixed > 0) {
    deps.notifyFilesChanged?.();
  }
}


export async function runLegacyTextRepair(deps: LegacyTextRepairDeps): Promise<void> {
  const sweep = startExtractionSweep(deps.rooms, deps.roomEpoch);
  if (sweep === null) {
    return;
  }
  if (legacyTextIsStamped(sweep.room.db)) {
    return;
  }
  // Filtered in TS with the same `extensionOf` the extractors use — see
  // `filesWithBytes`'s own doc for why this is not expressed in SQL.
  const candidates = legacyRepairCandidates(
    await availableExtractionCandidates(sweep.room, false),
  );
  const fixed = await repairLegacyCandidates(deps, sweep, candidates);
  if (fixed === null) {
    return;
  }
  finishLegacyRepair(deps, sweep, fixed);
}


/** Fire-and-forget wrapper for {@link runLegacyTextRepair} — see
 * {@link spawnReextractBackfill}. */
export function spawnLegacyTextRepair(deps: LegacyTextRepairDeps): void {
  void runLegacyTextRepair(deps).catch((err: unknown) => {
    console.error("legacy text repair failed:", err);
  });
}
