import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApi } from "./useLayout";
import type { RoomMenuActions } from "./useNativeMenu";

const nativeMenu = vi.hoisted(() => ({
  onMenuAction: vi.fn(),
  syncViewMenu: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    onMenuAction: nativeMenu.onMenuAction,
    syncViewMenu: nativeMenu.syncViewMenu,
  },
}));

import { useNativeMenu } from "./useNativeMenu";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type MenuListener = (id: string) => void;

function fakeLayout(overrides: Partial<LayoutApi> = {}): LayoutApi {
  return {
    visible: ["library", "center", "ai"],
    focusPane: "center",
    railExpandedPref: true,
    railAutoCollapsed: false,
    togglePane: vi.fn(),
    toggleFocus: vi.fn(),
    toggleRail: vi.fn(),
    applyPreset: vi.fn(),
    resetLayout: vi.fn(),
    ...overrides,
  } as unknown as LayoutApi;
}

function fakeRoom(): RoomMenuActions {
  return { newItem: vi.fn(), closeItem: vi.fn() };
}

function NativeMenuProbe({ layout, sidebarTitle, room }: {
  layout: LayoutApi;
  sidebarTitle: string;
  room: RoomMenuActions;
}) {
  useNativeMenu(layout, sidebarTitle, room);
  return null;
}

function installDom() {
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
  return document;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderNativeMenu(layout = fakeLayout(), sidebarTitle = "Library", room = fakeRoom()) {
  const document = installDom();
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("Test root missing.");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(NativeMenuProbe, { layout, sidebarTitle, room }));
  });
  await flush();
  return { root, layout, room };
}

function listener(): MenuListener {
  const registered = nativeMenu.onMenuAction.mock.calls[0]?.[0] as MenuListener | undefined;
  if (!registered) throw new Error("Native menu listener was not registered.");
  return registered;
}

beforeEach(() => {
  nativeMenu.onMenuAction.mockReset();
  nativeMenu.syncViewMenu.mockReset().mockResolvedValue(undefined);
  nativeMenu.onMenuAction.mockImplementation(() => Promise.resolve(vi.fn()));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useNativeMenu with fabricated API and window seams", () => {
  it("syncs state and dispatches every callback through the current layout and room refs", async () => {
    const firstLayout = fakeLayout();
    const firstRoom = fakeRoom();
    const view = await renderNativeMenu(firstLayout, "Library", firstRoom);

    expect(nativeMenu.syncViewMenu).toHaveBeenCalledWith({
      enabled: true,
      library: true,
      assistant: true,
      focus: true,
      railLabels: true,
      railLabelsSettable: true,
      sidebar: "Library",
    });

    await act(async () => listener()("view.library"));
    await flush();
    expect(firstLayout.togglePane).toHaveBeenCalledWith("library");

    const currentLayout = fakeLayout({ visible: ["center"], focusPane: null, railExpandedPref: false, railAutoCollapsed: true });
    const currentRoom = fakeRoom();
    await act(async () => {
      view.root.render(createElement(NativeMenuProbe, {
        layout: currentLayout,
        sidebarTitle: "Memory",
        room: currentRoom,
      }));
    });
    await flush();

    await act(async () => {
      listener()("view.assistant");
      listener()("file.new-item");
      listener()("file.close-item");
    });
    await flush();

    expect(currentLayout.togglePane).toHaveBeenCalledWith("ai");
    expect(firstLayout.togglePane).toHaveBeenCalledTimes(1);
    expect(currentRoom.newItem).toHaveBeenCalledTimes(1);
    expect(currentRoom.closeItem).toHaveBeenCalledTimes(1);
    expect(nativeMenu.onMenuAction).toHaveBeenCalledTimes(1);
    expect(nativeMenu.syncViewMenu).toHaveBeenLastCalledWith({
      enabled: true,
      library: false,
      assistant: false,
      focus: false,
      railLabels: false,
      railLabelsSettable: false,
      sidebar: "Memory",
    });
  });

  it("warns for an unknown fabricated row and cleans up both listener and menu state", async () => {
    const unlisten = vi.fn();
    nativeMenu.onMenuAction.mockImplementation(() => Promise.resolve(unlisten));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = await renderNativeMenu();

    await act(async () => listener()("view.unknown"));
    await flush();
    expect(warn).toHaveBeenCalledWith("[menu] no handler for", "view.unknown");

    await act(async () => view.root.unmount());
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(nativeMenu.syncViewMenu).toHaveBeenLastCalledWith({
      enabled: false,
      library: false,
      assistant: false,
      focus: false,
      railLabels: false,
      railLabelsSettable: false,
      sidebar: "Sidebar",
    });
  });
});
