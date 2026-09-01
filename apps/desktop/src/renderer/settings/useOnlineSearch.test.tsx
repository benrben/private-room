import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  webSearchTest: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    getSetting: bridge.getSetting,
    setSetting: bridge.setSetting,
    webSearchTest: bridge.webSearchTest,
  },
}));

import { useOnlineSearch } from "./useOnlineSearch";

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type OnlineSearch = ReturnType<typeof useOnlineSearch>;
let onlineSearch: OnlineSearch | null = null;

function OnlineSearchProbe() {
  onlineSearch = useOnlineSearch();
  return null;
}

function current(): OnlineSearch {
  if (!onlineSearch) throw new Error("Online-search hook has not rendered.");
  return onlineSearch;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const timers: Array<() => void> = [];
  Reflect.set(window, "setTimeout", (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  });
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(OnlineSearchProbe)));
  await flush();
  return {
    close: async () => act(async () => root.unmount()),
    runTimers: async () => act(async () => timers.splice(0).forEach((callback) => callback())),
  };
}

beforeEach(() => {
  onlineSearch = null;
  bridge.getSetting.mockReset().mockImplementation((key: string) => {
    const settings: Record<string, string | null> = {
      web_provider: "brave",
      web_agent_search: "off",
      web_agent_browse: null,
      web_result_previews: "off",
    };
    return Promise.resolve(settings[key] ?? null);
  });
  bridge.setSetting.mockReset().mockResolvedValue(undefined);
  bridge.webSearchTest.mockReset().mockResolvedValue("Search is available.");
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useOnlineSearch", () => {
  it("loads legacy and absent settings, saves both switch combinations, and clears its saved pulse", async () => {
    const view = await renderHook();
    expect(current().webOn).toBe(true);
    expect(current().searchAgent).toBe(false);
    expect(current().browseAgent).toBe(true);
    expect(current().resultPreviews).toBe(false);
    expect(current().webDirty).toBe(false);

    await act(async () => current().saveWebAccess());
    expect(bridge.setSetting).toHaveBeenNthCalledWith(1, "web_provider", "on");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(2, "web_agent_search", "off");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(3, "web_agent_browse", "on");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(4, "web_result_previews", "off");
    expect(current().webSaved).toBe(true);
    await view.runTimers();
    expect(current().webSaved).toBe(false);

    await act(async () => {
      current().setWebOn(false);
      current().setSearchAgent(true);
      current().setBrowseAgent(false);
      current().setResultPreviews(true);
    });
    expect(current().webDirty).toBe(true);
    await act(async () => current().saveWebAccess());
    expect(bridge.setSetting).toHaveBeenNthCalledWith(5, "web_provider", "off");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(6, "web_agent_search", "on");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(7, "web_agent_browse", "off");
    expect(bridge.setSetting).toHaveBeenNthCalledWith(8, "web_result_previews", "on");
    expect(current().webDirty).toBe(false);
    await view.close();
  });

  it("keeps the pending-save indication and exposes a fabricated storage failure", async () => {
    const view = await renderHook();
    await act(async () => current().setSearchAgent(true));
    bridge.setSetting.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("settings store unavailable"));
    await act(async () => {
      await expect(current().saveWebAccess()).rejects.toThrow("settings store unavailable");
    });
    expect(bridge.setSetting).toHaveBeenCalledTimes(2);
    expect(current().webDirty).toBe(true);
    expect(current().webSaved).toBe(false);
    expect(current().webError).toContain("Couldn't save: Error: settings store unavailable");
    await view.close();
  });

  it("uses fabricated search results and errors after saving the exact active settings", async () => {
    const view = await renderHook();
    let resolveSearch: ((result: string) => void) | null = null;
    bridge.webSearchTest.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveSearch = resolve; }),
    );
    let pending: Promise<void> | null = null;
    await act(async () => {
      pending = current().testWebSearch();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(current().webTesting).toBe(true);
    expect(current().webTestResult).toBe("");
    expect(bridge.setSetting).toHaveBeenCalledTimes(4);
    await act(async () => {
      resolveSearch?.("Search is available.");
      await pending;
    });
    expect(current().webTesting).toBe(false);
    expect(current().webTestResult).toBe("Search is available.");

    bridge.webSearchTest.mockRejectedValueOnce(new Error("search backend unavailable"));
    await act(async () => current().testWebSearch());
    expect(current().webTesting).toBe(false);
    expect(current().webTestResult).toBe("✗ Error: search backend unavailable");
    await view.close();
  });
});
