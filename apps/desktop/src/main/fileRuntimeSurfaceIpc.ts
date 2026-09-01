/** Remaining file/viewer and small host utility IPC surfaces. */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { FileContent, ViewerKind } from "../shared/apiTypes.js";
import {
  availableName,
  fileByExactName,
  getFileFull,
  getFileMeta,
  getMediaMeta,
  getWebMeta,
  insertFile,
  insertFileFromUrl,
  setFileExtractedText,
} from "./db-host/files.js";
import {
  resolveDerivedPreview,
  snapshotUnknownFormat,
  storeDerivedPreview,
  type DerivedPreviewStoreResult,
} from "./derivedPreview.js";
import { extractRawPreview } from "./rawPreview.js";
import { MIN_RAW_PREVIEW_WIDTH } from "./rawPreview.js";
import type { PreviewRenderFn } from "./previewTools.js";
import { renderQuickLook } from "./previewTools.js";
import type { RoomContentHandle } from "./workspace/roomContent.js";
import { extractIWorkPreview } from "./iWorkPreview.js";
import {
  installOfficeArtifacts,
  OfficeConverter,
  officeConvertible,
  verifyOfficeArtifacts,
} from "./officeConvert.js";
import { extractDocumentText } from "./documentExtraction.js";
import { guessDownloadMime, fetchReadable } from "./webFetch.js";
import { SCRATCH_PAD_NAME } from "./docsHtml.js";
import {
  createHtmlPreviews,
  openHtmlInBrowser,
  stagePreviewHtmlCore,
  studioPrompts,
  type HtmlPreviews,
} from "./studiosCmds.js";
import {
  createMediaStreams,
  playableMediaMime,
  stageMediaBytes,
  stageMediaStream,
  type MediaStreams,
} from "./mediaTools.js";
import { searchWeb } from "./webSearch.js";
import { isOcrCandidate, OCR_TEXT_PREFIX, recognize, recognizeViaSidecar } from "./ocrTools.js";
import { mediaKind } from "./peaksTools.js";
import { getRecMeta } from "./db-host/recordings.js";
import { logDir } from "./obs.js";
import { isCodeTextExtension } from "../shared/fileExtensions.js";
import {
  IWORK_PREVIEW_EXTENSIONS,
  RAW_PREVIEW_EXTENSIONS,
  ext,
  jsonOrNull,
  preflightImportPaths,
  readAll,
  rec,
  shouldAutoTranscribeImport,
  snapshotRawFallback,
  transcribeEligibleImport,
  viewerKind,
  viewerKindIsEditable,
  viewerKindReadsRawText,
} from "./fileRuntimeSupport.js";
import { registerFileRuntimeUtilityIpc } from "./fileRuntimeUtilityIpc.js";

export {
  preflightImportPaths,
  rawFallbackJpeg,
  rawFallbackPngDimensions,
  shouldAutoTranscribeImport,
  snapshotRawFallback,
  transcribeEligibleImport,
  viewerKind,
  viewerKindIsEditable,
  viewerKindReadsRawText,
} from "./fileRuntimeSupport.js";

export interface FileRuntimeHost {
  openPath(target: string): Promise<void>;
}

export interface FileRuntimeStores {
  htmlPreviews: HtmlPreviews;
  mediaStreams: MediaStreams;
  /** The lightweight IPC response for media files already staged in
   * `mediaStreams`, keyed by file id. The bytes live only in `mediaStreams`;
   * this map deliberately does not retain a second decrypted copy. */
  fileContents: Map<string, FileContent>;
}

export interface FileRuntimeActions {
  /** Starts durable on-device transcription after a media original has been
   * committed. The import response does not wait for the long-running job.
   *
   * Fired for {@link shouldAutoTranscribeImport} only — NOT for every media
   * import. An eligible file that is not in that narrow set is offered the
   * media viewer's Transcribe button instead, which runs the same pass
   * through `retranscribe_file` when the person asks for it. */
  retranscribeImportedFile?(fileId: string): Promise<void>;
}

/** Drop cached viewer responses after anything that can mutate room files.
 * Existing `mediaStreams` entries stay alive so an audio/video element that
 * is already playing is not interrupted; the next open will restage the
 * current database bytes under a fresh token. */
export function invalidateFileContentCacheForEvent(
  stores: FileRuntimeStores,
  event: string,
): void {
  if (event === "room-files-changed" || event === "file-updated") {
    stores.fileContents.clear();
  }
}

