import type Database from "better-sqlite3-multiple-ciphers";
import { Readable } from "node:stream";
import {
  getFileFull,
  getFileMeta,
  insertFile,
  setFileExtractedText,
  type FileMeta,
} from "../db-host/files.js";
import { snapshotFileVersion } from "../db-host/versions.js";
import { updateFileContent } from "../db-host/files.js";
import { WorkspaceService } from "./workspaceService.js";

export interface RoomContentHandle {
  db: Database.Database;
  /** Legacy database path or workspace root folder. */
  path: string;
}

export interface RoomFileContent {
  name: string;
  mimeType: string | null;
  bytes: Buffer | null;
  extractedText: string | null;
  storageKind: "blob" | "workspace";
}

function storageKind(db: Database.Database, fileId: string): "blob" | "workspace" {
  const row = db.prepare(
    "SELECT storage_kind FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(fileId) as { storage_kind: string | null } | undefined;
  if (row === undefined) throw new Error("That file is no longer in this room.");
  return row.storage_kind === "workspace" ? "workspace" : "blob";
}

/** Read current bytes from the correct source of truth for either room format. */
export async function readRoomFile(
  room: RoomContentHandle,
  fileId: string,
): Promise<RoomFileContent> {
  const [name, mimeType, blobBytes, extractedText] = getFileFull(room.db, fileId);
  const kind = storageKind(room.db, fileId);
  if (kind === "blob") {
    return { name, mimeType, bytes: blobBytes, extractedText, storageKind: kind };
  }
  const bytes = await new WorkspaceService(room.db, room.path).readBuffer(fileId);
  return { name, mimeType, bytes, extractedText, storageKind: kind };
}

/**
 * Version and replace one existing file without ever putting workspace bytes
 * back in `files.original_bytes`.
 */
export async function writeRoomFile(
  room: RoomContentHandle,
  fileId: string,
  bytes: Uint8Array,
  extractedText: string | null,
  cause: string,
): Promise<FileMeta> {
  if (storageKind(room.db, fileId) === "blob") {
    room.db.transaction(() => {
      snapshotFileVersion(room.db, fileId, cause);
      updateFileContent(room.db, fileId, bytes, extractedText);
    })();
    return getFileMeta(room.db, fileId);
  }

  const workspace = new WorkspaceService(room.db, room.path);
  const current = room.db.prepare(
    "SELECT content_sha256 FROM files WHERE id = ? AND storage_kind = 'workspace'",
  ).get(fileId) as { content_sha256: string | null } | undefined;
  if (current === undefined) throw new Error("That workspace file is no longer in this room.");
  await workspace.snapshotVersion(fileId, cause);
  await workspace.writeAtomic(
    fileId,
    Readable.from([Buffer.from(bytes)]),
    current.content_sha256 ?? undefined,
  );
  if (extractedText !== null) setFileExtractedText(room.db, fileId, extractedText);
  return getFileMeta(room.db, fileId);
}

/** Create a live file in the correct store and return the compatibility row. */
export async function createRoomFile(
  room: RoomContentHandle,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  extractedText: string | null,
  source: string,
): Promise<FileMeta> {
  const workspaceRoom = room.db.prepare(
    "SELECT 1 FROM meta WHERE key = 'room_kind' AND value = 'workspace-folder'",
  ).get() !== undefined;
  if (!workspaceRoom) {
    return insertFile(room.db, name, mimeType, bytes, extractedText, source);
  }
  const entry = await new WorkspaceService(room.db, room.path).createFile(
    name,
    Readable.from([Buffer.from(bytes)]),
    source,
  );
  room.db.prepare("UPDATE files SET mime_type = ? WHERE id = ?").run(mimeType, entry.fileId);
  if (extractedText !== null) setFileExtractedText(room.db, entry.fileId, extractedText);
  return getFileMeta(room.db, entry.fileId);
}
