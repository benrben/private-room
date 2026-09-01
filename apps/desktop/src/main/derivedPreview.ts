import path from "node:path";
import type { PreviewRenderFn } from "./previewTools.js";
import { renderQuickLook } from "./previewTools.js";
import {
  availableName,
  deleteFile,
  derivedPreviews,
  getDerivedPreview,
  markDerivedPreview,
  restoreFile,
  trashFile,
  type DerivedPreviewRef,
} from "./db-host/files.js";
import { createRoomFile, readRoomFile, type RoomContentHandle } from "./workspace/roomContent.js";
import { pathKey } from "./workspace/pathSafety.js";
import { WorkspaceService } from "./workspace/workspaceService.js";

export const MAX_DERIVED_PREVIEW_BYTES = 100 * 1024 * 1024;
export const DERIVED_PREVIEW_SOURCE = "derived-preview";
export const DERIVED_SNAPSHOT_SOURCE = "derived-preview-snapshot";
export type DerivedPreviewProvenance = "generated" | "snapshot";

export type DerivedPreviewStoreResult =
  | { kind: "stored"; preview: DerivedPreviewRef }
  | { kind: "reused"; preview: DerivedPreviewRef }
  | { kind: "too_large"; sizeBytes: number }
  | { kind: "unavailable" };

export interface ResolvedPreviewContent {
  originalId: string;
  originalName: string;
  preview: DerivedPreviewRef;
  bytes: Buffer;
}

function workspaceFor(room: RoomContentHandle): WorkspaceService {
  return new WorkspaceService(room.db, room.path);
}

function isWorkspaceRoom(room: RoomContentHandle): boolean {
  return room.db.prepare(
    "SELECT 1 FROM meta WHERE key = 'room_kind' AND value = 'workspace-folder'",
  ).get() !== undefined;
}

type PreviewSourceRow = { name: string; relative_path: string | null };

