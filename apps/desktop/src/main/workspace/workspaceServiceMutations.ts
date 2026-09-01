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

import { WorkspaceServiceVersions } from "./workspaceServiceVersions.js";
import {
  assertDestinationAbsent,
  mimeForName,
  serializeFileWrite,
  sha256,
  syncDirectory,
  type WorkspaceFileRow,
} from "./workspaceServiceSupport.js";

export class WorkspaceServiceMutations extends WorkspaceServiceVersions {
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

}
