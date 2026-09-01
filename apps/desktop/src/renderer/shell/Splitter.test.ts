import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "./useLayout";
import Splitter from "./Splitter";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function layout(overrides: Record<string, unknown> = {}) {
  return {
    showSplitA: true,
    showSplitB: true,
    ratios: { library: 0.25, ai: 0.3 },
    dragging: null,
    startDrag: vi.fn(),
    keyResize: vi.fn(),
    ...overrides,
  } as unknown as LayoutApi;
}

function installDom() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", window.document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  return window;
}

async function draw(side: "a" | "b", state = layout()) {
  const window = installDom();
  const host = window.document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Splitter, { side, layout: state, label: "Resize panes" })));
  const node = host.querySelector("[role=separator]");
  if (!node) throw new Error("splitter missing");
  return { window, root, state, node };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("Splitter", () => {
  it("renders the visible first divider and delegates pointer/keyboard resize controls", async () => {
    const state = layout({ dragging: "a" });
    const view = await draw("a", state);

    expect(view.node.getAttribute("tabindex")).toBe("0");
    expect(view.node.getAttribute("aria-hidden")).toBe("false");
    expect(view.node.getAttribute("aria-valuenow")).toBe("25");
    expect(view.node.getAttribute("class")).toContain("is-dragging");

    await act(async () => view.node.dispatchEvent(new view.window.Event("pointerdown", { bubbles: true })));
    expect(state.startDrag).toHaveBeenCalledWith("a", expect.anything());

    const right = new view.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperties(right, { key: { value: "ArrowRight" }, shiftKey: { value: true } });
    await act(async () => view.node.dispatchEvent(right));
    expect(right.defaultPrevented).toBe(true);
    expect(state.keyResize).toHaveBeenCalledWith("a", 1, true);

    const left = new view.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperties(left, { key: { value: "ArrowLeft" }, shiftKey: { value: false } });
    await act(async () => view.node.dispatchEvent(left));
    expect(state.keyResize).toHaveBeenLastCalledWith("a", -1, false);
    await act(async () => view.root.unmount());
  });

  it("keeps the hidden second divider in the grid but removes it from keyboard focus", async () => {
    const view = await draw("b", layout({ showSplitB: false, ratios: { library: 0.2, ai: 0.37 } }));

    expect(view.node.getAttribute("tabindex")).toBe("-1");
    expect(view.node.getAttribute("aria-hidden")).toBe("true");
    expect(view.node.getAttribute("aria-valuenow")).toBe("63");
    expect(view.node.getAttribute("class")).toContain("is-off");
    await act(async () => view.root.unmount());
  });
});
