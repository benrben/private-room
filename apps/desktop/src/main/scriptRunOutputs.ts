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
import { Materialized, safeName } from "./scriptRunInterpreter.js";
import { MAX_IMPORT_BYTES, MAX_NEW_FILES, scriptFingerprint } from "./scriptRunManifest.js";
import { ModifiedDbOutputImportDeps } from "./scriptRunRoomOutputs.js";
// ============================================================================
// Auto-heal
// ============================================================================

/**
 * The top-level package name from a Python `ModuleNotFoundError` stderr, if
 * any. `No module named 'pandas.core'` → `pandas`. Used to auto-install a
 * package the script imported but never declared, so the user never has to pip
 * install.
 */
export function missingModule(stderr: string): string | null {
  const marker = "No module named '";
  const at = stderr.indexOf(marker);
  if (at === -1) return null;
  const rest = stderr.slice(at + marker.length);
  // The text up to the first apostrophe, or the whole remainder when there is
  // none — Rust's `rest.split('\'').next()` behaves the same way.
  const name = rest.split("'")[0];
  if (name === undefined) return null;
  const topName = name.split(".")[0];
  if (topName === undefined) return null;
  const top = topName.trim();
  // Only plain package tokens — never shell out with something odd.
  if (top === "") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(top)) return null;
  return top;
}

// ============================================================================
// Import-back
// ============================================================================

/** A small, honest substitute for the `mime_guess` crate — real for every
 * extension a script's declared/undeclared output commonly uses, defaulting to
 * `text/plain` exactly as `mime_guess::from_path(..).first_or(TEXT_PLAIN)`
 * does for anything it has no entry for either. Same per-file convention
 * `turnEngine.ts`/`organize.ts` already carry. */
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  sql: "application/sql",
  py: "text/x-python",
  js: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
};

export function guessMime(name: string): string {
  return MIME_BY_EXT[extensionOf(name)] ?? "text/plain";
}

/**
 * The single write path for changing an existing file's bytes — ported from
 * `commands::files::store_file_bytes`, which is exactly this composition of
 * two already-ported primitives: snapshot the CURRENT bytes into version
 * history tagged with `cause`, then overwrite, as ONE transaction (a failed
 * overwrite must not still cut a version).
 */
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

/**
 * Whether a materialized file (a declared input OR one auto-materialized
 * because the script referenced its name) should be saved back: its bytes
 * CHANGED during the run (`currentSha` differs from the hash at
 * materialization) AND it was not a declared output (declared outputs already
 * write back via the output path). Pure — the caller reads the file and hashes
 * it.
 */
export function isModifiedUsedFile(
  originalSha: string,
  currentSha: string,
  name: string,
  declaredOutputs: readonly string[]
): boolean {
  return currentSha !== originalSha && !declaredOutputs.some((o) => safeName(o) === safeName(name));
}

/**
 * Write one output into the room: a versioned overwrite when the name already
 * exists (undo via Time Machine), else a new `source='script'` file. The bool
 * says which happened — an overwrite the user was never told about is the one
 * case the report must not call "Created".
 */
export function writeOutput(
  db: Database.Database,
  name: string,
  bytes: Buffer,
  cause: string
): { meta: FileMeta; replaced: boolean } {
  const display = safeName(name);
  const text = extractText(display, bytes);
  const existing = fileByExactName(db, display);
  if (existing !== null) {
    // Snapshot-then-overwrite: every script run is undoable for free.
    storeFileBytes(db, existing.id, bytes, text, cause);
    return { meta: getFileMeta(db, existing.id), replaced: true };
  }
  return { meta: insertFile(db, display, guessMime(display), bytes, text, "script"), replaced: false };
}

