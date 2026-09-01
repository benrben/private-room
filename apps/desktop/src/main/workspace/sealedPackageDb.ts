import { createHash } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { openRoomReadonly } from "../db-host/open.js";
import { rekey } from "../db-host/rekey.js";
import { normalizeRelativePath, pathKey } from "./pathSafety.js";

export const PACKAGE_VERSION = 2;
const CHUNK_BYTES = 1024 * 1024;

export interface SealedPackageInfo {
  version: number;
  purpose: string;
  createdAt: string;
  roomId: string;
  fileCount: number;
  objectCount: number;
}

export interface SealedFileEntry {
  fileId: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface SealedFileRow {
  file_id: string;
  relative_path: string;
  size_bytes: number;
  sha256: string;
}

export interface SealedObjectRow {
  object_id: string;
  relative_object_path: string;
  size_bytes: number;
  sha256: string;
}

export function packageSchema(db: Database.Database): void {
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

export function setPackageMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sealed_package_meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Validation provides the safety check on filesystems without dir fsync.
  }
}

export function mapsEqual(
  left: ReadonlyMap<string, { sha256: string; sizeBytes: number }>,
  right: ReadonlyMap<string, { sha256: string; sizeBytes: number }>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined || other.sha256 !== value.sha256 || other.sizeBytes !== value.sizeBytes) return false;
  }
  return true;
}

export async function addStreamChunks(
  stream: NodeJS.ReadableStream,
  insert: Database.Statement,
  ownerId: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let seq = 0;
  for await (const raw of stream) {
    const source = Buffer.from(raw as Uint8Array);
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

export function sealedPackageInfo(db: Database.Database): SealedPackageInfo {
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
}

export function sealedFileEntries(db: Database.Database, expectedCount: number): SealedFileEntry[] {
  const rows = db.prepare(
    "SELECT file_id, relative_path, size_bytes, sha256 FROM sealed_files ORDER BY relative_path COLLATE NOCASE, file_id",
  ).all() as SealedFileRow[];
  if (rows.length !== expectedCount) throw new Error("The sealed package item count is incorrect.");
  const seenPaths = new Set<string>();
  return rows.map((row) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(row.file_id)) {
      throw new Error("The sealed package contains an invalid file identifier.");
    }
    if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || !/^[0-9a-f]{64}$/i.test(row.sha256)) {
      throw new Error("The sealed package file manifest is damaged.");
    }
    const relativePath = normalizeRelativePath(row.relative_path);
    const key = pathKey(relativePath);
    if (seenPaths.has(key)) throw new Error("The sealed package contains colliding file paths.");
    seenPaths.add(key);
    return {
      fileId: row.file_id,
      relativePath,
      sizeBytes: row.size_bytes,
      sha256: row.sha256.toLowerCase(),
    };
  });
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

function requireSupportedPackageVersion(db: Database.Database): number {
  const version = numericMeta(db, "version");
  if (version !== PACKAGE_VERSION) throw new Error("This sealed package version is not supported.");
  return version;
}

function requireSealedPackageCounts(
  db: Database.Database,
  files: readonly SealedFileRow[],
  objects: readonly SealedObjectRow[],
): void {
  if (files.length !== numericMeta(db, "file_count") || objects.length !== numericMeta(db, "object_count")) {
    throw new Error("The sealed package item count is incorrect.");
  }
}

function verifySealedFiles(db: Database.Database, files: readonly SealedFileRow[]): void {
  for (const file of files) {
    normalizeRelativePath(file.relative_path);
    verifyChunkTable(db, file.file_id, "sealed_file_chunks", "file_id", file.size_bytes, file.sha256);
  }
}

export function requireSafeSealedObjectPath(relativeObjectPath: string): void {
  if (!/^objects\/[0-9a-f-]+\.aobj$/i.test(relativeObjectPath)) {
    throw new Error("The sealed package contains an unsafe object path.");
  }
}

function verifySealedObjects(db: Database.Database, objects: readonly SealedObjectRow[]): void {
  for (const object of objects) {
    requireSafeSealedObjectPath(object.relative_object_path);
    verifyChunkTable(db, object.object_id, "sealed_object_chunks", "object_id", object.size_bytes, object.sha256);
  }
}

function sealedPackageInfoFromRows(
  version: number,
  files: readonly SealedFileRow[],
  objects: readonly SealedObjectRow[],
  db: Database.Database,
): SealedPackageInfo {
  const purpose = packageMeta(db, "purpose");
  const createdAt = packageMeta(db, "created_at");
  const roomId = packageMeta(db, "room_id");
  if (purpose === null || createdAt === null || roomId === null) throw new Error("The sealed package metadata is incomplete.");
  return { version, purpose, createdAt, roomId, fileCount: files.length, objectCount: objects.length };
}

export function verifySealedDatabase(db: Database.Database): SealedPackageInfo {
  const version = requireSupportedPackageVersion(db);
  const files = db.prepare("SELECT file_id, relative_path, size_bytes, sha256 FROM sealed_files ORDER BY file_id")
    .all() as SealedFileRow[];
  const objects = db.prepare(
    "SELECT object_id, relative_object_path, size_bytes, sha256 FROM sealed_objects ORDER BY object_id",
  ).all() as SealedObjectRow[];
  requireSealedPackageCounts(db, files, objects);
  verifySealedFiles(db, files);
  verifySealedObjects(db, objects);
  return sealedPackageInfoFromRows(version, files, objects, db);
}

export function writeSealedPackageMetadata(
  db: Database.Database,
  roomId: string,
  purpose: string,
  fileCount: number,
  objectCount: number,
): void {
  const createdAt = new Date().toISOString();
  setPackageMeta(db, "version", String(PACKAGE_VERSION));
  setPackageMeta(db, "purpose", purpose);
  setPackageMeta(db, "created_at", createdAt);
  setPackageMeta(db, "room_id", roomId);
  setPackageMeta(db, "file_count", String(fileCount));
  setPackageMeta(db, "object_count", String(objectCount));
}

export function rekeySealedPackageWhenNeeded(
  db: Database.Database,
  currentPassword: string,
  exportPassword: string,
): void {
  if (exportPassword !== currentPassword) rekey(db, exportPassword);
}

export function verifyPublishedSealedPackage(tempPath: string, exportPassword: string): SealedPackageInfo {
  const verified = openRoomReadonly(tempPath, exportPassword);
  const info = verifySealedDatabase(verified);
  verified.close();
  return info;
}

async function pathExists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(() => true, () => false);
}

export async function requireMissingDestination(destination: string, message: string): Promise<void> {
  if (await pathExists(destination)) throw new Error(message);
}

export async function restoreChunksToFile(
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
