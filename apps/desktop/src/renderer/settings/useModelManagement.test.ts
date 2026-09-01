import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiStatus } from "../api";
import { useModelManagement } from "./useModelManagement";

const mocks = vi.hoisted(() => ({
  pullListener: null as null | ((event: { payload: { status: string; percent: number | null } }) => void),
  sttListener: null as null | ((progress: { percent: number }) => void),
  pullUnlisten: vi.fn(),
  sttUnlisten: vi.fn(),
  listen: vi.fn(),
  recommendedModels: vi.fn(),
  ensureEmbedModel: vi.fn(),
  api: {
    modelCapabilities: vi.fn(),
    groundingModelForRoom: vi.fn(),
    enginePreflight: vi.fn(),
    sttStatus: vi.fn(),
    getSetting: vi.fn(),
    onSttDownloadProgress: vi.fn(),
    sttDownloadModel: vi.fn(),
    sttCancelDownload: vi.fn(),
    sttDeleteModel: vi.fn(),
    cancelAsk: vi.fn(),
    pullModel: vi.fn(),
    deleteModel: vi.fn(),
    setSetting: vi.fn(),
  },
}));

vi.mock("../platform", () => ({ listen: mocks.listen }));
vi.mock("../api", () => ({
  api: mocks.api,
  recommendedModels: mocks.recommendedModels,
  ensureEmbedModel: mocks.ensureEmbedModel,
}));

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Management = ReturnType<typeof useModelManagement>;

let management: Management | null = null;

function ai(overrides: Partial<AiStatus> = {}): AiStatus {
  return {
    running: true,
    installed: true,
    models: ["vision:latest"],
    defaultModel: "vision:latest",
    external: [],
    remoteRelay: false,
    ...overrides,
  };
}

function HookProbe({ status, onModelsChanged }: { status: AiStatus | null; onModelsChanged: () => void }) {
  management = useModelManagement(status, onModelsChanged);
  return null;
}

