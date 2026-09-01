import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyQuoteHighlight: vi.fn(),
  clearQuoteHighlight: vi.fn(),
}));

vi.mock("../viewers/highlight", () => ({
  applyQuoteHighlight: mocks.applyQuoteHighlight,
  clearQuoteHighlight: mocks.clearQuoteHighlight,
}));

import TextView from "./TextView";

const globalKeys = ["document", "window", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

beforeEach(() => {
  mocks.applyQuoteHighlight.mockReset();
  mocks.clearQuoteHighlight.mockReset();
});

afterEach(() => {
  for (const key of globalKeys) {
    const value = originalGlobals[key];
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("TextView", () => {
  it("preserves extracted text and highlights only a supplied quote", async () => {
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Reflect.set(globalThis, "window", parsed.window);
    Reflect.set(globalThis, "document", parsed.document);
    Reflect.set(globalThis, "HTMLElement", parsed.window.HTMLElement);
    Reflect.set(globalThis, "React", React);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(TextView, { text: "first line\nsecond line" }));
      await Promise.resolve();
    });
    expect(host.querySelector("pre")?.textContent).toBe("first line\nsecond line");
    expect(mocks.applyQuoteHighlight).not.toHaveBeenCalled();

    await act(async () => {
      root.render(createElement(TextView, { text: "first line\nsecond line", quote: "second" }));
      await Promise.resolve();
    });
    expect(mocks.applyQuoteHighlight).toHaveBeenCalledWith(host.querySelector("pre"), "second");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(mocks.clearQuoteHighlight).toHaveBeenCalledOnce();
  });
});
