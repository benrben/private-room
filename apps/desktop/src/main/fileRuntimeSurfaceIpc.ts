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
import { getRecMeta } from "./db-host/recordings.js";
import { logDir } from "./obs.js";
import { isCodeTextExtension } from "../shared/fileExtensions.js";
import sharp from "sharp";

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
   * committed. The import response does not wait for the long-running job. */
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

function rec(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function viewerKind(name: string, mime: string): ViewerKind {
  const e = ext(name);
  // Extension-specific formats must win over broad MIME families. Illustrator
  // files are commonly labelled PostScript or generic binary even when their
  // modern payload is PDF-compatible, while SVG has its own safe text viewer.
  if (e === "ai" || e === "pdf") return "pdf";
  if (e === "svg") return "svg";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (e === "docx") return "docx";
  if (e === "doc") return "worddoc";
  if (["xlsx", "xls", "ods"].includes(e)) return "sheet";
  if (["csv", "tsv"].includes(e)) return "csv";
  if (["pptx", "ppt", "odp"].includes(e)) return "slides";
  if (["epub", "mobi", "azw", "azw3", "fb2", "cbz"].includes(e)) return "book";
  if (["zip", "tar", "gz", "7z", "rar"].includes(e)) return "archive";
  if (["md", "markdown"].includes(e)) return "markdown";
  if (["html", "htm"].includes(e)) return "html";
  if (e === "sketch") return "sketch";
  if (e === "ipynb") return "notebook";
  if (e === "json") return "json";
  if (["srt", "vtt"].includes(e)) return "subtitle";
  if (["eml", "msg"].includes(e)) return "email";
  if (e === "txt") return "prose";
  if (["log"].includes(e)) return "log";
  if (isCodeTextExtension(e)) return "code";
  if (mime.startsWith("text/")) return "text";
  return "binary";
}

export function shouldAutoTranscribeImport(name: string, mime: string): boolean {
  return ext(name) === "flac" && mime.startsWith("audio/");
}

const RAW_TEXT_VIEWER_KINDS: ReadonlySet<ViewerKind> = new Set([
  "markdown", "html", "json", "subtitle", "prose", "log", "code", "text", "sketch", "notebook",
]);

const EDITABLE_VIEWER_KINDS: ReadonlySet<ViewerKind> = new Set([
  "markdown", "html", "json", "subtitle", "prose", "log", "code", "text", "csv", "notebook",
]);

export function viewerKindIsEditable(kind: ViewerKind): boolean {
  return EDITABLE_VIEWER_KINDS.has(kind);
}

export function viewerKindReadsRawText(kind: ViewerKind): boolean {
  return RAW_TEXT_VIEWER_KINDS.has(kind);
}

function jsonOrNull<T>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total);
}

/** Validate the complete picker selection before importing the first item.
 * Finder packages such as .numbers and .rtfd are directories; treating them
 * as flat files produced partial rows followed by UNIQUE/EISDIR errors. A
 * package-aware archive format is not defined yet, so refuse the whole batch
 * without residue. */
