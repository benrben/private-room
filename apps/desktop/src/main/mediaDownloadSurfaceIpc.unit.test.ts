import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

const mocks = vi.hoisted(() => ({
  downloadRowStarter: vi.fn(),
  downloadToTemp: vi.fn(),
  importMediaUrl: vi.fn(),
  listMediaFormats: vi.fn(),
  mediaProgressToEventSender: vi.fn(),
  startDownloadJobInner: vi.fn(),
  webAccessEnabled: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  availableName: vi.fn(),
  getFileMeta: vi.fn(),
  insertFileFromUrl: vi.fn(),
  setFileExtractedText: vi.fn(),
}));
vi.mock("./documentExtraction.js", () => ({ extractDocumentText: vi.fn() }));
vi.mock("./editMatchExtraction.js", () => ({ extensionOf: vi.fn() }));
vi.mock("./peaksTools.js", () => ({ mediaKind: vi.fn() }));
vi.mock("./mediaTranscribeJob.js", () => ({ transcribeMediaWithSpeakers: vi.fn() }));
vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: mocks.webAccessEnabled }));
vi.mock("./ytdlp.js", () => ({
  cancelMediaDownload: vi.fn(),
  importMediaUrl: mocks.importMediaUrl,
  listMediaFormats: mocks.listMediaFormats,
  mediaProgressToEventSender: mocks.mediaProgressToEventSender,
}));
vi.mock("./jobDownload.js", () => ({
  downloadRowStarter: mocks.downloadRowStarter,
  startDownloadJobInner: mocks.startDownloadJobInner,
}));
vi.mock("./webFetch.js", () => ({ downloadToTemp: mocks.downloadToTemp, guessDownloadMime: vi.fn() }));

import { createDownloadEngineDeps, registerMediaDownloadSurfaceIpc } from "./mediaDownloadSurfaceIpc.js";

type Handler = (event: IpcMainInvokeEvent, raw?: unknown) => unknown;

function fixture(
  rollingBack = false,
  withQueue = true,
  room: unknown = { conn: { fake: "connection" } },
): {
  deps: RoomManagerDeps;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  const deps = (withQueue
    ? { jobQueue: { starters: new Map([["existing", "existing-starter"]]) } }
    : {}) as RoomManagerDeps;
  const state = { rollingBack, room } as RoomManagerState;
  registerMediaDownloadSurfaceIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as Pick<IpcMain, "handle">,
    state,
    deps,
    "/fake/user-data",
    vi.fn() as EventSender,
  );
  return { deps, handlers };
}

function handler(handlers: Map<string, Handler>, channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`Missing ${channel}`);
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadRowStarter.mockReturnValue("download-row-starter");
  mocks.downloadToTemp.mockReset();
  mocks.importMediaUrl.mockResolvedValue({ id: "fake-media" });
  mocks.listMediaFormats.mockReset().mockResolvedValue([]);
  mocks.mediaProgressToEventSender.mockReturnValue("fake-progress");
  mocks.startDownloadJobInner.mockReturnValue("download-job-1");
  mocks.webAccessEnabled.mockReturnValue(true);
});

describe("start_download_job IPC with fabricated download dependencies", () => {
  it("normalizes supplied and absent job details, then uses the registered fake queue starter", () => {
    const { deps, handlers } = fixture();
    const start = handler(handlers, "start_download_job");

    expect(start({} as IpcMainInvokeEvent, { url: 42, engine: "media" })).toBe("download-job-1");
    expect(start({} as IpcMainInvokeEvent, null)).toBe("download-job-1");

    expect(mocks.downloadRowStarter).toHaveBeenCalledOnce();
    expect(mocks.startDownloadJobInner.mock.calls.map(([, url, engine]) => [url, engine])).toEqual([
      ["42", "media"],
      ["", "fetch"],
    ]);
    const engineDeps = mocks.startDownloadJobInner.mock.calls[0]?.[0] as {
      dataDir: string;
      starters: Map<string, unknown>;
    };
    expect(engineDeps.dataDir).toBe("/fake/user-data");
    expect(engineDeps.starters.get("existing")).toBe("existing-starter");
    expect(engineDeps.starters.get("download")).toBe("download-row-starter");
    expect((deps.jobQueue?.starters as Map<string, unknown>).get("download")).toBe("download-row-starter");
  });

  it("refuses rollback and queue-unavailable requests before starting fabricated work", () => {
    const rollingBack = fixture(true);
    expect(() => handler(rollingBack.handlers, "start_download_job")({} as IpcMainInvokeEvent, {}))
      .toThrow("A rollback is in progress. Try again in a moment.");

    const withoutQueue = fixture(false, false);
    expect(() => handler(withoutQueue.handlers, "start_download_job")({} as IpcMainInvokeEvent, {}))
      .toThrow("The job queue is unavailable.");
    expect(mocks.startDownloadJobInner).not.toHaveBeenCalled();
  });
});

