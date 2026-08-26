import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom, openRoom, openRoomReadonly } from "../db-host/open.js";
import { migrate } from "../db-host/migrate.js";
import { setMeta } from "../db-host/meta.js";
import { PRIVATE_DIR } from "./pathSafety.js";
import type { RoomDescriptor, WorkspaceMarker } from "./types.js";

export const WORKSPACE_FORMAT_VERSION = 2 as const;
export const MARKER_FILE = "room.json";
export const DATABASE_FILE = "room.db";
export const OBJECTS_DIR = "objects";
export const TEMP_DIR = "tmp";
export const LOCK_FILE = "room.lock";

export interface WorkspaceLease {
  token: string;
  lockPath: string;
  renewal: ReturnType<typeof setInterval>;
}

export const REMOTE_LEASE_STALE_MS = 5 * 60_000;

export class WorkspaceLeaseConflictError extends Error {
  readonly code = "WORKSPACE_LEASE_CONFLICT";
  constructor(readonly remote: boolean) {
    super(remote
      ? "This synced room appears to be open on another device. It was opened read-only."
      : "This room is already open for writing in another Arcelle process. It was opened read-only.");
  }
}

function privatePath(rootPath: string, child: string): string {
  return path.join(rootPath, PRIVATE_DIR, child);
}

export function readWorkspaceMarker(rootPath: string): WorkspaceMarker {
  const markerPath = privatePath(rootPath, MARKER_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("This folder is not an Arcelle workspace.");
  }
  const marker = parsed as Partial<WorkspaceMarker>;
  if (
    marker.format !== "arcelle-workspace" ||
    marker.formatVersion !== WORKSPACE_FORMAT_VERSION ||
    typeof marker.roomId !== "string" ||
    marker.roomId.length < 8
  ) {
    throw new Error("This folder uses an unsupported Arcelle workspace format.");
  }
  return marker as WorkspaceMarker;
}

export function describeRoom(targetPath: string): RoomDescriptor {
  const resolved = path.resolve(targetPath);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    const marker = readWorkspaceMarker(resolved);
    return {
      kind: "workspace-folder",
      path: resolved,
      rootPath: resolved,
      dbPath: privatePath(resolved, DATABASE_FILE),
      roomId: marker.roomId,
      formatVersion: marker.formatVersion,
    };
  }
  return {
    kind: "sealed-db",
    path: resolved,
    rootPath: null,
    dbPath: resolved,
    roomId: resolved,
    formatVersion: 1,
  };
}

