import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  preflightImportPaths,
  rawFallbackJpeg,
  rawFallbackPngDimensions,
  registerFileRuntimeSurfaceIpc,
  shouldAutoTranscribeImport,
  snapshotRawFallback,
  viewerKind,
  viewerKindIsEditable,
  viewerKindReadsRawText,
} from "./fileRuntimeSurfaceIpc.js";
import { logDir, logPath, previousLogPath } from "./obs.js";
import { createRoomManagerState } from "./roomManager.js";
import { previousStderrLogPath, stderrLogPath } from "./sidecar.js";
import { fileExtensionLabel, sharedTextExtensions } from "../shared/fileExtensions.js";
import { createRoom } from "./db-host/open.js";
import { getFileFull, insertFile } from "./db-host/files.js";
import { resolveDerivedPreview, snapshotUnknownFormat } from "./derivedPreview.js";
import sharp from "sharp";

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

  it("automatically transcribes imported FLAC audio, not unrelated files", () => {
    expect(shouldAutoTranscribeImport("meeting.flac", "audio/flac")).toBe(true);
    expect(shouldAutoTranscribeImport("meeting.wav", "audio/wav")).toBe(false);
    expect(shouldAutoTranscribeImport("notes.flac", "application/octet-stream")).toBe(false);
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
  it("marks a durable Quick Look image as a snapshot of an unchanged original", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-preview-status-"));
    const roomPath = path.join(root, "preview.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "Preview status");
    const state = createRoomManagerState();
    state.room = {
      conn: db,
      path: roomPath,
      name: "Preview status",
      password: "correct horse battery staple",
    };
    try {
      const original = insertFile(
        db,
        "drawing.graffle",
        "application/octet-stream",
        Buffer.from("original drawing bytes"),
        null,
        "import",
      );
      const png = await sharp({
        create: { width: 1200, height: 800, channels: 3, background: "#336699" },
      }).png().toBuffer();
      await expect(snapshotUnknownFormat(
        { db, path: roomPath },
        original.id,
        async () => png,
      )).resolves.toMatchObject({ kind: "stored" });

      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const ipcMain = {
        handle(channel, handler): void {
          handlers.set(channel, handler as (...args: unknown[]) => unknown);
        },
      } satisfies Pick<IpcMain, "handle">;
      registerFileRuntimeSurfaceIpc(
        ipcMain,
        state,
        { userDataDir: root, spawnRoomServerIfEnabled: () => undefined },
        root,
        () => undefined,
        { openPath: async () => undefined },
      );

      const content = await handlers.get("get_file_content")!(
        {} as IpcMainInvokeEvent,
        { id: original.id },
      );
      expect(content).toMatchObject({
        kind: "image",
        name: "drawing.graffle",
        derivedPreview: {
          kind: "stored-snapshot",
          originalMime: "application/octet-stream",
        },
      });
      expect(getFileFull(db, original.id)[2]).toEqual(Buffer.from("original drawing bytes"));
    } finally {
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores a full-size RAW Quick Look fallback durably without replacing the export original", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-raw-fallback-"));
    const roomPath = path.join(root, "raw.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "RAW test");
    try {
      const originalBytes = Buffer.from("camera raw source bytes");
      const original = insertFile(db, "camera.cr2", "image/x-canon-cr2", originalBytes, null, "import");
      const png = await sharp({
        create: { width: 1200, height: 800, channels: 3, background: "#336699" },
      }).png().toBuffer();
      await expect(rawFallbackPngDimensions(png)).resolves.toEqual({ width: 1200, height: 800 });
      await expect(snapshotRawFallback({ db, path: roomPath }, original.id, async () => png))
        .resolves.toMatchObject({ kind: "stored" });
      const resolved = await resolveDerivedPreview({ db, path: roomPath }, original.id);
      expect(resolved?.preview).toMatchObject({ mimeType: "image/jpeg", provenance: "snapshot" });
      const stored = await sharp(resolved!.bytes).metadata();
      expect(stored).toMatchObject({ format: "jpeg", width: 1200, height: 800 });
      expect(getFileFull(db, original.id)[2]).toEqual(originalBytes);

      const tooSmall = insertFile(db, "thumbnail-only.cr2", "image/x-canon-cr2", originalBytes, null, "import");
      const smallPng = await sharp({
        create: { width: 999, height: 700, channels: 3, background: "#ffffff" },
      }).png().toBuffer();
      await expect(snapshotRawFallback({ db, path: roomPath }, tooSmall.id, async () => smallPng))
        .resolves.toEqual({ kind: "unavailable" });
      expect(await resolveDerivedPreview({ db, path: roomPath }, tooSmall.id)).toBeNull();
      expect(getFileFull(db, tooSmall.id)[2]).toEqual(originalBytes);

      const failedRender = insertFile(db, "quicklook-failed.cr2", "image/x-canon-cr2", originalBytes, null, "import");
      await expect(snapshotRawFallback({ db, path: roomPath }, failedRender.id, async () => {
        throw new Error("Quick Look could not decode this RAW file");
      })).resolves.toEqual({ kind: "unavailable" });
      expect(await resolveDerivedPreview({ db, path: roomPath }, failedRender.id)).toBeNull();
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes corrupt and undersized RAW fallback PNG headers", async () => {
    await expect(rawFallbackPngDimensions(Buffer.from("not png"))).resolves.toBeNull();
    const forged = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(forged, 0);
    forged.write("IHDR", 12, "ascii");
    forged.writeUInt32BE(1200, 16);
    forged.writeUInt32BE(800, 20);
    await expect(rawFallbackPngDimensions(forged)).resolves.toBeNull();
    await expect(rawFallbackJpeg(forged)).resolves.toBeNull();
    const png = await sharp({
      create: { width: 999, height: 700, channels: 3, background: "#ffffff" },
    }).png().toBuffer();
    await expect(rawFallbackPngDimensions(png)).resolves.toEqual({ width: 999, height: 700 });
  });

  it("preflights a whole selection and refuses Finder packages before any import", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-import-preflight-"));
    try {
      const regular = path.join(root, "notes.txt");
      const numbers = path.join(root, "sample.numbers");
      const rtfd = path.join(root, "sample.rtfd");
      await writeFile(regular, "notes");
      await mkdir(numbers);
      await mkdir(rtfd);
      await expect(preflightImportPaths([regular, numbers, rtfd])).resolves.toEqual([
        "sample.numbers: Folder/package imports are not supported. Export or compress the package as one file first.",
        "sample.rtfd: Folder/package imports are not supported. Export or compress the package as one file first.",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
