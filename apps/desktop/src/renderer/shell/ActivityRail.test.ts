import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "./useLayout";
import ActivityRail from "./ActivityRail";

const { act, createElement } = React;

const nav = vi.hoisted(() => ({
  pinned: ["library"],
  more: ["workflows", "scripts"],
}));

vi.mock("../icons", () => ({
  ChevronDownIcon: () => null,
  ChevronLeftIcon: () => null,
  ChevronRightIcon: () => null,
  ListFilterIcon: () => null,
  SettingsIcon: () => null,
  ToolsIcon: () => null,
}));
vi.mock("./navPrefs", () => ({
  useNavPrefs: () => nav,
  areaDef: (key: string) => ({ label: `Label ${key}`, icon: () => null }),
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
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function testLayout(overrides: Record<string, unknown> = {}) {
  return {
    railExpanded: true,
    railAutoCollapsed: false,
    moreToolsOpen: false,
    toggleRail: vi.fn(),
    toggleMoreTools: vi.fn(),
    ...overrides,
  } as unknown as LayoutApi;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderRail({
  layout = testLayout(),
  area = "library",
  onArea = vi.fn(),
  onSettings = vi.fn(),
  onCustomize = vi.fn(),
}: {
  layout?: LayoutApi;
  area?: string;
  onArea?: ReturnType<typeof vi.fn>;
  onSettings?: ReturnType<typeof vi.fn>;
  onCustomize?: ReturnType<typeof vi.fn>;
} = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Vitest" } });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ActivityRail, {
      layout,
      area: area as never,
      onArea: onArea as never,
      onSettings,
      onCustomize,
    }));
  });
  await flush();
  return { host, root, window, layout, onArea, onSettings, onCustomize };
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

beforeEach(() => {
  nav.pinned = ["library"];
  nav.more = ["workflows", "scripts"];
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (key === "navigator") {
      Reflect.deleteProperty(globalThis, key);
      if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor);
      continue;
    }
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("ActivityRail", () => {
  it("keeps the current unpinned destination visible and routes every visible control", async () => {
    const view = await renderRail({ area: "scripts" });
    expect(view.host.querySelector("nav.activity-rail.is-expanded")).not.toBeNull();
    expect(view.host.querySelector('[data-area="library"]')?.getAttribute("aria-current")).toBeNull();
    const current = view.host.querySelector<HTMLButtonElement>('[data-area="scripts"]');
    if (!current) throw new Error("current more row missing");
    expect(current.className).toContain("is-nested");
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(view.host.querySelector('[data-area="workflows"]')).toBeNull();
    const more = view.host.querySelector<HTMLButtonElement>('[data-testid="more-tools"]');
    if (!more) throw new Error("more tools button missing");
    expect(more.getAttribute("aria-label")).toBe("Show 1 more tool");
    await click(current, view.window);
    expect(view.onArea).toHaveBeenCalledWith("scripts");
    await click(view.host.querySelector('[data-testid="rail-expander"]')!, view.window);
    await click(more, view.window);
    await click(view.host.querySelector('[data-testid="customize-sidebar"]')!, view.window);
    await click(view.host.querySelector('[aria-label="Open room settings (⌘,)"]')!, view.window);
    expect(view.layout.toggleRail).toHaveBeenCalledOnce();
    expect(view.layout.toggleMoreTools).toHaveBeenCalledOnce();
    expect(view.onCustomize).toHaveBeenCalledOnce();
    expect(view.onSettings).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("expands every more-tool and states what closing the disclosure changes", async () => {
    const view = await renderRail({
      area: "library",
      layout: testLayout({ moreToolsOpen: true }),
    });
    const more = view.host.querySelector<HTMLButtonElement>('[data-testid="more-tools"]');
    if (!more) throw new Error("more tools button missing");
    expect(more.getAttribute("aria-label")).toBe("Hide the other 2 tools");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(view.host.querySelector('[data-area="workflows"]')).not.toBeNull();
    expect(view.host.querySelector('[data-area="scripts"]')).not.toBeNull();
    await click(view.host.querySelector('[data-area="workflows"]')!, view.window);
    expect(view.onArea).toHaveBeenCalledWith("workflows");
    await act(async () => view.root.unmount());
  });

  it("renders empty and icon-only rail variants without controls that cannot work", async () => {
    nav.pinned = [];
    nav.more = ["workflows"];
    const currentOnly = await renderRail({ area: "workflows" });
    expect(currentOnly.host.textContent).toContain("Nothing pinned");
    expect(currentOnly.host.querySelector('[data-testid="more-tools"]')?.getAttribute("aria-label")).toBe("More tools");
    await act(async () => currentOnly.root.unmount());

    const narrow = await renderRail({
      area: "library",
      layout: testLayout({ railExpanded: false, railAutoCollapsed: false }),
    });
    expect(narrow.host.querySelector('[data-testid="rail-expander"]')?.getAttribute("aria-label")).toBe("Expand the sidebar to show full labels");
    expect(narrow.host.querySelector('[data-testid="rail-expander"]')?.getAttribute("title")).toBe("Expand the sidebar");
    await act(async () => narrow.root.unmount());

    nav.pinned = ["library"];
    nav.more = [];
    const collapsed = await renderRail({
      area: "library",
      layout: testLayout({ railExpanded: false, railAutoCollapsed: true }),
    });
    expect(collapsed.host.querySelector('[data-testid="rail-expander"]')).toBeNull();
    expect(collapsed.host.querySelector('[data-testid="more-tools"]')).toBeNull();
    expect(collapsed.host.querySelector(".rail-label")).toBeNull();
    expect(collapsed.host.querySelector('[data-area="library"]')?.getAttribute("title")).toBe("Label library");
    expect(collapsed.host.querySelector('[data-testid="customize-sidebar"]')?.getAttribute("title")).toBe("Customize sidebar");
    expect(collapsed.host.querySelector('[aria-label="Open room settings (⌘,)"]')?.getAttribute("title")).toBe("Settings");
    await act(async () => collapsed.root.unmount());
  });
});
