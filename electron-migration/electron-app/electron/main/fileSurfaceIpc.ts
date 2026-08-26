/** Renderer IPC for the room file/trash/organization write surface. */

import type { IpcMain, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { Readable } from "node:stream";
import type { BulkReport } from "../shared/apiTypes.js";
import type { RoomManagerState } from "./roomManager.js";
import {
  anyFileName,
  availableName,
  deleteFile,
  emptyTrash,
  getFileMeta,
  inTransaction,
  listFiles,
  listTrashedFiles,
  renameFile,
  restoreFile,
  setLibraryVisibility,
  trashFile,
  updateFileContent,
} from "./db-host/files.js";
import { moveFileToFolder } from "./db-host/folders.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { saveGeneratedFile } from "./turnEngine.js";
import type { EventSender } from "./turn.js";

const MAX_BULK_FILES = 200;

function args(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function batch(
  state: RoomManagerState,
  ids: readonly string[],
  operation: (id: string) => void,
): BulkReport {
  const room = state.room;
  if (room === null) throw new Error("No room is open.");
  const unique = [...new Set(ids)];
  const kept = unique.slice(0, MAX_BULK_FILES);
  const report: BulkReport = { ok: [], failed: [], capped: unique.length - kept.length };
  for (const id of kept) {
    const name = anyFileName(room.conn, id) ?? id;
    try {
      operation(id);
      report.ok.push(name);
    } catch (error) {
      report.failed.push({ name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

export function registerFileSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  emit: EventSender,
): void {
  const room = () => {
    if (state.room === null) throw new Error("No room is open.");
    return state.room;
  };
  const changed = (): void => emit("room-files-changed", null);
  const changedIf = (report: BulkReport): BulkReport => {
    if (report.ok.length > 0) changed();
    return report;
  };

  ipcMain.handle("list_files", () => listFiles(room().conn));
  ipcMain.handle("list_trashed_files", () => listTrashedFiles(room().conn));
  ipcMain.handle("rename_file", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    const open = room();
    const id = String(a.id ?? "");
    const name = String(a.name ?? "");
    if (open.workspace !== undefined) {
      const row = open.conn.prepare("SELECT relative_path FROM files WHERE id = ?").get(id) as {
        relative_path: string | null;
      } | undefined;
      if (row?.relative_path === null || row?.relative_path === undefined) throw new Error("That file is unavailable.");
      const parent = path.posix.dirname(row.relative_path);
      const destination = parent === "." ? name : path.posix.join(parent, name);
      return open.workspace.move(id, destination).then(() => { changed(); });
    }
    renameFile(open.conn, id, name);
    changed();
  });
  ipcMain.handle("trash_file", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const open = room();
    const id = String(args(raw).id ?? "");
    if (open.workspace !== undefined) {
      return open.workspace.trash(id).then(() => { changed(); });
    }
    trashFile(open.conn, id, { kind: "user" });
    changed();
  });
  ipcMain.handle("restore_file", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const id = String(args(raw).id ?? "");
    const open = room();
    if (open.workspace !== undefined) {
      return open.workspace.restore(id).then(() => {
        const result = getFileMeta(open.conn, id);
        changed();
        return result;
      });
    }
    restoreFile(open.conn, id);
    const result = getFileMeta(open.conn, id);
    changed();
    return result;
  });
  ipcMain.handle("delete_file_permanently", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const id = String(args(raw).id ?? "");
    const count = room().conn.prepare(
      "SELECT count(*) AS n FROM files WHERE id = ? AND trashed_at IS NOT NULL",
    ).get(id) as { n: number };
    if (count.n === 0) throw new Error("Only a file already in the trash can be deleted permanently.");
    deleteFile(room().conn, id);
    changed();
  });
  ipcMain.handle("empty_trash", () => {
    const count = emptyTrash(room().conn);
    if (count > 0) changed();
    return count;
  });
  ipcMain.handle("set_file_in_library", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    const id = String(a.id ?? "");
    setLibraryVisibility(room().conn, id, a.linked === true);
    const result = getFileMeta(room().conn, id);
    changed();
    return result;
  });
  ipcMain.handle("update_file_content", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    const id = String(a.id ?? "");
    const content = String(a.content ?? "");
    const open = room();
    const db = open.conn;
    if (open.workspace !== undefined) {
      const expected = db.prepare("SELECT content_sha256 FROM files WHERE id = ?").get(id) as {
        content_sha256: string | null;
      } | undefined;
      return open.workspace.snapshotVersion(id, "You saved")
        .then(() => open.workspace!.writeAtomic(
          id,
          Readable.from([Buffer.from(content, "utf8")]),
          expected?.content_sha256 ?? undefined,
        ))
        .then(() => {
          db.prepare("UPDATE files SET extracted_text = ? WHERE id = ?").run(content, id);
          const result = getFileMeta(db, id);
          changed();
          emit("file-updated", { id });
          return result;
        });
    }
    inTransaction(db, () => {
      snapshotFileVersion(db, id, "You saved");
      updateFileContent(db, id, Buffer.from(content, "utf8"), content);
    });
    const result = getFileMeta(db, id);
    changed();
    emit("file-updated", { id });
    return result;
  });
  ipcMain.handle("save_generated_file", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    const open = room();
    const requestedName = String(a.name ?? "");
    const content = String(a.content ?? "");
    if (open.workspace !== undefined) {
      const name = availableName(open.conn, requestedName || "Generated.md");
      return open.workspace.createFile(name, Readable.from([Buffer.from(content, "utf8")]), "generated")
        .then((entry) => {
          open.conn.prepare("UPDATE files SET extracted_text = ? WHERE id = ?").run(content, entry.fileId);
          const result = getFileMeta(open.conn, entry.fileId);
          changed();
          return result;
        });
    }
    const result = saveGeneratedFile(open.conn, requestedName, content);
    changed();
    return result;
  });

  ipcMain.handle("trash_files", (_event: IpcMainInvokeEvent, raw: unknown) =>
    changedIf(batch(state, stringIds(args(raw).ids), (id) => trashFile(room().conn, id, { kind: "user" }))),
  );
  ipcMain.handle("restore_files", (_event: IpcMainInvokeEvent, raw: unknown) =>
    changedIf(batch(state, stringIds(args(raw).ids), (id) => restoreFile(room().conn, id))),
  );
  ipcMain.handle("move_files_to_folder", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = args(raw);
    const folderId = typeof a.folderId === "string" ? a.folderId : null;
    return changedIf(batch(state, stringIds(a.fileIds), (id) => moveFileToFolder(room().conn, id, folderId)));
  });
  ipcMain.handle("delete_files_permanently", (_event: IpcMainInvokeEvent, raw: unknown) =>
    changedIf(batch(state, stringIds(args(raw).ids), (id) => {
      const count = room().conn.prepare(
        "SELECT count(*) AS n FROM files WHERE id = ? AND trashed_at IS NOT NULL",
      ).get(id) as { n: number };
      if (count.n === 0) throw new Error("Only a file already in the trash can be deleted permanently.");
      deleteFile(room().conn, id);
    })),
  );
}
