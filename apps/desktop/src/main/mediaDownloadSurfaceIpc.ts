/**
 * Interactive and durable media-download IPC over the shared room/queue.
 *
 * {@link createDownloadEngineDeps}'s `importDownload` is the funnel every
 * URL-fetched file lands in — a `"download"` job of either engine, an agent's
 * `download_url`/`download_media`, the interactive `import_media_url` format
 * picker — so it is also the one place download-side intake policy belongs.
 *
 * NOT every download in the app, and the exception is worth naming rather than
 * discovering: a file clicked inside the PRIVATE BROWSER is imported by
 * `browserSurfaceIpc.ts`'s own `importBytes` (via `downloadGating.ts`'s
 * `importFinishedDownload`), which never touches this module. An mp3 saved
 * from a web page therefore does NOT transcribe itself today. Closing that
 * would mean giving `importBytes` the same call — `browserSurfaceIpc.ts`'s
 * change to make, not this one's.
 *
 * Through this funnel, audio and video are handed to the speaker-aware
 * transcription pass, per the owner's decision that downloads (unlike
 * drag-dropped imports) transcribe themselves: a podcast or an interview is
 * the most multi-speaker content this app sees, and it was arriving as an hour
 * of unsearchable audio while `download_media`'s own tool description told the
 * model otherwise.
 */

import fs from "node:fs";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { FileMeta as SharedFileMeta } from "../shared/apiTypes.js";
import { availableName, getFileMeta, insertFileFromUrl, setFileExtractedText } from "./db-host/files.js";
import { extractDocumentText } from "./documentExtraction.js";
import { extensionOf } from "./editMatchExtraction.js";
import { mediaKind } from "./peaksTools.js";
import { transcribeMediaWithSpeakers, type MediaTranscribeDeps } from "./mediaTranscribeJob.js";
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

/**
 * `process.resourcesPath` — where a packaged build keeps the bundled speech
 * and speaker-embedding weights — or `null` when there is no Electron around
 * it (a unit test running under plain Node). Read reflectively because the
 * property is Electron's addition to `process`, not Node's: this module types
 * against `electron` but never imports it at runtime, and the value must be
 * absent-not-crashing under plain Node.
 *
 * `index.ts` computes the same value as `app.isPackaged ? … : null`, and this
 * one deliberately drops the `isPackaged` gate. That gate exists so nothing
 * CLAIMS a bundle a dev build does not have; nothing here claims anything —
 * both model resolvers only ever ask whether a file EXISTS. In a dev run this
 * points inside `node_modules/electron/dist/…/Resources`, which holds no
 * `models/` directory, so `sttEffectiveModel` and `diarizeEffectiveModel`
 * return exactly what they return for `null` (the copy downloaded into
 * userData, and `mediaTranscribeJob.ts`'s dev-tree walk). Gating it would buy
 * nothing and would cost a packaged build its speaker separation whenever a
 * caller forgot to thread the value through.
 */
