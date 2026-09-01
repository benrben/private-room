import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUiRuntime } from "./agentUiSurfaceIpc.js";
import type { Browser } from "./browser/browser.js";
import { browserNavigate, browserSavePage } from "./browser/browseCommands.js";
import { formatHitsForAgent, runSearch } from "./browser/search.js";
import { createBrowserAgentTool } from "./browserAgentTools.js";
import type { ToolEffects } from "./execTool.js";
import { requestAgentUi } from "./agentUiSurfaceIpc.js";
import { maskOutboundWeb, outboundUrlHides, webMaskNote } from "./privacy.js";
import type { RoomManagerState } from "./roomManager.js";

vi.mock("./browser/browseCommands.js", () => ({
  browserNavigate: vi.fn(),
  browserSavePage: vi.fn(),
}));

vi.mock("./browser/search.js", () => ({
  runSearch: vi.fn(),
  formatHitsForAgent: vi.fn(),
}));

vi.mock("./privacy.js", () => ({
  maskOutboundWeb: vi.fn(),
  outboundUrlHides: vi.fn(),
  webMaskNote: vi.fn(),
}));

vi.mock("./agentUiSurfaceIpc.js", () => ({ requestAgentUi: vi.fn() }));

type BrowserFake = {
  takeover: boolean;
  isOpen: ReturnType<typeof vi.fn>;
  waitReady: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  callAsync: ReturnType<typeof vi.fn>;
  captureActivePage: ReturnType<typeof vi.fn>;
  journal: ReturnType<typeof vi.fn>;
};

function effects(): ToolEffects {
  return { pendingImages: [] } as ToolEffects;
}

function state(room = true): RoomManagerState {
  return {
    room: room ? {
      conn: { prepare: () => ({ raw: () => ({ get: () => undefined }) }) },
      path: "/tmp/test.roomai",
    } : null,
  } as unknown as RoomManagerState;
}

function browser(): BrowserFake {
  return {
    takeover: false,
    isOpen: vi.fn(() => false),
    waitReady: vi.fn(async () => undefined),
    call: vi.fn(async () => ({})),
    callAsync: vi.fn(async () => ({})),
    captureActivePage: vi.fn(async () => Buffer.from("png")),
    journal: vi.fn(),
  };
}

function toolHarness(options: { room?: boolean; browser?: BrowserFake } = {}) {
  const fakeBrowser = options.browser ?? browser();
  const emit = vi.fn();
  const runtime: AgentUiRuntime = { pending: new Map() };
  const tool = createBrowserAgentTool({
    state: state(options.room ?? true),
    roomDeps: {} as never,
    browser: fakeBrowser as unknown as Browser,
    agentUi: runtime,
    emit,
  });
  return { tool, fakeBrowser, emit };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(browserNavigate).mockImplementation(async (deps, url) => {
    deps.scheduleAutoIndex();
    deps.schedulePrivacyScan();
    deps.emitFilesChanged();
    return url;
  });
  vi.mocked(browserSavePage).mockImplementation(async (deps, what) => {
    deps.emitFilesChanged();
    return `Saved ${what}`;
  });
  vi.mocked(runSearch).mockImplementation(async (deps) => {
    deps.hasModelConfigured(deps.db);
    deps.journal("search", "", "Search started");
    return {} as never;
  });
  vi.mocked(formatHitsForAgent).mockReturnValue("Search hits");
  vi.mocked(maskOutboundWeb).mockReturnValue(null);
  vi.mocked(outboundUrlHides).mockReturnValue(null);
  vi.mocked(webMaskNote).mockReturnValue(" [masked]");
  vi.mocked(requestAgentUi).mockResolvedValue({ approved: true });
});

