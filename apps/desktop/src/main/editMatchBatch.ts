/** Cohesive extraction from editMatch.ts; the facade preserves its public API. */
import type Database from "better-sqlite3-multiple-ciphers";
import { findFileLike, getFileBytes } from "./db-host/files.js";
import { extensionOf } from "./editMatchExtraction.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { EditError, type EditMethod, errMessage, hashBytes, NO_REFINEMENTS, type PlannedWrite, previewPair } from "./editMatchCore.js";
import { computeEditBytes, MAX_BATCH_EDITS } from "./editMatchPlans.js";


/** One operation in an atomic batch — a rename rides the same transaction as
 * the content edits, so "rename + update every reference" is a single atomic
 * unit. Ported from `edit_match::BatchOp` (a discriminated union rather than
 * Rust's `#[serde(tag = "op")]` enum: this port's parsing is
 * {@link parseBatchOps}, not `serde`). */
export type BatchOp =
  | { readonly op: "edit"; readonly name: string; readonly oldText: string; readonly newText: string }
  | { readonly op: "rename"; readonly name: string; readonly newName: string };


/** Ported from `edit_match::BatchApplied`. */
export interface BatchApplied {
  readonly batchId: string;
  readonly edits: number;
  readonly renames: number;
  /** (fileId, displayName) for each touched file, in first-touch order — the
   * tool arm emits `file-updated` per id so the per-answer Undo chip reverts
   * the whole batch. */
  readonly files: ReadonlyArray<readonly [string, string]>;
}


/** Keep the current extension when the model dropped it (parity with the
 * `rename_file` tool arm). Ported from `edit_match::keep_ext`. */
function keepExt(current: string, newName: string): string {
  if (extensionOf(newName) === "") {
    const ext = extensionOf(current);
    return ext === "" ? newName : `${newName}.${ext}`;
  }
  return newName;
}


interface FileWork {
  realName: string;
  /** The ORIGINAL DB bytes, loaded lazily the first time this file is edited
   * (a rename-only file never loads them, so we never overwrite it with an
   * empty buffer). Kept for the diff-preview `before` and the staleness
   * token. */
  original: Buffer | null;
  bytes: Buffer | null;
  dirty: boolean;
  newName: string | null;
}


/** Count how many ops are edits vs. renames (for the success string /
 * telemetry). Ported from `edit_match::count_batch_ops`. */
export function countBatchOps(ops: readonly BatchOp[]): { edits: number; renames: number } {
  let edits = 0;
  let renames = 0;
  for (const op of ops) {
    if (op.op === "edit") {
      edits += 1;
    } else {
      renames += 1;
    }
  }
  return { edits, renames };
}


function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}


function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}


/**
 * Parse the tool's `edits` array into typed ops. The tagged form is what the
 * tool spec documents, but a 4B model may omit the tag, so the variant is
 * inferred from the fields present (a `new_name` with no edit fields ⇒
 * rename).
 *
 * A nameless entry is an ERROR, never a skip. It used to be skipped, so a
 * batch of three where one entry lost its `name` applied the other two and
 * reported "Applied 2 change(s)" — the model had no way to learn that a third
 * of its work silently evaporated, and the tool's own headline promise ("every
 * edit is checked first, then all are applied together") was already broken at
 * the parse step. Ported from `edit_match::parse_batch_ops`; throws a plain
 * `Error` where Rust returns `Result<_, String>`.
 */
export function parseBatchOps(args: Record<string, unknown>): BatchOp[] {
  const raw = batchOperationEntries(args);
  const ops = raw.map((entry, index) => parseBatchOperation(entry, index, raw.length));
  assertBatchHasOperations(ops);
  return ops;
}


function batchOperationEntries(args: Record<string, unknown>): unknown[] {
  const raw = args["edits"];
  if (Array.isArray(raw)) return raw;
  throw new Error("Pass edits: [{name, old_text, new_text}] (or {name, new_name} to rename) — one array.");
}


