import type Database from "better-sqlite3-multiple-ciphers";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VERSIONS_KEPT } from "../db-host/versions.js";
import { clearChunks } from "../db-host/files.js";
import { ContentObjectStore } from "./contentObjects.js";
import { scanWorkspaceManifest } from "./manifest.js";
import {
  assertNoSymlinkSegments,
  normalizeRelativePath,
  pathKey,
  resolveWorkspacePath,
} from "./pathSafety.js";
import type { ContentEntry, ContentObjectRef, ManifestEntry, WriteResult } from "./types.js";

interface WorkspaceFileRow {
  id: string;
  name: string;
  mime_type: string | null;
  relative_path: string;
  content_sha256: string | null;
  size_bytes: number;
  index_state?: string;
}

export interface WorkspaceVersionSnapshot {
  fileId: string;
  bytes: Buffer;
  text: string | null;
  recMeta: string | null;
  provenance: string | null;
}

export interface WorkspaceDirectoryState {
  relativePath: string;
  exists: boolean;
  empty: boolean;
  /** Used internally to refuse removal if another process replaced the directory. */
  fsIdentity: string | null;
}

export class ContentConflictError extends Error {
  readonly code = "CONTENT_CONFLICT";
  constructor(readonly expected: string, readonly actual: string) {
    super("The file changed after it was opened. Arcelle did not overwrite it.");
  }
}

function mimeForName(name: string): string {
  const extension = path.extname(name).toLocaleLowerCase("en-US");
  return ({
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".html": "text/html",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some network filesystems do not allow opening a directory. The file was
    // still fsynced; reconciliation will detect any incomplete operation.
  }
}

async function assertDestinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("A file already exists at that destination.");
}

export class WorkspaceService {
  readonly objects: ContentObjectStore;

  constructor(
    readonly db: Database.Database,
    readonly rootPath: string,
    readonly privateRoot = path.join(rootPath, ".arcelle"),
  ) {
    this.objects = new ContentObjectStore(db, privateRoot);
  }

