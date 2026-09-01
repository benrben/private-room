import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availableName: vi.fn(),
  browserInstances: [] as Array<Record<string, unknown>>,
  browserJournal: vi.fn(),
  browserNavigate: vi.fn(),
  browserPageText: vi.fn(),
  browserPeek: vi.fn(),
  browserPreview: vi.fn(),
  browserSearchSummary: vi.fn(),
  browserSetBounds: vi.fn(),
  browserTabs: vi.fn(),
  createReadStream: vi.fn(),
  generate: vi.fn(),
  getFileMeta: vi.fn(),
  guessDownloadMime: vi.fn(),
  importSearchResult: vi.fn(),
  insertFileFromUrl: vi.fn(),
  readFile: vi.fn(),
  removeFile: vi.fn(),
  modelSetting: vi.fn(),
  runSearch: vi.fn(),
  safeFileName: vi.fn(),
  schedulePrivacyScan: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    createReadStream: mocks.createReadStream,
    mkdirSync: vi.fn(),
    promises: { readFile: mocks.readFile, rm: mocks.removeFile },
  },
}));
vi.mock("./browser/browser.js", () => ({
  Browser: class {
    readonly close = vi.fn();
    readonly journal = vi.fn();
    constructor(options: Record<string, unknown>) {
      Object.assign(this, { options });
      mocks.browserInstances.push(this as unknown as Record<string, unknown>);
    }
  },
}));
vi.mock("./browser/browseCommands.js", () => ({
  browserClearJournal: vi.fn(), browserClearScope: vi.fn(), browserCloseTab: vi.fn(), browserGo: vi.fn(),
  browserInfo: vi.fn(), browserJournal: mocks.browserJournal, browserNavigate: mocks.browserNavigate, browserNewTab: vi.fn(),
  browserRetryProtection: vi.fn(), browserSavePage: vi.fn(), browserSelectTab: vi.fn(), browserSetBounds: mocks.browserSetBounds,
  browserSetTakeover: vi.fn(), browserTabs: mocks.browserTabs, browserVerifyPrivate: vi.fn(),
}));
vi.mock("./browser/reader.js", () => ({ browserFocusApp: vi.fn(), browserPageSelection: vi.fn(), browserPageText: mocks.browserPageText }));
vi.mock("./browser/search.js", () => ({
  browserPeek: mocks.browserPeek, browserPreview: mocks.browserPreview, browserSearchSummary: mocks.browserSearchSummary,
  importSearchResult: mocks.importSearchResult, runSearch: mocks.runSearch,
}));
vi.mock("./webFetch.js", () => ({
  fetchImage: vi.fn(), fetchPage: vi.fn(), fetchPreview: vi.fn(), fetchReadable: vi.fn(), guessDownloadMime: mocks.guessDownloadMime,
}));
vi.mock("./webSearch.js", () => ({ searchForBrowser: vi.fn() }));
vi.mock("./ollamaGenerate.js", () => ({ generate: mocks.generate }));
vi.mock("./gatherContext.js", () => ({ modelSetting: mocks.modelSetting }));
vi.mock("./db-host/files.js", () => ({
  availableName: mocks.availableName, getFileMeta: mocks.getFileMeta, insertFileFromUrl: mocks.insertFileFromUrl, setFileExtractedText: vi.fn(),
}));
vi.mock("./browser/downloads.js", () => ({ safeFileName: mocks.safeFileName }));
vi.mock("./privacy.js", () => ({ schedulePrivacyScan: mocks.schedulePrivacyScan }));

import { registerBrowserSurfaceIpc } from "./browserSurfaceIpc.js";

type Handler = (_event: unknown, raw?: unknown) => unknown;

function fixture(room: unknown, managerDeps: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  const emit = vi.fn();
  registerBrowserSurfaceIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    { room } as never,
    managerDeps as never,
    "/fake/user-data",
    emit,
    { windowContentView: () => null, focusMainWindow: vi.fn() },
  );
  const handler = (channel: string): Handler => {
    const registered = handlers.get(channel);
    if (!registered) throw new Error(`Missing IPC handler: ${channel}`);
    return registered;
  };
  return { emit, handler, managerDeps };
}

function commandDeps(call: ReturnType<typeof vi.fn>): Record<string, any> {
  const deps = call.mock.calls[0]?.[0];
  if (!deps) throw new Error("Browse command dependencies missing.");
  return deps as Record<string, any>;
}