function parseBatchOperation(raw: unknown, index: number, total: number): BatchOp {
  const entry = asRecord(raw);
  const name = batchOperationName(entry, index, total);
  if (batchOperationIsRename(entry)) return { op: "rename", name, newName: asStr(entry["new_name"]) };
  return { op: "edit", name, oldText: asStr(entry["old_text"]), newText: asStr(entry["new_text"]) };
}


function batchOperationName(entry: Record<string, unknown>, index: number, total: number): string {
  const name = asStr(entry["name"]).trim();
  if (name !== "") return name;
  throw new Error(
    `Edit ${index + 1} of ${total}: name is required — every entry needs the file ` +
      `to change, e.g. {"name": "notes.md", "old_text": "…", "new_text": "…"}. Nothing was changed.`,
  );
}


function batchOperationIsRename(entry: Record<string, unknown>): boolean {
  const operation = asStr(entry["op"]);
  return operation.toLowerCase() === "rename" || (operation === "" && asStr(entry["new_name"]).trim() !== "");
}


function assertBatchHasOperations(ops: readonly BatchOp[]): void {
  if (ops.length === 0) throw new Error("No edits given — pass edits: [{name, old_text, new_text} | {name, new_name}].");
}


/**
 * Phase A of the batch: validate every op against chained working state and
 * build one {@link PlannedWrite} per touched file — NO writes. A single
 * failure names WHICH op broke (keeping the ambiguity/closest-snippet hint) so
 * the model can fix just that one. Repeated edits to the same file compose over
 * working bytes, exactly like `set_cells` chains `setCellInBytes`. Ported from
 * `edit_match::plan_batch`; throws a plain `Error` where Rust returns
 * `Result<_, String>`.
 */
function planBatchWithLoader(
  db: Database.Database,
  ops: readonly BatchOp[],
  loadBytes: (id: string) => Buffer | null,
): PlannedWrite[] {
  assertBatchSize(ops.length);
  const state = batchPlanningState(db, ops.length, loadBytes);
  planBatchOperations(state, ops);
  return plannedBatchWrites(state);
}


interface BatchPlanningState {
  readonly db: Database.Database;
  readonly total: number;
  readonly loadBytes: (id: string) => Buffer | null;
  readonly working: Map<string, FileWork>;
  readonly order: string[];
}


function assertBatchSize(count: number): void {
  if (count === 0) throw new Error("No edits given — pass edits: [{name, old_text, new_text} | {name, new_name}].");
  if (count > MAX_BATCH_EDITS) throw new Error(`Too many operations in one batch (${count}). Split into batches of at most ${MAX_BATCH_EDITS} so each stays reviewable and the transaction stays short.`);
}


function batchPlanningState(db: Database.Database, total: number, loadBytes: (id: string) => Buffer | null): BatchPlanningState {
  return { db, total, loadBytes, working: new Map<string, FileWork>(), order: [] };
}


function planBatchOperations(state: BatchPlanningState, ops: readonly BatchOp[]): void {
  for (let index = 0; index < ops.length; index += 1) planBatchOperation(state, ops[index]!, index);
}


function planBatchOperation(state: BatchPlanningState, op: BatchOp, index: number): void {
  assertBatchOperation(op, index, state.total);
  const [id, realName] = resolveBatchFile(state.db, op, index, state.total);
  const entry = batchFileWork(state, id, realName);
  if (op.op === "rename") {
    entry.newName = keepExt(entry.realName, op.newName.trim());
    return;
  }
  updateBatchEdit(state, entry, id, op, index);
}


function assertBatchOperation(op: BatchOp, index: number, total: number): void {
  if (op.op === "edit" && op.oldText === "") throw new Error(`Edit ${index + 1} of ${total}: old_text is required.`);
  if (op.op === "rename" && op.newName.trim() === "") throw new Error(`Rename ${index + 1} of ${total}: new_name is required.`);
}


function resolveBatchFile(db: Database.Database, op: BatchOp, index: number, total: number): [string, string] {
  try {
    return findFileLike(db, op.name);
  } catch (error) {
    throw new Error(`${batchOperationLabel(op)} ${index + 1} of ${total} (${op.name}): ${errMessage(error)}`);
  }
}


