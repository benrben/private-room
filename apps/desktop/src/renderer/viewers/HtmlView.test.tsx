import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ stagePreviewHtml: vi.fn(), openHtmlInBrowser: vi.fn(), withFrameTheme: vi.fn((source: string) => `themed:${source}`), withSelectionReporter: vi.fn((source: string) => `selected:${source}`), textOf: vi.fn((source: string) => `text:${source}`) }));
vi.mock("../api", () => ({ api: { stagePreviewHtml: mocks.stagePreviewHtml, openHtmlInBrowser: mocks.openHtmlInBrowser } }));
vi.mock("./frameTheme", () => ({ useFrameTheme: () => "light", withFrameTheme: mocks.withFrameTheme }));
vi.mock("./frameSelection", () => ({ withSelectionReporter: mocks.withSelectionReporter }));
vi.mock("./htmlText", () => ({ textOf: mocks.textOf }));

import HtmlView from "./HtmlView";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

async function flush() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
}

async function render(source = "<h1>Page</h1>") {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(HtmlView, { source, name: "saved.html" })));
  await flush();
  return { host, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

beforeEach(() => {
  mocks.stagePreviewHtml.mockReset();
  mocks.openHtmlInBrowser.mockReset();
  mocks.withFrameTheme.mockClear();
  mocks.withSelectionReporter.mockClear();
  mocks.textOf.mockClear();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("HtmlView", () => {
  it("stages a sandboxed preview and switches among page, text, and source readings", async () => {
    mocks.stagePreviewHtml.mockResolvedValueOnce("preview-token");
    const view = await render();
    expect(mocks.stagePreviewHtml).toHaveBeenCalledWith("selected:themed:<h1>Page</h1>");
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("roomdoc://localhost/preview-token");
    await click(button(view.host, "Text"), view.window);
    expect(view.host.textContent).toContain("text:<h1>Page</h1>");
    await click(button(view.host, "Source"), view.window);
    expect(view.host.querySelector(".html-src pre")?.textContent).toBe("<h1>Page</h1>");
    await act(async () => view.root.unmount());
  });

  it("falls back to srcDoc when staging fails and reports a mocked browser handoff failure", async () => {
    mocks.stagePreviewHtml.mockRejectedValueOnce(new Error("cannot stage"));
    mocks.openHtmlInBrowser.mockRejectedValueOnce(new Error("browser unavailable"));
    const view = await render("<p>Fallback</p>");
    expect(view.host.querySelector("iframe")).not.toBeNull();
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBeNull();
    expect(mocks.withSelectionReporter).toHaveBeenLastCalledWith("themed:<p>Fallback</p>");
    await click(button(view.host, "Open in browser"), view.window);
    expect(mocks.openHtmlInBrowser).toHaveBeenCalledWith("saved.html", "<p>Fallback</p>");
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("browser unavailable");
    await act(async () => view.root.unmount());
  });

  it("explains when a page has no readable text", async () => {
    mocks.stagePreviewHtml.mockResolvedValueOnce("preview-token");
    mocks.textOf.mockReturnValueOnce("");
    const view = await render("<script>render()</script>");
    await click(button(view.host, "Text"), view.window);
    expect(view.host.textContent).toContain("This page has no text outside its markup");
    await act(async () => view.root.unmount());
  });
});
