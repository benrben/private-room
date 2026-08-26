/** Interactive and durable media-download IPC over the shared room/queue. */

import fs from "node:fs";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { FileMeta as SharedFileMeta } from "../shared/apiTypes.js";
import { availableName, insertFileFromUrl } from "./db-host/files.js";
import { extractDocumentText } from "./documentExtraction.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import {
  cancelMediaDownload,
  importMediaUrl,
  listMediaFormats,
  mediaProgressToEventSender,
  type ImportDownloadFn,
} from "./ytdlp.js";
import {
  downloadRowStarter,
  startDownloadJobInner,
  type DownloadEngineDeps,
} from "./jobDownload.js";
import { downloadToTemp, guessDownloadMime } from "./webFetch.js";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function createDownloadEngineDeps(
  state: RoomManagerState,
  userDataDir: string,
  emit: EventSender,
): DownloadEngineDeps {
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  const importDownload: ImportDownloadFn = async (filePath, displayName, sourceUrl) => {
    const open = room();
    const bytes = await fs.promises.readFile(filePath);
    const name = availableName(open.conn, displayName || path.basename(filePath) || "download");
    const mime = guessDownloadMime(name);
    const meta = insertFileFromUrl(open.conn, name, mime, bytes, await extractDocumentText(name, bytes), "download", sourceUrl);
    emit("room-files-changed", {});
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    return meta as unknown as SharedFileMeta;
  };
  return {
    dataDir: userDataDir,
    importDownload,
    downloadToTemp: async (url, cap, cancel, progress) => {
      const outcome = await downloadToTemp(url, cap, cancel, progress);
      return outcome.kind === "tooLarge"
        ? { kind: "too-large" }
        : { kind: "done", file: { path: outcome.downloaded.path, fileName: outcome.downloaded.fileName } };
    },
  };
}

export function registerMediaDownloadSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
): void {
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  const engineDeps = createDownloadEngineDeps(state, userDataDir, emit);
  const importDownload = engineDeps.importDownload!;

  if (deps.jobQueue) {
    const starters = new Map(deps.jobQueue.starters);
    starters.set("download", downloadRowStarter(engineDeps));
    deps.jobQueue = { ...deps.jobQueue, starters };
  }

  ipcMain.handle("cancel_media_download", (): void => cancelMediaDownload());
  ipcMain.handle("list_media_formats", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const url = String(object(raw).url ?? "");
    return listMediaFormats(url, {
      dataDir: userDataDir,
      webAccessAllowed: () => webAccessEnabled(room().conn),
      progress: mediaProgressToEventSender(emit),
    });
  });
  ipcMain.handle("import_media_url", (_event: IpcMainInvokeEvent, raw: unknown) => {
    const args = object(raw);
    const maxHeight = typeof args.maxHeight === "number" ? args.maxHeight : null;
    return importMediaUrl(String(args.url ?? ""), {
      dataDir: userDataDir,
      maxHeight,
      webAccessAllowed: () => webAccessEnabled(room().conn),
      importDownload,
      progress: mediaProgressToEventSender(emit),
    });
  });
  ipcMain.handle("start_download_job", (_event: IpcMainInvokeEvent, raw: unknown): string => {
    if (state.rollingBack) throw new Error("A rollback is in progress. Try again in a moment.");
    if (!deps.jobQueue) throw new Error("The job queue is unavailable.");
    const args = object(raw);
    return startDownloadJobInner(
      { ...deps.jobQueue, ...engineDeps },
      String(args.url ?? ""),
      String(args.engine ?? "fetch"),
    );
  });
}
