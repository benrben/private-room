import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { migrate } from "../db-host/migrate.js";
import { getMeta, setMeta } from "../db-host/meta.js";
import { MIN_ROOM_PASSWORD_CHARS, openRoom, openRoomReadonly } from "../db-host/open.js";
import { rekey, vacuum, vacuumInto } from "../db-host/rekey.js";
import { scanWorkspaceManifest } from "./manifest.js";
import {
  DATABASE_FILE,
  MARKER_FILE,
  OBJECTS_DIR,
  TEMP_DIR,
  WORKSPACE_FORMAT_VERSION,
} from "./roomLayout.js";
import { normalizeRelativePath, pathKey, PRIVATE_DIR, resolveWorkspacePath } from "./pathSafety.js";
import {
  WorkspaceOperationReporter,
  type WorkspaceOperationProgressOptions,
} from "./operationProgress.js";
import {
  addStreamChunks,
  mapsEqual,
  packageSchema,
  rekeySealedPackageWhenNeeded,
  requireMissingDestination,
  requireSafeSealedObjectPath,
  restoreChunksToFile,
  sealedFileEntries,
  sealedPackageInfo,
  syncDirectory,
  verifySealedDatabase,
  verifyPublishedSealedPackage,
  writeSealedPackageMetadata,
  type SealedFileEntry,
  type SealedFileRow,
  type SealedObjectRow,
  type SealedPackageInfo,
} from "./sealedPackageDb.js";
import type { ManifestEntry, WorkspaceMarker } from "./types.js";
import { WorkspaceService } from "./workspaceService.js";

export type { SealedFileEntry, SealedPackageInfo } from "./sealedPackageDb.js";

export interface SealedPackageInspection extends SealedPackageInfo {
  files: SealedFileEntry[];
}

export interface SealedExtractionResult {
  destinationPath: string;
  fileCount: number;
}

export interface SealedImportResult {
  destinationPath: string;
  roomId: string;
  fileCount: number;
  objectCount: number;
}

export interface SealedImportOptions extends WorkspaceOperationProgressOptions {
  /** Checkpoint restore keeps the logical room identity stored in the package. */
  preserveRoomIdentity?: boolean;
}

export interface SealedCreateOptions extends WorkspaceOperationProgressOptions {
  /** Checkpoints share the packager but keep a distinct UI operation kind. */
  operation?: "sealed-package-create" | "workspace-checkpoint";
}

interface WorkspacePackageFileRow {
  id: string;
  relative_path: string;
  content_sha256: string;
  size_bytes: number;
}

interface SealedPackageCreatePlan {
  before: ReadonlyMap<string, ManifestEntry>;
  destination: string;
  fileRows: WorkspacePackageFileRow[];
  root: string;
  tempPath: string;
}

interface SealedExtractionPlan {
  destination: string;
  source: string;
  wanted: ReadonlySet<string>;
}

interface SealedImportPlan {
  destination: string;
  privateRoot: string;
  source: string;
  sourceInfo: SealedPackageInfo;
  tempRoot: string;
}

export function inspectSealedPackage(packagePath: string, password: string): SealedPackageInspection {
  const db = openRoomReadonly(packagePath, password);
  try {
    const info = sealedPackageInfo(db);
    return { ...info, files: sealedFileEntries(db, info.fileCount) };
  } finally {
    db.close();
  }
}

function destinationIsOutsideWorkspace(root: string, destination: string): boolean {
  const relativeDestination = path.relative(root, destination);
  return relativeDestination !== "" && (relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination));
}

function workspacePackageRows(workspace: WorkspaceService): WorkspacePackageFileRow[] {
  return workspace.db.prepare(
    `SELECT id, relative_path, content_sha256, size_bytes FROM files
     WHERE storage_kind = 'workspace' AND trashed_at IS NULL ORDER BY relative_path`,
  ).all() as WorkspacePackageFileRow[];
}

async function prepareSealedPackageCreate(
  workspace: WorkspaceService,
  destinationPath: string,
  progress: WorkspaceOperationReporter,
): Promise<SealedPackageCreatePlan> {
  const destination = path.resolve(destinationPath);
  const root = path.resolve(workspace.rootPath);
  if (!destinationIsOutsideWorkspace(root, destination)) {
    throw new Error("Save the sealed package outside the workspace folder.");
  }
  await requireMissingDestination(destination, "A file already exists at the sealed package destination.");
  progress.emit("scanning", 0, null);
  await workspace.reconcile();
  const before = await scanWorkspaceManifest(root);
  const fileRows = workspacePackageRows(workspace);
  if (before.size !== fileRows.length) throw new Error("The workspace changed before sealing could start.");
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  return { before, destination, fileRows, root, tempPath };
}

