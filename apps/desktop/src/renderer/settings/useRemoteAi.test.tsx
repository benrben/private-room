import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getOllamaUrl: vi.fn(),
  setOllamaUrl: vi.fn(),
  testOllamaUrl: vi.fn(),
}));

vi.mock("../api", () => api);

import { useRemoteAi } from "./useRemoteAi";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type RemoteAi = ReturnType<typeof useRemoteAi>;
let remoteAi: RemoteAi | null = null;

function RemoteAiProbe() {
  remoteAi = useRemoteAi();
  return null;
}

function current(): RemoteAi {
  if (!remoteAi) throw new Error("Remote AI hook has not rendered.");
  return remoteAi;
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
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(RemoteAiProbe)));
  await flush();
  return {
    close: async () => act(async () => root.unmount()),
    runTimers: async () => act(async () => timers.splice(0).forEach((callback) => callback())),
  };
}

beforeEach(() => {
  remoteAi = null;
  api.getOllamaUrl.mockReset().mockResolvedValue("http://remote:11434");
  api.setOllamaUrl.mockReset().mockResolvedValue(undefined);
  api.testOllamaUrl.mockReset().mockResolvedValue("Connected to remote Ollama.");
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useRemoteAi", () => {
  it("saves a trimmed remote address and clears its saved pulse", async () => {
    const view = await renderHook();
    await act(async () => current().setClosetUrl("  https://remote:11434/  "));

    await act(async () => current().saveOllamaUrl());

    expect(api.setOllamaUrl).toHaveBeenCalledWith("https://remote:11434/");
    expect(current().closetDirty).toBe(false);
    expect(current().closetSaved).toBe(true);
    await view.runTimers();
    expect(current().closetSaved).toBe(false);
    await view.close();
  });

  it("keeps a failed save visible without claiming the edited address was stored", async () => {
    api.setOllamaUrl.mockRejectedValueOnce(new Error("invalid address"));
    const view = await renderHook();
    await act(async () => current().setClosetUrl("bad address"));

    await act(async () => current().saveOllamaUrl());

    expect(current().closetTestResult).toBe("✗ Couldn't save: Error: invalid address");
    expect(current().closetSaved).toBe(false);
    expect(current().closetDirty).toBe(true);
    await view.close();
  });

  it("tests the trimmed address through the mocked API and clears its saved pulse", async () => {
    const view = await renderHook();
    await act(async () => current().setClosetUrl("  remote:11434/  "));
    let resolveTest: ((result: string) => void) | null = null;
    api.testOllamaUrl.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveTest = resolve; }));
    let pending: Promise<void> | null = null;
    await act(async () => {
      pending = current().testOllama();
      await Promise.resolve();
    });
    expect(current().closetTesting).toBe(true);
    expect(current().closetTestResult).toBe("");
    expect(api.testOllamaUrl).toHaveBeenCalledWith("remote:11434/");

    await act(async () => {
      resolveTest?.("Connected to remote Ollama.");
      await pending;
    });
    expect(current().closetTesting).toBe(false);
    expect(current().closetTestResult).toBe("Connected to remote Ollama.");
    expect(current().closetSaved).toBe(true);
    expect(current().closetDirty).toBe(false);
    await view.runTimers();
    expect(current().closetSaved).toBe(false);
    await view.close();
  });

  it("reports a mocked reachability failure while retaining an equivalently stored remote address", async () => {
    api.getOllamaUrl.mockReset()
      .mockResolvedValueOnce("http://remote:11434")
      .mockResolvedValueOnce("HTTP://remote:11434/");
    api.testOllamaUrl.mockRejectedValueOnce(new Error("connection refused"));
    const view = await renderHook();
    await act(async () => current().setClosetUrl("remote:11434"));
    await act(async () => current().testOllama());
    expect(api.getOllamaUrl).toHaveBeenCalledTimes(2);
    expect(current().closetTesting).toBe(false);
    expect(current().closetDirty).toBe(false);
    expect(current().closetTestResult).toContain("Error: connection refused");
    expect(current().closetTestResult).toContain("the address was saved anyway");
    await view.close();
  });

  it("keeps a mocked connection failure visible when its stored-address lookup also fails", async () => {
    api.getOllamaUrl.mockReset()
      .mockResolvedValueOnce("http://previous:11434")
      .mockRejectedValueOnce(new Error("settings unavailable"));
    api.testOllamaUrl.mockRejectedValueOnce(new Error("host unreachable"));
    const view = await renderHook();
    await act(async () => current().setClosetUrl("http://next:11434"));
    await act(async () => current().testOllama());
    expect(current().closetTesting).toBe(false);
    expect(current().closetDirty).toBe(true);
    expect(current().closetTestResult).toBe("✗ Error: host unreachable");
    await view.close();
  });
});
