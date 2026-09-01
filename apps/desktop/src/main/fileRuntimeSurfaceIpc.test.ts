import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  rawPreview: { result: null as { bytes: Buffer } | null },
  iworkPreview: { result: null as { bytes: Buffer; mimeType: string; extension: string } | null },
  office: {
    convertible: vi.fn((_name: string) => false),
    verified: vi.fn(async (_dir: string) => true),
    installed: vi.fn(async (_dir: string) => undefined),
    converted: vi.fn(async (_name: string, _bytes: Uint8Array) => Buffer.from("converted preview")),
    dialogResponse: 0,
    dialog: vi.fn(async () => ({ response: 0 })),
  },
  ocr: {
    candidate: vi.fn((_mime: string, _extension: string) => false),
    recognize: vi.fn(async () => ""),
  },
  extraction: vi.fn(async (name: string, _bytes: Buffer) => name.endsWith(".txt") ? "extracted text" : null),
  web: {
    fetched: vi.fn(async (_url: string) => ({ title: "Fetched", text: "Fetched text" })),
    searched: vi.fn(async (_query: string) => ({ hits: [], failed: [] })),
  },
  derived: { snapshot: null as ((...args: unknown[]) => unknown) | null },
}));

vi.mock("./derivedPreview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./derivedPreview.js")>();
  return {
    ...actual,
    snapshotUnknownFormat: (...args: unknown[]) => runtimeMocks.derived.snapshot?.(...args) ?? actual.snapshotUnknownFormat(...args),
  };
});

vi.mock("./rawPreview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rawPreview.js")>()),
  extractRawPreview: () => runtimeMocks.rawPreview.result,
}));

vi.mock("./iWorkPreview.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./iWorkPreview.js")>()),
  extractIWorkPreview: () => runtimeMocks.iworkPreview.result,
}));

vi.mock("./officeConvert.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./officeConvert.js")>()),
  OfficeConverter: class {
    convert = runtimeMocks.office.converted;
  },
  officeConvertible: runtimeMocks.office.convertible,
  verifyOfficeArtifacts: runtimeMocks.office.verified,
  installOfficeArtifacts: runtimeMocks.office.installed,
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: (...args: unknown[]) => runtimeMocks.office.dialog(...args) },
}));

vi.mock("./ocrTools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ocrTools.js")>()),
  isOcrCandidate: runtimeMocks.ocr.candidate,
  recognize: runtimeMocks.ocr.recognize,
}));

vi.mock("./documentExtraction.js", () => ({ extractDocumentText: runtimeMocks.extraction }));

vi.mock("./webFetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./webFetch.js")>()),
  fetchReadable: runtimeMocks.web.fetched,
}));

vi.mock("./webSearch.js", () => ({ searchWeb: runtimeMocks.web.searched }));

import {
  invalidateFileContentCacheForEvent,
  preflightImportPaths,
  rawFallbackJpeg,
  rawFallbackPngDimensions,
  registerFileRuntimeSurfaceIpc,
  shouldAutoTranscribeImport,
  snapshotRawFallback,
  transcribeEligibleImport,
  viewerKind,
  viewerKindIsEditable,
  viewerKindReadsRawText,
} from "./fileRuntimeSurfaceIpc.js";
import { logDir, logPath, previousLogPath } from "./obs.js";
import { createRoomManagerState } from "./roomManager.js";
import { previousStderrLogPath, stderrLogPath } from "./sidecar.js";
import { fileExtensionLabel, sharedTextExtensions } from "../shared/fileExtensions.js";
import { createRoom } from "./db-host/open.js";
import { getFileFull, insertFile, setMediaMeta, setWebMeta } from "./db-host/files.js";
import { resolveDerivedPreview, snapshotUnknownFormat } from "./derivedPreview.js";
import { createWorkspaceRoom } from "./workspace/roomLayout.js";
import { WorkspaceService } from "./workspace/workspaceService.js";
import { Readable } from "node:stream";
import sharp from "sharp";

const TEXT_EXTENSIONS = sharedTextExtensions();

type IpcHandler = (...args: unknown[]) => unknown;