async function copySealedPackageFiles(
  db: Database.Database,
  plan: SealedPackageCreatePlan,
  progress: WorkspaceOperationReporter,
): Promise<void> {
  const insertFile = db.prepare(
    "INSERT INTO sealed_files(file_id, relative_path, size_bytes, sha256) VALUES (?, ?, ?, ?)",
  );
  const insertFileChunk = db.prepare(
    "INSERT INTO sealed_file_chunks(file_id, seq, bytes) VALUES (?, ?, ?)",
  );
  let completedFiles = 0;
  progress.emit("copying-files", completedFiles, plan.fileRows.length, "files");
  for (const row of plan.fileRows) {
    const absolute = resolveWorkspacePath(plan.root, row.relative_path);
    const packed = await addStreamChunks(createReadStream(absolute), insertFileChunk, row.id);
    if (packed.sizeBytes !== row.size_bytes || packed.sha256 !== row.content_sha256) {
      throw new Error(`The workspace changed while sealing ${row.relative_path}.`);
    }
    insertFile.run(row.id, row.relative_path, packed.sizeBytes, packed.sha256);
    completedFiles += 1;
    progress.emit("copying-files", completedFiles, plan.fileRows.length, "files");
  }
}

async function copySealedPackageObjects(
  db: Database.Database,
  workspace: WorkspaceService,
  progress: WorkspaceOperationReporter,
): Promise<number> {
  const objectRows = workspace.db.prepare(
    "SELECT id, relative_object_path FROM content_objects ORDER BY id",
  ).all() as Array<{ id: string; relative_object_path: string }>;
  const insertObject = db.prepare(
    "INSERT INTO sealed_objects(object_id, relative_object_path, size_bytes, sha256) VALUES (?, ?, ?, ?)",
  );
  const insertObjectChunk = db.prepare(
    "INSERT INTO sealed_object_chunks(object_id, seq, bytes) VALUES (?, ?, ?)",
  );
  let completedObjects = 0;
  progress.emit("copying-history", completedObjects, objectRows.length, "objects");
  for (const row of objectRows) {
    if (!/^objects\/[0-9a-f-]+\.aobj$/i.test(row.relative_object_path)) {
      throw new Error("The workspace object store contains an unsafe path.");
    }
    const objectPath = path.join(workspace.privateRoot, ...row.relative_object_path.split("/"));
    const packed = await addStreamChunks(createReadStream(objectPath), insertObjectChunk, row.id);
    insertObject.run(row.id, row.relative_object_path, packed.sizeBytes, packed.sha256);
    completedObjects += 1;
    progress.emit("copying-history", completedObjects, objectRows.length, "objects");
  }
  return objectRows.length;
}

function requireStableWorkspaceManifest(
  before: ReadonlyMap<string, ManifestEntry>,
  after: ReadonlyMap<string, ManifestEntry>,
): void {
  if (!mapsEqual(before, after)) throw new Error("The workspace changed while the sealed package was being made.");
}

async function publishSealedPackage(
  tempPath: string,
  destination: string,
  progress: WorkspaceOperationReporter,
): Promise<void> {
  progress.emit("publishing", 0, 1);
  await rename(tempPath, destination);
  await syncDirectory(path.dirname(destination));
  progress.emit("publishing", 1, 1);
}

function closeSealedPackageQuietly(db: Database.Database | null): void {
  try { db?.close(); } catch { /* best effort */ }
}

