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

import { WorkspaceServiceBase } from "./workspaceServiceBase.js";
import {
  ContentConflictError,
  serializeFileWrite,
  sha256,
  syncDirectory,
  syncFile,
  type WorkspaceFileRow,
  type WorkspaceVersionSnapshot,
} from "./workspaceServiceSupport.js";

export class WorkspaceServiceVersions extends WorkspaceServiceBase {
  readStream(fileId: string, range?: { start: number; end: number }): Readable {
    const row = this.fileRow(fileId);
    const filePath = resolveWorkspacePath(this.rootPath, row.relative_path);
    return range === undefined
      ? createReadStream(filePath)
      : createReadStream(filePath, { start: range.start, end: range.end });
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
    return serializeFileWrite(this.rootPath, fileId, () =>
      this.writeAtomicUnlocked(fileId, content, expectedHash, agentRunId));
  }

  protected async writeAtomicUnlocked(
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

}