function previewSource(room: RoomContentHandle, originalId: string): PreviewSourceRow {
  const row = room.db.prepare(
    "SELECT name, relative_path FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(originalId) as PreviewSourceRow | undefined;
  if (row === undefined) throw new Error("The original file is not in this room.");
  return row;
}

function previewFileName(source: PreviewSourceRow, extension: string): { parsed: path.ParsedPath; suffix: string; wanted: string } {
  const parsed = path.parse(source.relative_path ?? source.name);
  const suffix = extension.replace(/^\./, "");
  const wanted = `${parsed.name}-preview.${suffix}`;
  return { parsed, suffix, wanted };
}

function numberedPreviewName(wanted: string, suffix: string, number: number): string {
  if (number === 1) return wanted;
  return `${path.parse(wanted).name} (${number}).${suffix}`;
}

function availableWorkspacePreviewPath(
  room: RoomContentHandle,
  parsed: path.ParsedPath,
  wanted: string,
  suffix: string,
): string {
  let number = 1;
  for (;;) {
    const name = numberedPreviewName(wanted, suffix, number);
    const relative = parsed.dir ? path.join(parsed.dir, name) : name;
    const taken = room.db.prepare(
      "SELECT 1 FROM files WHERE path_key = lower(?) AND trashed_at IS NULL",
    ).get(pathKey(relative));
    if (taken === undefined) return relative;
    number += 1;
  }
}

function previewDestination(room: RoomContentHandle, originalId: string, extension: string): string {
  const { parsed, suffix, wanted } = previewFileName(previewSource(room, originalId), extension);
  if (!isWorkspaceRoom(room)) return availableName(room.db, wanted);
  return availableWorkspacePreviewPath(room, parsed, wanted, suffix);
}

/** Persist bytes as a normal file and link them as the hidden viewer preview.
 * The original remains the export and source-of-truth file. */
export async function storeDerivedPreview(
  room: RoomContentHandle,
  originalId: string,
  bytes: Uint8Array,
  mimeType: string,
  extension: string,
  provenance: DerivedPreviewProvenance = "generated",
): Promise<DerivedPreviewStoreResult> {
  const current = getDerivedPreview(room.db, originalId);
  if (current !== null) return { kind: "reused", preview: current };
  if (bytes.byteLength > MAX_DERIVED_PREVIEW_BYTES) {
    return { kind: "too_large", sizeBytes: bytes.byteLength };
  }
  const destination = previewDestination(room, originalId, extension);
  const meta = await createRoomFile(
    room,
    destination,
    mimeType,
    bytes,
    null,
    provenance === "snapshot" ? DERIVED_SNAPSHOT_SOURCE : DERIVED_PREVIEW_SOURCE,
  );
  try {
    markDerivedPreview(room.db, meta.id, originalId);
  } catch (error) {
    if (isWorkspaceRoom(room)) {
      // Do not drop metadata if filesystem cleanup fails: reconciliation can
      // then still see and manage the normal file instead of orphaning it.
      await workspaceFor(room).trash(meta.id).then(
        () => deleteFile(room.db, meta.id),
        () => undefined,
      );
    } else {
      deleteFile(room.db, meta.id);
    }
    throw error;
  }
  return { kind: "stored", preview: getDerivedPreview(room.db, originalId)! };
}

/** Resolve an original to its stored preview in either room format. */
export async function resolveDerivedPreview(
  room: RoomContentHandle,
  originalId: string,
): Promise<ResolvedPreviewContent | null> {
  const preview = getDerivedPreview(room.db, originalId);
  if (preview === null) return null;
  const original = room.db.prepare(
    "SELECT name FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(originalId) as { name: string } | undefined;
  if (original === undefined) return null;
  const content = await readRoomFile(room, preview.id);
  if (content.bytes === null) return null;
  return { originalId, originalName: original.name, preview, bytes: content.bytes };
}

/** Remove stale stored previews. */
export async function invalidateDerivedPreviews(
  room: RoomContentHandle,
  originalId: string,
): Promise<DerivedPreviewRef[]> {
  const stale = derivedPreviews(room.db, originalId);
  if (isWorkspaceRoom(room)) {
    const workspace = workspaceFor(room);
    for (const preview of stale) {
      await workspace.trash(preview.id);
      deleteFile(room.db, preview.id);
    }
  } else {
    for (const preview of stale) deleteFile(room.db, preview.id);
  }
  return stale;
}

export type DerivedPreviewRegenerator = (
  room: RoomContentHandle,
  originalId: string,
) => Promise<{ bytes: Uint8Array; mimeType: string; extension: string } | null>;

/** File-update hook: invalidate first, then publish a fresh preview. */
export async function regenerateDerivedPreview(
  room: RoomContentHandle,
  originalId: string,
  generate: DerivedPreviewRegenerator,
): Promise<DerivedPreviewStoreResult> {
  await invalidateDerivedPreviews(room, originalId);
  const next = await generate(room, originalId);
  if (next === null) return { kind: "unavailable" };
  return storeDerivedPreview(room, originalId, next.bytes, next.mimeType, next.extension);
}

/** Workspace-aware trash cascade. Blob rooms use one database transaction;
 * workspace rooms must remove each normal derived file as well. */
export async function trashFileWithDerivedPreviews(
  room: RoomContentHandle,
  originalId: string,
): Promise<void> {
  if (!isWorkspaceRoom(room)) {
    trashFile(room.db, originalId, { kind: "user" });
    return;
  }
  const workspace = workspaceFor(room);
  for (const preview of derivedPreviews(room.db, originalId)) await workspace.trash(preview.id);
  await workspace.trash(originalId);
}

export async function restoreFileWithDerivedPreviews(
  room: RoomContentHandle,
  originalId: string,
): Promise<void> {
  if (!isWorkspaceRoom(room)) {
    restoreFile(room.db, originalId);
    return;
  }
  const previews = derivedPreviews(room.db, originalId, true);
  const workspace = workspaceFor(room);
  await workspace.restore(originalId);
  for (const preview of previews) await workspace.restore(preview.id);
}

const quickLookInFlight = new Map<string, Promise<DerivedPreviewStoreResult>>();

export interface SnapshotPreparedPreview {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}

export interface SnapshotUnknownFormatOptions {
  /** Validate or transcode the renderer's PNG before it is committed. `null`
   * means the renderer result is not a usable durable preview. */
  prepare?(png: Buffer): Promise<SnapshotPreparedPreview | null>;
}

async function prepareSnapshotPng(
  png: Buffer,
  prepare: SnapshotUnknownFormatOptions["prepare"],
): Promise<SnapshotPreparedPreview | null> {
  if (prepare !== undefined) return prepare(png);
  return { bytes: png, mimeType: "image/png", extension: "png" };
}

async function renderPreparedSnapshot(
  name: string,
  bytes: Buffer,
  render: PreviewRenderFn,
  prepare: SnapshotUnknownFormatOptions["prepare"],
): Promise<SnapshotPreparedPreview | null> {
  try {
    const png = await render(name, bytes);
    return png === null ? null : await prepareSnapshotPng(png, prepare);
  } catch {
    // Quick Look is a best-effort import enhancement. A timeout, unavailable
    // sidecar, or broken format must never reject the original import.
    return null;
  }
}

/** Import-time, one-shot unknown-format fallback. Reopens reuse the stored
 * preview and never call Quick Look again. Concurrent calls share one render. */
export function snapshotUnknownFormat(
  room: RoomContentHandle,
  originalId: string,
  render: PreviewRenderFn = renderQuickLook,
  options: SnapshotUnknownFormatOptions = {},
): Promise<DerivedPreviewStoreResult> {
  const current = getDerivedPreview(room.db, originalId);
  if (current !== null) return Promise.resolve({ kind: "reused", preview: current });
  const key = `${room.path}\0${originalId}`;
  const active = quickLookInFlight.get(key);
  if (active !== undefined) return active;
  const task = (async (): Promise<DerivedPreviewStoreResult> => {
    const original = await readRoomFile(room, originalId);
    if (original.bytes === null || original.bytes.length === 0) return { kind: "unavailable" };
    const prepared = await renderPreparedSnapshot(original.name, original.bytes, render, options.prepare);
    if (prepared === null) return { kind: "unavailable" };
    return storeDerivedPreview(
      room,
      originalId,
      prepared.bytes,
      prepared.mimeType,
      prepared.extension,
      "snapshot",
    );
  })().finally(() => quickLookInFlight.delete(key));
  quickLookInFlight.set(key, task);
  return task;
}