function batchOperationLabel(op: BatchOp): string {
  return op.op === "edit" ? "Edit" : "Rename";
}


function batchFileWork(state: BatchPlanningState, id: string, realName: string): FileWork {
  const existing = state.working.get(id);
  if (existing !== undefined) return existing;
  const entry = { realName, original: null, bytes: null, dirty: false, newName: null };
  state.working.set(id, entry);
  state.order.push(id);
  return entry;
}


function updateBatchEdit(state: BatchPlanningState, entry: FileWork, id: string, op: Extract<BatchOp, { op: "edit" }>, index: number): void {
  const bytes = batchEditableBytes(state, entry, id, index);
  entry.bytes = computedBatchEdit(state, entry.realName, bytes, op, index);
  entry.dirty = true;
}


function batchEditableBytes(state: BatchPlanningState, entry: FileWork, id: string, index: number): Buffer {
  if (entry.bytes !== null) return entry.bytes;
  const loaded = loadBatchBytes(state, entry.realName, id, index);
  entry.original = loaded;
  entry.bytes = loaded;
  return loaded;
}


function loadBatchBytes(state: BatchPlanningState, realName: string, id: string, index: number): Buffer {
  let loaded: Buffer | null;
  try {
    loaded = state.loadBytes(id);
  } catch (error) {
    throw new Error(`Edit ${index + 1} of ${state.total} (${realName}): ${errMessage(error)}`);
  }
  if (loaded === null) throw new Error(`Edit ${index + 1} of ${state.total} (${realName}): file has no stored content.`);
  return loaded;
}


function computedBatchEdit(
  state: BatchPlanningState, realName: string, bytes: Buffer, op: Extract<BatchOp, { op: "edit" }>, index: number,
): Buffer {
  try {
    return computeEditBytes(realName, bytes, op.oldText, op.newText, undefined, NO_REFINEMENTS).bytes;
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    throw new Error(`Edit ${index + 1} of ${state.total} (${realName}): ${error.message}`);
  }
}


function plannedBatchWrites(state: BatchPlanningState): PlannedWrite[] {
  return state.order.map((id) => plannedBatchWrite(id, state.working.get(id)!));
}


function plannedBatchWrite(id: string, entry: FileWork): PlannedWrite {
  if (entry.dirty) return changedBatchWrite(id, entry);
  return renamedBatchWrite(id, entry);
}


function changedBatchWrite(id: string, entry: FileWork): PlannedWrite {
  const original = entry.original ?? Buffer.alloc(0);
  const newBytes = entry.bytes!;
  const preview = previewPair(entry.realName, original, newBytes);
  return {
    fileId: id, realName: entry.realName, newBytes, renameTo: entry.newName, method: null, count: 1,
    staleness: hashBytes(original), ...preview,
  };
}


function renamedBatchWrite(id: string, entry: FileWork): PlannedWrite {
  return {
    fileId: id, realName: entry.realName, newBytes: null, renameTo: entry.newName, method: null, count: 0,
    staleness: null, before: `name: ${entry.realName}`, after: `name: ${entry.newName ?? ""}`, clipped: false,
  };
}


export function planBatch(db: Database.Database, ops: readonly BatchOp[]): PlannedWrite[] {
  return planBatchWithLoader(db, ops, (id) => getFileBytes(db, id));
}


export async function planBatchWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  ops: readonly BatchOp[],
): Promise<PlannedWrite[]> {
  const bytes = new Map<string, Buffer>();
  for (const op of ops) {
    if (op.op !== "edit") continue;
    let id: string;
    try { [id] = findFileLike(db, op.name); }
    catch (error) { throw new Error(errMessage(error)); }
    if (!bytes.has(id)) bytes.set(id, await workspace.readBuffer(id));
  }
  return planBatchWithLoader(db, ops, (id) => bytes.get(id) ?? null);
}


// ------------------------------------------------- reference entry points (tests)

/** Ported from `edit_match::EditApplied` (Rust: `#[cfg(test)]`). */
export interface EditApplied {
  readonly fileId: string;
  readonly realName: string;
  readonly count: number;
  readonly method: EditMethod;
}