describe("createBrowserAgentTool", () => {
  it("leaves non-browser calls alone and safely refuses unavailable browser states", async () => {
    const noRoom = toolHarness({ room: false });
    await expect(noRoom.tool("not_browse", {}, effects())).resolves.toBeNull();
    await expect(noRoom.tool("browse_read", {}, effects())).resolves.toEqual({ ok: false, error: "No room is open." });
    expect(noRoom.fakeBrowser.journal).toHaveBeenCalledWith("error", "", "browse_read failed: No room is open.");

    const takeover = toolHarness();
    takeover.fakeBrowser.takeover = true;
    await expect(takeover.tool("browse_read", {}, effects())).resolves.toEqual({
      ok: false,
      error: "The user is controlling the browser right now. Wait until they hand it back.",
    });

    const unknown = toolHarness();
    unknown.fakeBrowser.isOpen.mockReturnValue(true);
    await expect(unknown.tool("browse_unknown", {}, effects())).resolves.toBeNull();
    expect(unknown.fakeBrowser.waitReady).toHaveBeenCalledWith();

    const blank = toolHarness();
    await expect(blank.tool("browse_open", {}, effects())).resolves.toEqual({
      ok: false,
      error: "Say what to open, or what to search for.",
    });
  });

  it("opens an address, waits for its settled snapshot, and reports controls", async () => {
    const { tool, fakeBrowser, emit } = toolHarness();
    fakeBrowser.callAsync.mockResolvedValue({
      snapshot: {
        title: "Example",
        elements: [{ ref: 2, role: "link", label: "Docs", region: "main", state: "enabled" }],
      },
    });

    await expect(tool("browse_open", { url: "https://example.com" }, effects())).resolves.toEqual({
      ok: true,
      text: "Example\n[2] link \"Docs\" — main (enabled)",
    });
    expect(browserNavigate).toHaveBeenCalledWith(expect.objectContaining({ roomPath: "/tmp/test.roomai" }), "https://example.com");
    expect(fakeBrowser.waitReady).toHaveBeenCalledWith(25_000);
    expect(fakeBrowser.journal).toHaveBeenCalledWith("open", "https://example.com", "Opened by the agent");
    expect(emit).toHaveBeenCalledWith("browser-navigated", "https://example.com");
    expect(emit).toHaveBeenCalledWith("room-files-changed", {});
  });

  it("searches masked text but does not open a protected outbound address", async () => {
    const search = toolHarness();
    vi.mocked(maskOutboundWeb).mockReturnValue({ masked: "safe query", hidden: 2 } as never);
    await expect(search.tool("browse_open", { url: "interesting private topic" }, effects())).resolves.toEqual({
      ok: true,
      text: "Search hits [masked]",
    });
    expect(runSearch).toHaveBeenCalledWith(expect.objectContaining({ db: expect.anything() }), "safe query");
    expect(search.emit).toHaveBeenCalledWith("browser-searched", {});

    const protectedAddress = toolHarness();
    vi.mocked(outboundUrlHides).mockReturnValue(3);
    await expect(protectedAddress.tool("browse_open", { url: "https://example.com" }, effects())).resolves.toEqual({
      ok: true,
      text: "Not opened: this address carries 3 protected name(s), and Cloud privacy is on.",
    });
    expect(browserNavigate).not.toHaveBeenCalled();
  });

  it("reads, finds, and snapshots browser content with their empty-state wording", async () => {
    const { tool, fakeBrowser } = toolHarness();
    fakeBrowser.call.mockImplementation(async (name: string) => {
      if (name === "read") return { title: "Read title", url: "https://example.com", text: "Body", nextOffset: 8 };
      if (name === "find") return { matches: [] };
      return { elements: [] };
    });

    await expect(tool("browse_read", { mode: "article", offset: 3 }, effects())).resolves.toEqual({
      ok: true,
      text: "Read title\nSource: https://example.com\n\nBody\n\nContinue with offset 8.",
    });
    await expect(tool("browse_find", { text: "needle" }, effects())).resolves.toEqual({
      ok: true,
      text: "Nothing on this page matches \"needle\".",
    });
    fakeBrowser.call.mockResolvedValueOnce({ matches: [{ mark: "m", name: "Needle" }] });
    await expect(tool("browse_find", { text: "needle" }, effects())).resolves.toEqual({
      ok: true,
      text: "1 match(es) for \"needle\":\n[m] control \"Needle\"",
    });
    await expect(tool("browse_snapshot", {}, effects())).resolves.toEqual({
      ok: true,
      text: "No interactive controls are visible on this page.",
    });
    fakeBrowser.call.mockResolvedValueOnce({});
    await expect(tool("browse_read", {}, effects())).resolves.toEqual({ ok: true, text: "This page has no readable text." });
  });

  it("requires consent before typing and reports both successful and failed actions", async () => {
    const { tool, fakeBrowser } = toolHarness();
    await expect(tool("browse_do", {}, effects())).resolves.toEqual({
      ok: false,
      error: "browse_do needs at least one action.",
    });

    fakeBrowser.call.mockResolvedValue({ url: "https://example.com" });
    fakeBrowser.callAsync.mockResolvedValue({
      results: [{ ok: true, did: "Clicked Docs" }],
      snapshot: { elements: [] },
    });
    const typing = [{ type: { ref: 7, text: "private" } }, { type: { ref: 8, text: "" } }];
    await expect(tool("browse_do", { actions: typing }, effects())).resolves.toEqual({
      ok: true,
      text: "Browser: Clicked Docs\nNo interactive controls are visible on this page.",
    });
    expect(requestAgentUi).toHaveBeenCalledWith(expect.anything(), expect.anything(), "browse_consent", {
      url: "https://example.com", field: "7", text: "private", entities: [],
    });
    expect(fakeBrowser.journal).toHaveBeenCalledWith("act", "https://example.com", "Browser: Clicked Docs");

    vi.mocked(requestAgentUi).mockResolvedValueOnce({ approved: false });
    await expect(tool("browse_do", { actions: typing }, effects())).resolves.toEqual({
      ok: false,
      error: "The user declined, so nothing was typed.",
    });

    vi.mocked(requestAgentUi).mockResolvedValue({ approved: true });
    fakeBrowser.callAsync.mockResolvedValue({ ok: false, error: "Act failed", results: [] });
    await expect(tool("browse_do", { actions: [{ type: { click: { ref: 1 } } }] }, effects())).resolves.toEqual({
      ok: false,
      error: "Act failed",
    });
  });

  it("captures annotated browser images, saves pages, and shapes transport errors", async () => {
    const { tool, fakeBrowser, emit } = toolHarness();
    fakeBrowser.callAsync.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "annotate" && args.on === false) throw new Error("cleanup lost");
      return {};
    });
    const imageEffects = effects();
    await expect(tool("browse_look", {}, imageEffects)).resolves.toEqual({
      ok: true,
      text: "Captured a picture of the current page with its interactive controls numbered.",
    });
    expect(imageEffects.pendingImages).toEqual(["cG5n"]);

    await expect(tool("browse_save", { what: "selection" }, effects())).resolves.toEqual({ ok: true, text: "Saved selection" });
    expect(emit).toHaveBeenCalledWith("room-files-changed", {});

    fakeBrowser.call.mockRejectedValueOnce("bridge lost");
    await expect(tool("browse_read", {}, effects())).resolves.toEqual({ ok: false, error: "bridge lost" });
    expect(fakeBrowser.journal).toHaveBeenCalledWith("error", "", "browse_read failed: bridge lost");
  });
});
