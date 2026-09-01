import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab, TabsApi } from "./tabs";

const bridge = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../api", () => ({ api: bridge }));

import {
  heirOfLast,
  heirOfNothing,
  selectionAfterDrop,
  tabId,
  useTabs,
} from "./tabs";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

const first: Tab = { id: "file:first", kind: "file", ref: "first", title: "First" };
const second: Tab = { id: "file:second", kind: "file", ref: "second", title: "Second" };

function Probe({ room, report }: { room: string; report: (tabs: TabsApi) => void }) {
  report(useTabs(room));
  return null;
}

async function flush(rounds = 8) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function render(room = "room-1") {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  let current!: TabsApi;
  const draw = async (nextRoom = room) => {
    await act(async () => {
      root.render(createElement(Probe, { room: nextRoom, report: (tabs) => { current = tabs; } }));
    });
    await flush();
  };
  await draw();
  return {
    get tabs() { return current; },
    draw,
    close: async () => act(async () => root.unmount()),
  };
}

async function change(view: Awaited<ReturnType<typeof render>>, update: (tabs: TabsApi) => void) {
  await act(async () => {
    update(view.tabs);
  });
  await flush();
}

beforeEach(() => {
  bridge.getSetting.mockReset().mockResolvedValue("");
  bridge.setSetting.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("workspace tabs", () => {
  it("keeps selection rules explicit", () => {
    expect(tabId("file", "memo")).toBe("file:memo");
    expect(selectionAfterDrop([first, second], "file:second", heirOfLast)).toBe("file:second");
    expect(selectionAfterDrop([first], "file:gone", heirOfLast)).toBe("file:first");
    expect(selectionAfterDrop([first], "", heirOfLast)).toBe("");
    expect(heirOfLast([])).toBe("");
    expect(heirOfNothing()).toBe("");
  });

  it("restores only recognized serialized tabs and falls back from a nonstring selection", async () => {
    bridge.getSetting.mockResolvedValueOnce(JSON.stringify({
      tabs: [
        first,
        { id: "browser:discard", kind: "browser", ref: "discard", title: "Discard" },
        { id: "file:broken", kind: "file", ref: 7, title: "Broken" },
        null,
        "not a tab",
      ],
      activeId: 7,
    }));
    const view = await render();
    expect(view.tabs.restored).toBe(true);
    expect(view.tabs.tabs).toEqual([first]);
    expect(view.tabs.activeId).toBe("file:first");
    expect(view.tabs.active).toEqual(first);
    await view.close();
  });

  it("treats missing, malformed, and structurally unrecognized settings as no saved tabs", async () => {
    bridge.getSetting.mockResolvedValueOnce("{bad json");
    const malformed = await render("malformed");
    expect(malformed.tabs).toMatchObject({ restored: true, tabs: [], activeId: "", active: null });
    await malformed.close();

    bridge.getSetting.mockResolvedValueOnce(JSON.stringify({ activeId: "file:first" }));
    const missingTabs = await render("missing-tabs");
    expect(missingTabs.tabs.tabs).toEqual([]);
    await missingTabs.close();

    bridge.getSetting.mockResolvedValueOnce(JSON.stringify([]));
    const arrayPayload = await render("array-payload");
    expect(arrayPayload.tabs.tabs).toEqual([]);
    await arrayPayload.close();
  });

  it("opens, retitles, reorders, selects, and drops through the public tab API", async () => {
    bridge.getSetting.mockResolvedValueOnce(JSON.stringify({ tabs: [first, second], activeId: first.id }));
    const view = await render();
    await change(view, (tabs) => tabs.open("file", "third", "Third"));
    expect(view.tabs.activeId).toBe("file:third");
    await change(view, (tabs) => tabs.open("file", "third", "Third revised"));
    expect(view.tabs.tabs.find((tab) => tab.id === "file:third")?.title).toBe("Third revised");
    await change(view, (tabs) => tabs.retitle("file:missing", "Unused"));
    await change(view, (tabs) => tabs.retitle("file:third", "Third final"));
    expect(view.tabs.tabs.find((tab) => tab.id === "file:third")?.title).toBe("Third final");

    await change(view, (tabs) => tabs.move(0, 0));
    await change(view, (tabs) => tabs.move(-1, 1));
    await change(view, (tabs) => tabs.move(0, 2));
    expect(view.tabs.tabs.map((tab) => tab.id)).toEqual([second.id, "file:third", first.id]);
    await change(view, (tabs) => tabs.activateIndex(0));
    expect(view.tabs.activeId).toBe(second.id);
    await change(view, (tabs) => tabs.activateIndex(8));
    expect(view.tabs.activeId).toBe(first.id);
    await change(view, (tabs) => tabs.step(1));
    expect(view.tabs.activeId).toBe(second.id);

    await change(view, (tabs) => tabs.close("file:missing"));
    await change(view, (tabs) => tabs.close(second.id));
    expect(view.tabs.activeId).toBe("file:third");
    await change(view, (tabs) => tabs.prune((tab) => tab.id !== "file:third"));
    expect(view.tabs.activeId).toBe(first.id);
    await change(view, (tabs) => tabs.unlist((tab) => tab.id !== first.id));
    expect(view.tabs.activeId).toBe("");
    expect(view.tabs.tabs).toEqual([]);
    expect(bridge.setSetting).toHaveBeenCalled();
    await view.close();
  });
});