/** Create one verified SQLCipher file containing current files and private history. */
async function createSealedPackageCore(
  workspace: WorkspaceService,
  roomId: string,
  currentPassword: string,
  destinationPath: string,
  exportPassword: string,
  purpose: string,
  progress: WorkspaceOperationReporter,
): Promise<SealedPackageInfo> {
  const plan = await prepareSealedPackageCreate(workspace, destinationPath, progress);
  let packageDb: Database.Database | null = null;
  try {
    vacuumInto(workspace.db, plan.tempPath);
    packageDb = openRoom(plan.tempPath, currentPassword);
    packageSchema(packageDb);
    await copySealedPackageFiles(packageDb, plan, progress);
    const objectCount = await copySealedPackageObjects(packageDb, workspace, progress);
    progress.emit("validating", 0, 1);
    requireStableWorkspaceManifest(plan.before, await scanWorkspaceManifest(plan.root));
    writeSealedPackageMetadata(packageDb, roomId, purpose, plan.fileRows.length, objectCount);
    verifySealedDatabase(packageDb);
    rekeySealedPackageWhenNeeded(packageDb, currentPassword, exportPassword);
    packageDb.close();
    packageDb = null;
    const info = verifyPublishedSealedPackage(plan.tempPath, exportPassword);
    progress.emit("validating", 1, 1);
    await publishSealedPackage(plan.tempPath, plan.destination, progress);
    return info;
  } catch (error) {
    closeSealedPackageQuietly(packageDb);
    await rm(plan.tempPath, { force: true });
    throw error;
  }
}

export async function createSealedPackage(
  workspace: WorkspaceService,
  roomId: string,
  currentPassword: string,
  destinationPath: string,
  exportPassword = currentPassword,
  purpose = "backup",
  options: SealedCreateOptions = {},
): Promise<SealedPackageInfo> {
  if ([...exportPassword].length < MIN_ROOM_PASSWORD_CHARS) {
    throw new Error(`Backup password must be at least ${MIN_ROOM_PASSWORD_CHARS} characters.`);
  }
  const progress = new WorkspaceOperationReporter(
    options.operation ?? "sealed-package-create",
    options.progress,
    options.operationId,
  );
  progress.start();
  try {
    const result = await createSealedPackageCore(
      workspace,
      roomId,
      currentPassword,
      destinationPath,
      exportPassword,
      purpose,
      progress,
    );
    progress.complete();
    return result;
  } catch (error) {
    progress.fail();
    throw error;
  }
}

function extractionSelection(fileIds: readonly string[]): ReadonlySet<string> {
  if (fileIds.length === 0) throw new Error("Select at least one file to extract.");
  const wanted = new Set(fileIds);
  if (wanted.size !== fileIds.length) throw new Error("The extraction selection contains duplicate files.");
  if (wanted.size > 10_000) throw new Error("Extract at most 10,000 files at one time.");
  return wanted;
}

async function prepareSealedExtraction(
  packagePath: string,
  fileIds: readonly string[],
  destinationPath: string,
): Promise<SealedExtractionPlan> {
  const wanted = extractionSelection(fileIds);
  const source = path.resolve(packagePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) throw new Error("Choose a different destination for the extracted files.");
  await requireMissingDestination(destination, "A file or folder already exists at the extraction destination.");
  return { destination, source, wanted };
}

function selectedSealedEntries(
  db: Database.Database,
  wanted: ReadonlySet<string>,
): SealedFileEntry[] {
  const info = sealedPackageInfo(db);
  const manifest = sealedFileEntries(db, info.fileCount);
  const selected = manifest.filter((entry) => wanted.has(entry.fileId));
  if (selected.length !== wanted.size) {
    throw new Error("One or more selected files are not in this sealed package.");
  }
  return selected;
}

async function restoreSealedEntries(
  db: Database.Database,
  tempRoot: string,
  selected: readonly SealedFileEntry[],
): Promise<void> {
  await mkdir(tempRoot, { mode: 0o700 });
  for (const entry of selected) {
    await restoreChunksToFile(
      db,
      entry.fileId,
      "sealed_file_chunks",
      "file_id",
      resolveWorkspacePath(tempRoot, entry.relativePath),
      entry.sizeBytes,
      entry.sha256,
    );
  }
  await syncDirectory(tempRoot);
}

async function publishSealedExtraction(tempRoot: string, destination: string): Promise<void> {
  await requireMissingDestination(destination, "A file or folder already exists at the extraction destination.");
  await rename(tempRoot, destination);
  await syncDirectory(path.dirname(destination));
}

/** Extract selected current files into a new normal folder without opening or
 * mutating the private database snapshot stored in the package. */
