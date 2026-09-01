/** Text decoding and small file-runtime utility IPC registrations. */

import { Readable } from "node:stream";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { FileRuntimeHost, FileRuntimeStores } from "./fileRuntimeSurfaceIpc.js";
import {
  availableName,
  fileByExactName,
  getFileFull,
  getFileMeta,
  insertFile,
  insertFileFromUrl,
  setFileExtractedText,
} from "./db-host/files.js";
import { guessDownloadMime, fetchReadable } from "./webFetch.js";
import { SCRATCH_PAD_NAME } from "./docsHtml.js";
import { openHtmlInBrowser, stagePreviewHtmlCore, studioPrompts } from "./studiosCmds.js";
import { searchWeb } from "./webSearch.js";
import { logDir } from "./obs.js";
import { readAll, rec, viewerKind } from "./fileRuntimeSupport.js";

export function registerFileRuntimeUtilityIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  room: () => NonNullable<RoomManagerState["room"]>,
  changed: () => void,
  stores: FileRuntimeStores,
  host: FileRuntimeHost,
): void {
  const requestedEncoding = (raw: Record<string, unknown>): string | null => {
    return typeof raw.encoding === "string" && raw.encoding.trim() ? raw.encoding : null;
  };

  const decodeText = (bytes: Buffer, encoding: string): { text: string; lossy: boolean } => {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), lossy: false };
    } catch {
      return { text: new TextDecoder(encoding, { fatal: false }).decode(bytes), lossy: true };
    }
  };

  const decodeSource = (chosen: string | null, bytes: Buffer): "chosen" | "bom" | "utf8" => {
    if (chosen !== null) return "chosen";
    return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "bom" : "utf8";
  };

  const decodedFileText = (name: string, bytes: Buffer, chosen: string | null) => {
    const encoding = chosen ?? "UTF-8";
    const decoded = decodeText(bytes, encoding);
    return {
      text: decoded.text,
      encoding,
      source: decodeSource(chosen, bytes),
      lossy: decoded.lossy,
      editable: !decoded.lossy && viewerKind(name, guessDownloadMime(name)) !== "binary",
      options: [
        { name: "UTF-8", title: "Unicode (UTF-8)" },
        { name: "windows-1252", title: "Western (Windows-1252)" },
        { name: "windows-1255", title: "Hebrew (Windows-1255)" },
        { name: "windows-1251", title: "Cyrillic (Windows-1251)" },
      ],
    };
  };

  const workspaceDecodedText = async (
    open: ReturnType<typeof room>,
    id: string,
    chosen: string | null,
  ) => {
    const row = open.conn.prepare("SELECT name FROM files WHERE id = ? AND trashed_at IS NULL")
      .get(id) as { name: string } | undefined;
    if (row === undefined) throw new Error("File not found.");
    return decodedFileText(row.name, await readAll(open.workspace!.readStream(id)), chosen);
  };

  ipcMain.handle("decode_file_text", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const request = rec(raw);
    const open = room();
    const id = String(request.id ?? "");
    const chosen = requestedEncoding(request);
    if (open.workspace !== undefined) return workspaceDecodedText(open, id, chosen);
    const [name, _mime, bytes] = getFileFull(open.conn, id);
    if (!bytes) throw new Error("This file has no stored bytes.");
    return decodedFileText(name, bytes, chosen);
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
}
