/** Live Electron wiring for the private-browser command surface. */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { WindowContentView } from "./browser/webviewManager.js";
import { Browser } from "./browser/browser.js";
import {
  browserClearJournal,
  browserClearScope,
  browserCloseTab,
  browserGo,
  browserInfo,
  browserJournal,
  browserNavigate,
  browserNewTab,
  browserRetryProtection,
  browserSavePage,
  browserSelectTab,
  browserSetBounds,
  browserSetTakeover,
  browserTabs,
  browserVerifyPrivate,
  type BrowseCommandsDeps,
} from "./browser/browseCommands.js";
import { browserFocusApp, browserPageSelection, browserPageText } from "./browser/reader.js";
import {
  browserPeek,
  browserPreview,
  browserSearchSummary,
  importSearchResult,
  runSearch,
} from "./browser/search.js";
import { fetchImage, fetchPage, fetchPreview, fetchReadable, guessDownloadMime } from "./webFetch.js";
import { searchForBrowser } from "./webSearch.js";
import { generate } from "./ollamaGenerate.js";
import { modelSetting } from "./gatherContext.js";
import {
  availableName,
  getFileMeta,
  insertFileFromUrl,
  setFileExtractedText,
  type FileMeta,
} from "./db-host/files.js";
import { safeFileName } from "./browser/downloads.js";

