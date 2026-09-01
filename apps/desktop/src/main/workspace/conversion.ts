import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { migrate } from "../db-host/migrate.js";
import { openRoom, openRoomReadonly } from "../db-host/open.js";
import { getMeta, setMeta } from "../db-host/meta.js";
import { vacuum } from "../db-host/rekey.js";
import { sha256File } from "./hash.js";
import { scanWorkspaceManifest } from "./manifest.js";
import {
  PHASE_META,
  conversionTempRoot,
  loadReport,
  planPaths,
  type ConversionRename,
  type ConversionSkipped,
  type PersistedReport,
} from "./conversionPlan.js";
import {
  DATABASE_FILE,
  MARKER_FILE,
  OBJECTS_DIR,
  TEMP_DIR,
  WORKSPACE_FORMAT_VERSION,
} from "./roomLayout.js";
import { PRIVATE_DIR } from "./pathSafety.js";
import {
  WorkspaceOperationReporter,
  type WorkspaceOperationProgressOptions,
} from "./operationProgress.js";
import type { WorkspaceMarker } from "./types.js";

const SOURCE_HASH_META = "workspace_conversion_source_sha256";
const ROOM_ID_META = "workspace_room_id";
const CHUNK_BYTES = 1024 * 1024;

export type { ConversionRename, ConversionSkipped } from "./conversionPlan.js";

export interface WorkspaceConversionReport {
  sourcePath: string;
  destinationPath: string;
  roomId: string;
  convertedFiles: number;
  renamed: ConversionRename[];
  skipped: ConversionSkipped[];
  resumed: boolean;
}

export interface WorkspaceConversionHooks extends WorkspaceOperationProgressOptions {
  /** Test seam used to prove resume after a committed per-file export. */
  afterFile?: (fileId: string) => void | Promise<void>;
}

interface WorkspaceCopyRow {
  id: string;
  path_key: string;
  content_sha256: string;
  size_bytes: number;
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some synced filesystems reject directory handles. Final validation still
    // detects incomplete output before the workspace is published.
  }
}

async function exportBlob(
  db: Database.Database,
  fileId: string,
  destination: string,
): Promise<{ sha256: string; sizeBytes: number }> {
  const sizeRow = db.prepare("SELECT length(original_bytes) AS size FROM files WHERE id = ?")
    .get(fileId) as { size: number | null } | undefined;
  if (sizeRow?.size === null || sizeRow === undefined) throw new Error("The source file bytes disappeared during conversion.");
  const sizeBytes = sizeRow.size;
  await mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.arcelle-conversion.tmp`;
  await rm(tempPath, { force: true });
  const handle = await open(tempPath, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    const readChunk = db.prepare(
      "SELECT substr(original_bytes, ?, ?) AS chunk FROM files WHERE id = ?",
    );
    let offset = 0;
    while (offset < sizeBytes) {
      const row = readChunk.get(offset + 1, Math.min(CHUNK_BYTES, sizeBytes - offset), fileId) as {
        chunk: Buffer | null;
      } | undefined;
      const chunk = row?.chunk;
      if (chunk === null || chunk === undefined) throw new Error("The source file bytes disappeared during conversion.");
      await handle.write(chunk, 0, chunk.length, offset);
      hash.update(chunk);
      offset += chunk.length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, destination);
  await syncDirectory(path.dirname(destination));
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function exportPendingFiles(
  db: Database.Database,
  tempRoot: string,
  hooks: WorkspaceConversionHooks,
  progress: WorkspaceOperationReporter,
): Promise<number> {
  const pending = db.prepare(
    `SELECT id, relative_path FROM files
     WHERE trashed_at IS NULL AND storage_kind = 'blob'
       AND original_bytes IS NOT NULL AND relative_path IS NOT NULL
     ORDER BY rowid`,
  ).all() as Array<{ id: string; relative_path: string }>;
  let converted = 0;
  progress.emit("copying-files", 0, pending.length, "files");
  for (const row of pending) {
    const destination = path.join(tempRoot, ...row.relative_path.split("/"));
    if (existsSync(destination)) {
      // A crash may happen after publishing this one file but before clearing
      // its copied BLOB row. Re-export from the still-authoritative BLOB so a
      // same-sized partial file can never be accepted by stat alone.
      await rm(destination, { force: true });
    }
    const exported = await exportBlob(db, row.id, destination);
    const fileStat = await lstat(destination, { bigint: true });
    db.prepare(
      `UPDATE files SET storage_kind = 'workspace', original_bytes = NULL,
         content_sha256 = ?, size_bytes = ?, mtime_ns = ?, fs_identity = ?,
         index_state = 'ready', index_error = NULL,
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
    ).run(
      exported.sha256,
      exported.sizeBytes,
      Number(fileStat.mtimeNs),
      `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`,
      row.id,
    );
    converted += 1;
    progress.emit("copying-files", converted, pending.length, "files");
    await hooks.afterFile?.(row.id);
  }
  return converted;
}