export async function extractSealedFiles(
  packagePath: string,
  password: string,
  fileIds: string[],
  destinationPath: string,
): Promise<SealedExtractionResult> {
  const plan = await prepareSealedExtraction(packagePath, fileIds, destinationPath);
  const db = openRoomReadonly(plan.source, password);
  const tempRoot = path.join(
    path.dirname(plan.destination),
    `.${path.basename(plan.destination)}.${randomUUID()}.extract.tmp`,
  );
  try {
    const selected = selectedSealedEntries(db, plan.wanted);
    await restoreSealedEntries(db, tempRoot, selected);
    await publishSealedExtraction(tempRoot, plan.destination);
    return { destinationPath: plan.destination, fileCount: selected.length };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  } finally {
    db.close();
  }
}

/** Import a sealed package into a new normal-file workspace. */
async function prepareSealedImport(
  packagePath: string,
  packagePassword: string,
  destinationPath: string,
  progress: WorkspaceOperationReporter,
): Promise<SealedImportPlan> {
  const source = path.resolve(packagePath);
  const destination = path.resolve(destinationPath);
  await requireMissingDestination(destination, "A file or folder already exists at the workspace destination.");
  progress.emit("scanning", 0, null);
  const sourceDb = openRoomReadonly(source, packagePassword);
  let sourceInfo: SealedPackageInfo;
  try { sourceInfo = verifySealedDatabase(sourceDb); } finally { sourceDb.close(); }
  const tempRoot = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.import.tmp`);
  return { destination, privateRoot: path.join(tempRoot, PRIVATE_DIR), source, sourceInfo, tempRoot };
}

async function openImportedWorkspace(
  plan: SealedImportPlan,
  packagePassword: string,
): Promise<Database.Database> {
  await mkdir(path.join(plan.privateRoot, OBJECTS_DIR), { recursive: true, mode: 0o700 });
  await mkdir(path.join(plan.privateRoot, TEMP_DIR), { recursive: true, mode: 0o700 });
  const dbPath = path.join(plan.privateRoot, DATABASE_FILE);
  await copyFile(plan.source, dbPath);
  await chmod(dbPath, 0o600);
  const db = openRoom(dbPath, packagePassword);
  migrate(db);
  return db;
}

function sealedImportFileRows(db: Database.Database): SealedFileRow[] {
  return db.prepare("SELECT file_id, relative_path, size_bytes, sha256 FROM sealed_files ORDER BY relative_path")
    .all() as SealedFileRow[];
}

async function restoreImportedFiles(
  db: Database.Database,
  tempRoot: string,
  files: readonly SealedFileRow[],
  progress: WorkspaceOperationReporter,
): Promise<void> {
  let completedFiles = 0;
  progress.emit("copying-files", completedFiles, files.length, "files");
  for (const file of files) {
    const relativePath = normalizeRelativePath(file.relative_path);
    const destinationFile = resolveWorkspacePath(tempRoot, relativePath);
    await restoreChunksToFile(
      db, file.file_id, "sealed_file_chunks", "file_id", destinationFile, file.size_bytes, file.sha256,
    );
    const fileStat = await lstat(destinationFile, { bigint: true });
    db.prepare(
      `UPDATE files SET name = ?, storage_kind = 'workspace', original_bytes = NULL,
         relative_path = ?, path_key = ?, content_sha256 = ?, size_bytes = ?,
         mtime_ns = ?, fs_identity = ?, index_state = 'ready', index_error = NULL,
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    ).run(
      path.posix.basename(relativePath), relativePath, pathKey(relativePath), file.sha256,
      file.size_bytes, Number(fileStat.mtimeNs),
      `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`, file.file_id,
    );
    completedFiles += 1;
    progress.emit("copying-files", completedFiles, files.length, "files");
  }
}

async function restoreImportedObjects(
  db: Database.Database,
  privateRoot: string,
  progress: WorkspaceOperationReporter,
): Promise<void> {
  const objects = db.prepare(
    "SELECT object_id, relative_object_path, size_bytes, sha256 FROM sealed_objects ORDER BY object_id",
  ).all() as SealedObjectRow[];
  let completedObjects = 0;
  progress.emit("copying-history", completedObjects, objects.length, "objects");
  for (const object of objects) {
    requireSafeSealedObjectPath(object.relative_object_path);
    const objectPath = path.join(privateRoot, ...object.relative_object_path.split("/"));
    await restoreChunksToFile(
      db, object.object_id, "sealed_object_chunks", "object_id", objectPath,
      object.size_bytes, object.sha256,
    );
    completedObjects += 1;
    progress.emit("copying-history", completedObjects, objects.length, "objects");
  }
}