/** Create a complete workspace in a sibling temp directory, then publish it. */
export function createWorkspaceRoom(
  rootPath: string,
  password: string,
  displayName: string,
): { descriptor: RoomDescriptor & { kind: "workspace-folder"; rootPath: string }; db: Database.Database } {
  const resolved = path.resolve(rootPath);
  if (existsSync(resolved)) throw new Error("A file or folder already exists at this location.");
  const parent = path.dirname(resolved);
  mkdirSync(parent, { recursive: true });
  const tempRoot = path.join(parent, `.${path.basename(resolved)}.arcelle-${randomUUID()}.tmp`);
  const privateRoot = path.join(tempRoot, PRIVATE_DIR);
  const roomId = randomUUID();
  let db: Database.Database | null = null;
  try {
    mkdirSync(path.join(privateRoot, OBJECTS_DIR), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(privateRoot, TEMP_DIR), { recursive: true, mode: 0o700 });
    const dbPath = path.join(privateRoot, DATABASE_FILE);
    db = createRoom(dbPath, password, displayName);
    migrate(db);
    setMeta(db, "room_kind", "workspace-folder");
    setMeta(db, "workspace_room_id", roomId);
    setMeta(db, "workspace_format_version", String(WORKSPACE_FORMAT_VERSION));
    const marker: WorkspaceMarker = {
      format: "arcelle-workspace",
      formatVersion: WORKSPACE_FORMAT_VERSION,
      roomId,
    };
    writeFileSync(path.join(privateRoot, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    db.close();
    db = null;
    renameSync(tempRoot, resolved);
    const descriptor = describeRoom(resolved) as RoomDescriptor & {
      kind: "workspace-folder";
      rootPath: string;
    };
    const reopened = openRoom(descriptor.dbPath, password);
    migrate(reopened);
    return { descriptor, db: reopened };
  } catch (error) {
    try { db?.close(); } catch { /* best effort */ }
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export function openWorkspaceRoom(
  rootPath: string,
  password: string,
  readOnly = false,
): { descriptor: RoomDescriptor & { kind: "workspace-folder"; rootPath: string }; db: Database.Database } {
  const descriptor = describeRoom(rootPath);
  if (descriptor.kind !== "workspace-folder" || descriptor.rootPath === null) {
    throw new Error("This path is not an Arcelle workspace folder.");
  }
  const db = readOnly
    ? openRoomReadonly(descriptor.dbPath, password)
    : openRoom(descriptor.dbPath, password);
  if (!readOnly) migrate(db);
  return { descriptor: descriptor as typeof descriptor & { kind: "workspace-folder"; rootPath: string }, db };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireWorkspaceLease(rootPath: string): WorkspaceLease {
  readWorkspaceMarker(rootPath);
  const lockPath = privatePath(rootPath, LOCK_FILE);
  const token = randomUUID();
  const record = () => ({
    token,
    pid: process.pid,
    host: os.hostname(),
    rootPath: path.resolve(rootPath),
    createdAt: new Date().toISOString(),
    renewedAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(record())}\n`, "utf8"); } finally { closeSync(fd); }
      const lease = { token, lockPath } as WorkspaceLease;
      lease.renewal = setInterval(() => {
        try {
          const existing = JSON.parse(readFileSync(lease.lockPath, "utf8")) as { token?: string };
          if (existing.token === token) {
            writeFileSync(lease.lockPath, `${JSON.stringify(record())}\n`, { encoding: "utf8", mode: 0o600 });
          }
        } catch {
          // A missing lease is handled as a lost lease by the next open or
          // write lifecycle. Renewal never recreates a lock it no longer owns.
        }
      }, Math.floor(REMOTE_LEASE_STALE_MS / 3));
      lease.renewal.unref?.();
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: {
        pid?: number;
        host?: string;
        rootPath?: string;
        renewedAt?: string;
        createdAt?: string;
      } = {};
      try { existing = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* stale/corrupt */ }
      // Finder copies `.arcelle/room.lock` together with the room. A lock
      // explicitly naming another root never owns this copied folder.
      if (existing.rootPath !== undefined && path.resolve(existing.rootPath) !== path.resolve(rootPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (existing.host === os.hostname() && processIsAlive(Number(existing.pid))) {
        throw new WorkspaceLeaseConflictError(false);
      }
      if (existing.host !== undefined && existing.host !== os.hostname()) {
        const renewed = Date.parse(existing.renewedAt ?? existing.createdAt ?? "");
        if (Number.isFinite(renewed) && Date.now() - renewed <= REMOTE_LEASE_STALE_MS) {
          throw new WorkspaceLeaseConflictError(true);
        }
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("Could not acquire the room write lease.");
}

/** Give a raw Finder copy a new identity after the user explicitly registers it. */
export function registerWorkspaceCopyIdentity(
  rootPath: string,
  password: string,
): { descriptor: RoomDescriptor & { kind: "workspace-folder"; rootPath: string }; db: Database.Database } {
  const descriptor = describeRoom(rootPath);
  if (descriptor.kind !== "workspace-folder" || descriptor.rootPath === null) {
    throw new Error("This path is not an Arcelle workspace folder.");
  }
  const oldMarker = readWorkspaceMarker(rootPath);
  const newRoomId = randomUUID();
  const markerPath = privatePath(rootPath, MARKER_FILE);
  const tempMarker = `${markerPath}.${randomUUID()}.tmp`;
  const db = openRoom(descriptor.dbPath, password);
  try {
    migrate(db);
    const marker: WorkspaceMarker = {
      format: "arcelle-workspace",
      formatVersion: WORKSPACE_FORMAT_VERSION,
      roomId: newRoomId,
    };
    writeFileSync(tempMarker, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    db.transaction(() => {
      setMeta(db, "workspace_room_id", newRoomId);
      setMeta(db, "workspace_format_version", String(WORKSPACE_FORMAT_VERSION));
    })();
    try {
      renameSync(tempMarker, markerPath);
    } catch (error) {
      // Keep the public marker and encrypted metadata in agreement if the
      // final atomic marker swap fails.
      setMeta(db, "workspace_room_id", oldMarker.roomId);
      throw error;
    }
    return {
      descriptor: describeRoom(rootPath) as RoomDescriptor & {
        kind: "workspace-folder";
        rootPath: string;
      },
      db,
    };
  } catch (error) {
    rmSync(tempMarker, { force: true });
    try { db.close(); } catch { /* best effort */ }
    throw error;
  }
}

export function releaseWorkspaceLease(lease: WorkspaceLease): void {
  clearInterval(lease.renewal);
  try {
    const existing = JSON.parse(readFileSync(lease.lockPath, "utf8")) as { token?: string };
    if (existing.token === lease.token) rmSync(lease.lockPath, { force: true });
  } catch {
    // A missing or damaged lease is already released from this process's view.
  }
}