  private fileRow(fileId: string): WorkspaceFileRow {
    const row = this.db.prepare(
      `SELECT id, name, mime_type, relative_path, content_sha256, size_bytes
       FROM files WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).get(fileId) as WorkspaceFileRow | undefined;
    if (row === undefined) throw new Error("That workspace file is not in this room.");
    return row;
  }

  private prepareOperation(
    operationType: string,
    fileId: string | null,
    oldPath: string | null,
    newPath: string | null,
    oldHash: string | null,
    agentRunId: string | null,
  ): string {
    const operationId = randomUUID();
    this.db.prepare(
      `INSERT INTO fs_operations(
         operation_id, operation_type, phase, file_id, old_path, new_path, old_hash, agent_run_id
       ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?)`,
    ).run(operationId, operationType, fileId, oldPath, newPath, oldHash, agentRunId);
    return operationId;
  }

  private updateOperation(operationId: string, phase: string, newHash?: string, error?: string): void {
    this.db.prepare(
      `UPDATE fs_operations SET phase = ?, new_hash = coalesce(?, new_hash), error = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE operation_id = ?`,
    ).run(phase, newHash ?? null, error ?? null, operationId);
  }

  private async verifyExpected(filePath: string, expectedHash?: string): Promise<string> {
    const actual = await sha256(filePath);
    if (expectedHash !== undefined && actual !== expectedHash) {
      throw new ContentConflictError(expectedHash, actual);
    }
    return actual;
  }

  /** Inspect a normal workspace directory without exposing an absolute path. */
  async directoryState(directoryPath: string): Promise<WorkspaceDirectoryState> {
    const relativePath = normalizeRelativePath(directoryPath);
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(destination, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { relativePath, exists: false, empty: true, fsIdentity: null };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in managed room paths.");
    if (!stat.isDirectory()) throw new Error("A normal file already exists at that folder path.");
    let entries: string[];
    try {
      entries = await readdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { relativePath, exists: false, empty: true, fsIdentity: null };
      }
      throw error;
    }
    return {
      relativePath,
      exists: true,
      empty: entries.length === 0,
      fsIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
    };
  }

  /** Create a normal workspace directory. Existing directories are an idempotent no-op. */
  async createDirectory(directoryPath: string): Promise<boolean> {
    const before = await this.directoryState(directoryPath);
    if (before.exists) return false;
    const destination = resolveWorkspacePath(this.rootPath, before.relativePath);
    const operationId = this.prepareOperation(
      "create_directory", null, null, before.relativePath, null, null,
    );
    try {
      const createdPath = await mkdir(destination, { recursive: true });
      await assertNoSymlinkSegments(this.rootPath, before.relativePath);
      const after = await this.directoryState(before.relativePath);
      if (!after.exists) throw new Error("The folder was not created.");
      await syncDirectory(path.dirname(destination));
      this.updateOperation(operationId, "filesystem_committed");
      this.updateOperation(operationId, "database_committed");
      this.updateOperation(operationId, "completed");
      return createdPath !== undefined;
    } catch (error) {
      this.updateOperation(
        operationId,
        "failed",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /** Remove one normal workspace directory, but only while it is still empty. */
  async removeDirectory(directoryPath: string): Promise<boolean> {
    const before = await this.directoryState(directoryPath);
    if (!before.exists) return false;
    if (!before.empty) throw new Error("The folder is not empty and was not removed.");
    const destination = resolveWorkspacePath(this.rootPath, before.relativePath);
    const operationId = this.prepareOperation(
      "remove_directory", null, before.relativePath, null, null, null,
    );
    try {
      const current = await this.directoryState(before.relativePath);
      if (!current.exists) {
        this.updateOperation(operationId, "filesystem_committed");
        this.updateOperation(operationId, "database_committed");
        this.updateOperation(operationId, "completed");
        return false;
      }
      if (current.fsIdentity !== before.fsIdentity) {
        throw new Error("The folder changed before it could be removed.");
      }
      if (!current.empty) throw new Error("The folder is not empty and was not removed.");
      try {
        await rmdir(destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          this.updateOperation(operationId, "filesystem_committed");
          this.updateOperation(operationId, "database_committed");
          this.updateOperation(operationId, "completed");
          return false;
        }
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          throw new Error("The folder is not empty and was not removed.");
        }
        throw error;
      }
      await syncDirectory(path.dirname(destination));
      this.updateOperation(operationId, "filesystem_committed");
      this.updateOperation(operationId, "database_committed");
      this.updateOperation(operationId, "completed");
      return true;
    } catch (error) {
      this.updateOperation(
        operationId,
        "failed",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  readStream(fileId: string): Readable {
    const row = this.fileRow(fileId);
    return createReadStream(resolveWorkspacePath(this.rootPath, row.relative_path));
  }

  async readBuffer(fileId: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.readStream(fileId)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /** Save the current normal-file bytes as one History entry. */
  async snapshotVersion(fileId: string, cause: string): Promise<string> {
    const row = this.db.prepare(
      `SELECT f.extracted_text, f.provenance, r.meta AS rec_meta
       FROM files f LEFT JOIN recordings r ON r.file_id = f.id
       WHERE f.id = ? AND f.storage_kind = 'workspace' AND f.trashed_at IS NULL`,
    ).get(fileId) as {
      extracted_text: string | null;
      provenance: string | null;
      rec_meta: string | null;
    } | undefined;
    if (row === undefined) throw new Error("That workspace file is not in this room.");
    const file = this.fileRow(fileId);
    const object = await this.objects.putFile(resolveWorkspacePath(this.rootPath, file.relative_path));
    const versionId = randomUUID();
    const pruned: string[] = [];
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO file_versions(id, file_id, bytes, text, rec_meta, cause, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        fileId,
        Buffer.alloc(0),
        row.extracted_text,
        row.rec_meta,
        cause,
        row.provenance,
      );
      this.objects.addReference("file_version", versionId, object.id, "content");
      const stale = this.db.prepare(
        `SELECT id FROM file_versions
         WHERE file_id = ? AND pinned = 0
         ORDER BY saved_at DESC, rowid DESC LIMIT -1 OFFSET ${VERSIONS_KEPT}`,
      ).all(fileId) as Array<{ id: string }>;
      for (const version of stale) {
        pruned.push(version.id);
        this.db.prepare(
          "DELETE FROM content_object_refs WHERE owner_type = 'file_version' AND owner_id = ?",
        ).run(version.id);
        this.db.prepare("DELETE FROM file_versions WHERE id = ?").run(version.id);
      }
    })();
    if (pruned.length > 0) await this.objects.collectGarbage();
    return versionId;
  }

  async versionSnapshot(versionId: string): Promise<WorkspaceVersionSnapshot> {
    const row = this.db.prepare(
      `SELECT v.file_id, v.bytes, v.text, v.rec_meta, v.provenance, r.object_id
       FROM file_versions v
       LEFT JOIN content_object_refs r
         ON r.owner_type = 'file_version' AND r.owner_id = v.id AND r.role = 'content'
       WHERE v.id = ?`,
    ).get(versionId) as {
      file_id: string;
      bytes: Buffer;
      text: string | null;
      rec_meta: string | null;
      provenance: string | null;
      object_id: string | null;
    } | undefined;
    if (row === undefined) throw new Error("That version is no longer available.");
    return {
      fileId: row.file_id,
      bytes: row.object_id === null ? row.bytes : await this.objects.readBuffer(row.object_id),
      text: row.text,
      recMeta: row.rec_meta,
      provenance: row.provenance,
    };
  }

  async restoreVersion(versionId: string): Promise<string> {
    const version = await this.versionSnapshot(versionId);
    const current = this.fileRow(version.fileId);
    await this.snapshotVersion(version.fileId, "Restored");
    const objectRow = this.db.prepare(
      `SELECT object_id FROM content_object_refs
       WHERE owner_type = 'file_version' AND owner_id = ? AND role = 'content'`,
    ).get(versionId) as { object_id: string } | undefined;
    const content = objectRow === undefined
      ? Readable.from([version.bytes])
      : (await this.objects.readStream(objectRow.object_id)).stream;
    await this.writeAtomic(version.fileId, content, current.content_sha256 ?? undefined);
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE files SET extracted_text = ?, provenance = ? WHERE id = ?",
      ).run(version.text, version.provenance, version.fileId);
      if (version.recMeta !== null) {
        this.db.prepare("UPDATE recordings SET meta = ? WHERE file_id = ?")
          .run(version.recMeta, version.fileId);
      }
    })();
    return version.fileId;
  }

  async deleteVersion(versionId: string): Promise<void> {
    const exists = this.db.prepare("SELECT 1 FROM file_versions WHERE id = ?").get(versionId);
    if (exists === undefined) throw new Error("That version is no longer available.");
    this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM content_object_refs WHERE owner_type = 'file_version' AND owner_id = ?",
      ).run(versionId);
      this.db.prepare("DELETE FROM file_versions WHERE id = ?").run(versionId);
    })();
    await this.objects.collectGarbage();
  }

  async writeAtomic(
    fileId: string,
    content: Readable,
    expectedHash?: string,
    agentRunId: string | null = null,
  ): Promise<WriteResult> {
    const row = this.fileRow(fileId);
    const relativePath = normalizeRelativePath(row.relative_path);
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath);
    const destinationStat = await lstat(destination);
    const oldHash = await this.verifyExpected(destination, expectedHash);
    const operationId = this.prepareOperation("write", fileId, relativePath, relativePath, oldHash, agentRunId);
    const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.arcelle-${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const observe = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(content, observe, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
      await chmod(tempPath, destinationStat.mode & 0o7777);
      const handle = await open(tempPath, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(tempPath, destination);
      await syncDirectory(path.dirname(destination));
      const newHash = hash.digest("hex");
      this.updateOperation(operationId, "filesystem_committed", newHash);
      const fileStat = await lstat(destination, { bigint: true });
      this.db.transaction(() => {
        clearChunks(this.db, fileId);
        this.db.prepare(
          `UPDATE files SET size_bytes = ?, content_sha256 = ?, mtime_ns = ?, fs_identity = ?,
             extracted_text = NULL, ai_summary = NULL,
             index_state = 'stale', index_error = NULL,
             last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
        ).run(
          sizeBytes,
          newHash,
          Number(fileStat.mtimeNs),
          `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`,
          fileId,
        );
        this.updateOperation(operationId, "database_committed", newHash);
      })();
      this.updateOperation(operationId, "completed", newHash);
      return {
        fileId,
        relativePath,
        sizeBytes,
        sha256: newHash,
        mtimeNs: Number(fileStat.mtimeNs),
        created: false,
      };
    } catch (error) {
      await rm(tempPath, { force: true });
      this.updateOperation(operationId, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async importFile(sourcePath: string, destinationPath: string): Promise<ContentEntry> {
    return this.createFile(destinationPath, createReadStream(sourcePath), "import");
  }

  async createFile(
    destinationPath: string,
    content: Readable,
    source = "generated",
  ): Promise<ContentEntry> {
    const relativePath = normalizeRelativePath(destinationPath);
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await mkdir(path.dirname(destination), { recursive: true });
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await assertDestinationAbsent(destination);
    const fileId = randomUUID();
    const operationId = this.prepareOperation("create", fileId, null, relativePath, null, null);
    const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.arcelle-${randomUUID()}.tmp`);
    const digest = createHash("sha256");
    let sizeBytes = 0;
    const observe = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(content, observe, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
      const handle = await open(tempPath, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(tempPath, destination);
      await syncDirectory(path.dirname(destination));
      const fileStat = await lstat(destination, { bigint: true });
      const contentHash = digest.digest("hex");
      this.updateOperation(operationId, "filesystem_committed", contentHash);
      const mime = mimeForName(relativePath);
      this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO files(
             id, name, mime_type, size_bytes, source, original_bytes, storage_kind,
             relative_path, path_key, content_sha256, mtime_ns, fs_identity, index_state, last_seen_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 'workspace', ?, ?, ?, ?, ?, 'pending',
             strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        ).run(
          fileId,
          path.basename(relativePath),
          mime,
          sizeBytes,
          source,
          relativePath,
          pathKey(relativePath),
          contentHash,
          Number(fileStat.mtimeNs),
          `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`,
        );
        this.updateOperation(operationId, "database_committed", contentHash);
      })();
      this.updateOperation(operationId, "completed", contentHash);
      return {
        fileId,
        name: path.basename(relativePath),
        relativePath,
        mimeType: mime,
        sizeBytes,
        storageKind: "workspace",
        sha256: contentHash,
        indexState: "pending",
      };
    } catch (error) {
      await rm(tempPath, { force: true });
      this.updateOperation(operationId, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Restore a private immutable object as a new normal file without replacing anything. */
  async createFileFromObject(
    objectId: string,
    destinationPath: string,
    source = "rollback",
  ): Promise<ContentEntry> {
    const relativePath = normalizeRelativePath(destinationPath);
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await mkdir(path.dirname(destination), { recursive: true });
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await assertDestinationAbsent(destination);
    const fileId = randomUUID();
    const operationId = this.prepareOperation("restore_copy", fileId, null, relativePath, null, null);
    try {
      const restored = await this.objects.restoreTo(objectId, destination);
      await syncDirectory(path.dirname(destination));
      this.updateOperation(operationId, "filesystem_committed", restored.sha256);
      const fileStat = await lstat(destination, { bigint: true });
      const mime = mimeForName(relativePath);
      this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO files(
             id, name, mime_type, size_bytes, source, original_bytes, storage_kind,
             relative_path, path_key, content_sha256, mtime_ns, fs_identity, index_state, last_seen_at
           ) VALUES (?, ?, ?, ?, ?, NULL, 'workspace', ?, ?, ?, ?, ?, 'pending',
             strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        ).run(
          fileId,
          path.basename(relativePath),
          mime,
          restored.sizeBytes,
          source,
          relativePath,
          pathKey(relativePath),
          restored.sha256,
          Number(fileStat.mtimeNs),
          `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`,
        );
        this.updateOperation(operationId, "database_committed", restored.sha256);
      })();
      this.updateOperation(operationId, "completed", restored.sha256);
      return {
        fileId,
        name: path.basename(relativePath),
        relativePath,
        mimeType: mime,
        sizeBytes: restored.sizeBytes,
        storageKind: "workspace",
        sha256: restored.sha256,
        indexState: "pending",
      };
    } catch (error) {
      await rm(destination, { force: true });
      this.updateOperation(operationId, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async move(fileId: string, destinationPath: string, expectedHash?: string): Promise<void> {
    const row = this.fileRow(fileId);
    const oldRelative = normalizeRelativePath(row.relative_path);
    const newRelative = normalizeRelativePath(destinationPath);
    const oldPath = resolveWorkspacePath(this.rootPath, oldRelative);
    const newPath = resolveWorkspacePath(this.rootPath, newRelative);
    if (oldRelative === newRelative) return;
    await assertNoSymlinkSegments(this.rootPath, oldRelative);
    await assertNoSymlinkSegments(this.rootPath, newRelative, true);
    const oldHash = await this.verifyExpected(oldPath, expectedHash);
    const operationId = this.prepareOperation("move", fileId, oldRelative, newRelative, oldHash, null);
    try {
      await mkdir(path.dirname(newPath), { recursive: true });
      await assertNoSymlinkSegments(this.rootPath, newRelative, true);
      await assertDestinationAbsent(newPath);
      await rename(oldPath, newPath);
      this.updateOperation(operationId, "filesystem_committed", oldHash);
      this.db.transaction(() => {
        this.db.prepare(
          `UPDATE files SET name = ?, relative_path = ?, path_key = ?,
             last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
        ).run(path.basename(newRelative), newRelative, pathKey(newRelative), fileId);
        this.updateOperation(operationId, "database_committed", oldHash);
      })();
      this.updateOperation(operationId, "completed", oldHash);
    } catch (error) {
      this.updateOperation(operationId, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async snapshot(fileId: string, ownerType = "file", ownerId = fileId, role = "version"): Promise<ContentObjectRef> {
    const row = this.fileRow(fileId);
    const object = await this.objects.putFile(resolveWorkspacePath(this.rootPath, row.relative_path));
    this.objects.addReference(ownerType, ownerId, object.id, role);
    return object;
  }

  async trash(fileId: string, expectedHash?: string): Promise<void> {
    const row = this.fileRow(fileId);
    const filePath = resolveWorkspacePath(this.rootPath, row.relative_path);
    const actual = await this.verifyExpected(filePath, expectedHash);
    const object = await this.snapshot(fileId, "trash", fileId, "content");
    const operationId = this.prepareOperation("trash", fileId, row.relative_path, null, actual, null);
    try {
      await rm(filePath);
      this.updateOperation(operationId, "filesystem_committed", actual);
      this.db.transaction(() => {
        this.db.prepare(
          `UPDATE files SET trashed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             trashed_by = 'user', index_state = 'offline' WHERE id = ?`,
        ).run(fileId);
        this.objects.addReference("trash", fileId, object.id, "content");
        this.updateOperation(operationId, "database_committed", actual);
      })();
      this.updateOperation(operationId, "completed", actual);
    } catch (error) {
      this.updateOperation(operationId, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async restore(fileId: string, destinationPath?: string): Promise<void> {
    const row = this.db.prepare(
      `SELECT id, relative_path FROM files WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NOT NULL`,
    ).get(fileId) as { id: string; relative_path: string } | undefined;
    if (row === undefined) throw new Error("That file is not in Arcelle Trash.");
    const relativePath = normalizeRelativePath(destinationPath ?? row.relative_path);
    const object = this.db.prepare(
      `SELECT r.object_id FROM content_object_refs r
       WHERE r.owner_type = 'trash' AND r.owner_id = ? AND r.role = 'content'
       ORDER BY rowid DESC LIMIT 1`,
    ).get(fileId) as { object_id: string } | undefined;
    if (object === undefined) throw new Error("The deleted file has no recoverable content object.");
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await mkdir(path.dirname(destination), { recursive: true });
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await assertDestinationAbsent(destination);
    const operationId = this.prepareOperation("restore", fileId, null, relativePath, null, null);
    try {
      const restored = await this.objects.restoreTo(object.object_id, destination);
      this.updateOperation(operationId, "filesystem_committed", restored.sha256);
      const fileStat = await lstat(destination, { bigint: true });
      this.db.transaction(() => {
        clearChunks(this.db, fileId);
        this.db.prepare(
          `UPDATE files SET name = ?, relative_path = ?, path_key = ?, content_sha256 = ?,
             size_bytes = ?, mtime_ns = ?, fs_identity = ?, trashed_at = NULL,
             trashed_by = NULL, trashed_by_id = NULL, extracted_text = NULL,
             ai_summary = NULL, index_state = 'stale',
             last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
        ).run(
          path.basename(relativePath), relativePath, pathKey(relativePath), restored.sha256,
          restored.sizeBytes, Number(fileStat.mtimeNs),
          `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`, fileId,
        );
        this.updateOperation(operationId, "database_committed", restored.sha256);
      })();
      this.updateOperation(operationId, "completed", restored.sha256);
    } catch (error) {
      this.updateOperation(operationId, "failed", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async reconcile(): Promise<{ added: number; changed: number; missing: number; renamed: number }> {
    const rows = this.db.prepare(
      `SELECT id, name, relative_path, path_key, content_sha256, size_bytes, mtime_ns, fs_identity,
              index_state
       FROM files WHERE storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).all() as Array<WorkspaceFileRow & {
      path_key: string;
      mtime_ns: number | null;
      fs_identity: string | null;
    }>;
    const trustedEntries = new Map(
      rows.flatMap((row) => row.content_sha256 !== null && row.mtime_ns !== null && row.fs_identity !== null
        ? [[row.path_key, {
          sizeBytes: row.size_bytes,
          mtimeNs: row.mtime_ns,
          sha256: row.content_sha256,
          fsIdentity: row.fs_identity,
        }] as const]
        : []),
    );
    const manifest = await scanWorkspaceManifest(this.rootPath, { trustedEntries });
    const byKey = new Map(rows.map((row) => [row.path_key, row]));
    const unmatchedRows = new Map(rows.map((row) => [row.id, row]));
    const unmatchedEntries = new Map(manifest);
    let changed = 0;
    let renamed = 0;

    for (const [key, entry] of manifest) {
      const row = byKey.get(key);
      if (row === undefined) continue;
      unmatchedRows.delete(row.id);
      unmatchedEntries.delete(key);
      if (row.content_sha256 !== entry.sha256 || row.size_bytes !== entry.sizeBytes) changed += 1;
      this.updateManifestRow(row.id, entry, this.reconciledIndexState(row, entry.sha256));
    }

    // An identity+hash pair is strong enough to call an external move. Hash
    // alone is intentionally not enough when duplicate files exist.
    for (const [id, row] of [...unmatchedRows]) {
      const candidates = [...unmatchedEntries.values()].filter(
        (entry) => entry.fsIdentity === row.fs_identity && entry.sha256 === row.content_sha256,
      );
      if (candidates.length !== 1) continue;
      const entry = candidates[0]!;
      this.updateManifestRow(id, entry, this.reconciledIndexState(row, entry.sha256));
      unmatchedRows.delete(id);
      unmatchedEntries.delete(entry.pathKey);
      renamed += 1;
    }

    // Synced filesystems may replace the inode during a rename. Hash-only is
    // safe only when both sides are unique; identical files stay ambiguous.
    for (const [id, row] of [...unmatchedRows]) {
      if (row.content_sha256 === null) continue;
      const sourceMatches = [...unmatchedRows.values()].filter(
        (candidate) => candidate.content_sha256 === row.content_sha256 && candidate.size_bytes === row.size_bytes,
      );
      const destinationMatches = [...unmatchedEntries.values()].filter(
        (entry) => entry.sha256 === row.content_sha256 && entry.sizeBytes === row.size_bytes,
      );
      if (sourceMatches.length !== 1 || destinationMatches.length !== 1) continue;
      const entry = destinationMatches[0]!;
      this.updateManifestRow(id, entry, this.reconciledIndexState(row, entry.sha256));
      unmatchedRows.delete(id);
      unmatchedEntries.delete(entry.pathKey);
      renamed += 1;
    }

    for (const entry of unmatchedEntries.values()) this.insertManifestEntry(entry);
    for (const row of unmatchedRows.values()) {
      this.db.transaction(() => {
        clearChunks(this.db, row.id);
        this.db.prepare("UPDATE files SET index_state = 'offline' WHERE id = ?").run(row.id);
      })();
    }
    return { added: unmatchedEntries.size, changed, missing: unmatchedRows.size, renamed };
  }

  private reconciledIndexState(row: WorkspaceFileRow, sha256: string): string {
    if (row.content_sha256 !== sha256 || row.index_state === "offline") return "stale";
    return row.index_state ?? "stale";
  }

  private updateManifestRow(fileId: string, entry: ManifestEntry, state: string): void {
    this.db.transaction(() => {
      if (state === "stale") clearChunks(this.db, fileId);
      this.db.prepare(
        `UPDATE files SET name = ?, relative_path = ?, path_key = ?, content_sha256 = ?,
           size_bytes = ?, mtime_ns = ?, fs_identity = ?, index_state = ?, index_error = NULL,
           extracted_text = CASE WHEN ? = 'stale' THEN NULL ELSE extracted_text END,
           ai_summary = CASE WHEN ? = 'stale' THEN NULL ELSE ai_summary END,
           last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
      ).run(
        path.basename(entry.relativePath), entry.relativePath, entry.pathKey, entry.sha256,
        entry.sizeBytes, entry.mtimeNs, entry.fsIdentity, state, state, state, fileId,
      );
    })();
  }

  private insertManifestEntry(entry: ManifestEntry): string {
    const fileId = randomUUID();
    try {
      this.db.prepare(
        `INSERT INTO files(
           id, name, mime_type, size_bytes, source, original_bytes, storage_kind, relative_path,
           path_key, content_sha256, mtime_ns, fs_identity, index_state, last_seen_at
         ) VALUES (?, ?, ?, ?, 'external', NULL, 'workspace', ?, ?, ?, ?, ?, 'pending',
           strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      ).run(
        fileId, path.basename(entry.relativePath), mimeForName(entry.relativePath), entry.sizeBytes,
        entry.relativePath, entry.pathKey, entry.sha256, entry.mtimeNs, entry.fsIdentity,
      );
      return fileId;
    } catch (error) {
      // A watcher hint, an explicit rescan, and a trusted import may overlap.
      // If another path won the insert race, keep its stable file ID and only
      // refresh its projection. Do not turn a harmless duplicate scan into a
      // UNIQUE-constraint failure.
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        const existing = this.db.prepare(
          `SELECT id FROM files
           WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key = ?`,
        ).get(entry.pathKey) as { id: string } | undefined;
        if (existing !== undefined) {
          const row = this.db.prepare(
            "SELECT content_sha256, index_state FROM files WHERE id = ?",
          ).get(existing.id) as WorkspaceFileRow;
          this.updateManifestRow(existing.id, entry, this.reconciledIndexState(row, entry.sha256));
          return existing.id;
        }
      }
      throw error;
    }
  }

  /** Mark interrupted operations for reconciliation; no guessed destructive repair. */
  recoverIncompleteOperations(): number {
    const result = this.db.prepare(
      `UPDATE fs_operations SET phase = 'failed', error = 'Interrupted; workspace reconciliation required',
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE phase NOT IN ('completed', 'failed')`,
    ).run();
    return result.changes;
  }
}
