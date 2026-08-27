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

function viewerKind(name: string, mime: string): ViewerKind {
  const e = ext(name);
  if (mime.startsWith("image/")) return e === "svg" ? "svg" : "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (e === "pdf") return "pdf";
  if (e === "docx") return "docx";
  if (e === "doc") return "worddoc";
  if (["xlsx", "xls", "ods"].includes(e)) return "sheet";
  if (["csv", "tsv"].includes(e)) return "csv";
  if (["pptx", "ppt", "odp"].includes(e)) return "slides";
  if (["epub", "mobi"].includes(e)) return "book";
  if (["zip", "tar", "gz", "7z", "rar"].includes(e)) return "archive";
  if (["md", "markdown"].includes(e)) return "markdown";
  if (["html", "htm"].includes(e)) return "html";
  if (e === "sketch") return "sketch";
  if (e === "json") return "json";
  if (["srt", "vtt"].includes(e)) return "subtitle";
  if (["eml", "msg"].includes(e)) return "email";
  if (["py", "js", "ts", "tsx", "jsx", "rs", "sh", "css", "xml", "yaml", "yml"].includes(e)) return "code";
  if (["log"].includes(e)) return "log";
  if (mime.startsWith("text/")) return "text";
  return "binary";
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

export function registerFileRuntimeSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  _userDataDir: string,
  emit: EventSender,
  host: FileRuntimeHost,
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

  ipcMain.handle("import_files", async (_e: IpcMainInvokeEvent, raw: unknown) => {
    const paths = rec(raw).paths;
    const report: { imported: ReturnType<typeof insertFile>[]; errors: string[] } = { imported: [], errors: [] };
    for (const filePath of Array.isArray(paths) ? paths.filter((v): v is string => typeof v === "string") : []) {
      try {
        const open = room();
        const name = availableName(open.conn, path.basename(filePath));
        const mime = guessDownloadMime(name);
        let meta: ReturnType<typeof insertFile>;
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

  ipcMain.handle("get_file_content", (_e: IpcMainInvokeEvent, raw: unknown): FileContent | Promise<FileContent> => {
    const id = String(rec(raw).id ?? "");
    const cached = stores.fileContents.get(id);
    if (cached?.mediaToken && stores.mediaStreams.map.has(cached.mediaToken)) {
      return cached;
    }
    if (cached) stores.fileContents.delete(id);
    const open = room();
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
        const byteViewer = !["markdown", "html", "json", "subtitle", "prose", "log", "code", "text", "sketch"]
          .includes(kind);
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
    const byteViewer = !["markdown", "html", "json", "subtitle", "prose", "log", "code", "text", "sketch"].includes(kind);
    const stagedMime = kind === "audio" || kind === "recording" || kind === "video"
      ? playableMediaMime(mime, ext(name), kind === "video")
      : mime;
    const content: FileContent = {
      kind,
      name,
      mime,
      editable: ["markdown", "html", "json", "subtitle", "prose", "log", "code", "text", "csv"].includes(kind),
      // `extracted` is deliberately just labels for a sketch, so search can
      // find a diagram without indexing coordinates and JSON keys. The canvas
      // must instead receive the exact normal-file document.
      text: kind === "sketch"
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