export async function writeOutputInRoom(
  db: Database.Database,
  roomPath: string,
  name: string,
  bytes: Buffer,
  cause: string,
): Promise<{ meta: FileMeta; replaced: boolean }> {
  const display = safeName(name);
  const text = extractText(display, bytes);
  const existing = fileByExactName(db, display);
  if (existing !== null) {
    return {
      meta: await writeRoomFile({ db, path: roomPath }, existing.id, bytes, text, cause),
      replaced: true,
    };
  }
  return {
    meta: await createRoomFile(
      { db, path: roomPath }, display, guessMime(display), bytes, text, "script",
    ),
    replaced: false,
  };
}

/** `statSync` without the throw — `null` when the path does not exist. */
export function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export interface OutputImportState {
  readonly imported: FileMeta[];
  readonly skipped: string[];
  readonly handled: Set<string>;
}

export interface ReadOutput {
  readonly safe: string;
  readonly bytes: Buffer | null;
  readonly skip: string | null;
}

export interface NewOutputBudget {
  bytes: number;
  count: number;
}

/**
 * Test seam for the undeclared workspace-output import loop. Production uses
 * the filesystem and workspace writer below; tests provide in-memory twins so
 * this boundary never needs a real workspace folder.
 */
export interface NewOutputImportDeps {
  readonly listWorkspaceFiles: (workspace: string) => readonly string[];
  readonly fileSize: (filePath: string) => number;
  readonly readFile: (filePath: string) => Buffer;
  readonly writeOutput: (
    db: Database.Database,
    roomPath: string,
    name: string,
    bytes: Buffer,
    cause: string,
  ) => Promise<{ meta: FileMeta; replaced: boolean }>;
}

/** Test seam for saving changed, pre-existing workspace inputs back to a room. */
export interface ModifiedOutputImportDeps {
  readonly readMaterialized: (workspace: string, name: string) => Buffer | null;
  readonly writeOutput: NewOutputImportDeps["writeOutput"];
}

export function outputImportState(materialized: readonly Materialized[], scriptName: string): OutputImportState {
  const handled = new Set<string>(materialized.map((item) => item.name));
  handled.add(safeName(scriptName));
  return { imported: [], skipped: [], handled };
}

export function declaredOutput(ws: string, want: string, safe: string): ReadOutput {
  const filePath = path.join(ws, safe);
  const stat = statOrNull(filePath);
  if (stat === null || !stat.isFile()) {
    return { safe, bytes: null, skip: `${want}: the script did not write this declared output` };
  }
  if (stat.size > MAX_IMPORT_BYTES) {
    return { safe, bytes: null, skip: `${want}: over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB import cap` };
  }
  return { safe, bytes: fs.readFileSync(filePath), skip: null };
}

export function unchangedMaterializedOutput(
  materialized: readonly Materialized[],
  safe: string,
  bytes: Buffer,
): boolean {
  const original = materialized.find((item) => item.name === safe);
  return original !== undefined && original.sha === scriptFingerprint(bytes);
}

export function workspaceFileNames(ws: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(ws);
  } catch {
    entries = [];
  }
  return entries.filter((name) => statOrNull(path.join(ws, name))?.isFile() === true).sort();
}

export function newOutputFits(budget: NewOutputBudget, length: number): boolean {
  return budget.count < MAX_NEW_FILES && budget.bytes + length <= MAX_IMPORT_BYTES;
}

export function acceptNewOutput(budget: NewOutputBudget, bytes: Buffer): void {
  budget.bytes += bytes.length;
  budget.count += 1;
}

export function undeclaredReplacementNote(name: string): string {
  return `${name}: a room file of that name already existed — the script's version was saved over it as a new version (undo via Time Machine); declare it in room-outputs to make that explicit`;
}

export function overImportCapNote(name: string, savedBack: boolean): string {
  const suffix = savedBack ? " — not saved back" : "";
  return `${name}: over the ${MAX_IMPORT_BYTES / 1024 / 1024}MB import cap${suffix}`;
}

export function materializedBytes(ws: string, name: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(ws, name));
  } catch {
    return null;
  }
}

