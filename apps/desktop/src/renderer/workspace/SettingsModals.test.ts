import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsModals from "./SettingsModals";

const { act, createElement } = React;

const bridge = vi.hoisted(() => ({
  onYtdlpProgress: vi.fn<(listener: (progress: { status: string; percent: number | null }) => void) => Promise<() => void>>(),
  listMediaFormats: vi.fn<(url: string) => Promise<Array<{ height: number; fits: boolean; approxBytes: number | null }>>>(),
  importMediaUrl: vi.fn<(url: string, maxHeight?: number) => Promise<{ imported: Array<{ id: string; name: string }>; errors: string[] }>>(),
  importLink: vi.fn<(url: string) => Promise<{ id: string; name: string }>>(),
  listFiles: vi.fn<() => Promise<Array<{ id: string }>>>(),
  cancelMediaDownload: vi.fn<() => Promise<void>>(),
}));

const settingsSpy = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../icons", () => ({ CloseIcon: () => null, LinkIcon: () => null, LockIcon: () => null }));
vi.mock("../Settings", () => ({
  default: (props: { busy: boolean; onClose: () => void }) => {
    settingsSpy(props);
    return createElement("button", { className: "settings-close", onClick: props.onClose }, props.busy ? "busy settings" : "settings");
  },
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

let progressListener: ((progress: { status: string; percent: number | null }) => void) | undefined;

function state(overrides: Record<string, unknown> = {}) {
  return {
    showSettings: false,
    ai: { available: true },
    model: "default",
    jobs: [],
    recLive: null,
    asking: false,
    settingsSection: null,
    setShowSettings: vi.fn(),
    setSettingsSection: vi.fn(),
    mcpDialogDismissed: false,
    approvingMcp: false,
    showAddLink: true,
    setShowAddLink: vi.fn(),
    linkUrl: "https://example.test/page",
    importingLink: false,
    setLinkUrl: vi.fn(),
    setImportingLink: vi.fn(),
    setFiles: vi.fn(),
    pushToast: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

function actions(overrides: Record<string, unknown> = {}) {
  return {
    changeModel: vi.fn(),
    refreshAi: vi.fn(),
    refreshWebAccess: vi.fn(),
    refreshAutolock: vi.fn(),
    refreshPrivacy: vi.fn(),
    refreshMemAutoSave: vi.fn(),
    keepMcpOff: vi.fn(),
    approveMcp: vi.fn(),
    viewFile: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

function info(overrides: Record<string, unknown> = {}) {
  return {
    name: "Private room",
    pendingMcp: null,
    ...overrides,
  } as Record<string, any>;
}

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.onYtdlpProgress.mockImplementation(async (listener) => {
    progressListener = listener;
    return () => {};
  });
  bridge.listMediaFormats.mockResolvedValue([]);
  bridge.importMediaUrl.mockResolvedValue({ imported: [{ id: "video-1", name: "clip.mp4" }], errors: [] });
  bridge.importLink.mockResolvedValue({ id: "link-1", name: "Page" });
  bridge.listFiles.mockResolvedValue([{ id: "file-1" }]);
  bridge.cancelMediaDownload.mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetBridge();
  settingsSpy.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function renderModals(
  s = state(),
  a = actions(),
  room = info(),
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLButtonElement", window.HTMLButtonElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const layout = { applyPreset: vi.fn() };
  const draw = async () => act(async () => {
    root.render(createElement(SettingsModals, { s: s as never, a: a as never, info: room as never, layout: layout as never }));
    await Promise.resolve();
    await Promise.resolve();
  });
  await draw();
  return {
    a,
    close: async () => act(async () => root.unmount()),
    document,
    draw,
    host,
    layout,
    root,
    room,
    s,
    window,
  };
}

function reactProp<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element) {
  await act(async () => reactProp<{ onClick: () => void }>(node).onClick());
}

async function change(node: Element, target: Record<string, unknown>) {
  await act(async () => reactProp<{ onChange: (event: { target: Record<string, unknown> }) => void }>(node).onChange({ target }));
}

async function keydown(node: Element, key: string) {
  await act(async () => reactProp<{ onKeyDown: (event: { key: string }) => void }>(node).onKeyDown({ key }));
}

async function mouseDown(node: Element, target: unknown) {
  await act(async () => reactProp<{ onMouseDown: (event: { target: unknown; currentTarget: unknown }) => void }>(node).onMouseDown({ target, currentTarget: node }));
}

function button(host: Element, text: string) {
  const node = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!node) throw new Error(`missing button ${text}`);
  return node;
}

function radio(host: Element, name: string) {
  const node = [...host.querySelectorAll("button[role='radio']")].find((candidate) => candidate.textContent?.includes(name));
  if (!node) throw new Error(`missing radio ${name}`);
  return node;
}

describe("SettingsModals", () => {
  it("marks Settings busy for recording or asking even without an active job", async () => {
    const recording = await renderModals(state({ showSettings: true, recLive: { id: "rec" } }));
    expect(settingsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true }));
    await recording.close();

    settingsSpy.mockClear();
    const asking = await renderModals(state({ showSettings: true, asking: true }));
    expect(settingsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true }));
    await asking.close();
  });

  it("closes settings, handles the MCP choice, and imports a normal page", async () => {
    const s = state({
      showSettings: true,
      jobs: [{ status: "running" }],
      recLive: { id: "recording" },
      asking: true,
    });
    const a = actions();
    const room = info({ pendingMcp: { servers: [{ name: "search", command: "search-mcp" }] } });
    const view = await renderModals(s, a, room);

    expect(view.host.textContent).toContain("Private room wants to run these programs");
    expect(settingsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ busy: true }));
    await click(button(view.host, "busy settings"));
    await click(button(view.host, "Keep off"));
    await click(button(view.host, "Allow"));
    const input = view.host.querySelector(".add-link-input");
    const backdrop = [...view.host.querySelectorAll(".settings-backdrop")].find(
      (node) => !node.classList.contains("mcp-approve-backdrop"),
    );
    if (!input || !backdrop) throw new Error("modal controls missing");
    await change(input, { value: "https://example.test/updated" });
    await keydown(input, "Escape");
    await keydown(input, "Enter");
    await mouseDown(backdrop, backdrop);
    await mouseDown(backdrop, input);
    await click(button(view.host, "Save page"));

    expect(a.keepMcpOff).toHaveBeenCalled();
    expect(a.approveMcp).toHaveBeenCalled();
    expect(a.refreshWebAccess).toHaveBeenCalled();
    expect(a.refreshAutolock).toHaveBeenCalled();
    expect(a.refreshPrivacy).toHaveBeenCalled();
    expect(a.refreshMemAutoSave).toHaveBeenCalled();
    expect(bridge.importLink).toHaveBeenCalledWith("https://example.test/page");
    expect(a.viewFile).toHaveBeenCalledWith("link-1");
    expect(s.pushToast).toHaveBeenCalledWith("success", 'Saved "Page" into the room.');
  });

  it("probes a non-YouTube video, chooses a quality, reports progress, and downloads it", async () => {
    const s = state({ linkUrl: "https://video.example.test/watch" });
    const a = actions();
    let resolveDownload: ((report: { imported: Array<{ id: string; name: string }>; errors: string[] }) => void) | undefined;
    bridge.listMediaFormats.mockResolvedValue([
      { height: 1080, fits: false, approxBytes: 2 * 1024 ** 3 },
      { height: 720, fits: true, approxBytes: 200 * 1024 ** 2 },
    ]);
    bridge.importMediaUrl.mockImplementation(() => new Promise((resolve) => { resolveDownload = resolve; }));
    bridge.cancelMediaDownload.mockRejectedValueOnce(new Error("cancel unavailable"));
    const view = await renderModals(s, a);

    await click(radio(view.host, "Video from this page"));
    expect(view.host.textContent).toContain("Checking which qualities this video offers");
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(view.host.textContent).toContain("~2.0 GB");
    expect(view.host.textContent).toContain("~200 MB");
    await click(radio(view.host, "720p"));
    await click(button(view.host, "Download video"));
    expect(view.host.textContent).toContain("Downloading video");
    await act(async () => progressListener?.({ status: "Downloading", percent: null }));
    await act(async () => progressListener?.({ status: "Almost done", percent: 91 }));
    await click(button(view.host, "Stop download"));
    await act(async () => {
      resolveDownload?.({ imported: [{ id: "video-1", name: "clip.mp4" }], errors: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.importMediaUrl).toHaveBeenCalledWith("https://video.example.test/watch", 720);
    expect(bridge.cancelMediaDownload).toHaveBeenCalled();
    expect(a.viewFile).toHaveBeenCalledWith("video-1");
    expect(s.pushToast).toHaveBeenCalledWith("success", 'Saved "clip.mp4" — it will transcribe itself shortly.');
  });

  it("falls back from missing YouTube captions and names a failed video import", async () => {
    const s = state({ linkUrl: "https://youtu.be/no-captions" });
    bridge.importLink.mockRejectedValueOnce("YT_NO_CAPTIONS");
    bridge.importMediaUrl.mockResolvedValueOnce({ imported: [], errors: ["download unavailable"] });
    const view = await renderModals(s);

    expect(view.host.textContent).toContain("Import YouTube video");
    expect(view.host.textContent).toContain("Transcript only");
    await click(button(view.host, "Import transcript"));
    expect(s.pushToast).toHaveBeenCalledWith("info", "This video has no captions — downloading it to transcribe on-device…");
    expect(s.pushToast).toHaveBeenCalledWith("error", "download unavailable");
  });

  it("keeps captions when requested with video, and reports direct downloader failures", async () => {
    const s = state({ linkUrl: "https://youtube.com/watch?v=with-captions" });
    const a = actions();
    bridge.listMediaFormats.mockRejectedValueOnce(new Error("formats unavailable"));
    bridge.importLink.mockResolvedValueOnce({ id: "caption-1", name: "Captions" });
    bridge.importMediaUrl.mockResolvedValueOnce({ imported: [], errors: [] });
    const view = await renderModals(s, a);

    await click(radio(view.host, "Video + transcript"));
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    await click(button(view.host, "Import video"));
    expect(a.viewFile).toHaveBeenCalledWith("caption-1");
    expect(s.pushToast).toHaveBeenCalledWith("success", "Video saved — it will transcribe itself shortly.");

    const direct = state({ linkUrl: "https://video.example.test/fails" });
    bridge.importMediaUrl.mockRejectedValueOnce(new Error("network failed"));
    const directView = await renderModals(direct);
    await click(radio(directView.host, "Video from this page"));
    await click(button(directView.host, "Download video"));
    expect(direct.pushToast).toHaveBeenCalledWith("error", "Error: network failed");
  });

  it("continues a video import after a non-caption error and reports that first failure", async () => {
    const s = state({ linkUrl: "https://youtube.com/watch?v=blocked-captions" });
    bridge.importLink.mockRejectedValueOnce(new Error("captions service unavailable"));
    bridge.importMediaUrl.mockResolvedValueOnce({ imported: [{ id: "video-2", name: "saved.mp4" }], errors: [] });
    const view = await renderModals(s);

    await click(radio(view.host, "Video + transcript"));
    await click(button(view.host, "Import video"));

    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: captions service unavailable");
    expect(bridge.importMediaUrl).toHaveBeenCalledWith("https://youtube.com/watch?v=blocked-captions", undefined);
    expect(s.pushToast).toHaveBeenCalledWith("success", 'Saved "saved.mp4" — it will transcribe itself shortly.');
    await view.close();
  });

  it("reports an ordinary page import failure and releases progress listeners and pending probes", async () => {
    const unlisten = vi.fn();
    bridge.onYtdlpProgress.mockResolvedValueOnce(unlisten);
    bridge.importLink.mockRejectedValueOnce(new Error("page import unavailable"));
    const s = state({ linkUrl: "https://example.test/unavailable" });
    const view = await renderModals(s);

    await click(button(view.host, "Save page"));
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: page import unavailable");

    await click(radio(view.host, "Video from this page"));
    await view.close();
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledOnce();
    expect(bridge.listMediaFormats).not.toHaveBeenCalled();
  });

  it("shows the fetching action state while an import is already in progress", async () => {
    const view = await renderModals(state({ importingLink: true }));
    expect(view.host.textContent).toContain("Fetching…");
    expect(button(view.host, "Fetching…").hasAttribute("disabled")).toBe(true);
  });
});