async function requireImportedManifest(
  tempRoot: string,
  files: readonly SealedFileRow[],
): Promise<void> {
  const manifest = await scanWorkspaceManifest(tempRoot);
  if (manifest.size !== files.length) throw new Error("The imported workspace file count is incorrect.");
  for (const file of files) {
    const entry = manifest.get(pathKey(file.relative_path));
    if (entry?.sha256 !== file.sha256 || entry.sizeBytes !== file.size_bytes) {
      throw new Error(`The imported workspace failed validation for ${file.relative_path}.`);
    }
  }
}

function configureImportedWorkspace(
  db: Database.Database,
  sourceInfo: SealedPackageInfo,
  destination: string,
  packagePassword: string,
  workspacePassword: string,
  preserveRoomIdentity: boolean | undefined,
): string {
  db.exec(
    `DROP TABLE sealed_file_chunks;
     DROP TABLE sealed_files;
     DROP TABLE sealed_object_chunks;
     DROP TABLE sealed_objects;
     DROP TABLE sealed_package_meta;`,
  );
  const roomId = preserveRoomIdentity ? sourceInfo.roomId : randomUUID();
  setMeta(db, "room_kind", "workspace-folder");
  setMeta(db, "workspace_room_id", roomId);
  setMeta(db, "workspace_format_version", String(WORKSPACE_FORMAT_VERSION));
  if (!preserveRoomIdentity) setMeta(db, "name", path.basename(destination));
  if (workspacePassword !== packagePassword) rekey(db, workspacePassword);
  vacuum(db);
  return roomId;
}

async function writeImportedWorkspaceMarker(privateRoot: string, roomId: string): Promise<void> {
  const marker: WorkspaceMarker = {
    format: "arcelle-workspace",
    formatVersion: WORKSPACE_FORMAT_VERSION,
    roomId,
  };
  await writeFile(path.join(privateRoot, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function publishImportedWorkspace(
  tempRoot: string,
  destination: string,
  progress: WorkspaceOperationReporter,
): Promise<void> {
  progress.emit("publishing", 0, 1);
  await rename(tempRoot, destination);
  await syncDirectory(path.dirname(destination));
  progress.emit("publishing", 1, 1);
}

async function importSealedPackageCore(
  packagePath: string,
  packagePassword: string,
  destinationPath: string,
  workspacePassword: string,
  options: SealedImportOptions,
  progress: WorkspaceOperationReporter,
): Promise<SealedImportResult> {
  const plan = await prepareSealedImport(packagePath, packagePassword, destinationPath, progress);
  let db: Database.Database | null = null;
  try {
    db = await openImportedWorkspace(plan, packagePassword);
    const files = sealedImportFileRows(db);
    await restoreImportedFiles(db, plan.tempRoot, files, progress);
    await restoreImportedObjects(db, plan.privateRoot, progress);
    progress.emit("validating", 0, 1);
    await requireImportedManifest(plan.tempRoot, files);
    progress.emit("validating", 1, 1);
    const roomId = configureImportedWorkspace(
      db, plan.sourceInfo, plan.destination, packagePassword, workspacePassword, options.preserveRoomIdentity,
    );
    await writeImportedWorkspaceMarker(plan.privateRoot, roomId);
    db.close();
    db = null;
    await publishImportedWorkspace(plan.tempRoot, plan.destination, progress);
    return {
      destinationPath: plan.destination,
      roomId,
      fileCount: plan.sourceInfo.fileCount,
      objectCount: plan.sourceInfo.objectCount,
    };
  } catch (error) {
    closeSealedPackageQuietly(db);
    await rm(plan.tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function importSealedPackage(
  packagePath: string,
  packagePassword: string,
  destinationPath: string,
  workspacePassword = packagePassword,
  options: SealedImportOptions = {},
): Promise<SealedImportResult> {
  const progress = new WorkspaceOperationReporter(
    "sealed-package-import",
    options.progress,
    options.operationId,
  );
  progress.start();
  try {
    const result = await importSealedPackageCore(
      packagePath,
      packagePassword,
      destinationPath,
      workspacePassword,
      options,
      progress,
    );
    progress.complete();
    return result;
  } catch (error) {
    progress.fail();
    throw error;
  }
}
