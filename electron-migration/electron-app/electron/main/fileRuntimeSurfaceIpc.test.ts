import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  registerFileRuntimeSurfaceIpc,
  viewerKind,
  viewerKindIsEditable,
  viewerKindReadsRawText,
} from "./fileRuntimeSurfaceIpc.js";
import { logDir, logPath, previousLogPath } from "./obs.js";
import { createRoomManagerState } from "./roomManager.js";
import { previousStderrLogPath, stderrLogPath } from "./sidecar.js";
import { fileExtensionLabel, sharedTextExtensions } from "../shared/fileExtensions.js";

const TEXT_EXTENSIONS = sharedTextExtensions();

describe("file viewer routing", () => {
  const explicitTextKinds: Readonly<Record<string, string>> = {
    txt: "prose",
    md: "markdown",
    markdown: "markdown",
    json: "json",
    csv: "csv",
    tsv: "csv",
    log: "log",
  };

  it.each(TEXT_EXTENSIONS)("routes .%s through an editable text viewer", (extension) => {
    const kind = viewerKind(`fixture.${extension}`, "application/octet-stream");
    expect(kind).toBe(explicitTextKinds[extension] ?? "code");
    expect(viewerKindIsEditable(kind)).toBe(true);
  });

  it.each([
    ["plain.txt", "text/plain", "prose"],
    ["analysis.ipynb", "application/octet-stream", "notebook"],
    ["artwork.ai", "application/postscript", "pdf"],
    ["photo.avif", "image/avif", "image"],
    ["movie.mkv", "video/x-matroska", "video"],
    ["sound.flac", "audio/flac", "audio"],
    ["mail.msg", "application/vnd.ms-outlook", "email"],
    ["book.mobi", "application/x-mobipocket-ebook", "book"],
    ["bundle.7z", "application/x-7z-compressed", "archive"],
    ["scan.tiff", "image/tiff", "image"],
    ["design.psd", "image/vnd.adobe.photoshop", "image"],
    ["photo.jxl", "image/jxl", "image"],
    ["book.azw3", "application/vnd.amazon.ebook", "book"],
    ["book.fb2", "application/x-fictionbook+xml", "book"],
    ["comic.cbz", "application/vnd.comicbook+zip", "book"],
  ] as const)("routes %s to %s", (name, mime, expected) => {
    expect(viewerKind(name, mime)).toBe(expected);
  });

  it("feeds notebook JSON to NotebookView instead of staging it as opaque bytes", () => {
    expect(viewerKindReadsRawText(viewerKind("analysis.ipynb", "application/octet-stream"))).toBe(true);
    expect(viewerKindIsEditable("notebook")).toBe(true);
  });

  it.each([
    ["mobi", "book"],
    ["7z", "archive"],
    ["rar", "archive"],
    ["tar", "archive"],
    ["msg", "message"],
    ["go", "script"],
    ["java", "script"],
    ["toml", "code"],
    ["jsonl", "data"],
    ["ai", "PDF"],
  ] as const)("labels .%s as %s in the Library", (extension, expected) => {
    expect(fileExtensionLabel(extension)).toBe(expected);
  });

  it("only produces viewer kinds covered by the frontend registry contract", () => {
    const covered = new Set([
      "image", "pdf", "docx", "worddoc", "sheet", "csv", "slides", "book", "archive",
      "markdown", "html", "svg", "sketch", "notebook", "json", "subtitle", "email", "prose",
      "log", "code", "text", "audio", "video", "recording", "binary",
    ]);
    const routed = [
      ...TEXT_EXTENSIONS.map((extension) => viewerKind(`fixture.${extension}`, "application/octet-stream")),
      ...["ai", "ipynb", "mkv", "flac", "ogg", "opus", "avif", "tiff"].map((extension) =>
        viewerKind(`fixture.${extension}`, "application/octet-stream")),
    ];
    expect(routed.every((kind) => covered.has(kind))).toBe(true);
  });
});

describe("file runtime utility IPC", () => {
  it("reveals the real directory shared by current and previous host and sidecar logs", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle(channel, handler): void {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    } satisfies Pick<IpcMain, "handle">;
    const openPath = vi.fn(async (_target: string) => {});

    registerFileRuntimeSurfaceIpc(
      ipcMain,
      createRoomManagerState(),
      { userDataDir: "/not-the-log-directory", spawnRoomServerIfEnabled: () => {} },
      "/not-the-log-directory",
      () => {},
      { openPath },
    );

    const revealed = await handlers.get("reveal_logs")!({} as IpcMainInvokeEvent);
    expect(revealed).toBe(logDir());
    expect(openPath).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledWith(logDir());
    for (const file of [logPath(), previousLogPath(), stderrLogPath(), previousStderrLogPath()]) {
      expect(path.dirname(file)).toBe(logDir());
    }
  });
});