function workspaceCopyRows(db: Database.Database): WorkspaceCopyRow[] {
  return db.prepare(
    `SELECT id, path_key, content_sha256, size_bytes FROM files
     WHERE trashed_at IS NULL AND storage_kind = 'workspace'`,
  ).all() as WorkspaceCopyRow[];
}

function validateManifestCount(manifestSize: number, expected: number): void {
  if (manifestSize !== expected) {
    throw new Error(`Conversion validation found ${manifestSize} files but expected ${expected}.`);
  }
}

function validateManifestRow(
  manifest: ReadonlyMap<string, { sha256: string; sizeBytes: number }>,
  row: WorkspaceCopyRow,
): void {
  const file = manifest.get(row.path_key);
  if (file === undefined || file.sha256 !== row.content_sha256 || file.sizeBytes !== row.size_bytes) {
    throw new Error(`Conversion validation failed for file ${row.id}.`);
  }
}

function validateManifestRows(
  manifest: ReadonlyMap<string, { sha256: string; sizeBytes: number }>,
  rows: readonly WorkspaceCopyRow[],
): void {
  for (const row of rows) {
    validateManifestRow(manifest, row);
  }
}

function remainingLiveBlobCount(db: Database.Database): number {
  const remaining = db.prepare(
    `SELECT count(*) AS count FROM files
     WHERE trashed_at IS NULL AND original_bytes IS NOT NULL`,
  ).get() as { count: number };
  return remaining.count;
}

function validateNoLiveBlobs(db: Database.Database): void {
  if (remainingLiveBlobCount(db) !== 0) {
    throw new Error("Conversion validation found live file bytes still stored in SQLCipher.");
  }
}

async function validateWorkspaceCopy(db: Database.Database, tempRoot: string): Promise<number> {
  const rows = workspaceCopyRows(db);
  const manifest = await scanWorkspaceManifest(tempRoot);
  validateManifestCount(manifest.size, rows.length);
  validateManifestRows(manifest, rows);
  validateNoLiveBlobs(db);
  return rows.length;
}

interface ConversionPaths {
  source: string;
  destination: string;
  tempRoot: string;
  privateRoot: string;
  dbPath: string;
  resumed: boolean;
}

interface ConversionPhaseResult {
  report: PersistedReport;
  convertedFiles: number;
}

function validateConversionDestination(source: string, destination: string): void {
  if (source === destination) {
    throw new Error("Choose a different destination folder for the workspace.");
  }
  if (existsSync(destination)) {
    throw new Error("A file or folder already exists at the destination.");
  }
}

function verifyLegacySource(source: string, password: string): void {
  const verified = openRoomReadonly(source, password);
  try {
    const sealed = verified.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sealed_package_meta'",
    ).get();
    if (sealed !== undefined) {
      throw new Error("This is a sealed backup. Use sealed import instead of legacy conversion.");
    }
  } finally {
    verified.close();
  }
}

function conversionPaths(source: string, destination: string): ConversionPaths {
  const tempRoot = conversionTempRoot(destination);
  const privateRoot = path.join(tempRoot, PRIVATE_DIR);
  return {
    source,
    destination,
    tempRoot,
    privateRoot,
    dbPath: path.join(privateRoot, DATABASE_FILE),
    resumed: existsSync(tempRoot),
  };
}

async function prepareConversionRoot(paths: ConversionPaths): Promise<void> {
  if (!paths.resumed) {
    await mkdir(path.join(paths.privateRoot, OBJECTS_DIR), { recursive: true, mode: 0o700 });
    await mkdir(path.join(paths.privateRoot, TEMP_DIR), { recursive: true, mode: 0o700 });
    await copyFile(paths.source, paths.dbPath);
  }
  // copyFile preserves the legacy database's mode. Older rooms may be 0644,
  // and a resumable conversion may already contain such a copied database.
  // Repair it before opening any private state and before the workspace can
  // ever be published.
  await chmod(paths.dbPath, 0o600);
}

function validateRecordedSourceHash(db: Database.Database, sourceHash: string): void {
  const recordedSourceHash = getMeta(db, SOURCE_HASH_META);
  if (recordedSourceHash !== null && recordedSourceHash !== sourceHash) {
    throw new Error("The legacy source changed after this conversion started. Remove the temporary conversion and try again.");
  }
  if (recordedSourceHash === null) {
    setMeta(db, SOURCE_HASH_META, sourceHash);
  }
}

function ensureWorkspaceRoomMetadata(
  db: Database.Database,
  existingRoomId: string | null,
  destination: string,
): string {
  if (existingRoomId !== null) {
    return existingRoomId;
  }
  const roomId = randomUUID();
  setMeta(db, ROOM_ID_META, roomId);
  setMeta(db, "room_kind", "workspace-folder");
  setMeta(db, "workspace_format_version", String(WORKSPACE_FORMAT_VERSION));
  setMeta(db, "name", path.basename(destination));
  return roomId;
}

