import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const workerPath = require.resolve("./browserLive.worker.cjs");
const { createWorker, isWorkerEntrypoint } = require(workerPath) as {
  createWorker(deps: Record<string, unknown>): { run(): Promise<void>; start(): Promise<void> };
  isWorkerEntrypoint(runtimeProcess: { argv: string[] }): boolean;
};

type BeforeRequest = (
  details: {
    url: string;
    resourceType?: string;
    frame?: { top?: { url?: string } | null } | null;
  },
  callback: (result: { cancel: boolean }) => void,
) => void;

function workerResult(output: string[]): Record<string, unknown> {
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]!.slice("RESULT:".length)) as Record<string, unknown>;
}

function workerFakes(scenario: string) {
  const output: string[] = [];
  const sites: Array<{
    handle: (request: { url: string }, response: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }) => void;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const sessions = new Map<string, {
    name: string;
    beforeRequest: BeforeRequest | null;
    isPersistent(): boolean;
    getStoragePath(): string | undefined;
    registerPreloadScript: ReturnType<typeof vi.fn>;
    webRequest: { onBeforeRequest(listener: BeforeRequest): void };
  }>();
  let nextViewId = 1;
  const addedViews: unknown[] = [];

  class FakeView {
    webContents: {
      id: number;
      on: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
      executeJavaScript: ReturnType<typeof vi.fn>;
      getURL: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      mainFrame: { frames: unknown[] };
    };
    constructor(readonly options: { webPreferences: { session: { beforeRequest: BeforeRequest | null } } }) {
      const events = new Map<string, (event: { url: string; isMainFrame: boolean }) => void>();
      let opened: ((details: { url: string; disposition: string }) => unknown) | undefined;
      let currentUrl = "";
      this.webContents = {
        id: nextViewId++,
        on: vi.fn((event: string, listener: (payload: { url: string; isMainFrame: boolean }) => void) => {
          events.set(event, listener);
        }),
        loadURL: vi.fn(async (url: string) => {
          currentUrl = url;
          if (scenario !== "navigation-events") return;
          if (url.endsWith("/redirect")) {
            const landing = "http://127.0.0.1:4567/landing";
            events.get("will-redirect")?.({ url: landing, isMainFrame: true });
            events.get("will-frame-navigate")?.({ url: landing, isMainFrame: true });
            currentUrl = landing;
            return;
          }
          if (url.endsWith("/popup")) {
            opened?.({ url: "https://popup.invalid/", disposition: "new-window" });
            return;
          }
          const beforeRequest = options.webPreferences.session.beforeRequest;
          if (beforeRequest !== null) {
            const proceed = vi.fn();
            beforeRequest({ url, resourceType: "mainFrame" }, proceed);
            beforeRequest({
              url: "http://127.0.0.1:4567/frame",
              resourceType: "subFrame",
              frame: { top: { url } },
            }, proceed);
            beforeRequest({
              url: "http://127.0.0.1:4567/no-top",
              resourceType: "xhr",
              frame: { top: null },
            }, proceed);
            const throwingFrame = { url: "http://127.0.0.1:4567/broken", resourceType: "xhr" };
            Object.defineProperty(throwingFrame, "frame", {
              get: () => { throw new Error("fake frame access failure"); },
            });
            beforeRequest(throwingFrame, proceed);
          }
        }),
        executeJavaScript: vi.fn(async (source: string) => {
          if (source.includes("JSON.stringify")) return "[]";
          if (source.includes('call("ping"')) return { doc: "fake document" };
          return "object";
        }),
        getURL: vi.fn(() => currentUrl),
        setWindowOpenHandler: vi.fn((handler: (details: { url: string; disposition: string }) => unknown) => {
          opened = handler;
        }),
        mainFrame: {
          frames: scenario === "preload"
            ? [{ executeJavaScript: vi.fn(async () => "object") }]
            : [] as unknown[],
        },
      };
    }
    setBounds = vi.fn();
  }

  class FakeWindow {
    contentView = { addChildView: vi.fn((view: unknown) => addedViews.push(view)) };
  }

  const electron = {
    app: { whenReady: vi.fn(async () => {}), exit: vi.fn() },
    session: {
      fromPartition(name: string) {
        const known = sessions.get(name);
        if (known !== undefined) return known;
        const created = {
          name,
          beforeRequest: null as BeforeRequest | null,
          isPersistent: () => name.startsWith("persist:"),
          getStoragePath: () => name.startsWith("persist:") ? `/fake/${name}` : undefined,
          registerPreloadScript: vi.fn(),
          webRequest: {
            onBeforeRequest(listener: BeforeRequest) {
              created.beforeRequest = listener;
            },
          },
        };
        sessions.set(name, created);
        return created;
      },
    },
    net: {},
    BaseWindow: FakeWindow,
    WebContentsView: FakeView,
  };
  const http = {
    createServer(handle: (request: { url: string }, response: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }) => void) {
      const close = vi.fn();
      sites.push({ handle, close });
      return {
        listen: (_port: number, _host: string, ready: () => void) => ready(),
        address: () => ({ port: 4567 }),
        close,
      };
    },
  };
  const process = {
    argv: ["node", "browserLive.worker.cjs", scenario, "/fake/page.js", "4567"],
    stdout: { write: (line: string) => output.push(line.trim()) },
  };
  const worker = createWorker({
    electron,
    http,
    process,
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
  });
  return { worker, electron, sessions, addedViews, output, sites };
}

