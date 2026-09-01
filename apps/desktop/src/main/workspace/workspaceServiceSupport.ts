import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceFileRow {
  id: string;
  name: string;
  mime_type: string | null;
  relative_path: string;
  content_sha256: string | null;
  size_bytes: number;
  index_state?: string;
}

export interface ReconciledWorkspaceFileRow extends WorkspaceFileRow {
  path_key: string;
  mtime_ns: number | null;
  fs_identity: string | null;
}

export interface ReconcileResult {
  added: number;
  changed: number;
  missing: number;
  renamed: number;
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

export interface LiveBlobFileRow {
  id: string;
  name: string;
  storage_kind: string | null;
  byte_length: number | null;
  folder_name: string | null;
}

export interface InterruptedLiveBlobRepair {
  operation_id: string;
  new_path: string;
  new_hash: string;
}

export interface LiveBlobPublication {
  operationId: string;
  destination: string;
  tempPath: string;
  contentHash: string | null;
  filesystemCommitted: boolean;
  databaseCommitted: boolean;
}

export type BigIntFileStat = Awaited<ReturnType<typeof lstat>> & {
  mtimeNs: bigint;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
};

export class ContentConflictError extends Error {
  readonly code = "CONTENT_CONFLICT";
  constructor(readonly expected: string, readonly actual: string) {
    super("The file changed after it was opened. Arcelle did not overwrite it.");
  }
}

/** One process can reach the same normal file through several service
 * instances (renderer autosave, native-agent reconciliation, MCP and the
 * compatibility layer all construct handles independently). Optimistic hash
 * checks only work when check + temporary write + rename are one serialized
 * operation: without this queue, two callers can both verify the old hash and
 * the slower, older write can rename last.
 *
 * Keyed by stable file id as well as room root so unrelated files retain full
 * concurrency. Entries remove themselves after the final queued writer. */
export const FILE_WRITE_QUEUES = new Map<string, Promise<void>>();

export async function serializeFileWrite<T>(
  rootPath: string,
  fileId: string,
  write: () => Promise<T>,
): Promise<T> {
  const key = `${path.resolve(rootPath)}\0${fileId}`;
  const previous = FILE_WRITE_QUEUES.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => current);
  FILE_WRITE_QUEUES.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await write();
  } finally {
    release();
    if (FILE_WRITE_QUEUES.get(key) === queued) FILE_WRITE_QUEUES.delete(key);
  }
}

export function mimeForName(name: string): string {
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

export async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some network filesystems do not allow opening a directory. The file was
    // still fsynced; reconciliation will detect any incomplete operation.
  }
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function assertDestinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("A file already exists at that destination.");
}

export function safeRecoveredComponent(raw: string, fallback: string): string {
  let value = path.basename(raw).normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (value === "" || value === "." || value === "..") value = fallback;
  if (value.toLocaleLowerCase("en-US") === ".arcelle") value = `${value}_file`;
  value = [...value].slice(0, 180).join("").replace(/[. ]+$/g, "");
  return value === "" ? fallback : value;
}
