import { stat } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { scanWorkspaceManifest } from "./manifest.js";
import type { RoomDescriptor } from "./types.js";

export interface RoomStorageUsage {
  kind: "legacy" | "workspace";
  /** Logical current content bytes. Normal files for workspaces, BLOBs for legacy rooms. */
  liveFileBytes: number;
  /** Physical SQLCipher database plus active WAL/SHM sidecars. */
  databaseBytes: number;
  /** Physical encrypted object files, or logical legacy version BLOB bytes. */
  privateHistoryBytes: number;
  /** Actual Arcelle-managed disk bytes, without double-counting legacy BLOBs inside the DB. */
  totalOnDiskBytes: number;
}

export interface StorageUsageRoom {
  conn: Database.Database;
  path: string;
  descriptor?: RoomDescriptor;
}

async function fileSize(filePath: string): Promise<number> {
  try { return (await stat(filePath)).size; } catch { return 0; }
}

async function databaseDiskBytes(dbPath: string): Promise<number> {
  return (await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(fileSize)))
    .reduce((total, size) => total + size, 0);
}

export async function roomStorageUsage(room: StorageUsageRoom): Promise<RoomStorageUsage> {
  if (room.descriptor?.kind === "workspace-folder" && room.descriptor.rootPath !== null) {
    const manifest = await scanWorkspaceManifest(room.descriptor.rootPath);
    const liveFileBytes = [...manifest.values()].reduce((total, entry) => total + entry.sizeBytes, 0);
    const databaseBytes = await databaseDiskBytes(room.descriptor.dbPath);
    const objects = room.conn.prepare(
      "SELECT relative_object_path FROM content_objects",
    ).all() as Array<{ relative_object_path: string }>;
    const privateRoot = path.dirname(room.descriptor.dbPath);
    const privateHistoryBytes = (await Promise.all(objects.map((object) =>
      fileSize(path.join(privateRoot, ...object.relative_object_path.split("/"))),
    ))).reduce((total, size) => total + size, 0);
    return {
      kind: "workspace",
      liveFileBytes,
      databaseBytes,
      privateHistoryBytes,
      totalOnDiskBytes: liveFileBytes + databaseBytes + privateHistoryBytes,
    };
  }

  const live = room.conn.prepare(
    "SELECT coalesce(sum(length(original_bytes)), 0) AS bytes FROM files WHERE trashed_at IS NULL",
  ).get() as { bytes: number };
  const history = room.conn.prepare(
    "SELECT coalesce(sum(length(bytes)), 0) AS bytes FROM file_versions",
  ).get() as { bytes: number };
  const databaseBytes = await databaseDiskBytes(room.descriptor?.dbPath ?? room.path);
  return {
    kind: "legacy",
    liveFileBytes: live.bytes,
    databaseBytes,
    privateHistoryBytes: history.bytes,
    totalOnDiskBytes: databaseBytes,
  };
}
