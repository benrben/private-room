import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availableName: vi.fn(),
  fetchReadable: vi.fn(),
  getFileMeta: vi.fn(),
  importSearchResult: vi.fn(),
  insertFileFromUrl: vi.fn(),
  safeFileName: vi.fn(),
  setFileExtractedText: vi.fn(),
}));

vi.mock("./browser/browser.js", () => ({
  Browser: class {
    close = vi.fn();
    journal = vi.fn();
  },
}));
vi.mock("./browser/browseCommands.js", () => ({
  browserClearJournal: vi.fn(), browserClearScope: vi.fn(), browserCloseTab: vi.fn(), browserGo: vi.fn(),
  browserInfo: vi.fn(), browserJournal: vi.fn(), browserNavigate: vi.fn(), browserNewTab: vi.fn(),
  browserRetryProtection: vi.fn(), browserSavePage: vi.fn(), browserSelectTab: vi.fn(), browserSetBounds: vi.fn(),
  browserSetTakeover: vi.fn(), browserTabs: vi.fn(), browserVerifyPrivate: vi.fn(),
}));
vi.mock("./browser/reader.js", () => ({ browserFocusApp: vi.fn(), browserPageSelection: vi.fn(), browserPageText: vi.fn() }));
vi.mock("./browser/search.js", () => ({
  browserPeek: vi.fn(), browserPreview: vi.fn(), browserSearchSummary: vi.fn(),
  importSearchResult: mocks.importSearchResult, runSearch: vi.fn(),
}));
vi.mock("./webFetch.js", () => ({
  fetchImage: vi.fn(), fetchPage: vi.fn(), fetchPreview: vi.fn(), fetchReadable: mocks.fetchReadable,
  guessDownloadMime: vi.fn(() => "text/plain"),
}));
vi.mock("./webSearch.js", () => ({ searchForBrowser: vi.fn() }));
vi.mock("./ollamaGenerate.js", () => ({ generate: vi.fn() }));
vi.mock("./gatherContext.js", () => ({ modelSetting: vi.fn() }));
vi.mock("./db-host/files.js", () => ({
  availableName: mocks.availableName,
  getFileMeta: mocks.getFileMeta,
  insertFileFromUrl: mocks.insertFileFromUrl,
  setFileExtractedText: mocks.setFileExtractedText,
}));
vi.mock("./browser/downloads.js", () => ({ safeFileName: mocks.safeFileName }));

import { registerBrowserSurfaceIpc } from "./browserSurfaceIpc.js";

type ImportHandler = (_event: unknown, raw: unknown) => Promise<unknown>;

function importHandler(room: unknown) {
  const handlers = new Map<string, ImportHandler>();
  const ipcMain = { handle: vi.fn((channel: string, handler: ImportHandler) => handlers.set(channel, handler)) };
  const emit = vi.fn();
  const deps = { scheduleAutoIndex: vi.fn() };
  registerBrowserSurfaceIpc(
    ipcMain as never,
    { room } as never,
    deps as never,
    "/fake/user-data",
    emit,
    { windowContentView: () => null, focusMainWindow: vi.fn() },
  );
  const handler = handlers.get("import_search_result");
  if (!handler) throw new Error("web import handler was not registered");
  return { handler, emit, deps };
}

beforeEach(() => {
  mocks.availableName.mockReset().mockImplementation((_conn: unknown, name: string) => name);
  mocks.fetchReadable.mockReset();
  mocks.getFileMeta.mockReset();
  mocks.importSearchResult.mockReset().mockImplementation((deps: { importWebSource(url: string, title: string): Promise<unknown> }, url: string, title: string) =>
    deps.importWebSource(url, title));
  mocks.insertFileFromUrl.mockReset();
  mocks.safeFileName.mockReset().mockImplementation((name: string) => name);
  mocks.setFileExtractedText.mockReset();
});

