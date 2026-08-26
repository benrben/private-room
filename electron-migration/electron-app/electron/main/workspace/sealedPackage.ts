import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { migrate } from "../db-host/migrate.js";
import { getMeta, setMeta } from "../db-host/meta.js";
import { openRoom, openRoomReadonly } from "../db-host/open.js";
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
import type { ManifestEntry, WorkspaceMarker } from "./types.js";
import { WorkspaceService } from "./workspaceService.js";

const PACKAGE_VERSION = 2;
const CHUNK_BYTES = 1024 * 1024;

export interface SealedPackageInfo {
  version: number;
  purpose: string;
  createdAt: string;
  roomId: string;
  fileCount: number;
  objectCount: number;
}

export interface SealedImportResult {
  destinationPath: string;
  roomId: string;
  fileCount: number;
  objectCount: number;
}

export interface SealedImportOptions {
  /** Checkpoint restore keeps the logical room identity stored in the package. */
  preserveRoomIdentity?: boolean;
}

interface SealedFileRow {
  file_id: string;
  relative_path: string;
  size_bytes: number;
  sha256: string;
}

interface SealedObjectRow {
  object_id: string;
  relative_object_path: string;
  size_bytes: number;
  sha256: string;
}

function packageSchema(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS sealed_package_meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS sealed_files (
       file_id TEXT PRIMARY KEY,
       relative_path TEXT NOT NULL,
       size_bytes INTEGER NOT NULL,
       sha256 TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS sealed_file_chunks (
       file_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       bytes BLOB NOT NULL,
       PRIMARY KEY(file_id, seq)
     );
     CREATE TABLE IF NOT EXISTS sealed_objects (
       object_id TEXT PRIMARY KEY,
       relative_object_path TEXT NOT NULL,
       size_bytes INTEGER NOT NULL,
       sha256 TEXT NOT NULL
     );
     CREATE TABLE IF NOT EXISTS sealed_object_chunks (
       object_id TEXT NOT NULL,
       seq INTEGER NOT NULL,
       bytes BLOB NOT NULL,
       PRIMARY KEY(object_id, seq)
     );`,
  );
}

function packageMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM sealed_package_meta WHERE key = ?").get(key) as {
    value: string;
  } | undefined;
  return row?.value ?? null;
}

function setPackageMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sealed_package_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Validation provides the safety check on filesystems without dir fsync.
  }
}

function mapsEqual(
  left: ReadonlyMap<string, ManifestEntry>,
  right: ReadonlyMap<string, ManifestEntry>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || other.sha256 !== value.sha256 || other.sizeBytes !== value.sizeBytes) return false;
  }
  return true;
}

async function addStreamChunks(
  stream: NodeJS.ReadableStream,
  insert: Database.Statement,
  ownerId: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let seq = 0;
  for await (const raw of stream) {
    const source = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === "string"
        ? Buffer.from(raw)
        : Buffer.from(raw as Uint8Array);
    for (let offset = 0; offset < source.length; offset += CHUNK_BYTES) {
      const chunk = source.subarray(offset, Math.min(source.length, offset + CHUNK_BYTES));
      hash.update(chunk);
      sizeBytes += chunk.length;
      insert.run(ownerId, seq, chunk);
      seq += 1;
    }
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

function numericMeta(db: Database.Database, key: string): number {
  const raw = packageMeta(db, key);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("The sealed package metadata is damaged.");
  return value;
}

export function inspectSealedPackage(packagePath: string, password: string): SealedPackageInfo {
  const db = openRoomReadonly(packagePath, password);
  try {
    const version = numericMeta(db, "version");
    if (version !== PACKAGE_VERSION) throw new Error("This sealed package version is not supported.");
    const purpose = packageMeta(db, "purpose");
    const createdAt = packageMeta(db, "created_at");
    const roomId = packageMeta(db, "room_id");
    if (purpose === null || createdAt === null || roomId === null) {
      throw new Error("The sealed package metadata is incomplete.");
    }
    return {
      version,
      purpose,
      createdAt,
      roomId,
      fileCount: numericMeta(db, "file_count"),
      objectCount: numericMeta(db, "object_count"),
    };
  } finally {
    db.close();
  }
}

function verifyChunkTable(
  db: Database.Database,
  ownerId: string,
  table: "sealed_file_chunks" | "sealed_object_chunks",
  idColumn: "file_id" | "object_id",
  sizeBytes: number,
  expectedHash: string,
): void {
  const rows = db.prepare(
    `SELECT bytes FROM ${table} WHERE ${idColumn} = ? ORDER BY seq`,
  ).all(ownerId) as Array<{ bytes: Buffer }>;
  const hash = createHash("sha256");
  let size = 0;
  for (const row of rows) {
    hash.update(row.bytes);
    size += row.bytes.length;
  }
  if (size !== sizeBytes || hash.digest("hex") !== expectedHash) {
    throw new Error("The sealed package failed its content integrity check.");
  }
}

function verifySealedDatabase(db: Database.Database): SealedPackageInfo {
  const version = numericMeta(db, "version");
  if (version !== PACKAGE_VERSION) throw new Error("This sealed package version is not supported.");
  const files = db.prepare("SELECT file_id, relative_path, size_bytes, sha256 FROM sealed_files ORDER BY file_id")
    .all() as SealedFileRow[];
  const objects = db.prepare(
    "SELECT object_id, relative_object_path, size_bytes, sha256 FROM sealed_objects ORDER BY object_id",
  ).all() as SealedObjectRow[];
  if (files.length !== numericMeta(db, "file_count") || objects.length !== numericMeta(db, "object_count")) {
    throw new Error("The sealed package item count is incorrect.");
  }
  for (const file of files) {
    normalizeRelativePath(file.relative_path);
    verifyChunkTable(db, file.file_id, "sealed_file_chunks", "file_id", file.size_bytes, file.sha256);
  }
  for (const object of objects) {
    if (!/^objects\/[0-9a-f-]+\.aobj$/i.test(object.relative_object_path)) {
      throw new Error("The sealed package contains an unsafe object path.");
    }
    verifyChunkTable(db, object.object_id, "sealed_object_chunks", "object_id", object.size_bytes, object.sha256);
  }
  const purpose = packageMeta(db, "purpose");
  const createdAt = packageMeta(db, "created_at");
  const roomId = packageMeta(db, "room_id");
  if (purpose === null || createdAt === null || roomId === null) throw new Error("The sealed package metadata is incomplete.");
  return { version, purpose, createdAt, roomId, fileCount: files.length, objectCount: objects.length };
}

/** Create one verified SQLCipher file containing current files and private history. */
export async function createSealedPackage(
  workspace: WorkspaceService,
  roomId: string,
  currentPassword: string,
  destinationPath: string,
  exportPassword = currentPassword,
  purpose = "backup",
): Promise<SealedPackageInfo> {
  const destination = path.resolve(destinationPath);
  const root = path.resolve(workspace.rootPath);
  const relativeDestination = path.relative(root, destination);
  if (relativeDestination === "" || (!relativeDestination.startsWith("..") && !path.isAbsolute(relativeDestination))) {
    throw new Error("Save the sealed package outside the workspace folder.");
  }
  if (await lstat(destination).then(() => true, () => false)) {
    throw new Error("A file already exists at the sealed package destination.");
  }
  await workspace.reconcile();
  const before = await scanWorkspaceManifest(root);
  const fileRows = workspace.db.prepare(
    `SELECT id, relative_path, content_sha256, size_bytes FROM files
     WHERE storage_kind = 'workspace' AND trashed_at IS NULL ORDER BY relative_path`,
  ).all() as Array<{
    id: string;
    relative_path: string;
    content_sha256: string;
    size_bytes: number;
  }>;
  if (before.size !== fileRows.length) throw new Error("The workspace changed before sealing could start.");
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  let packageDb: Database.Database | null = null;
  try {
    vacuumInto(workspace.db, tempPath);
    packageDb = openRoom(tempPath, currentPassword);
    packageSchema(packageDb);
    const insertFile = packageDb.prepare(
      "INSERT INTO sealed_files(file_id, relative_path, size_bytes, sha256) VALUES (?, ?, ?, ?)",
    );
    const insertFileChunk = packageDb.prepare(
      "INSERT INTO sealed_file_chunks(file_id, seq, bytes) VALUES (?, ?, ?)",
    );
    for (const row of fileRows) {
      const absolute = resolveWorkspacePath(root, row.relative_path);
      const packed = await addStreamChunks(createReadStream(absolute), insertFileChunk, row.id);
      if (packed.sizeBytes !== row.size_bytes || packed.sha256 !== row.content_sha256) {
        throw new Error(`The workspace changed while sealing ${row.relative_path}.`);
      }
      insertFile.run(row.id, row.relative_path, packed.sizeBytes, packed.sha256);
    }

    const objectRows = workspace.db.prepare(
      "SELECT id, relative_object_path FROM content_objects ORDER BY id",
    ).all() as Array<{ id: string; relative_object_path: string }>;
    const insertObject = packageDb.prepare(
      "INSERT INTO sealed_objects(object_id, relative_object_path, size_bytes, sha256) VALUES (?, ?, ?, ?)",
    );
    const insertObjectChunk = packageDb.prepare(
      "INSERT INTO sealed_object_chunks(object_id, seq, bytes) VALUES (?, ?, ?)",
    );
    for (const row of objectRows) {
      if (!/^objects\/[0-9a-f-]+\.aobj$/i.test(row.relative_object_path)) {
        throw new Error("The workspace object store contains an unsafe path.");
      }
      const objectPath = path.join(workspace.privateRoot, ...row.relative_object_path.split("/"));
      const packed = await addStreamChunks(createReadStream(objectPath), insertObjectChunk, row.id);
      insertObject.run(row.id, row.relative_object_path, packed.sizeBytes, packed.sha256);
    }
    const after = await scanWorkspaceManifest(root);
    if (!mapsEqual(before, after)) throw new Error("The workspace changed while the sealed package was being made.");
    const createdAt = new Date().toISOString();
    setPackageMeta(packageDb, "version", String(PACKAGE_VERSION));
    setPackageMeta(packageDb, "purpose", purpose);
    setPackageMeta(packageDb, "created_at", createdAt);
    setPackageMeta(packageDb, "room_id", roomId);
    setPackageMeta(packageDb, "file_count", String(fileRows.length));
    setPackageMeta(packageDb, "object_count", String(objectRows.length));
    verifySealedDatabase(packageDb);
    if (exportPassword !== currentPassword) rekey(packageDb, exportPassword);
    packageDb.close();
    packageDb = null;
    const verified = openRoomReadonly(tempPath, exportPassword);
    const info = verifySealedDatabase(verified);
    verified.close();
    await rename(tempPath, destination);
    await syncDirectory(path.dirname(destination));
    return info;
  } catch (error) {
    try { packageDb?.close(); } catch { /* best effort */ }
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function restoreChunksToFile(
  db: Database.Database,
  ownerId: string,
  table: "sealed_file_chunks" | "sealed_object_chunks",
  idColumn: "file_id" | "object_id",
  destination: string,
  expectedSize: number,
  expectedHash: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await open(destination, "wx", 0o600);
  const rows = db.prepare(`SELECT bytes FROM ${table} WHERE ${idColumn} = ? ORDER BY seq`)
    .iterate(ownerId) as Iterable<{ bytes: Buffer }>;
  const hash = createHash("sha256");
  let offset = 0;
  try {
    for (const row of rows) {
      await handle.write(row.bytes, 0, row.bytes.length, offset);
      hash.update(row.bytes);
      offset += row.bytes.length;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (offset !== expectedSize || hash.digest("hex") !== expectedHash) {
    await rm(destination, { force: true });
    throw new Error("The sealed package failed while restoring a file.");
  }
}

/** Import a sealed package into a new normal-file workspace. */
export async function importSealedPackage(
  packagePath: string,
  packagePassword: string,
  destinationPath: string,
  workspacePassword = packagePassword,
  options: SealedImportOptions = {},
): Promise<SealedImportResult> {
  const source = path.resolve(packagePath);
  const destination = path.resolve(destinationPath);
  if (await lstat(destination).then(() => true, () => false)) {
    throw new Error("A file or folder already exists at the workspace destination.");
  }
  const sourceDb = openRoomReadonly(source, packagePassword);
  let sourceInfo: SealedPackageInfo;
  try { sourceInfo = verifySealedDatabase(sourceDb); } finally { sourceDb.close(); }
  const tempRoot = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.import.tmp`);
  const privateRoot = path.join(tempRoot, PRIVATE_DIR);
  const dbPath = path.join(privateRoot, DATABASE_FILE);
  let db: Database.Database | null = null;
  try {
    await mkdir(path.join(privateRoot, OBJECTS_DIR), { recursive: true, mode: 0o700 });
    await mkdir(path.join(privateRoot, TEMP_DIR), { recursive: true, mode: 0o700 });
    await copyFile(source, dbPath);
    db = openRoom(dbPath, packagePassword);
    migrate(db);
    const files = db.prepare("SELECT file_id, relative_path, size_bytes, sha256 FROM sealed_files ORDER BY relative_path")
      .all() as SealedFileRow[];
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
    }
    const objects = db.prepare(
      "SELECT object_id, relative_object_path, size_bytes, sha256 FROM sealed_objects ORDER BY object_id",
    ).all() as SealedObjectRow[];
    for (const object of objects) {
      if (!/^objects\/[0-9a-f-]+\.aobj$/i.test(object.relative_object_path)) {
        throw new Error("The sealed package contains an unsafe object path.");
      }
      const objectPath = path.join(privateRoot, ...object.relative_object_path.split("/"));
      await restoreChunksToFile(
        db, object.object_id, "sealed_object_chunks", "object_id", objectPath,
        object.size_bytes, object.sha256,
      );
    }
    const manifest = await scanWorkspaceManifest(tempRoot);
    if (manifest.size !== files.length) throw new Error("The imported workspace file count is incorrect.");
    for (const file of files) {
      const entry = manifest.get(pathKey(file.relative_path));
      if (entry?.sha256 !== file.sha256 || entry.sizeBytes !== file.size_bytes) {
        throw new Error(`The imported workspace failed validation for ${file.relative_path}.`);
      }
    }
    db.exec(
      `DROP TABLE sealed_file_chunks;
       DROP TABLE sealed_files;
       DROP TABLE sealed_object_chunks;
       DROP TABLE sealed_objects;
       DROP TABLE sealed_package_meta;`,
    );
    const roomId = options.preserveRoomIdentity ? sourceInfo.roomId : randomUUID();
    setMeta(db, "room_kind", "workspace-folder");
    setMeta(db, "workspace_room_id", roomId);
    setMeta(db, "workspace_format_version", String(WORKSPACE_FORMAT_VERSION));
    if (!options.preserveRoomIdentity) setMeta(db, "name", path.basename(destination));
    if (workspacePassword !== packagePassword) rekey(db, workspacePassword);
    vacuum(db);
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
    db.close();
    db = null;
    await rename(tempRoot, destination);
    await syncDirectory(path.dirname(destination));
    return {
      destinationPath: destination,
      roomId,
      fileCount: sourceInfo.fileCount,
      objectCount: sourceInfo.objectCount,
    };
  } catch (error) {
    try { db?.close(); } catch { /* best effort */ }
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
