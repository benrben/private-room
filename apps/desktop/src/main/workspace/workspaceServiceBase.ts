import type Database from "better-sqlite3-multiple-ciphers";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VERSIONS_KEPT } from "../db-host/versions.js";
import { clearChunks } from "../db-host/files.js";
import { ContentObjectStore } from "./contentObjects.js";
import { scanWorkspaceManifest, type TrustedManifestEntry } from "./manifest.js";
import {
  assertNoSymlinkSegments,
  normalizeRelativePath,
  pathKey,
  resolveWorkspacePath,
} from "./pathSafety.js";
import type { ContentEntry, ContentObjectRef, ManifestEntry, WriteResult } from "./types.js";

import {
  ContentConflictError,
  FILE_WRITE_QUEUES,
  assertDestinationAbsent,
  mimeForName,
  safeRecoveredComponent,
  serializeFileWrite,
  sha256,
  syncDirectory,
  syncFile,
  type BigIntFileStat,
  type InterruptedLiveBlobRepair,
  type LiveBlobFileRow,
  type LiveBlobPublication,
  type WorkspaceDirectoryState,
  type WorkspaceFileRow,
} from "./workspaceServiceSupport.js";

export class WorkspaceServiceBase {
  readonly objects: ContentObjectStore;
  protected reconcileRunning: Promise<{ added: number; changed: number; missing: number; renamed: number }> | null = null;
  protected reconcileAgain = false;

  constructor(
    readonly db: Database.Database,
    readonly rootPath: string,
    readonly privateRoot = path.join(rootPath, ".arcelle"),
  ) {
    if (lstatSync(rootPath).isSymbolicLink()) {
      throw new Error("A workspace room cannot use a symlink as its root folder.");
    }
    this.objects = new ContentObjectStore(db, privateRoot);
  }