beforeEach(() => {
  mocks.availableName.mockReset().mockImplementation((_db: unknown, name: string) => name);
  mocks.browserInstances.splice(0);
  mocks.browserJournal.mockReset();
  mocks.browserNavigate.mockReset();
  mocks.browserPageText.mockReset();
  mocks.browserPeek.mockReset();
  mocks.browserPreview.mockReset();
  mocks.browserSearchSummary.mockReset();
  mocks.browserSetBounds.mockReset();
  mocks.browserTabs.mockReset();
  mocks.generate.mockReset();
  mocks.getFileMeta.mockReset().mockReturnValue({ id: "downloaded", name: "downloaded" });
  mocks.guessDownloadMime.mockReset().mockReturnValue("text/plain");
  mocks.importSearchResult.mockReset();
  mocks.insertFileFromUrl.mockReset().mockReturnValue({ id: "legacy-download", name: "note.txt" });
  mocks.modelSetting.mockReset();
  mocks.runSearch.mockReset();
  mocks.safeFileName.mockReset().mockImplementation((name: string) => name);
  mocks.schedulePrivacyScan.mockReset();
  mocks.createReadStream.mockReset().mockReturnValue({ kind: "binary-stream" });
  mocks.readFile.mockReset().mockImplementation((_file: string, encoding?: string) =>
    Promise.resolve(encoding === "utf8" ? "downloaded text" : Buffer.from("downloaded text")),
  );
  mocks.removeFile.mockReset().mockResolvedValue(undefined);
});

