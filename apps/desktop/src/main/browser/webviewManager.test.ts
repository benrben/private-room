import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireElectron: vi.fn(),
  registerWebRequestFunnel: vi.fn(),
  attachDownloadGating: vi.fn(),
  attachNavigationGating: vi.fn(),
  attachPopupHandling: vi.fn(),
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: vi.fn(() => mocks.requireElectron) };
});
vi.mock("./webRequestFunnel.js", () => ({ registerWebRequestFunnel: mocks.registerWebRequestFunnel }));
vi.mock("./downloadGating.js", () => ({ attachDownloadGating: mocks.attachDownloadGating }));
vi.mock("./navigation.js", () => ({ attachNavigationGating: mocks.attachNavigationGating }));
vi.mock("./popup.js", () => ({ attachPopupHandling: mocks.attachPopupHandling }));
vi.mock("./pageScript.js", () => ({
  PAGE_SCRIPT_PATHS: ["/fake/page-core.js", "/fake/page-script.js"],
}));

import {
  createLivePage,
  destroyLivePage,
  evalHostFor,
  verifyPageEphemeral,
  type CreatePageDeps,
} from "./webviewManager.js";

function deps(): CreatePageDeps {
  return { contentBlocking: {} as never, downloadGating: {} as never, navigation: {} as never };
}

beforeEach(() => {
  mocks.requireElectron.mockReset();
  mocks.registerWebRequestFunnel.mockReset().mockReturnValue({ ok: true });
  mocks.attachDownloadGating.mockReset();
  mocks.attachNavigationGating.mockReset();
  mocks.attachPopupHandling.mockReset();
});

describe("webview manager Electron seam", () => {
  it("rejects every non-Electron module shape before creating browser state", () => {
    for (const candidate of [undefined, "/fake/electron", {}, { session: {} }]) {
      mocks.requireElectron.mockReturnValue(candidate);

      expect(() => createLivePage("page", deps())).toThrow(
        "The private browser is only available inside a running Electron app.",
      );
    }
    expect(mocks.registerWebRequestFunnel).not.toHaveBeenCalled();
  });

  it("constructs an isolated fabricated Electron page after registering its protections", () => {
    const webSession = { registerPreloadScript: vi.fn() };
    const fromPartition = vi.fn(() => webSession);
    const contents = {};
    class FakeWebContentsView {
      readonly webContents = contents;

      constructor(readonly options: { webPreferences: Record<string, unknown> }) {}
    }
    mocks.requireElectron.mockReturnValue({
      session: { fromPartition },
      WebContentsView: FakeWebContentsView,
    });

    const page = createLivePage("page-1", deps());

    expect(fromPartition).toHaveBeenCalledWith(expect.stringMatching(/^arcelle-browse-/));
    expect(webSession.registerPreloadScript.mock.calls).toEqual([
      [{ filePath: "/fake/page-core.js", type: "frame" }],
      [{ filePath: "/fake/page-script.js", type: "frame" }],
    ]);
    expect(mocks.registerWebRequestFunnel).toHaveBeenCalledWith(webSession, {});
    expect(mocks.attachDownloadGating).toHaveBeenCalledWith(webSession, {});
    expect(mocks.attachPopupHandling).toHaveBeenCalledWith(contents);
    expect(mocks.attachNavigationGating).toHaveBeenCalledWith(contents, {});
    expect(page).toMatchObject({ id: "page-1", contents, webSession, protection: { state: "active" } });
    expect(page.view).toBeInstanceOf(FakeWebContentsView);
    expect((page.view as unknown as FakeWebContentsView).options.webPreferences).toMatchObject({
      session: webSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      webSecurity: true,
    });
  });

  it("records blocker failure, contains detach errors, and closes the renderer", () => {
    const contents = { isDestroyed: vi.fn(() => false), close: vi.fn() };
    class FakeWebContentsView { readonly webContents = contents; }
    mocks.requireElectron.mockReturnValue({
      session: { fromPartition: () => ({ registerPreloadScript: vi.fn() }) },
      WebContentsView: FakeWebContentsView,
    });
    mocks.registerWebRequestFunnel.mockReturnValue({ ok: false, reason: "fabricated blocker refusal" });
    const page = createLivePage("failed-protection", deps());
    expect(page.protection).toEqual({ state: "failed", reason: "fabricated blocker refusal" });

    const removeChildView = vi.fn(() => { throw new Error("fabricated detached view"); });
    expect(() => destroyLivePage({ addChildView: vi.fn(), removeChildView } as never, page)).not.toThrow();
    expect(removeChildView).toHaveBeenCalledWith(page.view);
    expect(contents.close).toHaveBeenCalledOnce();
  });

  it("rejects evaluation when the requested renderer has already gone away", async () => {
    const host = evalHostFor(new Map());
    await expect(host.evaluate("closed-page", "2 + 2")).rejects.toThrow(
      "That page was closed while it was working",
    );
  });

  it("requires both independent session checks to confirm an ephemeral page", () => {
    const isPersistent = vi.fn(() => false);
    const getStoragePath = vi.fn(() => null);
    const page = { webSession: { isPersistent, getStoragePath } } as never;

    expect(verifyPageEphemeral(page)).toBe(true);
    expect(isPersistent).toHaveBeenCalledOnce();
    expect(getStoragePath).toHaveBeenCalledOnce();

    isPersistent.mockReturnValue(true);
    expect(verifyPageEphemeral(page)).toBe(false);
    expect(getStoragePath).toHaveBeenCalledOnce();

    isPersistent.mockReturnValue(false);
    getStoragePath.mockReturnValue("/unexpected/session/path" as never);
    expect(verifyPageEphemeral(page)).toBe(false);
  });
});