describe("browser source import IPC", () => {
  it("imports a titled readable page through the fabricated legacy-file seam", async () => {
    const conn = {};
    const result = { id: "legacy-web", name: "Manual.md" };
    mocks.fetchReadable.mockResolvedValue({ title: "Fetched title", text: "Readable body" });
    mocks.insertFileFromUrl.mockReturnValue(result);
    const registered = importHandler({ conn, path: "/fake/room" });

    await expect(registered.handler({}, { url: "https://example.test/manual", title: "Manual" }))
      .resolves.toEqual(result);

    expect(mocks.fetchReadable).toHaveBeenCalledWith("https://example.test/manual");
    expect(mocks.availableName).toHaveBeenCalledWith(conn, "Manual.md");
    expect(mocks.insertFileFromUrl).toHaveBeenCalledWith(
      conn,
      "Manual.md",
      "text/markdown",
      expect.objectContaining({
        toString: expect.any(Function),
      }),
      "# Manual\n\nSource: https://example.test/manual\n\nReadable body",
      "web",
      "https://example.test/manual",
    );
    expect(registered.emit).toHaveBeenCalledWith("room-files-changed", {});
    expect(registered.deps.scheduleAutoIndex).toHaveBeenCalledWith("/fake/room");
  });

  it("uses a fetched title and writes fabricated workspace source metadata and extraction", async () => {
    const run = vi.fn();
    const conn = { prepare: vi.fn(() => ({ run })) };
    const createFile = vi.fn(async () => ({ fileId: "workspace-web" }));
    const result = { id: "workspace-web", name: "Fetched.md" };
    mocks.fetchReadable.mockResolvedValue({ title: "Fetched", text: "Workspace body" });
    mocks.getFileMeta.mockReturnValue(result);
    const registered = importHandler({ conn, path: "/fake/workspace", workspace: { createFile } });

    await expect(registered.handler({}, { url: "https://example.test/source", title: "" }))
      .resolves.toEqual(result);

    const stream = createFile.mock.calls[0]?.[1] as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(createFile).toHaveBeenCalledWith("Fetched.md", expect.any(Readable), "web");
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      "# Fetched\n\nSource: https://example.test/source\n\nWorkspace body",
    );
    expect(conn.prepare).toHaveBeenCalledWith(
      "UPDATE files SET mime_type = 'text/markdown', origin_url = ? WHERE id = ?",
    );
    expect(run).toHaveBeenCalledWith("https://example.test/source", "workspace-web");
    expect(mocks.setFileExtractedText).toHaveBeenCalledWith(
      conn,
      "workspace-web",
      "# Fetched\n\nSource: https://example.test/source\n\nWorkspace body",
    );
  });

  it("falls back to the URL host when neither supplied nor fetched title exists", async () => {
    const conn = {};
    mocks.fetchReadable.mockResolvedValue({ title: "", text: "Host fallback" });
    mocks.insertFileFromUrl.mockReturnValue({ id: "host-web" });
    const registered = importHandler({ conn, path: "/fake/room" });

    await registered.handler({}, { url: "https://docs.example.test/path", title: "   " });

    expect(mocks.availableName).toHaveBeenCalledWith(conn, "docs.example.test.md");
  });

  it("preserves no-room and readable-fetch failures without emitting an import receipt", async () => {
    const closed = importHandler(null);

    await expect(closed.handler({}, { url: "https://example.test", title: "" }))
      .rejects.toThrow("No room is open.");
    expect(mocks.fetchReadable).not.toHaveBeenCalled();
    expect(closed.emit).not.toHaveBeenCalled();

    const opened = importHandler({ conn: {}, path: "/fake/room" });
    mocks.fetchReadable.mockRejectedValueOnce(new Error("fabricated readable failure"));

    await expect(opened.handler({}, { url: "https://example.test", title: "" }))
      .rejects.toThrow("fabricated readable failure");
    expect(mocks.insertFileFromUrl).not.toHaveBeenCalled();
    expect(opened.emit).not.toHaveBeenCalled();
  });
});
