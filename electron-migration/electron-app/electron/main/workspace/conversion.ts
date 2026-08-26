import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
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
  DATABASE_FILE,
  MARKER_FILE,
  OBJECTS_DIR,
  TEMP_DIR,
  WORKSPACE_FORMAT_VERSION,
} from "./roomLayout.js";
import { pathKey, PRIVATE_DIR } from "./pathSafety.js";
import {
  WorkspaceOperationReporter,
  type WorkspaceOperationProgressOptions,
} from "./operationProgress.js";
import type { WorkspaceMarker } from "./types.js";

const SOURCE_HASH_META = "workspace_conversion_source_sha256";
const PHASE_META = "workspace_conversion_phase";
const REPORT_META = "workspace_conversion_report";
const ROOM_ID_META = "workspace_room_id";
const CHUNK_BYTES = 1024 * 1024;

export interface ConversionRename {
  fileId: string;
  originalPath: string;
  convertedPath: string;
}

export interface ConversionSkipped {
  fileId: string;
  name: string;
  reason: string;
}

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

interface PlannedRow {
  id: string;
  name: string;
  missing_bytes: number;
  folder_id: string | null;
}

interface PersistedReport {
  renamed: ConversionRename[];
  skipped: ConversionSkipped[];
}

function conversionTempRoot(destinationPath: string): string {
  const resolved = path.resolve(destinationPath);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.arcelle-conversion.tmp`);
}

function safeComponent(raw: string, fallback: string): string {
  let value = raw.normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (value === "" || value === "." || value === "..") value = fallback;
  if (value.toLocaleLowerCase("en-US") === PRIVATE_DIR) value = `${value}_files`;
  value = [...value].slice(0, 180).join("").replace(/[. ]+$/g, "");
  return value === "" ? fallback : value;
}

function availableRelativePath(desired: string, used: Set<string>): string {
  const extension = path.posix.extname(desired);
  const stem = desired.slice(0, desired.length - extension.length);
  for (let number = 1; number <= 10_000; number += 1) {
    const candidate = number === 1 ? desired : `${stem} (${number})${extension}`;
    const key = pathKey(candidate);
    if (!used.has(key)) {
      used.add(key);
      return candidate;
    }
  }
  throw new Error(`Could not create a unique workspace path for ${desired}.`);
}

function loadReport(db: Database.Database): PersistedReport {
  const raw = getMeta(db, REPORT_META);
  if (raw === null) return { renamed: [], skipped: [] };
  try {
    const parsed = JSON.parse(raw) as PersistedReport;
    return {
      renamed: Array.isArray(parsed.renamed) ? parsed.renamed : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
    };
  } catch {
    throw new Error("The saved workspace conversion report is damaged.");
  }
}

function persistReport(db: Database.Database, report: PersistedReport): void {
  setMeta(db, REPORT_META, JSON.stringify(report));
}

function planPaths(db: Database.Database): PersistedReport {
  const folderRows = db.prepare("SELECT id, name FROM folders ORDER BY rowid")
    .all() as Array<{ id: string; name: string }>;
  const usedFolders = new Set<string>();
  const folders = new Map<string, { original: string; converted: string }>();
  for (const folder of folderRows) {
    const safe = availableRelativePath(safeComponent(folder.name, "Folder"), usedFolders);
    folders.set(folder.id, { original: folder.name, converted: safe });
    db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(safe, folder.id);
  }

  const rows = db.prepare(
    `SELECT id, name, original_bytes IS NULL AS missing_bytes, folder_id FROM files
     WHERE trashed_at IS NULL ORDER BY rowid`,
  ).all() as PlannedRow[];
  const usedPaths = new Set<string>();
  const report: PersistedReport = { renamed: [], skipped: [] };
  const update = db.prepare(
    "UPDATE files SET name = ?, relative_path = ?, path_key = ? WHERE id = ?",
  );
  for (const row of rows) {
    if (row.missing_bytes === 1) {
      report.skipped.push({
        fileId: row.id,
        name: row.name,
        reason: "This legacy row has no current file bytes.",
      });
      continue;
    }
    const fileName = safeComponent(row.name, `File-${row.id.slice(0, 8)}`);
    const folder = row.folder_id === null ? null : folders.get(row.folder_id) ?? null;
    const originalPath = folder === null ? row.name : `${folder.original}/${row.name}`;
    const desired = folder === null ? fileName : `${folder.converted}/${fileName}`;
    const convertedPath = availableRelativePath(desired, usedPaths);
    update.run(path.posix.basename(convertedPath), convertedPath, pathKey(convertedPath), row.id);
    if (convertedPath !== originalPath) {
      report.renamed.push({ fileId: row.id, originalPath, convertedPath });
    }
  }
  persistReport(db, report);
  setMeta(db, PHASE_META, "planned");
  return report;
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

async function validateWorkspaceCopy(db: Database.Database, tempRoot: string): Promise<number> {
  const rows = db.prepare(
    `SELECT id, path_key, content_sha256, size_bytes FROM files
     WHERE trashed_at IS NULL AND storage_kind = 'workspace'`,
  ).all() as Array<{ id: string; path_key: string; content_sha256: string; size_bytes: number }>;
  const manifest = await scanWorkspaceManifest(tempRoot);
  if (manifest.size !== rows.length) {
    throw new Error(`Conversion validation found ${manifest.size} files but expected ${rows.length}.`);
  }
  for (const row of rows) {
    const file = manifest.get(row.path_key);
    if (file === undefined || file.sha256 !== row.content_sha256 || file.sizeBytes !== row.size_bytes) {
      throw new Error(`Conversion validation failed for file ${row.id}.`);
    }
  }
  const remaining = db.prepare(
    `SELECT count(*) AS count FROM files
     WHERE trashed_at IS NULL AND original_bytes IS NOT NULL`,
  ).get() as { count: number };
  if (remaining.count !== 0) throw new Error("Conversion validation found live file bytes still stored in SQLCipher.");
  return rows.length;
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
  if (source === destination) throw new Error("Choose a different destination folder for the workspace.");
  if (existsSync(destination)) throw new Error("A file or folder already exists at the destination.");
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
  const sourceHash = await sha256File(source);
  const tempRoot = conversionTempRoot(destination);
  const privateRoot = path.join(tempRoot, PRIVATE_DIR);
  const dbPath = path.join(privateRoot, DATABASE_FILE);
  const resumed = existsSync(tempRoot);

  if (!resumed) {
    await mkdir(path.join(privateRoot, OBJECTS_DIR), { recursive: true, mode: 0o700 });
    await mkdir(path.join(privateRoot, TEMP_DIR), { recursive: true, mode: 0o700 });
    await copyFile(source, dbPath);
  }

  const db = openRoom(dbPath, password);
  let roomId = getMeta(db, ROOM_ID_META);
  try {
    migrate(db);
    const recordedSourceHash = getMeta(db, SOURCE_HASH_META);
    if (recordedSourceHash !== null && recordedSourceHash !== sourceHash) {
      throw new Error("The legacy source changed after this conversion started. Remove the temporary conversion and try again.");
    }
    if (recordedSourceHash === null) setMeta(db, SOURCE_HASH_META, sourceHash);
    if (roomId === null) {
      roomId = randomUUID();
      setMeta(db, ROOM_ID_META, roomId);
      setMeta(db, "room_kind", "workspace-folder");
      setMeta(db, "workspace_format_version", String(WORKSPACE_FORMAT_VERSION));
      setMeta(db, "name", path.basename(destination));
    }

    let report = loadReport(db);
    progress.emit("planning", getMeta(db, PHASE_META) === null ? 0 : 1, 1);
    if (getMeta(db, PHASE_META) === null) report = planPaths(db);
    progress.emit("planning", 1, 1);
    setMeta(db, PHASE_META, "exporting");
    await exportPendingFiles(db, tempRoot, hooks, progress);
    progress.emit("validating", 0, 1);
    const convertedFiles = await validateWorkspaceCopy(db, tempRoot);
    progress.emit("validating", 1, 1);
    setMeta(db, PHASE_META, "validated");
    vacuum(db);
    setMeta(db, PHASE_META, "complete");

    const marker: WorkspaceMarker = {
      format: "arcelle-workspace",
      formatVersion: WORKSPACE_FORMAT_VERSION,
      roomId: roomId!,
    };
    await writeFile(path.join(privateRoot, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: existsSync(path.join(privateRoot, MARKER_FILE)) ? "w" : "wx",
    });
    db.close();
    if (await sha256File(source) !== sourceHash) {
      throw new Error("The legacy source changed during conversion. The workspace was not published.");
    }
    progress.emit("publishing", 0, 1);
    await rename(tempRoot, destination);
    await syncDirectory(path.dirname(destination));
    progress.emit("publishing", 1, 1);
    return {
      sourcePath: source,
      destinationPath: destination,
      roomId: roomId!,
      convertedFiles,
      renamed: report.renamed,
      skipped: report.skipped,
      resumed,
    };
  } catch (error) {
    try { db.close(); } catch { /* keep the resumable temp workspace */ }
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
  if (path.dirname(tempRoot) !== path.dirname(destination)) {
    throw new Error("The conversion temporary path is invalid.");
  }
  await rm(tempRoot, { recursive: true, force: true });
}