function planConversionPaths(
  db: Database.Database,
  progress: WorkspaceOperationReporter,
): PersistedReport {
  let report = loadReport(db);
  progress.emit("planning", getMeta(db, PHASE_META) === null ? 0 : 1, 1);
  if (getMeta(db, PHASE_META) === null) {
    report = planPaths(db);
  }
  progress.emit("planning", 1, 1);
  return report;
}

async function runConversionPhases(
  db: Database.Database,
  tempRoot: string,
  hooks: WorkspaceConversionHooks,
  progress: WorkspaceOperationReporter,
): Promise<ConversionPhaseResult> {
  const report = planConversionPaths(db, progress);
  setMeta(db, PHASE_META, "exporting");
  await exportPendingFiles(db, tempRoot, hooks, progress);
  progress.emit("validating", 0, 1);
  const convertedFiles = await validateWorkspaceCopy(db, tempRoot);
  progress.emit("validating", 1, 1);
  setMeta(db, PHASE_META, "validated");
  vacuum(db);
  setMeta(db, PHASE_META, "complete");
  return { report, convertedFiles };
}

async function writeWorkspaceMarker(privateRoot: string, roomId: string): Promise<void> {
  const marker: WorkspaceMarker = {
    format: "arcelle-workspace",
    formatVersion: WORKSPACE_FORMAT_VERSION,
    roomId,
  };
  const markerPath = path.join(privateRoot, MARKER_FILE);
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: existsSync(markerPath) ? "w" : "wx",
  });
}

async function publishConvertedWorkspace(
  paths: ConversionPaths,
  sourceHash: string,
  progress: WorkspaceOperationReporter,
): Promise<void> {
  if (await sha256File(paths.source) !== sourceHash) {
    throw new Error("The legacy source changed during conversion. The workspace was not published.");
  }
  progress.emit("publishing", 0, 1);
  await rename(paths.tempRoot, paths.destination);
  await syncDirectory(path.dirname(paths.destination));
  progress.emit("publishing", 1, 1);
}

function closeAfterFailedConversion(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // Keep the resumable temp workspace even if the failed DB close is noisy.
  }
}

function conversionReport(
  paths: ConversionPaths,
  roomId: string,
  phases: ConversionPhaseResult,
): WorkspaceConversionReport {
  return {
    sourcePath: paths.source,
    destinationPath: paths.destination,
    roomId,
    convertedFiles: phases.convertedFiles,
    renamed: phases.report.renamed,
    skipped: phases.report.skipped,
    resumed: paths.resumed,
  };
}

/**
 * Convert a closed legacy room into a normal-file workspace. The source is
 * verified read-only and is never migrated, rekeyed, or replaced.
 */
async function convertLegacyRoomToWorkspaceCore(
  sourcePath: string,
  password: string,
  destinationPath: string,
  hooks: WorkspaceConversionHooks,
  progress: WorkspaceOperationReporter,
): Promise<WorkspaceConversionReport> {
  progress.emit("scanning", 0, null);
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  validateConversionDestination(source, destination);
  verifyLegacySource(source, password);
  const sourceHash = await sha256File(source);
  const paths = conversionPaths(source, destination);
  await prepareConversionRoot(paths);

  const db = openRoom(paths.dbPath, password);
  const existingRoomId = getMeta(db, ROOM_ID_META);
  try {
    migrate(db);
    validateRecordedSourceHash(db, sourceHash);
    const roomId = ensureWorkspaceRoomMetadata(db, existingRoomId, paths.destination);
    const phases = await runConversionPhases(db, paths.tempRoot, hooks, progress);
    await writeWorkspaceMarker(paths.privateRoot, roomId);
    db.close();
    await publishConvertedWorkspace(paths, sourceHash, progress);
    return conversionReport(paths, roomId, phases);
  } catch (error) {
    closeAfterFailedConversion(db);
    throw error;
  }
}

export async function convertLegacyRoomToWorkspace(
  sourcePath: string,
  password: string,
  destinationPath: string,
  hooks: WorkspaceConversionHooks = {},
): Promise<WorkspaceConversionReport> {
  const progress = new WorkspaceOperationReporter(
    "legacy-conversion",
    hooks.progress,
    hooks.operationId,
  );
  progress.start();
  try {
    const report = await convertLegacyRoomToWorkspaceCore(
      sourcePath,
      password,
      destinationPath,
      hooks,
      progress,
    );
    progress.complete();
    return report;
  } catch (error) {
    progress.fail();
    throw error;
  }
}

/** Explicit cleanup for a conversion the user chose to abandon. */
export async function discardWorkspaceConversion(destinationPath: string): Promise<void> {
  const destination = path.resolve(destinationPath);
  const tempRoot = conversionTempRoot(destination);
  await rm(tempRoot, { recursive: true, force: true });
}
