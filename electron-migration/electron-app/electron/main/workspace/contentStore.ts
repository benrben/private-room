import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  getFileBytes,
  insertFile,
  listFiles,
  restoreFile,
  trashFile,
  updateFileContent,
} from "../db-host/files.js";
import { sha256Bytes } from "./hash.js";
import type {
  ContentEntry,
  ContentObjectRef,
  ContentStat,
  ContentStore,
  WriteResult,
} from "./types.js";
import { WorkspaceService } from "./workspaceService.js";

async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    total += chunk.length;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function blobEntry(meta: ReturnType<typeof listFiles>[number]): ContentEntry {
  return {
    fileId: meta.id,
    name: meta.name,
    relativePath: null,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    storageKind: "blob",
    sha256: null,
    indexState: "ready",
  };
}

/** Exact compatibility wrapper for current single-database rooms. */
export class BlobContentStore implements ContentStore {
  constructor(private readonly db: Database.Database) {}

  async *enumerate(): AsyncIterable<ContentEntry> {
    for (const meta of listFiles(this.db)) yield blobEntry(meta);
  }

  async stat(fileId: string): Promise<ContentStat> {
    const bytes = getFileBytes(this.db, fileId);
    if (bytes === null) throw new Error("That file has no saved bytes.");
    return {
      fileId,
      relativePath: null,
      sizeBytes: bytes.length,
      sha256: sha256Bytes(bytes),
      mtimeNs: null,
    };
  }

  async readStream(fileId: string): Promise<Readable> {
    const bytes = getFileBytes(this.db, fileId);
    if (bytes === null) throw new Error("That file has no saved bytes.");
    return Readable.from([bytes]);
  }

  async writeAtomic(fileId: string, content: Readable, expectedHash?: string): Promise<WriteResult> {
    const current = await this.stat(fileId);
    if (expectedHash !== undefined && current.sha256 !== expectedHash) {
      throw new Error("The file changed after it was opened. Arcelle did not overwrite it.");
    }
    const bytes = await streamBytes(content);
    updateFileContent(this.db, fileId, bytes, null);
    return {
      fileId,
      relativePath: null,
      sizeBytes: bytes.length,
      sha256: sha256Bytes(bytes),
      mtimeNs: null,
      created: false,
    };
  }

  async importFile(sourcePath: string, destination: string): Promise<ContentEntry> {
    const bytes = await readFile(sourcePath);
    const meta = insertFile(
      this.db,
      path.basename(destination),
      "application/octet-stream",
      bytes,
      null,
      "upload",
    );
    return blobEntry(meta);
  }

  async move(fileId: string, destination: string, expectedHash?: string): Promise<void> {
    if (expectedHash !== undefined) {
      const current = await this.stat(fileId);
      if (current.sha256 !== expectedHash) throw new Error("The file changed after it was opened.");
    }
    this.db.prepare("UPDATE files SET name = ?, artifact_key = NULL WHERE id = ? AND trashed_at IS NULL")
      .run(path.basename(destination), fileId);
  }

  async trash(fileId: string, expectedHash?: string): Promise<void> {
    if (expectedHash !== undefined) {
      const current = await this.stat(fileId);
      if (current.sha256 !== expectedHash) throw new Error("The file changed after it was opened.");
    }
    trashFile(this.db, fileId, { kind: "user" });
  }

  async restore(fileId: string): Promise<void> {
    restoreFile(this.db, fileId);
  }

  async createSnapshot(fileId: string): Promise<ContentObjectRef> {
    const bytes = getFileBytes(this.db, fileId);
    if (bytes === null) throw new Error("That file has no saved bytes.");
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO file_versions(id, file_id, bytes, cause) VALUES (?, ?, ?, 'harness baseline')`,
    ).run(id, fileId, bytes);
    return { id, sha256: sha256Bytes(bytes), sizeBytes: bytes.length };
  }
}

/** Normal-file implementation backed by WorkspaceService safety and journal. */
export class WorkspaceContentStore implements ContentStore {
  constructor(private readonly workspace: WorkspaceService) {}

  async *enumerate(): AsyncIterable<ContentEntry> {
    const rows = this.workspace.db.prepare(
      `SELECT id, name, mime_type, size_bytes, relative_path, content_sha256, index_state
       FROM files WHERE storage_kind = 'workspace' AND trashed_at IS NULL ORDER BY created_at DESC`,
    ).all() as Array<{
      id: string;
      name: string;
      mime_type: string | null;
      size_bytes: number;
      relative_path: string;
      content_sha256: string | null;
      index_state: ContentEntry["indexState"];
    }>;
    for (const row of rows) {
      yield {
        fileId: row.id,
        name: row.name,
        relativePath: row.relative_path,
        mimeType: row.mime_type ?? "",
        sizeBytes: row.size_bytes,
        storageKind: "workspace",
        sha256: row.content_sha256,
        indexState: row.index_state,
      };
    }
  }

  async stat(fileId: string): Promise<ContentStat> {
    const row = this.workspace.db.prepare(
      `SELECT relative_path, size_bytes, content_sha256, mtime_ns
       FROM files WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL`,
    ).get(fileId) as {
      relative_path: string;
      size_bytes: number;
      content_sha256: string | null;
      mtime_ns: number | null;
    } | undefined;
    if (row === undefined || row.content_sha256 === null) throw new Error("That workspace file is not indexed.");
    return {
      fileId,
      relativePath: row.relative_path,
      sizeBytes: row.size_bytes,
      sha256: row.content_sha256,
      mtimeNs: row.mtime_ns,
    };
  }

  async readStream(fileId: string): Promise<Readable> {
    return this.workspace.readStream(fileId);
  }

  writeAtomic(fileId: string, content: Readable, expectedHash?: string): Promise<WriteResult> {
    return this.workspace.writeAtomic(fileId, content, expectedHash);
  }

  importFile(sourcePath: string, destination: string): Promise<ContentEntry> {
    return this.workspace.importFile(sourcePath, destination);
  }

  move(fileId: string, destination: string, expectedHash?: string): Promise<void> {
    return this.workspace.move(fileId, destination, expectedHash);
  }

  trash(fileId: string, expectedHash?: string): Promise<void> {
    return this.workspace.trash(fileId, expectedHash);
  }

  restore(fileId: string, destination?: string): Promise<void> {
    return this.workspace.restore(fileId, destination);
  }

  createSnapshot(fileId: string): Promise<ContentObjectRef> {
    return this.workspace.snapshot(fileId);
  }
}

export function contentStoreFor(
  db: Database.Database,
  workspaceRoot: string | null,
): ContentStore {
  return workspaceRoot === null
    ? new BlobContentStore(db)
    : new WorkspaceContentStore(new WorkspaceService(db, workspaceRoot));
}
