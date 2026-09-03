import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetSavedLayout,
  forgetSavedLayouts,
  layoutKey,
  useLayout,
  type LayoutApi,
} from "./useLayout";

const { act, createElement } = React;

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
  "localStorage",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type MediaListener = () => void;
type FakeMedia = {
  matches: boolean;
  listeners: Set<MediaListener>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
};

let layout: LayoutApi | null = null;

function LayoutProbe() {
  layout = useLayout("/rooms/layout-test.room");
  return createElement("div", { ref: layout.gridRef });
}

function current(): LayoutApi {
  if (!layout) throw new Error("Layout hook has not rendered.");
  return layout;
}

function fakeStorage(entries: Record<string, string> = {}) {
  const storage = { ...entries } as Record<string, unknown>;
  Object.defineProperties(storage, {
    getItem: {
      configurable: true,
      enumerable: false,
      writable: true,
      value: vi.fn((key: string) =>
        typeof storage[key] === "string" ? storage[key] : null,
      ),
    },
    setItem: {
      configurable: true,
      enumerable: false,
      writable: true,
      value: vi.fn((key: string, value: string) => {
        storage[key] = value;
      }),
    },
    removeItem: {
      configurable: true,
      enumerable: false,
      writable: true,
      value: vi.fn((key: string) => {
        delete storage[key];
      }),
    },
  });
  return storage as Storage;
}

function fakeMedia(matches = false): FakeMedia {
  const listeners = new Set<MediaListener>();
  return {
    matches,
    listeners,
    addEventListener: vi.fn((_event: string, listener: MediaListener) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_event: string, listener: MediaListener) => {
      listeners.delete(listener);
    }),
  };
}

function updateMedia(media: FakeMedia, matches: boolean) {
  media.matches = matches;
  for (const listener of media.listeners) listener();
}

function installDom(storage = fakeStorage(), narrow = fakeMedia(), railNarrow = fakeMedia()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) =>
      query === "(max-width: 1080px)" ? narrow : railNarrow,
    ),
  });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "localStorage", storage);
  return { document, narrow, railNarrow, storage, window };
}

async function flush(rounds = 3) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderLayout(storage = fakeStorage(), narrow = fakeMedia(), railNarrow = fakeMedia()) {
  layout = null;
  const environment = installDom(storage, narrow, railNarrow);
  const { createRoot } = await import("react-dom/client");
  const host = environment.document.getElementById("root");
  if (!host) throw new Error("Test root missing.");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(LayoutProbe));
  });
  await flush();
  return { ...environment, host, root };
}

function keyboardEvent(
  window: Window & typeof globalThis,
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
) {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    altKey: { value: modifiers.altKey ?? false },
    ctrlKey: { value: modifiers.ctrlKey ?? false },
    metaKey: { value: modifiers.metaKey ?? false },
    shiftKey: { value: modifiers.shiftKey ?? false },
  });
  return event as unknown as KeyboardEvent;
}

function pointerEvent(window: Window & typeof globalThis, type: string, clientX: number, pointerId = 9) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: clientX },
    pointerId: { value: pointerId },
  });
  return event as unknown as PointerEvent;
}

