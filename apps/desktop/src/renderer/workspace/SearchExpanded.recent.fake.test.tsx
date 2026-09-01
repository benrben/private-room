import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

vi.mock("../api", () => ({
  api: { getSetting: bridge.getSetting, setSetting: bridge.setSetting },
  fileKindLabel: vi.fn(),
  formatSize: vi.fn(),
}));
vi.mock("../icons", () => ({
  ChatBubbleIcon: () => null,
  CloseIcon: () => null,
  FileTypeIcon: () => null,
  MemoryIcon: () => null,
}));
vi.mock("./composer", () => ({ fileLabel: vi.fn(), formatWhen: vi.fn() }));

import { useRecentAndSaved } from "./SearchExpanded";

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type SearchRecall = ReturnType<typeof useRecentAndSaved>;
let searchRecall: SearchRecall | null = null;

function SearchRecallProbe() {
  searchRecall = useRecentAndSaved();
  return null;
}

function current(): SearchRecall {
  if (searchRecall === null) throw new Error("Recent-search hook has not rendered.");
  return searchRecall;
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
  if (!host) throw new Error("Recent-search hook test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(SearchRecallProbe));
    await Promise.resolve();
  });
  await flush();
  return { close: async () => act(async () => root.unmount()) };
}

beforeEach(() => {
  searchRecall = null;
  bridge.getSetting.mockReset().mockImplementation((key: string) => Promise.resolve(
    key === "find_recent_searches" ? "[]" : "[]",
  ));
  bridge.setSetting.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useRecentAndSaved noteSearch", () => {
  it("degrades malformed stored lists and supports saving and removing a complete search", async () => {
    bridge.getSetting.mockResolvedValue("{not-json");
    const view = await renderHook();
    expect(current().recent).toEqual([]);
    expect(current().saved).toEqual([]);
    bridge.setSetting.mockClear();

    await act(async () => current().toggleSaved("invoices", {
      sources: ["files"], kinds: ["PDF"], when: "month", match: "text", sort: "newest",
    }));
    expect(current().saved.map((entry) => entry.q)).toEqual(["invoices"]);

    await act(async () => current().toggleSaved("invoices", current().saved[0]!.filters));
    expect(current().saved).toEqual([]);

    await act(async () => {
      current().toggleSaved("budget", { sources: ["files"], kinds: [], when: "any", match: "any", sort: "best" });
      current().toggleSaved("", { sources: ["files"], kinds: [], when: "any", match: "any", sort: "best" });
    });
    await act(async () => current().removeSaved("budget"));
    expect(current().saved).toEqual([]);
    await view.close();
  });

  it("collapses fabricated incremental searches to the completed query and persists it", async () => {
    bridge.getSetting.mockImplementation((key: string) => Promise.resolve(
      key === "find_recent_searches" ? JSON.stringify(["inv", "in", "archive"]) : "[]",
    ));
    const view = await renderHook();
    expect(current().recent).toEqual(["inv", "in", "archive"]);
    bridge.setSetting.mockClear();

    await act(async () => current().noteSearch("invoice"));
    await flush();

    expect(current().recent).toEqual(["invoice", "archive"]);
    expect(bridge.setSetting).toHaveBeenCalledWith(
      "find_recent_searches",
      JSON.stringify(["invoice", "archive"]),
    );
    await view.close();
  });

  it("keeps a fabricated most-recent query stable and ignores an empty completion", async () => {
    bridge.getSetting.mockImplementation((key: string) => Promise.resolve(
      key === "find_recent_searches" ? JSON.stringify(["invoice", "archive"]) : "[]",
    ));
    const view = await renderHook();
    bridge.setSetting.mockClear();

    await act(async () => {
      current().noteSearch("invoice");
      current().noteSearch("");
    });
    await flush();

    expect(current().recent).toEqual(["invoice", "archive"]);
    expect(bridge.setSetting).not.toHaveBeenCalled();
    await view.close();
  });

  it("caps fabricated history at eight completed searches", async () => {
    const stored = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
    bridge.getSetting.mockImplementation((key: string) => Promise.resolve(
      key === "find_recent_searches" ? JSON.stringify(stored) : "[]",
    ));
    const view = await renderHook();

    await act(async () => current().noteSearch("nine"));

    expect(current().recent).toEqual(["nine", "one", "two", "three", "four", "five", "six", "seven"]);
    await view.close();
  });
});