function registeredRuntime(
  state: ReturnType<typeof createRoomManagerState>,
  root: string,
  options: {
    emit?: (event: string, payload: unknown) => void;
    openPath?: (target: string) => Promise<void>;
    scheduleAutoIndex?: (roomPath: string) => void;
    retranscribeImportedFile?: (fileId: string) => Promise<void>;
    clearEphemeralCaches?: () => void;
  } = {},
): { handlers: Map<string, IpcHandler>; stores: ReturnType<typeof registerFileRuntimeSurfaceIpc>; clearCaches(): void } {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle(channel: string, handler: unknown): void {
      handlers.set(channel, handler as IpcHandler);
    },
  } satisfies Pick<IpcMain, "handle">;
  const deps = {
    userDataDir: root,
    spawnRoomServerIfEnabled: () => undefined,
    scheduleAutoIndex: options.scheduleAutoIndex,
    clearEphemeralCaches: options.clearEphemeralCaches,
  };
  const stores = registerFileRuntimeSurfaceIpc(
    ipcMain,
    state,
    deps,
    root,
    options.emit ?? (() => undefined),
    { openPath: options.openPath ?? (async () => undefined) },
    { retranscribeImportedFile: options.retranscribeImportedFile },
  );
  return { handlers, stores, clearCaches: deps.clearEphemeralCaches! };
}