  protected fileRow(fileId: string): WorkspaceFileRow {
    const row = this.db.prepare(
      `SELECT id, name, mime_type, relative_path, content_sha256, size_bytes
       FROM files WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).get(fileId) as WorkspaceFileRow | undefined;
    if (row === undefined) throw new Error("That workspace file is not in this room.");
    return row;
  }

  protected prepareOperation(
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

  protected updateOperation(operationId: string, phase: string, newHash?: string, error?: string): void {
    this.db.prepare(
      `UPDATE fs_operations SET phase = ?, new_hash = coalesce(?, new_hash), error = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE operation_id = ?`,
    ).run(phase, newHash ?? null, error ?? null, operationId);
  }

  protected async verifyExpected(filePath: string, expectedHash?: string): Promise<string> {
    const actual = await sha256(filePath);
    if (expectedHash !== undefined && actual !== expectedHash) {
      throw new ContentConflictError(expectedHash, actual);
    }
    return actual;
  }

  /**
   * Repair a live legacy/blob row that was accidentally created after a room
   * became a workspace. The stable file id and all private metadata stay on
   * the original row; only its current bytes move to the normal filesystem.
   */
  materializeLiveBlobFile(fileId: string): Promise<boolean> {
    // Path allocation and publication are room-wide. Serializing by file id
    // would let two old rows with the same name both select the same unused
    // destination before either one commits its path_key.
    return serializeFileWrite(
      this.rootPath,
      "__arcelle_live_blob_repair__",
      () => this.materializeLiveBlobFileSerialized(fileId),
    );
  }

  protected async materializeLiveBlobFileSerialized(fileId: string): Promise<boolean> {
    const row = this.materializableBlobRow(fileId);
    if (row === null) return false;
    if (await this.adoptInterruptedLiveBlobRepair(row)) return true;
    return this.materializeNewLiveBlobFile(row);
  }

  protected materializableBlobRow(fileId: string): LiveBlobFileRow | null {
    const row = this.db.prepare(
      `SELECT f.id, f.name, f.storage_kind, length(f.original_bytes) AS byte_length,
              fo.name AS folder_name
       FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE f.id = ? AND f.trashed_at IS NULL`,
    ).get(fileId) as LiveBlobFileRow | undefined;
    if (row === undefined) throw new Error("That file is no longer in this room.");
    if (row.storage_kind === "workspace") return null;
    if (row.byte_length === null) throw new Error("This database-only file has no recoverable current bytes.");
    return row;
  }

  protected commitMaterializedBlobRow(
    row: LiveBlobFileRow,
    operationId: string,
    relativePath: string,
    contentHash: string,
    fileStat: BigIntFileStat,
  ): void {
    this.db.transaction(() => {
      const updated = this.db.prepare(
        `UPDATE files SET name = ?, storage_kind = 'workspace', original_bytes = NULL,
           relative_path = ?, path_key = ?, content_sha256 = ?, size_bytes = ?,
           mtime_ns = ?, fs_identity = ?, index_state = CASE
             WHEN extracted_text IS NULL THEN 'pending' ELSE 'ready' END,
           index_error = NULL, last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ? AND trashed_at IS NULL
           AND (storage_kind IS NULL OR storage_kind <> 'workspace')`,
      ).run(
        path.posix.basename(relativePath),
        relativePath,
        pathKey(relativePath),
        contentHash,
        row.byte_length,
        Number(fileStat.mtimeNs),
        `${fileStat.dev}:${fileStat.ino}:${fileStat.birthtimeNs}`,
        row.id,
      );
      if (updated.changes !== 1) {
        throw new Error("The database-only file changed while it was being restored.");
      }
      this.updateOperation(operationId, "database_committed", contentHash);
    })();
  }

  protected interruptedLiveBlobRepair(fileId: string): InterruptedLiveBlobRepair | undefined {
    return this.db.prepare(
      `SELECT operation_id, new_path, new_hash
       FROM fs_operations
       WHERE operation_type = 'repair_live_blob' AND file_id = ?
         AND phase <> 'completed' AND new_path IS NOT NULL AND new_hash IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(fileId) as InterruptedLiveBlobRepair | undefined;
  }

  protected async adoptInterruptedLiveBlobRepair(row: LiveBlobFileRow): Promise<boolean> {
    const interrupted = this.interruptedLiveBlobRepair(row.id);
    if (interrupted === undefined) return false;
    try {
      const adopted = await this.adoptableInterruptedBlobFile(row, interrupted);
      if (adopted === null) {
        this.recordChangedInterruptedRepair(interrupted.operation_id);
        return false;
      }
      const relativePath = normalizeRelativePath(interrupted.new_path);
      this.commitMaterializedBlobRow(row, interrupted.operation_id, relativePath, interrupted.new_hash, adopted);
      this.updateOperation(interrupted.operation_id, "completed", interrupted.new_hash);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.recordUnsafeInterruptedRepair(interrupted.operation_id);
      }
      return false;
    }
  }