/**
 * Import the script's outputs back into the room after a clean exit
 * (decision 2). Returns the imported files (for the report + terminal
 * auto-open) and a list of human-readable skip notes. All writes are versioned
 * via {@link storeFileBytes}, so every script run is undoable through Time
 * Machine.
 *
 * FOLLOWS SYMLINKS, deliberately matching the Rust source (`Path::is_file()`
 * and `std::fs::read` both resolve them). See the module header: a script that
 * names a symlink as its declared output has the TARGET's bytes imported —
 * documented, not silently "fixed", because refusing it would deviate from the
 * source while granting no protection a script cannot trivially route around.
 */
export function importOutputs(
  db: Database.Database,
  ws: string,
  manifest: ScriptManifest,
  materialized: readonly Materialized[],
  scriptName: string,
  cause: string
): { imported: FileMeta[]; skipped: string[] } {
  const state = outputImportState(materialized, scriptName);
  importDeclaredOutputs(db, ws, manifest.outputs, materialized, cause, state);
  importNewOutputs(db, ws, cause, state);
  importModifiedOutputs(db, ws, materialized, manifest.outputs, cause, state);
  return { imported: state.imported, skipped: state.skipped };
}

export function importDeclaredOutputs(
  db: Database.Database,
  ws: string,
  declared: readonly string[],
  materialized: readonly Materialized[],
  cause: string,
  state: OutputImportState,
): void {
  const seen = new Set<string>();
  for (const want of declared) {
    const safe = safeName(want);
    state.handled.add(safe);
    if (seen.has(safe)) continue;
    seen.add(safe);
    const output = declaredOutput(ws, want, safe);
    if (output.skip !== null) {
      state.skipped.push(output.skip);
      continue;
    }
    const bytes = output.bytes as Buffer;
    if (unchangedMaterializedOutput(materialized, output.safe, bytes)) {
      state.skipped.push(`${want}: unchanged from the room's copy — no new version was saved`);
      continue;
    }
    state.imported.push(writeOutput(db, want, bytes, cause).meta);
  }
}

export function importNewOutputs(
  db: Database.Database,
  ws: string,
  cause: string,
  state: OutputImportState,
): void {
  const budget: NewOutputBudget = { bytes: 0, count: 0 };
  for (const name of workspaceFileNames(ws)) {
    if (state.handled.has(name)) continue;
    state.handled.add(name);
    const filePath = path.join(ws, name);
    const length = workspaceFileSize(filePath);
    if (!newOutputFits(budget, length)) {
      state.skipped.push(`${name}: skipped (new-file import cap reached)`);
      continue;
    }
    const bytes = fs.readFileSync(filePath);
    acceptNewOutput(budget, bytes);
    const written = writeOutput(db, name, bytes, cause);
    recordNewOutput(state, name, written);
  }
}

export function workspaceFileSize(filePath: string): number {
  const stat = statOrNull(filePath);
  return stat === null ? 0 : stat.size;
}

export function recordNewOutput(
  state: OutputImportState,
  name: string,
  written: { meta: FileMeta; replaced: boolean },
): void {
  state.imported.push(written.meta);
  if (written.replaced) state.skipped.push(undeclaredReplacementNote(name));
}

export function importModifiedOutputs(
  db: Database.Database,
  ws: string,
  materialized: readonly Materialized[],
  declared: readonly string[],
  cause: string,
  state: OutputImportState,
  deps: ModifiedDbOutputImportDeps = {
    readMaterialized: materializedBytes,
    writeOutput,
  },
): void {
  for (const item of materialized) {
    const bytes = deps.readMaterialized(ws, item.name);
    if (bytes === null) continue;
    if (!isModifiedUsedFile(item.sha, scriptFingerprint(bytes), item.name, declared)) continue;
    if (bytes.length > MAX_IMPORT_BYTES) {
      state.skipped.push(overImportCapNote(item.name, true));
      continue;
    }
    state.imported.push(deps.writeOutput(db, item.name, bytes, cause).meta);
    state.skipped.push(
      `${item.name}: updated in place by the script — saved back as a new version (undo via Time Machine)`,
    );
  }
}