function invoke(handlers: Map<string, IpcHandler>, channel: string, raw?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
  return Promise.resolve().then(() => handler({} as IpcMainInvokeEvent, raw));
}

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

  it("treats every audio and video container as eligible to be transcribed, not just FLAC", () => {
    for (const [name, mime] of [
      ["meeting.flac", "audio/flac"],
      ["interview.mp3", "audio/mpeg"],
      ["memo.m4a", "audio/mp4"],
      ["talk.mp4", "video/mp4"],
      // No `guessDownloadMime` entry, so these import as octet-stream. The
      // extension arm of `mediaKind` is the only thing that saves them from
      // BinaryView, which offers no Transcribe button at all.
      ["voice.aac", "application/octet-stream"],
      ["tape.aiff", "application/octet-stream"],
      ["capture.caf", "application/octet-stream"],
      ["clip.m4v", "application/octet-stream"],
    ] as const) {
      expect(transcribeEligibleImport(name, mime), name).toBe(true);
    }
    expect(transcribeEligibleImport("notes.txt", "text/plain")).toBe(false);
    expect(transcribeEligibleImport("scan.pdf", "application/pdf")).toBe(false);
  });

  it("routes every eligible container to the media viewer that owns the Transcribe button", () => {
    for (const [name, expected] of [
      ["voice.aac", "audio"],
      ["tape.aiff", "audio"],
      ["memo.aif", "audio"],
      ["capture.caf", "audio"],
      ["clip.m4v", "video"],
    ] as const) {
      expect(viewerKind(name, "application/octet-stream"), name).toBe(expected);
    }
  });

  it("still runs itself for an imported FLAC only — eligibility is an offer, not a trigger", () => {
    expect(shouldAutoTranscribeImport("meeting.flac", "audio/flac")).toBe(true);
    // Eligible, and offered the button — but a bulk drop of these must never
    // queue hours of decoding nobody asked for, so none of them auto-run.
    for (const [name, mime] of [
      ["meeting.wav", "audio/wav"],
      ["interview.mp3", "audio/mpeg"],
      ["talk.mp4", "video/mp4"],
      ["voice.aac", "application/octet-stream"],
    ] as const) {
      expect(transcribeEligibleImport(name, mime), name).toBe(true);
      expect(shouldAutoTranscribeImport(name, mime), name).toBe(false);
    }
    expect(shouldAutoTranscribeImport("notes.txt", "text/plain")).toBe(false);
    // Deliberate change from the old `mime.startsWith("audio/")` spelling: a
    // `.flac` whose MIME arrived generic is still a FLAC. `import_files`
    // derives the MIME from the name (`guessDownloadMime` maps flac ->
    // audio/flac), so this case cannot actually reach the auto path there —
    // and where it can be reached, answering "not audio" would be a lie.
    expect(shouldAutoTranscribeImport("notes.flac", "application/octet-stream")).toBe(true);
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
  it("builds, caches, invalidates, and decodes stored file content through IPC", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-content-"));
    const db = createRoom(path.join(root, "content.roomai"), "correct horse battery staple", "Content");
    const state = createRoomManagerState();
    state.room = { conn: db, path: path.join(root, "content.roomai"), name: "Content", password: "correct horse battery staple" };
    let previousClearCalls = 0;
    try {
      const text = insertFile(db, "notes.txt", "text/plain", Buffer.from("stored text"), null, "import");
      const binary = insertFile(db, "blob.bin", "application/octet-stream", Buffer.from([1, 2, 3]), null, "import");
      const replacement = insertFile(db, "replacement.bin", "application/octet-stream", Buffer.from([4, 5, 6]), null, "import");
      const broken = insertFile(db, "broken.txt", "text/plain", Buffer.from([0xc3, 0x28]), null, "import");
      setMediaMeta(db, binary.id, '{"codec":"aac"}');
      setWebMeta(db, binary.id, "not valid JSON");
      const { handlers, stores, clearCaches } = registeredRuntime(state, root, {
        clearEphemeralCaches: () => { previousClearCalls += 1; },
      });

      await expect(invoke(handlers, "get_file_content", { id: text.id })).resolves.toMatchObject({
        kind: "prose", text: "stored text", mediaToken: null,
      });
      const staged = await invoke(handlers, "get_file_content", { id: binary.id }) as { mediaToken: string };
      expect(staged.mediaToken).toEqual(expect.any(String));
      expect(staged).toMatchObject({ mediaMeta: { codec: "aac" }, webMeta: null });
      await expect(invoke(handlers, "get_file_content", { id: binary.id })).resolves.toBe(stores.fileContents.get(binary.id));
      stores.mediaStreams.map.clear();
      await expect(invoke(handlers, "get_file_content", { id: replacement.id })).resolves.toMatchObject({ mediaToken: expect.any(String) });
      expect(stores.fileContents.has(binary.id)).toBe(false);
      invalidateFileContentCacheForEvent(stores, "unrelated-event");
      expect(stores.fileContents.has(replacement.id)).toBe(true);
      invalidateFileContentCacheForEvent(stores, "file-updated");
      expect(stores.fileContents).toHaveLength(0);
      stores.htmlPreviews.map.set("preview", "<p>cached</p>");
      clearCaches();
      expect(previousClearCalls).toBe(1);
      expect(stores.htmlPreviews.map).toHaveLength(0);
      expect(stores.mediaStreams.map).toHaveLength(0);

      await expect(invoke(handlers, "decode_file_text", { id: text.id })).resolves.toMatchObject({
        text: "stored text", source: "utf8", editable: true, lossy: false,
      });
      await expect(invoke(handlers, "decode_file_text", { id: broken.id, encoding: "UTF-8" })).resolves.toMatchObject({
        source: "chosen", editable: false, lossy: true,
      });
      await expect(invoke(handlers, "get_file_content", { id: "missing" })).rejects.toThrow("Query returned no rows");
    } finally {
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports buffered files in order, derives previews, and only auto-starts FLAC", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-import-"));
    const roomPath = path.join(root, "import.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "Import");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "Import", password: "correct horse battery staple" };
    const events: string[] = [];
    const indexed: string[] = [];
    const transcribed: string[] = [];
    try {
      const notes = path.join(root, "notes.txt");
      const flac = path.join(root, "meeting.flac");
      const raw = path.join(root, "camera.cr2");
      await writeFile(notes, "imported text");
      await writeFile(flac, "not a real flac");
      await writeFile(raw, "raw bytes");
      const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#112233" } }).jpeg().toBuffer();
      runtimeMocks.rawPreview.result = { bytes: jpeg };
      const { handlers } = registeredRuntime(state, root, {
        emit: (event) => events.push(event),
        scheduleAutoIndex: (target) => indexed.push(target),
        retranscribeImportedFile: async (id) => { transcribed.push(id); },
      });

      const report = await invoke(handlers, "import_files", { paths: [notes, flac, raw] }) as {
        imported: Array<{ id: string; name: string }>;
        errors: string[];
      };
      expect(report.errors).toEqual([]);
      expect(report.imported.map((file) => file.name)).toEqual(["notes.txt", "meeting.flac", "camera.cr2"]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(transcribed).toEqual([report.imported[1].id]);
      expect(events).toContain("room-files-changed");
      expect(indexed).toEqual([roomPath]);
      expect(await resolveDerivedPreview({ db, path: roomPath }, report.imported[2].id)).not.toBeNull();
    } finally {
      runtimeMocks.rawPreview.result = null;
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the workspace stream and materialization paths without changing file contracts", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-workspace-"));
    const root = path.join(parent, "Workspace");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Workspace");
    const state = createRoomManagerState();
    const workspace = new WorkspaceService(db, root);
    state.room = { conn: db, path: root, name: "Workspace", password: "correct horse battery staple", workspace };
    try {
      const text = await workspace.createFile("notes.txt", Readable.from(["workspace text"]), "generated");
      const media = await workspace.createFile("clip.mp3", Readable.from([Buffer.from([1, 2, 3])]), "generated");
      const source = path.join(parent, "voice.flac");
      await writeFile(source, "workspace flac");
      const { handlers } = registeredRuntime(state, root);

      await expect(invoke(handlers, "get_file_content", { id: text.fileId })).resolves.toMatchObject({
        text: "workspace text", mediaToken: null,
      });
      await expect(invoke(handlers, "get_file_content", { id: media.fileId })).resolves.toMatchObject({
        kind: "audio", mediaToken: expect.any(String),
      });
      await expect(invoke(handlers, "decode_file_text", { id: text.fileId })).resolves.toMatchObject({
        text: "workspace text", source: "utf8",
      });

      const imported = await invoke(handlers, "import_files", { paths: [source] }) as { imported: Array<{ name: string }> };
      expect(imported.imported.map((file) => file.name)).toEqual(["voice.flac"]);
    } finally {
      state.room = null;
      db.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("takes the validated RAW and invalid-Illustrator fallback paths without treating either as a preview", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-fallback-"));
    const roomPath = path.join(root, "fallback.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "Fallback");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "Fallback", password: "correct horse battery staple" };
    const snapshotCalls: string[] = [];
    try {
      const raw = path.join(root, "unreadable.cr2");
      const illustrator = path.join(root, "not-a-pdf.ai");
      await Promise.all([writeFile(raw, "not camera data"), writeFile(illustrator, "not PDF data")]);
      runtimeMocks.derived.snapshot = (_room, id) => {
        snapshotCalls.push(String(id));
        return Promise.resolve({ kind: "unavailable" });
      };
      const { handlers } = registeredRuntime(state, root);

      const report = await invoke(handlers, "import_files", { paths: [raw, illustrator] }) as {
        imported: Array<{ id: string }>;
        errors: string[];
      };
      expect(report.errors).toEqual([]);
      expect(snapshotCalls).toEqual(report.imported.map((file) => file.id));
    } finally {
      runtimeMocks.derived.snapshot = null;
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a file read failure beside its basename after preflight succeeds", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-import-error-"));
    const roomPath = path.join(root, "error.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "Error");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "Error", password: "correct horse battery staple" };
    const source = path.join(root, "read-fails.txt");
    try {
      await writeFile(source, "will not be read");
      const read = vi.spyOn((await import("node:fs")).promises, "readFile").mockRejectedValueOnce(new Error("disk read failed"));
      const { handlers } = registeredRuntime(state, root);
      await expect(invoke(handlers, "import_files", { paths: [source] })).resolves.toMatchObject({
        imported: [], errors: ["read-fails.txt: disk read failed"],
      });
      read.mockRestore();
    } finally {
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes text and generated files through a live workspace before streaming their exact bytes", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-workspace-write-"));
    const root = path.join(parent, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const workspace = new WorkspaceService(db, root);
    const state = createRoomManagerState();
    state.room = { conn: db, path: root, name: "Room", password: "correct horse battery staple", workspace };
    try {
      const sketch = await workspace.createFile("diagram.sketch", Readable.from(["{\"objects\":[]}"]), "generated");
      const audio = await workspace.createFile("voice.mp3", Readable.from([Buffer.from([1, 2, 3])]), "generated");
      const source = path.join(parent, "incoming.txt");
      await writeFile(source, "workspace import");
      const { handlers, stores } = registeredRuntime(state, root);

      await expect(invoke(handlers, "get_file_content", { id: sketch.fileId })).resolves.toMatchObject({
        kind: "sketch", text: "{\"objects\":[]}", mediaToken: null,
      });
      const staged = await invoke(handlers, "get_file_content", { id: audio.fileId }) as { mediaToken: string };
      const range = await stores.mediaStreams.map.get(staged.mediaToken)!.openRange!(1, 2);
      const bytes: Buffer[] = [];
      for await (const chunk of range) bytes.push(Buffer.from(chunk));
      expect(Buffer.concat(bytes)).toEqual(Buffer.from([2, 3]));
      const full = await stores.mediaStreams.map.get(staged.mediaToken)!.openStream!();
      const complete: Buffer[] = [];
      for await (const chunk of full) complete.push(Buffer.from(chunk));
      expect(Buffer.concat(complete)).toEqual(Buffer.from([1, 2, 3]));

      const imported = await invoke(handlers, "import_files", { paths: [source] }) as { imported: Array<{ name: string }>; errors: string[] };
      expect(imported).toMatchObject({ errors: [] });
      expect(imported.imported.map((file) => file.name)).toEqual(["incoming.txt"]);
      expect(db.prepare("SELECT storage_kind FROM files WHERE name = 'incoming.txt'").get())
        .toEqual({ storage_kind: "workspace" });
      await expect(invoke(handlers, "import_link", { url: "https://workspace.example/" })).resolves.toMatchObject({ name: "Fetched.md" });
      await expect(invoke(handlers, "open_scratch_pad")).resolves.toMatchObject({ name: "Scratch pad.md" });
    } finally {
      state.room = null;
      db.close();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("keeps read-only legacy files immutable and refuses a failed workspace materialization", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-legacy-"));
    const roomPath = path.join(root, "legacy.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "Legacy");
    const state = createRoomManagerState();
    const legacy = insertFile(db, "legacy.txt", "text/plain", Buffer.from("legacy bytes"), "legacy text", "import");
    const broken = insertFile(db, "broken.txt", "text/plain", Buffer.from("broken bytes"), "broken text", "import");
    let materialize = async (id: string): Promise<void> => {
      db.prepare("UPDATE files SET storage_kind = 'workspace' WHERE id = ?").run(id);
    };
    const fakeWorkspace = {
      materializeLiveBlobFile: (id: string) => materialize(id),
      readStream: (id: string) => Readable.from([getFileFull(db, id)[2]!]),
    } as unknown as WorkspaceService;
    state.room = {
      conn: db,
      path: roomPath,
      name: "Legacy",
      password: "correct horse battery staple",
      workspace: fakeWorkspace,
      readOnly: true,
    };
    try {
      const { handlers } = registeredRuntime(state, root);
      await expect(invoke(handlers, "get_file_content", { id: legacy.id })).resolves.toMatchObject({ text: "legacy text" });
      expect(db.prepare("SELECT storage_kind FROM files WHERE id = ?").get(legacy.id)).toEqual({ storage_kind: "blob" });

      state.room.readOnly = false;
      await expect(invoke(handlers, "get_file_content", { id: legacy.id })).resolves.toMatchObject({ text: "legacy text" });
      expect(db.prepare("SELECT storage_kind FROM files WHERE id = ?").get(legacy.id)).toEqual({ storage_kind: "workspace" });

      materialize = async () => undefined;
      await expect(invoke(handlers, "get_file_content", { id: broken.id })).rejects.toThrow(
        "could not be restored to the workspace",
      );
    } finally {
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps preview consent, embedded preview, and OCR completion behavior in the import path", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-preview-"));
    const roomPath = path.join(root, "preview.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "Preview");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "Preview", password: "correct horse battery staple" };
    const events: string[] = [];
    try {
      const docx = path.join(root, "first.docx");
      const laterDocx = path.join(root, "later.docx");
      const pages = path.join(root, "slides.pages");
      const image = path.join(root, "scan.png");
      await Promise.all([docx, laterDocx, pages, image].map((target) => writeFile(target, "fixture")));
      const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#abcdef" } }).jpeg().toBuffer();
      runtimeMocks.office.convertible.mockImplementation((name) => name.endsWith(".docx"));
      runtimeMocks.office.verified.mockResolvedValue(false);
      runtimeMocks.office.dialog.mockResolvedValue({ response: 0 });
      runtimeMocks.iworkPreview.result = { bytes: jpeg, mimeType: "image/jpeg", extension: "jpg" };
      runtimeMocks.ocr.candidate.mockImplementation((_mime, extension) => extension === "png");
      runtimeMocks.ocr.recognize.mockResolvedValue("recognized words");
      const { handlers } = registeredRuntime(state, root, { emit: (event) => events.push(event) });

      const report = await invoke(handlers, "import_files", { paths: [docx, laterDocx, pages, image] }) as {
        imported: Array<{ id: string; name: string }>;
      };
      await new Promise((resolve) => setImmediate(resolve));
      const byName = new Map(report.imported.map((file) => [file.name, file]));
      expect(runtimeMocks.office.installed).toHaveBeenCalledOnce();
      expect(await resolveDerivedPreview({ db, path: roomPath }, byName.get("first.docx")!.id)).not.toBeNull();
      expect(await resolveDerivedPreview({ db, path: roomPath }, byName.get("later.docx")!.id)).toBeNull();
      expect(await resolveDerivedPreview({ db, path: roomPath }, byName.get("slides.pages")!.id)).not.toBeNull();
      expect(db.prepare("SELECT extracted_text FROM files WHERE id = ?").get(byName.get("scan.png")!.id))
        .toEqual({ extracted_text: "(text recognized from scan)\nrecognized words" });
      expect(events).toEqual(expect.arrayContaining(["ocr-progress", "file-updated", "room-files-changed"]));
    } finally {
      runtimeMocks.office.convertible.mockImplementation(() => false);
      runtimeMocks.office.verified.mockResolvedValue(true);
      runtimeMocks.iworkPreview.result = null;
      runtimeMocks.ocr.candidate.mockImplementation(() => false);
      runtimeMocks.ocr.recognize.mockResolvedValue("");
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps IPC completion, link, scratch, search, and pending-decision contracts", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-file-runtime-misc-"));
    const roomPath = path.join(root, "misc.roomai");
    const db = createRoom(roomPath, "correct horse battery staple", "Misc");
    const state = createRoomManagerState();
    state.room = { conn: db, path: roomPath, name: "Misc", password: "correct horse battery staple" };
    const opened: string[] = [];
    const decisions: Array<{ approved: boolean; remember: boolean }> = [];
    try {
      const { handlers, stores } = registeredRuntime(state, root, { openPath: async (target) => { opened.push(target); } });
      await expect(invoke(handlers, "import_link", { url: "https://example.test/page" })).resolves.toMatchObject({ name: "Fetched.md" });
      const firstScratch = await invoke(handlers, "open_scratch_pad") as { id: string };
      await expect(invoke(handlers, "open_scratch_pad")).resolves.toMatchObject({ id: firstScratch.id });
      await expect(invoke(handlers, "open_html_in_browser", { name: "Preview", html: "<h1>OK</h1>" })).resolves.toEqual(expect.any(String));
      expect(opened).toHaveLength(1);
      expect(await invoke(handlers, "stage_preview_html", { html: "<p>one</p>" })).toBe("0");
      expect(stores.htmlPreviews.map.get("0")).toBe("<p>one</p>");

      runtimeMocks.web.searched.mockResolvedValueOnce({ hits: [{ title: "hit" }], failed: [] });
      await expect(invoke(handlers, "web_search_test")).resolves.toBe("Online search is working (1 results).");
      runtimeMocks.web.searched.mockResolvedValueOnce({ hits: [], failed: ["offline"] });
      await expect(invoke(handlers, "web_search_test")).resolves.toBe("Search was blocked by: offline.");
      await expect(invoke(handlers, "web_search_test")).resolves.toBe("Search connected, but returned no results.");
      expect(await invoke(handlers, "studio_prompts")).toMatchObject({ flashcards: expect.any(String) });

      state.mcpPending.set("approve", (decision) => decisions.push(decision));
      await expect(invoke(handlers, "resolve_mcp_call", { id: "approve", decision: "always" })).resolves.toBeUndefined();
      expect(decisions).toEqual([{ approved: true, remember: true }]);
      await expect(invoke(handlers, "resolve_mcp_call", { id: "gone" })).rejects.toThrow("no longer pending");
    } finally {
      state.room = null;
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("returns unavailable when the JPEG transcode fails after a valid PNG decode", async () => {
    const png = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: "#ffffff" },
    }).png().toBuffer();
    const encode = vi.spyOn(sharp.prototype, "jpeg").mockImplementation(() => {
      throw new Error("encoder stopped");
    });
    try {
      await expect(rawFallbackJpeg(png)).resolves.toBeNull();
    } finally {
      encode.mockRestore();
    }
  });

  it("preflights a whole selection and refuses Finder packages before any import", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-import-preflight-"));
    try {
      const regular = path.join(root, "notes.txt");
      const numbers = path.join(root, "sample.numbers");
      const rtfd = path.join(root, "sample.rtfd");
      const missing = path.join(root, "missing.txt");
      await writeFile(regular, "notes");
      await mkdir(numbers);
      await mkdir(rtfd);
      await expect(preflightImportPaths([regular, numbers, rtfd, missing])).resolves.toEqual([
        "sample.numbers: Folder/package imports are not supported. Export or compress the package as one file first.",
        "sample.rtfd: Folder/package imports are not supported. Export or compress the package as one file first.",
        expect.stringMatching(/^missing\.txt: ENOENT:/),
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