function current(): Management {
  if (!management) throw new Error("Model management hook has not rendered.");
  return management;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook(initialStatus: AiStatus | null = ai()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const onModelsChanged = vi.fn();
  let status = initialStatus;
  const update = async (next: AiStatus | null) => {
    status = next;
    await act(async () => {
      root.render(createElement(HookProbe, { status, onModelsChanged }));
      await Promise.resolve();
    });
    await flush();
  };
  await update(status);
  return { close: async () => act(async () => root.unmount()), onModelsChanged, update };
}

function configureMocks() {
  mocks.pullListener = null;
  mocks.sttListener = null;
  mocks.pullUnlisten.mockReset();
  mocks.sttUnlisten.mockReset();
  mocks.listen.mockReset().mockImplementation((_channel: string, listener: (event: { payload: { status: string; percent: number | null } }) => void) => {
    mocks.pullListener = listener;
    return Promise.resolve(mocks.pullUnlisten);
  });
  mocks.recommendedModels.mockReset().mockResolvedValue({ vision: "vision-helper", embed: "embed-helper" });
  mocks.ensureEmbedModel.mockReset().mockResolvedValue(undefined);
  mocks.api.modelCapabilities.mockReset().mockResolvedValue([{ name: "vision:latest", tools: true, vision: true }]);
  mocks.api.groundingModelForRoom.mockReset().mockResolvedValue("cloud-vision");
  mocks.api.enginePreflight.mockReset().mockResolvedValue({ status: "blocked", code: "privacy-door", reason: "Images stay private." });
  mocks.api.sttStatus.mockReset().mockResolvedValue({ installed: false, downloading: false, sizeMb: 574 });
  mocks.api.getSetting.mockReset().mockImplementation((name: string) => Promise.resolve(name === "dict_translate" ? "on" : "punctuate"));
  mocks.api.onSttDownloadProgress.mockReset().mockImplementation((listener: (progress: { percent: number }) => void) => {
    mocks.sttListener = listener;
    return Promise.resolve(mocks.sttUnlisten);
  });
  mocks.api.sttDownloadModel.mockReset().mockResolvedValue(undefined);
  mocks.api.sttCancelDownload.mockReset().mockResolvedValue(true);
  mocks.api.sttDeleteModel.mockReset().mockResolvedValue(undefined);
  mocks.api.cancelAsk.mockReset().mockResolvedValue({});
  mocks.api.pullModel.mockReset().mockResolvedValue(undefined);
  mocks.api.deleteModel.mockReset().mockResolvedValue(undefined);
  mocks.api.setSetting.mockReset().mockResolvedValue(undefined);
}

beforeEach(() => {
  management = null;
  configureMocks();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useModelManagement", () => {
  it("loads room model state, follows progress, and cleans subscriptions", async () => {
    const view = await renderHook();

    expect(current().caps).toEqual([{ name: "vision:latest", tools: true, vision: true }]);
    expect(current().groundingModel).toBe("cloud-vision");
    expect(current().visionBlock).toBe("Images stay private.");
    expect(current().recommended).toEqual({ vision: "vision-helper", embed: "embed-helper" });
    expect(current().embedInstalled).toBe(false);
    expect(current().dictTranslate).toBe(true);
    expect(current().dictMode).toBe("punctuate");

    await act(async () => {
      mocks.pullListener?.({ payload: { status: "downloading", percent: 42 } });
      mocks.sttListener?.({ percent: 67 });
    });
    expect(current().pullStatus).toBe("downloading");
    expect(current().pullPercent).toBe(42);
    expect(current().sttPercent).toBe(67);

    mocks.api.modelCapabilities.mockRejectedValueOnce(new Error("capabilities offline"));
    mocks.api.groundingModelForRoom.mockRejectedValueOnce(new Error("grounding offline"));
    mocks.api.enginePreflight.mockRejectedValueOnce(new Error("preflight offline"));
    await view.update(ai({ models: ["other-model"] }));
    expect(current().caps).toEqual([]);
    expect(current().groundingModel).toBeNull();
    expect(current().visionBlock).toBeNull();

    await view.update(ai({ running: false, models: [] }));
    expect(current().caps).toEqual([]);
    await view.close();
    expect(mocks.pullUnlisten).toHaveBeenCalledTimes(1);
    expect(mocks.sttUnlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps model and dictation commands successful or visibly failed", async () => {
    const view = await renderHook();

    await act(async () => { await current().downloadStt(); });
    expect(mocks.api.sttDownloadModel).toHaveBeenCalledTimes(1);
    expect(current().sttPercent).toBeNull();
    await act(async () => { await current().cancelStt(); });
    expect(current().sttErr).toBe("Download stopped.");
    await act(async () => { await current().removeStt(); });
    expect(mocks.api.sttDeleteModel).toHaveBeenCalledTimes(1);

    mocks.api.sttDownloadModel.mockRejectedValueOnce(new Error("download disk full"));
    await act(async () => { await current().downloadStt(); });
    expect(current().sttErr).toContain("download disk full");
    mocks.api.sttCancelDownload.mockRejectedValueOnce(new Error("cancel offline"));
    await act(async () => { await current().cancelStt(); });
    expect(current().sttErr).toContain("cancel offline");
    mocks.api.sttDeleteModel.mockRejectedValueOnce(new Error("delete denied"));
    await act(async () => { await current().removeStt(); });
    expect(current().sttErr).toContain("delete denied");

    await act(async () => { current().askRemoveModel("vision:latest"); });
    expect(current().confirmModel).toBe("vision:latest");
    await act(async () => { current().cancelRemoveModel(); });
    expect(current().confirmModel).toBeNull();
    await act(async () => { current().confirmRemoveModel("vision:latest"); });
    await flush();
    expect(mocks.api.deleteModel).toHaveBeenCalledWith("vision:latest");
    expect(view.onModelsChanged).toHaveBeenCalledTimes(1);
    mocks.api.deleteModel.mockRejectedValueOnce(new Error("model in use"));
    await act(async () => { current().confirmRemoveModel("vision:latest"); });
    await flush();
    expect(current().error).toContain("model in use");

    await act(async () => { current().onDictTranslateChange({ target: { checked: false } } as React.ChangeEvent<HTMLInputElement>); });
    await act(async () => { current().onDictModeChange({ target: { value: "raw" } } as React.ChangeEvent<HTMLSelectElement>); });
    expect(mocks.api.setSetting).toHaveBeenNthCalledWith(1, "dict_translate", "off");
    expect(mocks.api.setSetting).toHaveBeenNthCalledWith(2, "dict_mode", "raw");

    await act(async () => { await current().pull(); });
    expect(mocks.api.pullModel).not.toHaveBeenCalled();
    await act(async () => { current().setPullName("local-helper"); });
    await act(async () => { await current().pull(); });
    expect(mocks.api.pullModel).toHaveBeenCalledWith("local-helper");
    expect(current().pullStatus).toBe("downloaded ✓");
    expect(current().pullName).toBe("");
    expect(view.onModelsChanged).toHaveBeenCalledTimes(2);

    await act(async () => { current().setPullName("bad-helper"); });
    mocks.api.pullModel.mockRejectedValueOnce(new Error("not enough space"));
    await act(async () => { await current().pull(); });
    expect(current().error).toContain("not enough space");
    await act(async () => { current().setPullName("stopped-helper"); });
    mocks.api.pullModel.mockRejectedValueOnce(new Error("download was cancelled by user"));
    await act(async () => { await current().pull(); });
    expect(current().pullStatus).toBe("download stopped");
    await view.close();
  });

  it("pulls recommended helpers, stops the active pull, and reports helper failures", async () => {
    const view = await renderHook();

    await act(async () => { await current().stopPull(); });
    expect(mocks.api.cancelAsk).not.toHaveBeenCalled();
    await act(async () => { await current().pullSpecial("vision-helper"); });
    expect(mocks.api.pullModel).toHaveBeenCalledWith("vision-helper");
    expect(current().pullStatus).toBe("ready ✓");
    expect(view.onModelsChanged).toHaveBeenCalledTimes(1);
    await act(async () => { await current().pullSpecial("", true); });
    expect(mocks.ensureEmbedModel).toHaveBeenCalledTimes(1);

    mocks.api.pullModel.mockRejectedValueOnce(new Error("helper unavailable"));
    await act(async () => { await current().pullSpecial("vision-helper"); });
    expect(current().error).toContain("helper unavailable");
    mocks.api.pullModel.mockRejectedValueOnce(new Error("download was cancelled by user"));
    await act(async () => { await current().pullSpecial("vision-helper"); });
    expect(current().pullStatus).toBe("download stopped");
    await act(async () => { await current().pullSpecial(""); });
    expect(mocks.api.pullModel).toHaveBeenCalledTimes(3);

    let releasePull: (() => void) | null = null;
    mocks.api.pullModel.mockImplementationOnce(() => new Promise<void>((resolve) => { releasePull = resolve; }));
    let pendingPull: Promise<void> | null = null;
    await act(async () => {
      pendingPull = current().pullSpecial("large-helper");
      await Promise.resolve();
    });
    expect(current().pullingSpecial).toBe("large-helper");
    mocks.api.cancelAsk.mockRejectedValueOnce(new Error("cancel unavailable"));
    await act(async () => { await current().stopPull(); });
    expect(current().error).toContain("cancel unavailable");
    await act(async () => { await current().stopPull(); });
    expect(mocks.api.cancelAsk).toHaveBeenCalledWith("pull:large-helper");
    expect(current().stoppingPull).toBe(false);
    await act(async () => { releasePull?.(); await pendingPull; });
    expect(current().pullingSpecial).toBeNull();
    await view.close();
  });
});