describe("browser command dependency mapping with fabricated IPC state", () => {
  it("imports finished staged downloads through text and binary workspace adapters and always cleans up", async () => {
    fixture({ conn: {}, path: "/fake/legacy" }, { scheduleAutoIndex: vi.fn() });
    const legacyOptions = mocks.browserInstances[0]?.options as {
      importFinishedDownload(file: string, name: string, url: string): Promise<unknown>;
    };
    await expect(legacyOptions.importFinishedDownload(
      "/staged/legacy-note",
      "note.txt",
      "https://example.test/legacy-note",
    )).resolves.toMatchObject({ id: "legacy-download" });
    expect(mocks.readFile).toHaveBeenCalledWith("/staged/legacy-note");

    const prepare = vi.fn(() => ({ run: vi.fn() }));
    const createFile = vi.fn(async () => ({ fileId: "downloaded" }));
    const room = { conn: { prepare }, path: "/fake/workspace", workspace: { createFile } };
    const scheduleAutoIndex = vi.fn();
    const privacyScan = { scan: "fake" };
    fixture(room, { scheduleAutoIndex, privacyScan });
    const options = mocks.browserInstances[1]?.options as {
      importFinishedDownload(file: string, name: string, url: string): Promise<unknown>;
    };

    await options.importFinishedDownload("/staged/note", "note.txt", "https://example.test/note");
    expect(mocks.readFile).toHaveBeenCalledWith("/staged/note", "utf8");
    expect(createFile).toHaveBeenCalledWith("note.txt", expect.anything(), "web");
    await vi.dynamicImportSettled();
    expect(scheduleAutoIndex).toHaveBeenCalledWith("/fake/workspace");
    expect(mocks.schedulePrivacyScan).toHaveBeenCalledWith(privacyScan);

    mocks.guessDownloadMime.mockReturnValue("application/zip");
    mocks.removeFile.mockRejectedValueOnce(new Error("fabricated cleanup refusal"));
    await expect(options.importFinishedDownload(
      "/staged/archive",
      "archive.zip",
      "https://example.test/archive",
    )).resolves.toBeDefined();
    expect(mocks.createReadStream).toHaveBeenCalledWith("/staged/archive");
    expect(mocks.removeFile).toHaveBeenCalledWith("/staged/archive", { force: true });
  });

  it("maps a closed room to null/empty command context without fabricating workspace access", () => {
    mocks.browserTabs.mockReturnValue({ tabs: [] });
    const view = fixture(null);

    expect(view.handler("browser_tabs")({})).toEqual({ tabs: [] });

    const deps = commandDeps(mocks.browserTabs);
    expect(deps).toMatchObject({
      browser: expect.any(Object),
      db: null,
      roomPath: "",
      scheduleAutoIndex: expect.any(Function),
      schedulePrivacyScan: expect.any(Function),
      emitFilesChanged: expect.any(Function),
    });
    expect("workspace" in deps).toBe(false);
    deps.emitFilesChanged();
    deps.scheduleAutoIndex("/not-a-room");
    deps.schedulePrivacyScan();
    expect(view.emit).toHaveBeenCalledWith("room-files-changed", {});
    expect(mocks.schedulePrivacyScan).not.toHaveBeenCalled();
  });

  it("adds workspace context, schedules follow-up work, and preserves a fabricated command failure", async () => {
    const scheduleAutoIndex = vi.fn();
    const privacyScan = { scan: "fake" };
    const workspace = { createFile: vi.fn() };
    const room = { conn: { kind: "fake-db" }, path: "/fake/workspace", workspace };
    mocks.browserNavigate.mockRejectedValue(new Error("fake navigation failure"));
    const view = fixture(room, { scheduleAutoIndex, privacyScan });

    await expect(view.handler("browser_navigate")({}, { url: "https://fake.test" }))
      .rejects.toThrow("fake navigation failure");

    const deps = commandDeps(mocks.browserNavigate);
    expect(deps.browser).toBe(mocks.browserInstances[0]);
    expect(deps.db).toBe(room.conn);
    expect(deps.roomPath).toBe("/fake/workspace");
    expect(deps.workspace).toBe(workspace);
    deps.scheduleAutoIndex("/fake/workspace");
    deps.schedulePrivacyScan();
    await vi.dynamicImportSettled();
    expect(scheduleAutoIndex).toHaveBeenCalledWith("/fake/workspace");
    expect(mocks.schedulePrivacyScan).toHaveBeenCalledWith(privacyScan);
    expect(mocks.browserNavigate).toHaveBeenCalledWith(deps, "https://fake.test");
  });

  it("normalizes fabricated private-browser inputs and keeps search/model work behind injected seams", async () => {
    const conn = { kind: "fake-db" };
    const room = { conn, path: "/fake/room" };
    const view = fixture(room);
    mocks.browserSetBounds.mockReturnValue({ ok: true });
    mocks.browserJournal.mockImplementation((_deps, limit) => ({ limit }));
    mocks.runSearch.mockImplementation((deps, query) => {
      expect(deps.db).toBe(conn);
      expect(deps.hasModelConfigured(conn)).toBe(true);
      deps.journal("search", "https://fake.test", query);
      return { query };
    });
    mocks.modelSetting.mockReturnValue("fake-configured-model");
    mocks.browserPreview.mockImplementation((_deps, urls) => ({ urls }));
    mocks.browserPeek.mockImplementation((_deps, url) => ({ url }));
    mocks.browserSearchSummary.mockImplementation(async (deps, query) => ({
      query,
      summary: await deps.generate("fake-model", "fabricated system", "fabricated user"),
    }));
    mocks.generate.mockResolvedValue("fabricated summary");
    mocks.importSearchResult.mockReturnValue({ imported: "fabricated result" });

    expect(view.handler("browser_set_bounds")({}, { x: "4", y: 5, width: "640", height: 480 }))
      .toEqual({ ok: true });
    expect(mocks.browserSetBounds).toHaveBeenCalledWith(
      expect.objectContaining({ db: conn, roomPath: "/fake/room" }),
      { x: 4, y: 5, width: 640, height: 480 },
    );

    expect(view.handler("browser_journal")({}, { limit: 7 })).toEqual({ limit: 7 });
    expect(view.handler("browser_journal")({}, { limit: "7" })).toEqual({ limit: undefined });
    expect(mocks.browserJournal).toHaveBeenLastCalledWith(expect.any(Object), undefined);

    expect(view.handler("browser_search")({}, { query: "fabricated query" }))
      .toEqual({ query: "fabricated query" });
    const browserJournal = mocks.browserInstances[0]?.journal as ReturnType<typeof vi.fn>;
    expect(browserJournal).toHaveBeenCalledWith(
      "search",
      "https://fake.test",
      "fabricated query",
    );

    expect(view.handler("browser_preview")({}, { urls: ["https://one.test", 4, null, "https://two.test"] }))
      .toEqual({ urls: ["https://one.test", "https://two.test"] });
    mocks.browserPageText.mockReturnValue({ text: "fabricated page slice" });
    expect(view.handler("browser_page_text")({}, { mode: "selection", offset: "12" }))
      .toEqual({ text: "fabricated page slice" });
    expect(mocks.browserPageText).toHaveBeenCalledWith(mocks.browserInstances[0], "selection", 12);
    expect(view.handler("browser_peek")({}, null)).toEqual({ url: "" });
    await expect(view.handler("browser_search_summary")({}, { query: "condense this" }))
      .resolves.toEqual({ query: "condense this", summary: "fabricated summary" });
    expect(mocks.generate).toHaveBeenCalledWith(
      "fake-model",
      [
        { role: "system", content: "fabricated system" },
        { role: "user", content: "fabricated user" },
      ],
      0.2,
      "5m",
    );

    expect(view.handler("import_search_result")({}, { url: "https://fake.test/result", title: "Fake result" }))
      .toEqual({ imported: "fabricated result" });
    expect(mocks.importSearchResult).toHaveBeenCalledWith(
      expect.objectContaining({ db: conn, importWebSource: expect.any(Function), journal: expect.any(Function) }),
      "https://fake.test/result",
      "Fake result",
    );
  });
});
