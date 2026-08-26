import type Database from "better-sqlite3-multiple-ciphers";
import type { Readable } from "node:stream";

export type RoomKind = "sealed-db" | "workspace-folder";
export type StorageKind = "blob" | "workspace";
export type IndexState =
  | "pending"
  | "ready"
  | "stale"
  | "offline"
  | "unsupported"
  | "failed";

export interface RoomDescriptor {
  kind: RoomKind;
  /** User-visible room path: a database file or the outer workspace folder. */
  path: string;
  /** SQLCipher database path used by the main process only. */
  dbPath: string;
  /** Normal-file root. Null for a legacy/sealed database room. */
  rootPath: string | null;
  roomId: string;
  formatVersion: number;
}

export interface WorkspaceMarker {
  format: "arcelle-workspace";
  formatVersion: 2;
  roomId: string;
}

export interface ContentEntry {
  fileId: string;
  name: string;
  relativePath: string | null;
  mimeType: string;
  sizeBytes: number;
  storageKind: StorageKind;
  sha256: string | null;
  indexState: IndexState;
}

export interface ContentStat {
  fileId: string;
  relativePath: string | null;
  sizeBytes: number;
  sha256: string;
  mtimeNs: number | null;
}

export interface WriteResult extends ContentStat {
  created: boolean;
}

export interface ContentObjectRef {
  id: string;
  sha256: string;
  sizeBytes: number;
}

/** Main-process content seam. Renderers and the sidecar never receive paths. */
export interface ContentStore {
  enumerate(): AsyncIterable<ContentEntry>;
  stat(fileId: string): Promise<ContentStat>;
  readStream(fileId: string): Promise<Readable>;
  writeAtomic(fileId: string, content: Readable, expectedHash?: string): Promise<WriteResult>;
  importFile(sourcePath: string, destination: string): Promise<ContentEntry>;
  move(fileId: string, destination: string, expectedHash?: string): Promise<void>;
  trash(fileId: string, expectedHash?: string): Promise<void>;
  restore(fileId: string, destination?: string): Promise<void>;
  createSnapshot(fileId: string): Promise<ContentObjectRef>;
}

export interface WorkspaceContext {
  descriptor: RoomDescriptor & { kind: "workspace-folder"; rootPath: string };
  db: Database.Database;
}

export interface ManifestEntry {
  relativePath: string;
  pathKey: string;
  sizeBytes: number;
  mtimeNs: number;
  sha256: string;
  fsIdentity: string;
}
