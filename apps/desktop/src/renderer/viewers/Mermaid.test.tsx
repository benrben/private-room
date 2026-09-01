import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(),
  render: vi.fn(),
  theme: "light" as "light" | "dark",
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: bridge.initialize,
    parse: bridge.parse,
    render: bridge.render,
  },
}));
vi.mock("./frameTheme", () => ({ useFrameTheme: () => bridge.theme }));

import Mermaid from "./Mermaid";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function render(source: string) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Mermaid, { source })));
  await flush();
  return { host, root };
}

beforeEach(() => {
  bridge.initialize.mockReset();
  bridge.parse.mockReset().mockResolvedValue(undefined);
  bridge.render.mockReset().mockResolvedValue({ svg: "<svg><text>graph</text></svg>" });
  bridge.theme = "light";
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("Mermaid", () => {
  it("keeps an empty diagram as source text without loading the renderer", async () => {
    const view = await render("   ");
    expect(view.host.querySelector(".mermaid-pending")?.textContent).toBe("   ");
    expect(bridge.parse).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("draws valid source with the active strict palette", async () => {
    bridge.theme = "dark";
    const parseStarted = deferred<void>();
    const parseFinished = deferred<void>();
    const renderStarted = deferred<void>();
    const renderFinished = deferred<{ svg: string }>();
    bridge.parse.mockImplementation(() => {
      parseStarted.resolve();
      return parseFinished.promise;
    });
    bridge.render.mockImplementation(() => {
      renderStarted.resolve();
      return renderFinished.promise;
    });
    const view = await render("graph TD; A-->B");
    await act(async () => {
      await parseStarted.promise;
      parseFinished.resolve();
      await renderStarted.promise;
      renderFinished.resolve({ svg: "<svg><text>graph</text></svg>" });
    });
    expect(bridge.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    expect(bridge.parse).toHaveBeenCalledWith("graph TD; A-->B");
    expect(view.host.querySelector(".mermaid-figure svg text")?.textContent).toBe("graph");
    await act(async () => view.root.unmount());
  });

  it("shows the original source with parser failures", async () => {
    const parseStarted = deferred<void>();
    bridge.parse.mockImplementationOnce(() => {
      parseStarted.resolve();
      return Promise.reject("unfinished edge");
    });
    const view = await render("graph TD; A-->");
    await act(async () => { await parseStarted.promise; });
    expect(view.host.querySelector(".mermaid-error")?.textContent).toContain(
      "This diagram could not be drawn: unfinished edge",
    );
    expect(view.host.querySelector(".mermaid-error pre")?.textContent).toBe("graph TD; A-->");
    await act(async () => view.root.unmount());
  });
});