afterEach(() => {
  layout = null;
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useLayout", () => {
  it("uses opaque room keys and forgets only the intended saved layouts", () => {
    const key = layoutKey("/private/Work Room");
    expect(key).toMatch(/^prLayout:[0-9a-f]{16}$/);
    expect(key).toBe(layoutKey("/private/Work Room"));
    expect(key).not.toContain("Work");

    const storage = fakeStorage({
      [key]: "saved",
      "prLayout:legacy room": "legacy",
      unrelated: "keep",
    });
    installDom(storage);
    forgetSavedLayout("/private/Work Room");
    expect(storage.getItem(key)).toBeNull();
    forgetSavedLayouts();
    expect(storage.getItem("prLayout:legacy room")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");

    const blocked = fakeStorage({ "prLayout:one": "saved" });
    Object.defineProperty(blocked, "removeItem", { value: () => { throw new Error("blocked"); } });
    Reflect.set(globalThis, "localStorage", blocked);
    expect(() => forgetSavedLayouts()).not.toThrow();
    expect(() => forgetSavedLayout("/private/Work Room")).not.toThrow();
  });

  it("loads valid persisted choices, removes legacy room names, and applies layouts", async () => {
    const roomKey = layoutKey("/rooms/layout-test.room");
    const storage = fakeStorage({
      "prLayout:Readable room name": "old layout",
      [roomKey]: JSON.stringify({
        ratios: { library: 0.25, center: 0.5, ai: 0.25 },
        hidden: { library: true, center: true, ai: false },
        railExpanded: false,
        v: 2,
      }),
    });
    const view = await renderLayout(storage);

    expect(storage.getItem("prLayout:Readable room name")).toBeNull();
    expect(current().ratios).toEqual({ library: 0.25, center: 0.5, ai: 0.25 });
    expect(current().hidden).toEqual({ library: true, center: false, ai: false });
    expect(current().railExpandedPref).toBe(false);
    expect(current().layoutLabel).toBe("2 panes");

    await act(async () => current().applyPreset("focus"));
    expect(current().visible).toEqual(["center"]);
    expect(current().layoutLabel).toBe("1 pane");
    expect((current().gridStyle as Record<string, unknown>)["--center-track"]).toBe("1fr");

    await act(async () => current().applyPreset("review"));
    expect(current().hidden.ai).toBe(true);
    expect(current().ratios.library).toBe(0.2);
    await act(async () => current().applyPreset("research"));
    expect(current().visible).toEqual(["library", "center", "ai"]);
    expect(current().showSplitA).toBe(true);
    expect(current().showSplitB).toBe(true);

    await act(async () => current().toggleFocus("library"));
    expect(current().layoutLabel).toBe("Sidebar focus");
    expect(current().visible).toEqual(["library"]);
    await act(async () => current().togglePane("ai"));
    expect(current().focusPane).toBeNull();
    expect(current().hidden.ai).toBe(false);
    await act(async () => current().toggleFocus("library"));
    expect(current().layoutLabel).toBe("Sidebar focus");
    await act(async () => current().showPane("ai"));
    expect(current().focusPane).toBeNull();
    await act(async () => current().toggleFocus("ai"));
    expect(current().focusPane).toBe("ai");
    await act(async () => current().showPane("ai"));
    expect(current().focusPane).toBe("ai");
    await act(async () => current().toggleFocus("ai"));
    expect(current().focusPane).toBeNull();
    await act(async () => current().collapsePane("library"));
    await act(async () => current().collapsePane("ai"));
    await act(async () => current().collapsePane("center"));
    expect(current().hidden.center).toBe(false);
    await act(async () => current().showPane("ai"));
    expect(current().hidden.ai).toBe(false);
    await act(async () => current().togglePane("ai"));
    expect(current().hidden.ai).toBe(true);
    await act(async () => current().resetLayout());
    expect(current().visible).toEqual(["library", "center", "ai"]);
    expect(current().railExpandedPref).toBe(true);
    await act(async () => view.root.unmount());
  });

  it("keeps page suggestions transient and adapts the one-pane narrow layout", async () => {
    const narrow = fakeMedia(true);
    const railNarrow = fakeMedia(true);
    const view = await renderLayout(fakeStorage(), narrow, railNarrow);

    expect(current().railExpanded).toBe(false);
    expect(current().railAutoCollapsed).toBe(true);
    await act(async () => current().setFocusedPage(true));
    expect(current().hidden.ai).toBe(true);
    await act(async () => current().togglePane("library"));
    expect(current().hidden.ai).toBe(true);
    await act(async () => current().toggleFocus("library"));
    expect(current().hidden.ai).toBe(true);
    await act(async () => current().collapsePane("library"));
    expect(current().hidden.ai).toBe(true);
    await act(async () => current().setFocusedPage(true));
    await act(async () => current().showPane("ai"));
    expect(current().hidden.ai).toBe(false);
    expect(current().focusPane).toBe("ai");
    expect(current().layoutLabel).toBe("Assistant");
    await act(async () => current().togglePane("ai"));
    expect(current().focusPane).toBe("center");
    await act(async () => current().showPane("library"));
    expect(current().focusPane).toBe("library");
    await act(async () => current().toggleFocus("ai"));
    expect(current().focusPane).toBe("ai");
    await act(async () => current().toggleRail());
    await act(async () => current().toggleMoreTools());
    expect(current().moreToolsOpen).toBe(true);

    await act(async () => updateMedia(narrow, false));
    await act(async () => updateMedia(railNarrow, false));
    expect(current().isNarrow).toBe(false);
    expect(current().railExpanded).toBe(false);
    await act(async () => current().setFocusedPage(false));
    await act(async () => current().setFocusedPage(true));
    expect(current().hidden.ai).toBe(false);
    await act(async () => view.root.unmount());
    expect(narrow.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(railNarrow.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("previews skin pane dimensions and restores the reader's prior ratios", async () => {
    const view = await renderLayout();
    const original = { ...current().ratios };
    Object.defineProperty(view.window, "innerWidth", { configurable: true, value: 800 });

    await act(async () => {
      view.window.dispatchEvent(new view.window.CustomEvent("arcelle-skin-layout", { detail: {} }));
      view.window.dispatchEvent(new view.window.CustomEvent("arcelle-skin-layout", {
        detail: {
          enabled: true,
          layout: { railWidth: 112, sidebarWidth: 420, agentWidth: 560, paneGap: 40 },
        },
      }));
    });
    expect(current().ratios.center).toBeGreaterThanOrEqual(0.32);
    expect(current().ratios.library).toBeCloseTo(0.2993220339);
    expect(current().ratios.center).toBeCloseTo(0.4);
    expect(current().ratios.ai).toBeCloseTo(0.3006779661);
    expect((current().gridStyle as Record<string, string>)["--split-a"]).toBe("24px");

    Object.defineProperty(view.window, "innerWidth", { configurable: true, value: 1400 });
    await act(async () => view.window.dispatchEvent(new view.window.CustomEvent("arcelle-skin-layout", {
      detail: {
        enabled: true,
        layout: { railWidth: 100, sidebarWidth: 300, agentWidth: 400, paneGap: 10 },
      },
    })));
    expect(current().ratios).toEqual({ library: 0.234375, center: 0.453125, ai: 0.3125 });

    await act(async () => view.window.dispatchEvent(new view.window.CustomEvent("arcelle-skin-layout", {
      detail: { enabled: false, layout: { railWidth: 84, sidebarWidth: 260, agentWidth: 340, paneGap: 8 } },
    })));
    expect(current().ratios).toEqual(original);
    expect((current().gridStyle as Record<string, string>)["--split-a"]).toBe("5px");

    await act(async () => view.window.dispatchEvent(new view.window.CustomEvent("arcelle-skin-layout", {
      detail: { enabled: false, layout: { railWidth: 84, sidebarWidth: 260, agentWidth: 340, paneGap: 8 } },
    })));
    await act(async () => view.root.unmount());
  });

  it("claims only the exact pane shortcut and lets text inputs keep Escape", async () => {
    const view = await renderLayout();
    const shortcut = keyboardEvent(view.window, "3", { metaKey: true });
    await act(async () => view.window.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true);
    expect(current().hidden.ai).toBe(true);

    const modified = keyboardEvent(view.window, "3", { metaKey: true, shiftKey: true });
    await act(async () => view.window.dispatchEvent(modified));
    expect(modified.defaultPrevented).toBe(false);
    expect(current().hidden.ai).toBe(true);

    await act(async () => current().toggleFocus("ai"));
    const input = view.document.createElement("input");
    view.document.body.append(input);
    const inputEscape = keyboardEvent(view.window, "Escape");
    await act(async () => input.dispatchEvent(inputEscape));
    expect(inputEscape.defaultPrevented).toBe(false);
    expect(current().focusPane).toBe("ai");
    const escape = keyboardEvent(view.window, "Escape");
    await act(async () => view.window.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(current().focusPane).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("shares bounded resize math between keyboard and pointer controls", async () => {
    const view = await renderLayout();
    await act(async () => current().keyResize("a", 1, false));
    expect(current().ratios.library).toBeCloseTo(0.175);
    expect(current().ratios.center).toBeCloseTo(0.595);
    expect(current().ratios.library + current().ratios.center + current().ratios.ai).toBeCloseTo(1);
    await act(async () => current().keyResize("b", -1, true));
    expect(current().ratios.ai).toBeCloseTo(0.27);
    expect(current().ratios.center).toBeCloseTo(0.555);

    const grid = view.host.firstElementChild as HTMLElement;
    Object.defineProperties(grid, {
      getBoundingClientRect: {
        value: () => ({ left: 100, right: 1100, width: 1000 }),
      },
      setPointerCapture: { value: vi.fn() },
      releasePointerCapture: { value: () => { throw new Error("already released"); } },
    });
    const preventDefault = vi.fn();
    await act(async () => current().startDrag("a", {
      currentTarget: grid,
      pointerId: 9,
      preventDefault,
    } as never));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(current().dragging).toBe("a");
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointermove", 400)));
    expect(current().ratios.library).toBeCloseTo(0.3);
    expect(current().ratios.center).toBeCloseTo(0.43);
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointerup", 400)));
    expect(current().dragging).toBeNull();
    expect(view.document.body.className).not.toContain("resizing-col");
    await act(async () => current().startDrag("b", {
      currentTarget: grid,
      pointerId: 9,
      preventDefault,
    } as never));
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointermove", 900)));
    expect(current().ratios.ai).toBeCloseTo(0.2);
    expect(current().ratios.center).toBeCloseTo(0.5);
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointercancel", 900)));

    await act(async () => current().startDrag("a", {
      currentTarget: grid,
      pointerId: 9,
      preventDefault,
    } as never));
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointermove", 1000)));
    expect(current().ratios.library).toBeCloseTo(0.4);
    expect(current().ratios.center).toBeCloseTo(0.4);
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointerup", 1000)));

    await act(async () => current().startDrag("b", {
      currentTarget: grid,
      pointerId: 9,
      preventDefault,
    } as never));
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointermove", 200)));
    expect(current().ratios.ai).toBeCloseTo(0.2);
    expect(current().ratios.center).toBeCloseTo(0.4);
    await act(async () => view.window.dispatchEvent(pointerEvent(view.window, "pointerup", 200)));
    await act(async () => view.root.unmount());
  });

  it("falls back from malformed or unavailable storage without breaking the layout", async () => {
    const roomKey = layoutKey("/rooms/layout-test.room");
    const malformed = fakeStorage({ [roomKey]: "{" });
    const malformedView = await renderLayout(malformed);
    expect(current().ratios.center).toBe(0.61);
    await act(async () => malformedView.root.unmount());

    const unavailable = fakeStorage();
    Object.defineProperty(unavailable, "getItem", { value: () => { throw new Error("private mode"); } });
    Object.defineProperty(unavailable, "setItem", { value: () => { throw new Error("private mode"); } });
    const unavailableView = await renderLayout(unavailable);
    await act(async () => current().togglePane("library"));
    expect(current().hidden.library).toBe(true);
    await act(async () => unavailableView.root.unmount());

    const unreadable = new Proxy(fakeStorage(), {
      ownKeys: () => {
        throw new Error("private mode");
      },
    }) as Storage;
    const unreadableView = await renderLayout(unreadable);
    expect(current().ratios.center).toBe(0.61);
    await act(async () => unreadableView.root.unmount());
  });
});