describe("browserLive worker with fabricated process and Electron seams", () => {
  it("recognizes Electron's direct script argv when its bootstrap owns require.main", () => {
    expect(
      isWorkerEntrypoint({
        argv: ["/fake/electron", workerPath, "ephemeral"],
      }),
    ).toBe(true);
    expect(isWorkerEntrypoint({ argv: ["node", "/fake/vitest.mjs"] })).toBe(false);
  });

  it("reports ephemeral-partition isolation through the RESULT protocol", async () => {
    const fakes = workerFakes("ephemeral");

    await fakes.worker.run();

    expect(workerResult(fakes.output)).toMatchObject({
      ephemeralIsPersistent: false,
      persistentIsPersistent: true,
      persistentHasStoragePath: true,
      differentNamesAreDifferentSessions: true,
      sameNameIsTheSameSession: true,
    });
  });

  it("creates three fabricated views with three isolated sessions", async () => {
    const fakes = workerFakes("views");

    await fakes.worker.run();

    expect(workerResult(fakes.output)).toMatchObject({ allUnique: true });
    expect(fakes.addedViews).toHaveLength(3);
    expect([...fakes.sessions.values()].filter((session) => session.name.includes("arcelle-live-tab-")))
      .toHaveLength(3);
  });

  it("records fabricated navigation, popup, and frame-context details without navigating", async () => {
    const fakes = workerFakes("navigation-events");

    await fakes.worker.run();

    expect(workerResult(fakes.output)).toEqual({
      redirectEvents: [
        { event: "will-redirect", url: "http://127.0.0.1:4567/landing", isMainFrame: true },
        { event: "will-frame-navigate", url: "http://127.0.0.1:4567/landing", isMainFrame: true },
      ],
      finalUrl: "http://127.0.0.1:4567/landing",
      windowOpenDetails: [{ url: "https://popup.invalid/", disposition: "new-window" }],
      webRequests: [
        { url: "http://127.0.0.1:4567/", resourceType: "mainFrame", hasFrame: false, topUrl: null },
        {
          url: "http://127.0.0.1:4567/frame",
          resourceType: "subFrame",
          hasFrame: true,
          topUrl: "http://127.0.0.1:4567/",
        },
        { url: "http://127.0.0.1:4567/no-top", resourceType: "xhr", hasFrame: true, topUrl: null },
        { url: "http://127.0.0.1:4567/broken", resourceType: "xhr", hasFrame: false, topUrl: "THREW" },
      ],
    });
    expect(fakes.sites[0]?.close).toHaveBeenCalledOnce();
  });

  it("serves every fabricated reader page from the worker's local-site handler", async () => {
    const fakes = workerFakes("preload");

    await fakes.worker.run();

    const site = fakes.sites[0];
    if (site === undefined) throw new Error("worker did not create its local site");
    const serve = (url: string) => {
      const response = { writeHead: vi.fn(), end: vi.fn() };
      site.handle({ url }, response);
      return response;
    };

    for (const [url, body] of [
      ["/frame", "<button id='fb'>In frame</button>"],
      ["/landing", "landed"],
      ["/popup", "window.open();"],
      ["/", "window.__sawBridgeAtInline"],
    ]) {
      const response = serve(url);
      expect(response.writeHead).toHaveBeenCalledWith(200, { "content-type": "text/html" });
      expect(response.end).toHaveBeenCalledWith(expect.stringContaining(body));
    }

    const redirect = serve("/redirect");
    expect(redirect.writeHead).toHaveBeenCalledWith(302, { location: "http://127.0.0.1:4567/landing" });
    expect(redirect.end).toHaveBeenCalledWith();
    expect(site.close).toHaveBeenCalledOnce();
  });

  it("keeps web-request cancellation and success replies inside fabricated client seams", async () => {
    const fakes = workerFakes("webrequest-block");
    const net = {
      request({ url, session }: { url: string; session: { beforeRequest: BeforeRequest | null } }) {
        const listeners = new Map<string, (value: any) => void>();
        return {
          on(event: string, listener: (value: any) => void) {
            listeners.set(event, listener);
            return this;
          },
          end() {
            const complete = (blocked: boolean) => {
              if (blocked) {
                listeners.get("error")?.(new Error("blocked by fake rule"));
                return;
              }
              listeners.get("response")?.({
                statusCode: 204,
                on(event: string, listener: () => void) {
                  if (event === "data" || event === "end") listener();
                },
              });
            };
            if (session.beforeRequest === null) {
              complete(false);
              return;
            }
            session.beforeRequest({ url }, (result) => complete(result.cancel));
          },
        };
      },
    };
    fakes.worker = createWorker({
      electron: {
        app: fakes.electron.app,
        session: fakes.electron.session,
        net,
        BaseWindow: fakes.electron.BaseWindow,
        WebContentsView: fakes.electron.WebContentsView,
      },
      http: {},
      process: {
        argv: ["node", "browserLive.worker.cjs", "webrequest-block", "/fake/page.js", "4567"],
        stdout: { write: (line: string) => fakes.output.push(line.trim()) },
      },
      setTimeout: () => 0,
    });

    await fakes.worker.run();

    expect(workerResult(fakes.output)).toEqual({
      blocked: { ok: false, error: "blocked by fake rule" },
      allowed: { ok: true, status: 204 },
    });

    const blocking = [...fakes.sessions.values()].find((value) => value.name.includes("live-block"));
    const callback = vi.fn();
    blocking?.beforeRequest?.({ url: "not a URL" }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: false });
  });

  it("turns a synchronous fabricated net.request failure into a normal scenario result", async () => {
    const fakes = workerFakes("webrequest-block");
    const request = vi.fn(() => { throw new Error("fabricated net setup failure"); });
    fakes.worker = createWorker({
      electron: { ...fakes.electron, net: { request } },
      http: {},
      process: {
        argv: ["node", "browserLive.worker.cjs", "webrequest-block", "/fake/page.js", "4567"],
        stdout: { write: (line: string) => fakes.output.push(line.trim()) },
      },
      setTimeout: () => 0,
    });

    await fakes.worker.run();

    expect(workerResult(fakes.output)).toEqual({
      blocked: { ok: false, error: "fabricated net setup failure" },
      allowed: { ok: false, error: "fabricated net setup failure" },
    });
  });

  it("reports unknown scenarios without starting a fabricated runtime", async () => {
    const fakes = workerFakes("unknown");

    await fakes.worker.run();

    expect(workerResult(fakes.output)).toEqual({ error: "unknown scenario: unknown" });
    expect(fakes.electron.app.whenReady).not.toHaveBeenCalled();
  });

  it("turns a fabricated worker failure into the existing exit-one protocol", async () => {
    const fakes = workerFakes("ephemeral");
    fakes.electron.session.fromPartition = () => {
      throw new Error("fake session failure");
    };

    await fakes.worker.start();

    expect(fakes.electron.app.exit).toHaveBeenCalledWith(1);
    expect(workerResult(fakes.output).error).toContain("worker threw: Error: fake session failure");
  });
});