export async function preflightImportPaths(filePaths: readonly string[]): Promise<string[]> {
  const checks = await Promise.all(filePaths.map(async (filePath) => {
    try {
      const info = await fs.promises.stat(filePath);
      return info.isFile()
        ? null
        : `${path.basename(filePath)}: Folder/package imports are not supported. Export or compress the package as one file first.`;
    } catch (error) {
      return `${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }));
  return checks.filter((message): message is string => message !== null);
}

/** Quick Look promises PNG bytes. Check its signature, then fully decode it
 * before trusting the dimensions or making a RAW fallback durable. */
export async function rawFallbackPngDimensions(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  const png = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    png.toString("ascii", 12, 16) !== "IHDR"
  ) return null;
  try {
    // Force a complete pixel decode, not just metadata parsing. A forged IHDR
    // with missing/truncated IDAT bytes must never become a durable preview.
    const decoded = await sharp(png, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    const { width, height } = decoded.info;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

/** Decode Quick Look's PNG completely, enforce the RAW minimum, and publish a
 * normal JPEG that the image viewer can reopen without relying on Quick Look. */
export async function rawFallbackJpeg(png: Uint8Array): Promise<Buffer | null> {
  const dimensions = await rawFallbackPngDimensions(png);
  if (dimensions === null || dimensions.width < MIN_RAW_PREVIEW_WIDTH) return null;
  try {
    const jpeg = await sharp(png, { failOn: "error" }).jpeg({ quality: 90 }).toBuffer();
    const verified = await sharp(jpeg, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    return verified.info.width >= MIN_RAW_PREVIEW_WIDTH && verified.info.height > 0 ? jpeg : null;
  } catch {
    return null;
  }
}

/** Store a RAW Quick Look fallback only when it is a readable, full-size PNG.
 * Returning unavailable keeps an unsupported CR2 honest instead of silently
 * persisting corrupt pixels or another small embedded thumbnail. */
export function snapshotRawFallback(
  room: RoomContentHandle,
  originalId: string,
  render: PreviewRenderFn = renderQuickLook,
): Promise<DerivedPreviewStoreResult> {
  return snapshotUnknownFormat(room, originalId, render, {
    prepare: async (png) => {
      const jpeg = await rawFallbackJpeg(png);
      return jpeg === null ? null : { bytes: jpeg, mimeType: "image/jpeg", extension: "jpg" };
    },
  });
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

  const deriveImportedPreview = async (
    open: ReturnType<typeof room>,
    fileId: string,
    name: string,
    mime: string,
    bytes: Buffer,
    extracted: string | null,
  ): Promise<void> => {
    const extension = ext(name);
    const converted = await officePdf(name, bytes);
    if (converted !== null) {
      await storeDerivedPreview({ db: open.conn, path: open.path }, fileId, converted, "application/pdf", "pdf");
      return;
    }
    const rawExtensions = new Set(["3fr", "arw", "cr2", "cr3", "dng", "erf", "kdc", "mos", "mrw", "nef", "nrw", "orf", "pef", "raf", "raw", "rw2", "sr2", "srf", "x3f"]);
    if (rawExtensions.has(extension)) {
      const preview = extractRawPreview(bytes);
      if (preview !== null) {
        await storeDerivedPreview({ db: open.conn, path: open.path }, fileId, preview.bytes, "image/jpeg", "jpg");
        return;
      }
    }
    const iWork = ["pages", "key", "numbers"].includes(extension);
    if (iWork) {
      const preview = extractIWorkPreview(bytes);
      if (preview !== null) {
        await storeDerivedPreview(
          { db: open.conn, path: open.path }, fileId, preview.bytes, preview.mimeType, preview.extension,
        );
        return;
      }
    }
    const invalidIllustratorPdf = extension === "ai" && !bytes.subarray(0, 8).toString("ascii").startsWith("%PDF-");
    const needsNativeFallback = iWork || rawExtensions.has(extension) || ["heic", "heif"].includes(extension);
    if (rawExtensions.has(extension)) {
      await snapshotRawFallback({ db: open.conn, path: open.path }, fileId);
    } else if ((viewerKind(name, mime) === "binary" && !extracted?.trim()) || invalidIllustratorPdf || needsNativeFallback) {
      await snapshotUnknownFormat({ db: open.conn, path: open.path }, fileId);
    }
  };

  ipcMain.handle("import_files", async (_e: IpcMainInvokeEvent, raw: unknown) => {
    const paths = rec(raw).paths;
    const report: { imported: ReturnType<typeof insertFile>[]; errors: string[] } = { imported: [], errors: [] };
    const filePaths = Array.isArray(paths) ? paths.filter((v): v is string => typeof v === "string") : [];
    report.errors = await preflightImportPaths(filePaths);
    if (report.errors.length > 0) return report;
    for (const filePath of filePaths) {
      try {
        const open = room();
        const name = availableName(open.conn, path.basename(filePath));
        const mime = guessDownloadMime(name);
        let meta: ReturnType<typeof insertFile>;
        let importedBytes: Buffer | null = null;
        if (open.workspace !== undefined && (mime.startsWith("audio/") || mime.startsWith("video/"))) {
          // Media has no document text to extract and is not an OCR candidate.
          // Import it directly as a stream instead of allocating the entire
          // recording or video in the Electron main-process heap.
          meta = await open.workspace.importFile(filePath, name).then((entry) => {
            open.conn.prepare(
              "UPDATE files SET mime_type = ? WHERE id = ?",
            ).run(mime, entry.fileId);
            return getFileMeta(open.conn, entry.fileId);
          });
        } else {
          const bytes = await fs.promises.readFile(filePath);
          importedBytes = bytes;
          const extracted = await extractDocumentText(name, bytes);
          meta = open.workspace === undefined
            ? insertFile(open.conn, name, mime, bytes, extracted, "import")
            : await open.workspace.importFile(filePath, name).then((entry) => {
              open.conn.prepare(
                "UPDATE files SET mime_type = ?, extracted_text = ? WHERE id = ?",
              ).run(mime, extracted, entry.fileId);
              return getFileMeta(open.conn, entry.fileId);
            });
          if (!extracted || extracted.trim() === "") startOcr(open.path, meta.id, name, mime, bytes);
        }
        report.imported.push(meta);
        if (importedBytes !== null) {
          const extracted = open.conn.prepare("SELECT extracted_text FROM files WHERE id = ?").get(meta.id) as { extracted_text: string | null };
          await deriveImportedPreview(open, meta.id, name, mime, importedBytes, extracted.extracted_text).catch(() => undefined);
        }
        if (shouldAutoTranscribeImport(name, mime)) {
          void actions.retranscribeImportedFile?.(meta.id).catch(() => undefined);
        }
      } catch (error) {
        report.errors.push(`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (report.imported.length) {
      changed();
      deps.scheduleAutoIndex?.(room().path);
    }
    return report;
  });

  ipcMain.handle("get_file_content", async (_e: IpcMainInvokeEvent, raw: unknown): Promise<FileContent> => {
    const id = String(rec(raw).id ?? "");
    const cached = stores.fileContents.get(id);
    if (cached?.mediaToken && stores.mediaStreams.map.has(cached.mediaToken)) {
      return cached;
    }
    if (cached) stores.fileContents.delete(id);
    const open = room();
    const derived = await resolveDerivedPreview({ db: open.conn, path: open.path }, id);
    if (derived !== null) {
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
        // Read persisted generation provenance, never infer from MIME. RAW
        // Quick Look snapshots are validated and transcoded to JPEG, while an
        // embedded camera preview is also JPEG; only the stored source tells
        // those two truthful stories apart after relaunch.
        kind: derived.preview.provenance === "snapshot" ? "stored-snapshot" : "stored-preview",
        originalMime: original.mimeType,
      };
      return content;
    }
    if (open.workspace !== undefined) {
      let row = open.conn.prepare(
        "SELECT name, mime_type, extracted_text, size_bytes, storage_kind FROM files WHERE id = ? AND trashed_at IS NULL",
      ).get(id) as {
        name: string;
        mime_type: string | null;
        extracted_text: string | null;
        size_bytes: number;
        storage_kind: string | null;
      } | undefined;
      if (row === undefined) throw new Error("File not found.");
      const finish = (current: NonNullable<typeof row>): FileContent | Promise<FileContent> => {
        const mime = current.mime_type ?? "application/octet-stream";
        const kind = getRecMeta(open.conn, id) !== null ? "recording" : viewerKind(current.name, mime);
        // A sketch is JSON edited by its own canvas. It needs the real document
        // text, not a roommedia token and not `extracted_text` (which contains
        // only the drawing's searchable labels). Treating it as a byte viewer
        // made converted sketches open on those labels, so the canvas reported
        // malformed JSON and could neither draw nor save.
        const byteViewer = !viewerKindReadsRawText(kind);
        if (byteViewer) {
          // The legacy database may carry MIME labels such as `audio/m4a` or
          // `audio/mp4a-latm`. Chromium does not accept those labels for the
          // AAC-in-MP4 bytes it can otherwise play. Conversion deliberately
          // preserves that metadata, so normalize the response type when the
          // normal workspace file is staged, not only when a new file is
          // imported. This also gives old octet-stream media a playable type
          // from its extension.
          const streamMime = kind === "audio" || kind === "recording" || kind === "video"
            ? playableMediaMime(mime, ext(current.name), kind === "video")
            : mime;
          const token = stageMediaStream(
            stores.mediaStreams,
            current.size_bytes,
            streamMime,
            async () => open.workspace!.readStream(id),
            async (start, end) => open.workspace!.readStream(id, { start, end }),
          );
          return buildFileContent(
            open.conn,
            stores,
            id,
            current.name,
            current.mime_type,
            null,
            current.extracted_text,
            token,
          );
        }
        return readAll(open.workspace!.readStream(id)).then((bytes) =>
          buildFileContent(open.conn, stores, id, current.name, current.mime_type, bytes, current.extracted_text));
      };
      if (row.storage_kind === "workspace") return finish(row);
      // A second Arcelle process may open the room read-only while the writer
      // lease is held elsewhere. Opening a legacy DB-only row must not mutate
      // that room just to display it. Serve its encrypted DB bytes for this
      // session; the writable owner (or the next writable open) will perform
      // the one-time materialization into a normal workspace file.
      if (open.readOnly === true) {
        const [name, mime0, bytes, extracted] = getFileFull(open.conn, id);
        return buildFileContent(open.conn, stores, id, name, mime0, bytes, extracted);
      }
      return open.workspace.materializeLiveBlobFile(id).then(() => {
        const repaired = open.conn.prepare(
          "SELECT name, mime_type, extracted_text, size_bytes, storage_kind FROM files WHERE id = ? AND trashed_at IS NULL",
        ).get(id) as typeof row;
        if (repaired === undefined || repaired.storage_kind !== "workspace") {
          throw new Error("That file could not be restored to the workspace.");
        }
        return finish(repaired);
      });
    }
    const [name, mime0, bytes, extracted] = getFileFull(open.conn, id);
    return buildFileContent(open.conn, stores, id, name, mime0, bytes, extracted);
  });

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
    // A `recordings` row—not the WAV MIME—is the database's explicit marker
    // for Arcelle's recording editor. Without this check every live capture
    // was routed to the generic AudioView, hiding pause/resume/stop while the
    // backend session continued to run.
    const kind: ViewerKind = getRecMeta(db, id) !== null
      ? "recording"
      : viewerKind(name, mime);
    const byteViewer = !viewerKindReadsRawText(kind);
    const stagedMime = kind === "audio" || kind === "recording" || kind === "video"
      ? playableMediaMime(mime, ext(name), kind === "video")
      : mime;
    const content: FileContent = {
      kind,
      name,
      mime,
      editable: viewerKindIsEditable(kind),
      // `extracted` is deliberately just labels for a sketch, so search can
      // find a diagram without indexing coordinates and JSON keys. The canvas
      // must instead receive the exact normal-file document.
      text: kind === "sketch" || kind === "notebook"
        ? (bytes === null ? null : bytes.toString("utf8"))
        : extracted ?? (bytes && mime.startsWith("text/") ? bytes.toString("utf8") : null),
      dataB64: null,
      mediaToken: stagedToken ?? (byteViewer && bytes ? stageMediaBytes(runtimeStores.mediaStreams, bytes, stagedMime) : null),
      mediaMeta: jsonOrNull(getMediaMeta(db, id)),
      webMeta: jsonOrNull(getWebMeta(db, id)),
    };
    if (content.mediaToken) {
      // `stageMediaBytes` may have evicted older tokens. Prune their cheap
      // response records too, keeping this cache naturally bounded by the
      // media staging limits (currently four entries / 1.5 GB).
      for (const [fileId, prior] of runtimeStores.fileContents) {
        if (!prior.mediaToken || !runtimeStores.mediaStreams.map.has(prior.mediaToken)) {
          runtimeStores.fileContents.delete(fileId);
        }
      }
      runtimeStores.fileContents.set(id, content);
    }
    return content;
  }

  ipcMain.handle("decode_file_text", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = rec(raw);
    const open = room();
    const id = String(a.id ?? "");
    const decode = (name: string, bytes: Buffer) => {
      const chosen = typeof a.encoding === "string" && a.encoding.trim() ? a.encoding : null;
      const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      const encoding = chosen ?? "UTF-8";
      let lossy = false;
      let text: string;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder(encoding, { fatal: false }).decode(bytes); lossy = true; }
      return {
        text, encoding, source: chosen ? "chosen" : bom ? "bom" : "utf8", lossy,
        editable: !lossy && viewerKind(name, guessDownloadMime(name)) !== "binary",
        options: [
          { name: "UTF-8", title: "Unicode (UTF-8)" },
          { name: "windows-1252", title: "Western (Windows-1252)" },
          { name: "windows-1255", title: "Hebrew (Windows-1255)" },
          { name: "windows-1251", title: "Cyrillic (Windows-1251)" },
        ],
      };
    };
    if (open.workspace !== undefined) {
      const row = open.conn.prepare(
        "SELECT name FROM files WHERE id = ? AND trashed_at IS NULL",
      ).get(id) as { name: string } | undefined;
      if (row === undefined) throw new Error("File not found.");
      return readAll(open.workspace.readStream(id)).then((bytes) => decode(row.name, bytes));
    }
    const [name, _mime, bytes] = getFileFull(open.conn, id);
    if (!bytes) throw new Error("This file has no stored bytes.");
    return decode(name, bytes);
  });

  ipcMain.handle("import_link", async (_e: IpcMainInvokeEvent, raw: unknown) => {
    const url = String(rec(raw).url ?? "");
    const page = await fetchReadable(url);
    const open = room();
    const name = availableName(open.conn, `${page.title || new URL(url).hostname}.md`);
    const content = `# ${page.title}\n\nSource: ${url}\n\n${page.text}`;
    const meta = open.workspace === undefined
      ? insertFileFromUrl(open.conn, name, "text/markdown", Buffer.from(content), content, "web", url)
      : await open.workspace.createFile(name, Readable.from([Buffer.from(content)]), "web").then((entry) => {
        open.conn.prepare(
          "UPDATE files SET mime_type = 'text/markdown', origin_url = ? WHERE id = ?",
        ).run(url, entry.fileId);
        setFileExtractedText(open.conn, entry.fileId, content);
        return getFileMeta(open.conn, entry.fileId);
      });
    changed();
    deps.scheduleAutoIndex?.(open.path);
    return meta;
  });
  ipcMain.handle("open_scratch_pad", async () => {
    const open = room();
    const db = open.conn;
    const existing = fileByExactName(db, SCRATCH_PAD_NAME);
    if (existing) return existing;
    const content = "# Scratch pad\n\n";
    const meta = open.workspace === undefined
      ? insertFile(db, SCRATCH_PAD_NAME, "text/markdown", Buffer.from(content), content, "generated")
      : await open.workspace.createFile(
        SCRATCH_PAD_NAME,
        Readable.from([Buffer.from(content)]),
        "generated",
      ).then((entry) => {
        db.prepare("UPDATE files SET mime_type = 'text/markdown' WHERE id = ?").run(entry.fileId);
        setFileExtractedText(db, entry.fileId, content);
        return getFileMeta(db, entry.fileId);
      });
    changed();
    deps.scheduleAutoIndex?.(open.path);
    return meta;
  });
  ipcMain.handle("open_html_in_browser", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = rec(raw);
    return openHtmlInBrowser(String(a.name ?? "preview"), String(a.html ?? ""), host.openPath);
  });
  ipcMain.handle("stage_preview_html", (_e: IpcMainInvokeEvent, raw: unknown) =>
    stagePreviewHtmlCore(stores.htmlPreviews, String(rec(raw).html ?? "")));
  ipcMain.handle("reveal_logs", async () => {
    // Host and sidecar logs intentionally share this OS temp directory. The
    // old userData/logs target was an unrelated empty folder in installed
    // builds, so it could not help diagnose a host or sidecar failure.
    const logs = logDir();
    await host.openPath(logs);
    return logs;
  });
  ipcMain.handle("web_search_test", async () => {
    const page = await searchWeb("Arcelle connectivity test");
    return page.hits.length > 0
      ? `Online search is working (${page.hits.length} results).`
      : page.failed.length > 0 ? `Search was blocked by: ${page.failed.join(", ")}.` : "Search connected, but returned no results.";
  });
  ipcMain.handle("studio_prompts", () => studioPrompts());
  ipcMain.handle("resolve_mcp_call", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = rec(raw);
    const resolve = state.mcpPending.get(String(a.id ?? ""));
    if (!resolve) throw new Error("That connector approval is no longer pending.");
    state.mcpPending.delete(String(a.id ?? ""));
    const decision = String(a.decision ?? "deny");
    resolve({ approved: decision === "always" || decision === "once", remember: decision === "always" });
  });
  return stores;
}