export function registerFileRuntimeSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
  host: FileRuntimeHost,
  actions: FileRuntimeActions = {},
): FileRuntimeStores {
  const stores: FileRuntimeStores = {
    htmlPreviews: createHtmlPreviews(),
    mediaStreams: createMediaStreams(),
    fileContents: new Map(),
  };
  const room = () => {
    if (!state.room) throw new Error("No room is open.");
    return state.room;
  };
  const changed = (): void => emit("room-files-changed", {});
  const startOcr = (
    roomPath: string,
    fileId: string,
    name: string,
    mime: string,
    bytes: Buffer,
  ): void => {
    const extension = ext(name);
    if (!isOcrCandidate(mime, extension)) return;
    emit("ocr-progress", [name, "started"]);
    void recognize(mime, extension, bytes, recognizeViaSidecar)
      .then((text) => {
        if (!text || !state.room || state.room.path !== roomPath) return;
        setFileExtractedText(state.room.conn, fileId, `${OCR_TEXT_PREFIX}\n${text}`);
        emit("file-updated", fileId);
        changed();
        deps.scheduleAutoIndex?.(roomPath);
      })
      .then(() => emit("ocr-progress", [name, "done"]))
      .catch((error) => emit("ocr-progress", [name, `failed: ${error instanceof Error ? error.message : String(error)}`]));
  };
  const previousClear = deps.clearEphemeralCaches;
  deps.clearEphemeralCaches = () => {
    previousClear?.();
    stores.htmlPreviews.map.clear();
    stores.mediaStreams.map.clear();
    stores.fileContents.clear();
  };
  const officeArtifactDir = path.join(userDataDir, "office-converter-v1");
  let officeConverter: OfficeConverter | null = null;
  let officeConsentAsked = false;
  const officePdf = async (name: string, bytes: Uint8Array): Promise<Buffer | null> => {
    if (!officeConvertible(name)) return null;
    if (!await verifyOfficeArtifacts(officeArtifactDir)) {
      if (officeConsentAsked) return null;
      officeConsentAsked = true;
      const { dialog } = await import("electron");
      const answer = await dialog.showMessageBox({
        type: "info",
        buttons: ["Enable previews", "Not now"],
        defaultId: 0,
        cancelId: 1,
        title: "Enable office document previews?",
        message: "Arcelle can download the open-source ZetaOffice converter.",
        detail: "This is a one-time download of about 53 MB. It is integrity-checked, then conversions work offline. Your documents are not uploaded.",
      });
      if (answer.response !== 0) return null;
      await installOfficeArtifacts(officeArtifactDir);
    }
    officeConverter ??= new OfficeConverter(officeArtifactDir);
    return officeConverter.convert(name, bytes).catch(() => null);
  };

  const storeOfficePreview = async (
    open: ReturnType<typeof room>,
    fileId: string,
    name: string,
    bytes: Buffer,
  ): Promise<boolean> => {
    const converted = await officePdf(name, bytes);
    if (converted === null) return false;
    await storeDerivedPreview({ db: open.conn, path: open.path }, fileId, converted, "application/pdf", "pdf");
    return true;
  };

  const storeRawPreview = async (
    open: ReturnType<typeof room>,
    fileId: string,
    extension: string,
    bytes: Buffer,
  ): Promise<boolean> => {
    if (!RAW_PREVIEW_EXTENSIONS.has(extension)) return false;
    const preview = extractRawPreview(bytes);
    if (preview === null) return false;
    await storeDerivedPreview({ db: open.conn, path: open.path }, fileId, preview.bytes, "image/jpeg", "jpg");
    return true;
  };

  const storeIWorkPreview = async (
    open: ReturnType<typeof room>,
    fileId: string,
    extension: string,
    bytes: Buffer,
  ): Promise<boolean> => {
    if (!IWORK_PREVIEW_EXTENSIONS.has(extension)) return false;
    const preview = extractIWorkPreview(bytes);
    if (preview === null) return false;
    await storeDerivedPreview(
      { db: open.conn, path: open.path }, fileId, preview.bytes, preview.mimeType, preview.extension,
    );
    return true;
  };

  const isNativeImagePreviewExtension = (extension: string): boolean => {
    return extension === "heic" || extension === "heif";
  };

  const isInvalidIllustratorPdf = (extension: string, bytes: Buffer): boolean => {
    if (extension !== "ai") return false;
    return !bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-");
  };

  const isBinaryWithoutText = (name: string, mime: string, extracted: string | null): boolean => {
    return viewerKind(name, mime) === "binary" && !extracted?.trim();
  };

  const needsUnknownFormatSnapshot = (
    name: string,
    mime: string,
    extension: string,
    bytes: Buffer,
    extracted: string | null,
  ): boolean => {
    if (IWORK_PREVIEW_EXTENSIONS.has(extension)) return true;
    if (isNativeImagePreviewExtension(extension)) return true;
    if (isInvalidIllustratorPdf(extension, bytes)) return true;
    return isBinaryWithoutText(name, mime, extracted);
  };

  const snapshotImportedFallback = async (
    open: ReturnType<typeof room>,
    fileId: string,
    name: string,
    mime: string,
    extension: string,
    bytes: Buffer,
    extracted: string | null,
  ): Promise<void> => {
    if (RAW_PREVIEW_EXTENSIONS.has(extension)) {
      await snapshotRawFallback({ db: open.conn, path: open.path }, fileId);
      return;
    }
    if (needsUnknownFormatSnapshot(name, mime, extension, bytes, extracted)) {
      await snapshotUnknownFormat({ db: open.conn, path: open.path }, fileId);
    }
  };

  const deriveImportedPreview = async (
    open: ReturnType<typeof room>,
    fileId: string,
    name: string,
    mime: string,
    bytes: Buffer,
    extracted: string | null,
  ): Promise<void> => {
    const extension = ext(name);
    if (await storeOfficePreview(open, fileId, name, bytes)) return;
    if (await storeRawPreview(open, fileId, extension, bytes)) return;
    if (await storeIWorkPreview(open, fileId, extension, bytes)) return;
    await snapshotImportedFallback(open, fileId, name, mime, extension, bytes, extracted);
  };

  type ImportReport = { imported: ReturnType<typeof insertFile>[]; errors: string[] };
  type ImportedFile = { meta: ReturnType<typeof insertFile>; bytes: Buffer | null };

  const selectedImportPaths = (raw: unknown): string[] => {
    const paths = rec(raw).paths;
    return Array.isArray(paths) ? paths.filter((value): value is string => typeof value === "string") : [];
  };

  const importWorkspaceMedia = async (
    open: ReturnType<typeof room>,
    filePath: string,
    name: string,
    mime: string,
  ): Promise<ImportedFile> => {
    const meta = await open.workspace!.importFile(filePath, name).then((entry) => {
      open.conn.prepare("UPDATE files SET mime_type = ? WHERE id = ?").run(mime, entry.fileId);
      return getFileMeta(open.conn, entry.fileId);
    });
    return { meta, bytes: null };
  };

  const importWorkspaceBytes = async (
    open: ReturnType<typeof room>,
    filePath: string,
    name: string,
    mime: string,
    bytes: Buffer,
    extracted: string | null,
  ): Promise<ReturnType<typeof insertFile>> => {
    return open.workspace!.importFile(filePath, name).then((entry) => {
      open.conn.prepare("UPDATE files SET mime_type = ?, extracted_text = ? WHERE id = ?")
        .run(mime, extracted, entry.fileId);
      return getFileMeta(open.conn, entry.fileId);
    });
  };

  const importBufferedFile = async (
    open: ReturnType<typeof room>,
    filePath: string,
    name: string,
    mime: string,
  ): Promise<ImportedFile> => {
    const bytes = await fs.promises.readFile(filePath);
    const extracted = await extractDocumentText(name, bytes);
    const meta = open.workspace === undefined
      ? insertFile(open.conn, name, mime, bytes, extracted, "import")
      : await importWorkspaceBytes(open, filePath, name, mime, bytes, extracted);
    if (!extracted || extracted.trim() === "") startOcr(open.path, meta.id, name, mime, bytes);
    return { meta, bytes };
  };

  const importSelectedFile = async (filePath: string): Promise<{ open: ReturnType<typeof room>; name: string; mime: string; file: ImportedFile }> => {
    const open = room();
    const name = availableName(open.conn, path.basename(filePath));
    const mime = guessDownloadMime(name);
    const file = open.workspace !== undefined && transcribeEligibleImport(name, mime)
      ? await importWorkspaceMedia(open, filePath, name, mime)
      : await importBufferedFile(open, filePath, name, mime);
    return { open, name, mime, file };
  };

  const derivePreviewAfterImport = async (
    open: ReturnType<typeof room>,
    fileId: string,
    name: string,
    mime: string,
    bytes: Buffer | null,
  ): Promise<void> => {
    if (bytes === null) return;
    const extracted = open.conn.prepare("SELECT extracted_text FROM files WHERE id = ?").get(fileId) as { extracted_text: string | null };
    await deriveImportedPreview(open, fileId, name, mime, bytes, extracted.extracted_text).catch(() => undefined);
  };

  const triggerAutoTranscription = (fileId: string, name: string, mime: string): void => {
    if (!shouldAutoTranscribeImport(name, mime)) return;
    void actions.retranscribeImportedFile?.(fileId).catch(() => undefined);
  };

  const importOne = async (filePath: string, report: ImportReport): Promise<void> => {
    try {
      const { open, name, mime, file } = await importSelectedFile(filePath);
      report.imported.push(file.meta);
      await derivePreviewAfterImport(open, file.meta.id, name, mime, file.bytes);
      triggerAutoTranscription(file.meta.id, name, mime);
    } catch (error) {
      report.errors.push(`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const reportImportCompletion = (report: ImportReport): void => {
    if (!report.imported.length) return;
    changed();
    deps.scheduleAutoIndex?.(room().path);
  };

  ipcMain.handle("import_files", async (_e: IpcMainInvokeEvent, raw: unknown) => {
    const report: ImportReport = { imported: [], errors: [] };
    const filePaths = selectedImportPaths(raw);
    report.errors = await preflightImportPaths(filePaths);
    if (report.errors.length > 0) return report;
    for (const filePath of filePaths) await importOne(filePath, report);
    reportImportCompletion(report);
    return report;
  });

  const contentKind = (
    db: ReturnType<typeof room>["conn"],
    id: string,
    name: string,
    mime: string,
  ): ViewerKind => getRecMeta(db, id) !== null ? "recording" : viewerKind(name, mime);

  const canvasDocumentKind = (kind: ViewerKind): boolean => kind === "sketch" || kind === "notebook";

  const canvasDocumentText = (bytes: Buffer | null): string | null => {
    return bytes === null ? null : bytes.toString("utf8");
  };

  const extractedOrPlainText = (mime: string, bytes: Buffer | null, extracted: string | null): string | null => {
    if (extracted !== null) return extracted;
    return bytes !== null && mime.startsWith("text/") ? bytes.toString("utf8") : null;
  };

  const contentText = (
    kind: ViewerKind,
    mime: string,
    bytes: Buffer | null,
    extracted: string | null,
  ): string | null => {
    if (canvasDocumentKind(kind)) return canvasDocumentText(bytes);
    return extractedOrPlainText(mime, bytes, extracted);
  };

  const stageMime = (kind: ViewerKind, mime: string, name: string): string => {
    if (kind === "audio" || kind === "recording" || kind === "video") {
      return playableMediaMime(mime, ext(name), kind === "video");
    }
    return mime;
  };

  const contentMediaToken = (
    runtimeStores: FileRuntimeStores,
    stagedToken: string | null,
    kind: ViewerKind,
    mime: string,
    name: string,
    bytes: Buffer | null,
  ): string | null => {
    if (stagedToken !== null) return stagedToken;
    if (viewerKindReadsRawText(kind) || bytes === null) return null;
    return stageMediaBytes(runtimeStores.mediaStreams, bytes, stageMime(kind, mime, name));
  };

  const cacheStagedContent = (runtimeStores: FileRuntimeStores, id: string, content: FileContent): void => {
    if (!content.mediaToken) return;
    for (const [fileId, prior] of runtimeStores.fileContents) {
      if (!prior.mediaToken || !runtimeStores.mediaStreams.map.has(prior.mediaToken)) {
        runtimeStores.fileContents.delete(fileId);
      }
    }
    runtimeStores.fileContents.set(id, content);
  };

  function buildFileContent(
    db: ReturnType<typeof room>["conn"],
    runtimeStores: FileRuntimeStores,
    id: string,
    name: string,
    mime0: string | null,
    bytes: Buffer | null,
    extracted: string | null,
    stagedToken: string | null = null,
  ): FileContent {
    const mime = mime0 ?? "application/octet-stream";
    const kind = contentKind(db, id, name, mime);
    const content: FileContent = {
      kind,
      name,
      mime,
      editable: viewerKindIsEditable(kind),
      text: contentText(kind, mime, bytes, extracted),
      dataB64: null,
      mediaToken: contentMediaToken(runtimeStores, stagedToken, kind, mime, name, bytes),
      mediaMeta: jsonOrNull(getMediaMeta(db, id)),
      webMeta: jsonOrNull(getWebMeta(db, id)),
    };
    cacheStagedContent(runtimeStores, id, content);
    return content;
  }

  type WorkspaceFileRow = {
    name: string;
    mime_type: string | null;
    extracted_text: string | null;
    size_bytes: number;
    storage_kind: string | null;
  };

  const workspaceFileRow = (open: ReturnType<typeof room>, id: string): WorkspaceFileRow | undefined => {
    return open.conn.prepare(
      "SELECT name, mime_type, extracted_text, size_bytes, storage_kind FROM files WHERE id = ? AND trashed_at IS NULL",
    ).get(id) as WorkspaceFileRow | undefined;
  };

  const streamWorkspaceFile = (
    open: ReturnType<typeof room>,
    id: string,
    row: WorkspaceFileRow,
  ): FileContent | Promise<FileContent> => {
    const mime = row.mime_type ?? "application/octet-stream";
    const kind = contentKind(open.conn, id, row.name, mime);
    if (viewerKindReadsRawText(kind)) {
      return readAll(open.workspace!.readStream(id)).then((bytes) =>
        buildFileContent(open.conn, stores, id, row.name, row.mime_type, bytes, row.extracted_text));
    }
    const token = stageMediaStream(
      stores.mediaStreams,
      row.size_bytes,
      stageMime(kind, mime, row.name),
      async () => open.workspace!.readStream(id),
      async (start, end) => open.workspace!.readStream(id, { start, end }),
    );
    return buildFileContent(open.conn, stores, id, row.name, row.mime_type, null, row.extracted_text, token);
  };

  const databaseFileContent = (open: ReturnType<typeof room>, id: string): FileContent => {
    const [name, mime0, bytes, extracted] = getFileFull(open.conn, id);
    return buildFileContent(open.conn, stores, id, name, mime0, bytes, extracted);
  };

  const restoreWorkspaceFile = async (open: ReturnType<typeof room>, id: string): Promise<FileContent> => {
    await open.workspace!.materializeLiveBlobFile(id);
    const repaired = workspaceFileRow(open, id);
    if (repaired === undefined || repaired.storage_kind !== "workspace") {
      throw new Error("That file could not be restored to the workspace.");
    }
    return streamWorkspaceFile(open, id, repaired);
  };

  const workspaceFileContent = (open: ReturnType<typeof room>, id: string): FileContent | Promise<FileContent> => {
    const row = workspaceFileRow(open, id);
    if (row === undefined) throw new Error("File not found.");
    if (row.storage_kind === "workspace") return streamWorkspaceFile(open, id, row);
    if (open.readOnly === true) return databaseFileContent(open, id);
    return restoreWorkspaceFile(open, id);
  };

  const cachedFileContent = (id: string): FileContent | null => {
    const cached = stores.fileContents.get(id);
    if (cached?.mediaToken && stores.mediaStreams.map.has(cached.mediaToken)) return cached;
    if (cached) stores.fileContents.delete(id);
    return null;
  };

  const derivedFileContent = async (open: ReturnType<typeof room>, id: string): Promise<FileContent | null> => {
    const derived = await resolveDerivedPreview({ db: open.conn, path: open.path }, id);
    if (derived === null) return null;
    const original = getFileMeta(open.conn, id);
    const content = buildFileContent(
      open.conn,
      stores,
      derived.preview.id,
      derived.preview.name,
      derived.preview.mimeType,
      derived.bytes,
      null,
    );
    content.name = derived.originalName;
    content.derivedPreview = {
      kind: derived.preview.provenance === "snapshot" ? "stored-snapshot" : "stored-preview",
      originalMime: original.mimeType,
    };
    return content;
  };

  ipcMain.handle("get_file_content", async (_e: IpcMainInvokeEvent, raw: unknown): Promise<FileContent> => {
    const id = String(rec(raw).id ?? "");
    const cached = cachedFileContent(id);
    if (cached !== null) return cached;
    const open = room();
    const derived = await derivedFileContent(open, id);
    if (derived !== null) return derived;
    if (open.workspace !== undefined) return workspaceFileContent(open, id);
    return databaseFileContent(open, id);
  });

  registerFileRuntimeUtilityIpc(ipcMain, state, deps, room, changed, stores, host);
  return stores;
}