function bundledResourcesPath(): string | null {
  const value: unknown = Reflect.get(process, "resourcesPath");
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Everything {@link createDownloadEngineDeps} needs beyond the open room.
 * Every field is optional, and a caller that supplies none still gets working
 * download transcription — the weights resolve themselves and the two test
 * seams default to the real implementations. What it gives up is the
 * re-index nudge: without {@link DownloadEngineOptions.onIndexed} a fresh
 * transcript waits for the room's next ordinary indexing trigger before it is
 * searchable.
 */
export interface DownloadEngineOptions {
  /**
   * Where the bundled speech and speaker-embedding weights live — the value
   * `index.ts` computes as `app.isPackaged ? process.resourcesPath : null`.
   * Omitted (or `null`) falls back to {@link bundledResourcesPath}, which is
   * the same answer for every real build; pass it explicitly from a caller
   * that already holds it.
   *
   * DECIDED FAILURE BEHAVIOUR when no weights are found at all: the download
   * still commits, and the pass says `model-missing` on the `stt-progress`
   * lane. It never fabricates a transcript and never fails the download. If
   * only the SPEAKER weights are missing the transcript is still produced,
   * with a warning in the log and no speaker turns — `mediaTranscribeJob.ts`
   * owns that split.
   */
  resourcesPath?: string | null;
  /** `RoomManagerDeps.scheduleAutoIndex` — a transcript is new searchable text
   * for the room, so the index has to hear about it. Omitted means the room is
   * re-indexed on its next ordinary trigger instead. */
  onIndexed?: (roomPath: string) => void;
  /** Test seam for document extraction. */
  extractText?: typeof extractDocumentText;
  /** Test seam for the transcription pass, so a test can assert WHICH file id
   * was handed over without running whisper. */
  transcribe?: typeof transcribeMediaWithSpeakers;
}

export function createDownloadEngineDeps(
  state: RoomManagerState,
  userDataDir: string,
  emit: EventSender,
  options: DownloadEngineOptions = {},
): DownloadEngineDeps {
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  const transcribe = options.transcribe ?? transcribeMediaWithSpeakers;
  const transcribeDeps: MediaTranscribeDeps = {
    state,
    userDataDir,
    resourcesPath: options.resourcesPath ?? bundledResourcesPath(),
    emit,
    ...(options.onIndexed === undefined ? {} : { onIndexed: options.onIndexed }),
  };
  /**
   * Downloads DO transcribe themselves — this is the one intake path where
   * that is the owner's decision, and the difference from a drag-dropped
   * import is intent: somebody asked for this one file by URL, so a podcast
   * or an interview is speaker-separated and searchable by the time they open
   * it, instead of arriving as an unreadable hour of audio.
   *
   * It also makes `download_media`'s tool description true. That description
   * promised the model "transcribed automatically after it arrives" for as
   * long as it has existed, while nothing on the download path transcribed
   * anything; the wording and this call landed together.
   *
   * FIRE AND FORGET, AND UNABLE TO HURT THE DOWNLOAD. The file is already
   * committed and announced by the time this runs; a refusal, a crash inside
   * the pass, or a missing model must not roll any of that back. Everything is
   * caught — but not swallowed: the failure is said out loud on the same
   * `stt-progress` lane the viewer already reads, keyed by file NAME the way
   * every other producer on that lane keys it.
   */
  const startTranscription = (fileId: string, name: string, mime: string): void => {
    try {
      // Only audio and video, decided by the resolver the transcriber itself
      // gates on — a downloaded PDF or ZIP must not be staged and decoded.
      if (mediaKind(mime, extensionOf(name)) === null) return;
      void transcribe(transcribeDeps, fileId).catch((error) => {
        emit("stt-progress", [name, `failed: ${error instanceof Error ? error.message : String(error)}`]);
      });
    } catch (error) {
      emit("stt-progress", [name, `failed: ${error instanceof Error ? error.message : String(error)}`]);
    }
  };
  const importDownload: ImportDownloadFn = async (filePath, displayName, sourceUrl) => {
    const open = room();
    const bytes = await fs.promises.readFile(filePath);
    const name = availableName(open.conn, displayName || path.basename(filePath) || "download");
    const mime = guessDownloadMime(name);
    const extracted = await (options.extractText ?? extractDocumentText)(name, bytes);
    const meta = open.workspace === undefined
      ? insertFileFromUrl(open.conn, name, mime, bytes, extracted, "download", sourceUrl)
      : await open.workspace.createFile(name, fs.createReadStream(filePath), "download").then((entry) => {
        open.conn.prepare(
          "UPDATE files SET mime_type = ?, origin_url = ? WHERE id = ?",
        ).run(mime, sourceUrl, entry.fileId);
        if (extracted !== null && extracted.trim() !== "") {
          setFileExtractedText(open.conn, entry.fileId, extracted);
        }
        return getFileMeta(open.conn, entry.fileId);
      });
    emit("room-files-changed", {});
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    // After the staged copy is gone: the pass stages its own from the room, so
    // starting earlier would only keep two copies of an hour of video on disk.
    startTranscription(meta.id, name, mime);
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

/**
 * `resourcesPath` is where the bundled speech/speaker weights live — pass the
 * same value the rest of the registry passes to `retranscribeFile`. It is
 * optional because {@link bundledResourcesPath} resolves the identical answer
 * on its own; passing it explicitly keeps that resolution in ONE place for a
 * caller that already holds the value.
 */
export function registerMediaDownloadSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
  resourcesPath: string | null = null,
): void {
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  const engineDeps = createDownloadEngineDeps(state, userDataDir, emit, {
    resourcesPath,
    onIndexed: (roomPath) => deps.scheduleAutoIndex?.(roomPath),
  });
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