describe("import_media_url IPC with fabricated media dependencies", () => {
  it("normalizes a valid fake request and delegates with access and progress seams", async () => {
    const conn = { fake: "connection" };
    const received: Array<[string, Record<string, unknown>]> = [];
    mocks.importMediaUrl.mockImplementation(async (url: string, options: Record<string, unknown>) => {
      received.push([url, options]);
      expect((options.webAccessAllowed as () => boolean)()).toBe(true);
      return { id: "fake-import", name: "clip.mp4" };
    });
    const { handlers } = fixture(false, true, { conn });

    await expect(handler(handlers, "import_media_url")(
      {} as IpcMainInvokeEvent,
      { url: "https://fake.example/clip", maxHeight: 720 },
    )).resolves.toEqual({ id: "fake-import", name: "clip.mp4" });

    expect(received).toHaveLength(1);
    const [url, options] = received[0]!;
    expect(url).toBe("https://fake.example/clip");
    expect(options).toMatchObject({
      dataDir: "/fake/user-data",
      maxHeight: 720,
      progress: "fake-progress",
    });
    expect(options.importDownload).toEqual(expect.any(Function));
    expect(mocks.webAccessEnabled).toHaveBeenCalledWith(conn);
  });

  it("forwards fabricated validation failures and normalizes malformed values without importing", async () => {
    mocks.importMediaUrl.mockImplementation(async (url: string) => {
      throw new Error(`fake invalid media URL: ${url || "missing"}`);
    });
    const { handlers } = fixture();

    await expect(handler(handlers, "import_media_url")({} as IpcMainInvokeEvent, {
      url: null,
      maxHeight: "720",
    })).rejects.toThrow("fake invalid media URL: missing");
    expect(mocks.importMediaUrl).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ maxHeight: null }),
    );
  });

  it("keeps a missing fabricated room error visible when the media layer checks access", async () => {
    mocks.importMediaUrl.mockImplementation(async (_url: string, options: Record<string, unknown>) => (
      (options.webAccessAllowed as () => boolean)()
    ));
    const { handlers } = fixture(false, true, null);

    await expect(handler(handlers, "import_media_url")(
      {} as IpcMainInvokeEvent,
      { url: "https://fake.example/clip" },
    )).rejects.toThrow("No room is open.");
    expect(mocks.webAccessEnabled).not.toHaveBeenCalled();
  });
});

describe("download engine and format-list adapters", () => {
  it("maps both fabricated download outcomes to the engine contract", async () => {
    const engine = createDownloadEngineDeps({ room: {} } as RoomManagerState, "/fake/data", vi.fn());
    mocks.downloadToTemp
      .mockResolvedValueOnce({ kind: "tooLarge" })
      .mockResolvedValueOnce({ kind: "done", downloaded: { path: "/fake/staged", fileName: "clip.mp4" } });
    const cancel = { load: () => false };
    const progress = vi.fn();

    await expect(engine.downloadToTemp!("https://fake.example/large", 10, cancel, progress))
      .resolves.toEqual({ kind: "too-large" });
    await expect(engine.downloadToTemp!("https://fake.example/clip", 20, cancel, progress))
      .resolves.toEqual({ kind: "done", file: { path: "/fake/staged", fileName: "clip.mp4" } });
  });

  it("normalizes a format-list request and drives its room access predicate", async () => {
    const conn = { fake: "connection" };
    mocks.listMediaFormats.mockImplementation(async (_url: string, options: Record<string, unknown>) => {
      expect((options.webAccessAllowed as () => boolean)()).toBe(true);
      return [{ id: "fake-format" }];
    });
    const { handlers } = fixture(false, true, { conn });

    await expect(handler(handlers, "list_media_formats")(
      {} as IpcMainInvokeEvent,
      { url: 42 },
    )).resolves.toEqual([{ id: "fake-format" }]);
    expect(mocks.listMediaFormats).toHaveBeenCalledWith("42", {
      dataDir: "/fake/user-data",
      webAccessAllowed: expect.any(Function),
      progress: "fake-progress",
    });
    expect(mocks.webAccessEnabled).toHaveBeenCalledWith(conn);
  });
});