  protected async adoptableInterruptedBlobFile(
    row: LiveBlobFileRow,
    interrupted: InterruptedLiveBlobRepair,
  ): Promise<BigIntFileStat | null> {
    const relativePath = normalizeRelativePath(interrupted.new_path);
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath, false);
    const fileStat = await lstat(destination, { bigint: true }) as BigIntFileStat;
    if (!fileStat.isFile()) return null;
    if (Number(fileStat.size) !== row.byte_length) return null;
    if (await sha256(destination) !== interrupted.new_hash) return null;
    return fileStat;
  }

  protected recordChangedInterruptedRepair(operationId: string): void {
    this.updateOperation(
      operationId,
      "failed",
      undefined,
      "Interrupted repair destination changed; preserved it and selected a new path.",
    );
  }

  protected recordUnsafeInterruptedRepair(operationId: string): void {
    this.updateOperation(
      operationId,
      "failed",
      undefined,
      "Interrupted repair destination could not be safely adopted; preserved it and selected a new path.",
    );
  }

  protected async materializeNewLiveBlobFile(row: LiveBlobFileRow): Promise<boolean> {
    const relativePath = await this.availableLiveBlobPath(row);
    const publication = await this.prepareLiveBlobPublication(row.id, relativePath);
    try {
      publication.contentHash = await this.writeLiveBlobTemp(row, publication.tempPath);
      const fileStat = await this.publishLiveBlobTemp(publication);
      this.commitMaterializedBlobRow(row, publication.operationId, relativePath, publication.contentHash, fileStat);
      publication.databaseCommitted = true;
      this.updateOperation(publication.operationId, "completed", publication.contentHash);
      return true;
    } catch (error) {
      await this.cleanFailedLiveBlobPublication(publication);
      this.failOperation(publication.operationId, error);
      throw error;
    }
  }

  protected async availableLiveBlobPath(row: LiveBlobFileRow): Promise<string> {
    const desired = this.desiredLiveBlobPath(row);
    const extension = path.posix.extname(desired);
    const stem = desired.slice(0, desired.length - extension.length);
    const used = await this.usedWorkspacePaths();
    for (let number = 1; number <= 10_000; number += 1) {
      const candidate = number === 1 ? desired : `${stem} (${number})${extension}`;
      if (!used.has(pathKey(candidate))) return normalizeRelativePath(candidate);
    }
    throw new Error(`Could not create a unique workspace path for ${row.name}.`);
  }

  protected desiredLiveBlobPath(row: LiveBlobFileRow): string {
    const fileName = safeRecoveredComponent(row.name, `File-${row.id.slice(0, 8)}`);
    if (row.folder_name === null) return fileName;
    return `${safeRecoveredComponent(row.folder_name, "Recovered")}/${fileName}`;
  }

  protected async usedWorkspacePaths(): Promise<Set<string>> {
    const manifest = await scanWorkspaceManifest(this.rootPath);
    const used = new Set(manifest.keys());
    for (const item of this.db.prepare(
      `SELECT path_key FROM files
       WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key IS NOT NULL`,
    ).all() as Array<{ path_key: string }>) used.add(item.path_key);
    return used;
  }

  protected async prepareLiveBlobPublication(fileId: string, relativePath: string): Promise<LiveBlobPublication> {
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await mkdir(path.dirname(destination), { recursive: true });
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    await assertDestinationAbsent(destination);
    const operationId = this.prepareOperation("repair_live_blob", fileId, null, relativePath, null, null);
    return {
      operationId,
      destination,
      tempPath: path.join(path.dirname(destination), `.${path.basename(destination)}.arcelle-${randomUUID()}.tmp`),
      contentHash: null,
      filesystemCommitted: false,
      databaseCommitted: false,
    };
  }

  protected async writeLiveBlobTemp(row: LiveBlobFileRow, tempPath: string): Promise<string> {
    const digest = createHash("sha256");
    const observe = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(this.liveBlobChunks(row.id, row.byte_length!)),
      observe,
      createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
    await syncFile(tempPath);
    return digest.digest("hex");
  }

  protected async *liveBlobChunks(fileId: string, byteLength: number): AsyncGenerator<Buffer> {
    const readChunk = this.db.prepare("SELECT substr(original_bytes, ?, ?) AS chunk FROM files WHERE id = ?");
    const chunkBytes = 1024 * 1024;
    for (let offset = 0; offset < byteLength; offset += chunkBytes) {
      const found = readChunk.get(
        offset + 1,
        Math.min(chunkBytes, byteLength - offset),
        fileId,
      ) as { chunk: Buffer | null } | undefined;
      if (found?.chunk === null || found?.chunk === undefined) {
        throw new Error("The database-only file bytes disappeared during recovery.");
      }
      yield found.chunk;
    }
  }

  protected async publishLiveBlobTemp(publication: LiveBlobPublication): Promise<BigIntFileStat> {
    const contentHash = publication.contentHash!;
    this.updateOperation(publication.operationId, "prepared", contentHash);
    await link(publication.tempPath, publication.destination);
    publication.filesystemCommitted = true;
    await rm(publication.tempPath, { force: true });
    await syncDirectory(path.dirname(publication.destination));
    const fileStat = await lstat(publication.destination, { bigint: true }) as BigIntFileStat;
    this.updateOperation(publication.operationId, "filesystem_committed", contentHash);
    return fileStat;
  }

  protected async cleanFailedLiveBlobPublication(publication: LiveBlobPublication): Promise<void> {
    await rm(publication.tempPath, { force: true });
    if (!publication.filesystemCommitted || publication.databaseCommitted || publication.contentHash === null) return;
    await this.removeUncommittedLiveBlob(publication.destination, publication.contentHash);
  }

  protected async removeUncommittedLiveBlob(destination: string, contentHash: string): Promise<void> {
    try {
      if (await sha256(destination) === contentHash) await rm(destination, { force: true });
    } catch { /* Preserve missing or externally changed destinations for recovery. */ }
  }

  protected failOperation(operationId: string, error: unknown): void {
    this.updateOperation(operationId, "failed", undefined, error instanceof Error ? error.message : String(error));
  }

  async materializeLiveBlobFiles(): Promise<number> {
    const rows = this.db.prepare(
      `SELECT id FROM files
       WHERE trashed_at IS NULL
         AND (storage_kind IS NULL OR storage_kind <> 'workspace')
         AND original_bytes IS NOT NULL
       ORDER BY rowid`,
    ).all() as Array<{ id: string }>;
    let repaired = 0;
    for (const row of rows) {
      if (await this.materializeLiveBlobFile(row.id)) repaired += 1;
    }
    return repaired;
  }

  /** Inspect a normal workspace directory without exposing an absolute path. */
  async directoryState(directoryPath: string): Promise<WorkspaceDirectoryState> {
    const relativePath = normalizeRelativePath(directoryPath);
    const destination = resolveWorkspacePath(this.rootPath, relativePath);
    await assertNoSymlinkSegments(this.rootPath, relativePath, true);
    const stat = await this.workspaceDirectoryStat(destination);
    if (stat === null) return this.missingDirectoryState(relativePath);
    this.assertNormalDirectory(stat);
    const entries = await this.workspaceDirectoryEntries(destination);
    if (entries === null) return this.missingDirectoryState(relativePath);
    return {
      relativePath,
      exists: true,
      empty: entries.length === 0,
      fsIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
    };
  }

  protected missingDirectoryState(relativePath: string): WorkspaceDirectoryState {
    return { relativePath, exists: false, empty: true, fsIdentity: null };
  }

  protected async workspaceDirectoryStat(destination: string): Promise<BigIntFileStat | null> {
    try {
      return await lstat(destination, { bigint: true }) as BigIntFileStat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  protected assertNormalDirectory(stat: BigIntFileStat): void {
    if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in managed room paths.");
    if (!stat.isDirectory()) throw new Error("A normal file already exists at that folder path.");
  }

  protected async workspaceDirectoryEntries(destination: string): Promise<string[] | null> {
    try {
      return await readdir(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
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
    return this.removeKnownEmptyDirectory(before);
  }

  protected async removeKnownEmptyDirectory(before: WorkspaceDirectoryState): Promise<boolean> {
    const destination = resolveWorkspacePath(this.rootPath, before.relativePath);
    const operationId = this.prepareOperation(
      "remove_directory", null, before.relativePath, null, null, null,
    );
    try {
      const removed = await this.removeVerifiedEmptyDirectory(before, destination);
      if (removed) await syncDirectory(path.dirname(destination));
      this.completeOperation(operationId);
      return removed;
    } catch (error) {
      this.failOperation(operationId, error);
      throw error;
    }
  }

  protected async removeVerifiedEmptyDirectory(
    before: WorkspaceDirectoryState,
    destination: string,
  ): Promise<boolean> {
    const current = await this.directoryState(before.relativePath);
    if (!current.exists) return false;
    if (current.fsIdentity !== before.fsIdentity) {
      throw new Error("The folder changed before it could be removed.");
    }
    if (!current.empty) throw new Error("The folder is not empty and was not removed.");
    return this.removeDirectoryAt(destination);
  }

  protected async removeDirectoryAt(destination: string): Promise<boolean> {
    try {
      await rmdir(destination);
      return true;
    } catch (error) {
      return this.removalResult(error);
    }
  }

  protected removalResult(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      throw new Error("The folder is not empty and was not removed.");
    }
    throw error;
  }

  protected completeOperation(operationId: string): void {
    this.updateOperation(operationId, "filesystem_committed");
    this.updateOperation(operationId, "database_committed");
    this.updateOperation(operationId, "completed");
  }
}