export interface BrowserSurfaceHost {
  windowContentView(): WindowContentView | null;
  focusMainWindow(): void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function cleanTitle(value: string, fallback: string): string {
  const safe = safeFileName(value.trim() || fallback).replace(/\.(md|markdown)$/i, "");
  return safe === "" ? "Web source" : safe;
}

export function registerBrowserSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  userDataDir: string,
  emit: EventSender,
  host: BrowserSurfaceHost,
): Browser {
  const stagingDir = path.join(userDataDir, "browser-downloads");
  const currentDb = () => state.room?.conn ?? null;
  const notifyFiles = (): void => emit("room-files-changed", {});
  const afterImport = (): void => {
    notifyFiles();
    if (state.room) deps.scheduleAutoIndex?.(state.room.path);
    if (deps.privacyScan) {
      void import("./privacy.js").then(({ schedulePrivacyScan }) => schedulePrivacyScan(deps.privacyScan!));
    }
  };

  const importBytes = async (stagedPath: string, name: string, url: string): Promise<FileMeta> => {
    const room = state.room;
    if (!room) throw new Error("No room is open.");
    const finalName = availableName(room.conn, safeFileName(name));
    const mime = guessDownloadMime(finalName);
    let meta: FileMeta;
    if (room.workspace === undefined) {
      const bytes = await fs.promises.readFile(stagedPath);
      const text = mime.startsWith("text/") ? bytes.toString("utf8") : null;
      meta = insertFileFromUrl(room.conn, finalName, mime, bytes, text, "web", url);
    } else {
      const text = mime.startsWith("text/") ? await fs.promises.readFile(stagedPath, "utf8") : null;
      const content = text === null
        ? fs.createReadStream(stagedPath)
        : Readable.from([Buffer.from(text, "utf8")]);
      const entry = await room.workspace.createFile(finalName, content, "web");
      room.conn.prepare("UPDATE files SET mime_type = ?, origin_url = ? WHERE id = ?")
        .run(mime, url, entry.fileId);
      if (text !== null) setFileExtractedText(room.conn, entry.fileId, text);
      meta = getFileMeta(room.conn, entry.fileId);
    }
    afterImport();
    return meta;
  };

  const browser = new Browser({
    windowContentView: host.windowContentView,
    journalSink: {
      get db() { return currentDb(); },
      emit: (row) => emit("browser-journal", row),
    },
    emit,
    stagingDir: () => stagingDir,
    ensureStagingDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    removeStagedFile: (file) => fs.promises.rm(file, { force: true }),
    removeStagingDir: (dir) => fs.promises.rm(dir, { recursive: true, force: true }),
    importFinishedDownload: async (file, name, url) => {
      try {
        return await importBytes(file, name, url);
      } finally {
        await fs.promises.rm(file, { force: true }).catch(() => {});
      }
    },
  });

  // The room lifecycle and browser IPC share this exact runtime instance.
  deps.closeBrowser = () => browser.close();

  const commandDeps = (): BrowseCommandsDeps => ({
    browser,
    db: currentDb(),
    roomPath: state.room?.path ?? "",
    ...(state.room?.workspace === undefined ? {} : { workspace: state.room.workspace }),
    // File rows and search chunks are committed synchronously by insertFile;
    // the optional AI-summary filler is wired with the job surface later.
    scheduleAutoIndex: (roomPath) => deps.scheduleAutoIndex?.(roomPath),
    schedulePrivacyScan: () => {
      if (deps.privacyScan) {
        void import("./privacy.js").then(({ schedulePrivacyScan }) => schedulePrivacyScan(deps.privacyScan!));
      }
    },
    emitFilesChanged: notifyFiles,
  });

  const importWebSource = async (url: string, title: string): Promise<FileMeta> => {
    const room = state.room;
    if (!room) throw new Error("No room is open.");
    const page = await fetchReadable(url);
    const display = title.trim() || page.title || new URL(url).hostname;
    const name = availableName(room.conn, `${cleanTitle(display, "Web source")}.md`);
    const content = `# ${display}\n\nSource: ${url}\n\n${page.text}`;
    const meta = room.workspace === undefined
      ? insertFileFromUrl(
          room.conn, name, "text/markdown", Buffer.from(content, "utf8"), content, "web", url,
        )
      : await room.workspace.createFile(
          name,
          Readable.from([Buffer.from(content, "utf8")]),
          "web",
        ).then((entry) => {
          room.conn.prepare(
            "UPDATE files SET mime_type = 'text/markdown', origin_url = ? WHERE id = ?",
          ).run(url, entry.fileId);
          setFileExtractedText(room.conn, entry.fileId, content);
          return getFileMeta(room.conn, entry.fileId);
        });
    afterImport();
    return meta;
  };

  ipcMain.handle("browser_navigate", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserNavigate(commandDeps(), String(record(raw).url ?? "")));
  ipcMain.handle("browser_new_tab", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserNewTab(commandDeps(), String(record(raw).url ?? "")));
  ipcMain.handle("browser_select_tab", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserSelectTab(commandDeps(), String(record(raw).id ?? "")));
  ipcMain.handle("browser_close_tab", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserCloseTab(commandDeps(), String(record(raw).id ?? "")));
  ipcMain.handle("browser_tabs", () => browserTabs(commandDeps()));
  ipcMain.handle("browser_set_bounds", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = record(raw);
    return browserSetBounds(commandDeps(), {
      x: Number(a.x), y: Number(a.y), width: Number(a.width), height: Number(a.height),
    });
  });
  ipcMain.handle("browser_info", () => browserInfo(commandDeps()));
  ipcMain.handle("browser_go", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserGo(commandDeps(), String(record(raw).action ?? "")));
  ipcMain.handle("browser_set_takeover", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserSetTakeover(commandDeps(), record(raw).on === true));
  ipcMain.handle("browser_journal", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const limit = record(raw).limit;
    return browserJournal(commandDeps(), typeof limit === "number" ? limit : undefined);
  });
  ipcMain.handle("browser_clear_journal", () => browserClearJournal(commandDeps()));
  ipcMain.handle("browser_clear_scope", () => browserClearScope(commandDeps()));
  ipcMain.handle("browser_verify_private", () => browserVerifyPrivate(commandDeps()));
  ipcMain.handle("browser_retry_protection", () => browserRetryProtection(commandDeps()));
  ipcMain.handle("browser_save_page", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserSavePage(commandDeps(), String(record(raw).what ?? "page")));
  ipcMain.handle("browser_page_text", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = record(raw);
    return browserPageText(browser, String(a.mode ?? "main"), Number(a.offset ?? 0));
  });
  ipcMain.handle("browser_page_selection", () => browserPageSelection(browser));
  ipcMain.handle("browser_focus_app", () => host.focusMainWindow());
  ipcMain.handle("browser_search", (_e: IpcMainInvokeEvent, raw: unknown) =>
    runSearch({
      db: currentDb(), searchForBrowser,
      hasModelConfigured: (db) => modelSetting(db) !== null,
      journal: (kind, url, detail) => browser.journal(kind, url, detail),
    }, String(record(raw).query ?? "")));
  ipcMain.handle("browser_preview", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const urls = record(raw).urls;
    return browserPreview(
      { db: currentDb(), fetchPreview, fetchImage },
      Array.isArray(urls) ? urls.filter((v): v is string => typeof v === "string") : [],
    );
  });
  ipcMain.handle("browser_peek", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserPeek({ db: currentDb(), fetchPage }, String(record(raw).url ?? "")));
  ipcMain.handle("browser_search_summary", (_e: IpcMainInvokeEvent, raw: unknown) =>
    browserSearchSummary({
      db: currentDb(), fetchPage, modelSetting,
      generate: (model, system, user) => generate(
        model,
        [{ role: "system", content: system }, { role: "user", content: user }],
        0.2,
        "5m",
      ),
    }, String(record(raw).query ?? "")));
  ipcMain.handle("import_search_result", (_e: IpcMainInvokeEvent, raw: unknown) => {
    const a = record(raw);
    return importSearchResult(
      { db: currentDb(), importWebSource, journal: (kind, url, detail) => browser.journal(kind, url, detail) },
      String(a.url ?? ""), String(a.title ?? ""),
    );
  });

  return browser;
}
