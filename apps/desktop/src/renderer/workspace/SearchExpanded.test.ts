import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileMeta, SearchResults } from "../api";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn<(key: string) => Promise<string | null>>(),
  setSetting: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock("../api", () => ({
  api: { getSetting: mocks.getSetting, setSetting: mocks.setSetting },
  fileKindLabel: (file: { mimeType: string; name: string; source: string }) => {
    if (file.source === "recording") return "recording";
    if (file.mimeType === "application/pdf") return "PDF";
    return file.name.endsWith(".md") ? "note" : "file";
  },
  formatSize: (bytes: number) => `${bytes} B`,
}));
vi.mock("../icons", () => ({
  ChatBubbleIcon: () => null,
  CloseIcon: () => null,
  FileTypeIcon: () => null,
  MemoryIcon: () => null,
}));
vi.mock("./composer", () => ({
  fileLabel: (name: string) => name,
  formatWhen: (when: string) => when,
}));

import {
  applyFindFilters,
  DEFAULT_FILTERS,
  flattenShown,
  highlightTerms,
  kindsPresentOf,
  SearchFiltersBar,
  SearchIdlePanel,
  SearchQueryActions,
  SearchResultRows,
  splitMatches,
  useRecentAndSaved,
} from "./SearchExpanded";
import type { SavedSearch } from "./SearchExpanded";

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  HTMLButtonElement: globalThis.HTMLButtonElement,
  Event: globalThis.Event,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function meta(id: string, name: string, createdAt = "2026-08-30T09:00:00.000Z", overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id,
    name,
    mimeType: name.endsWith(".pdf") ? "application/pdf" : "text/markdown",
    sizeBytes: 16,
    source: "import",
    hasText: true,
    createdAt,
    folderId: null,
    partiallyIndexed: false,
    aiSummary: null,
    originDestination: "library",
    libraryVisibility: "linked",
    ...overrides,
  };
}

function results(): SearchResults {
  return {
    files: [
      { id: "ten", name: "File 10.pdf", snippet: "" },
      { id: "two", name: "File 2.pdf", snippet: "matching content" },
      { id: "old", name: "Alpha.md", snippet: "old matching content" },
      { id: "gone", name: "Gone.pdf", snippet: "matching content" },
    ],
    messages: [{ chatId: "chat", messageId: "message", snippet: "a conversation hit" }],
    memories: [{ id: "memory", snippet: "a memory hit" }],
  };
}

function currentFiles(): Map<string, FileMeta> {
  const now = new Date().toISOString();
  return new Map([
    ["ten", meta("ten", "File 10.pdf", now)],
    ["two", meta("two", "File 2.pdf", now)],
    ["old", meta("old", "Alpha.md", "2020-01-01T00:00:00.000Z")],
  ]);
}

async function render(element: React.ReactNode) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLButtonElement", window.HTMLButtonElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(React.Fragment, null, element));
    await Promise.resolve();
  });
  return { document, host, root };
}

function reactHandler(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

async function invoke(element: Element, name = "onClick") {
  await act(async () => {
    reactHandler(element, name)({ currentTarget: element, target: element });
  });
}

function button(host: Element, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

describe("SearchExpanded", () => {
  it("keeps highlight offsets safe and prefers the longer term at a shared offset", () => {
    expect(splitMatches("Formula form tail", ["form", "formula"])).toEqual([
      { text: "Formula", hit: true },
      { text: " ", hit: false },
      { text: "form", hit: true },
      { text: " tail", hit: false },
    ]);
    expect(splitMatches("İ form", ["form"])).toEqual([{ text: "İ form", hit: false }]);
    expect(splitMatches("", ["form"])).toEqual([{ text: "", hit: false }]);
    expect(splitMatches("form", [])).toEqual([{ text: "form", hit: false }]);
  });

  it("normalizes saved filters through the room-setting hook", async () => {
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.getSetting.mockImplementation(async (key) => {
      if (key === "find_recent_searches") return JSON.stringify(["report"]);
      return JSON.stringify([
        { q: "kept", filters: { sources: ["files", "bogus"], kinds: ["PDF", 2], when: "week", match: "name", sort: "newest" } },
        { q: "fallback", filters: { sources: [], kinds: "not an array", when: "future", match: "wrong", sort: "random" } },
        { q: "missing", filters: null },
      ]);
    });
    function Probe() {
      const { recent, saved } = useRecentAndSaved();
      return createElement("output", null, JSON.stringify({ recent, saved }));
    }
    const view = await render(createElement(Probe));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(JSON.parse(view.host.textContent ?? "{}")) .toEqual({
      recent: ["report"],
      saved: [
        { q: "kept", filters: { sources: ["files"], kinds: ["PDF"], when: "week", match: "name", sort: "newest" } },
        { q: "fallback", filters: DEFAULT_FILTERS },
        { q: "missing", filters: DEFAULT_FILTERS },
      ],
    });
  });

  it("filters the existing result set by source, match, metadata, and sort without mutating it", () => {
    const raw = results();
    const files = currentFiles();
    const textPdf = applyFindFilters(raw, {
      sources: ["files", "messages", "memories"], kinds: ["PDF"], when: "week", match: "text", sort: "newest",
    }, files);
    expect(textPdf.files.map((hit) => hit.id)).toEqual(["two"]);
    expect(textPdf.messages).toEqual(raw.messages);
    expect(textPdf.memories).toEqual(raw.memories);
    expect(raw.files).toHaveLength(4);

    const names = applyFindFilters(raw, {
      ...DEFAULT_FILTERS, sources: ["files", "messages", "memories"], match: "name", sort: "name",
    }, files);
    expect(names.files.map((hit) => hit.id)).toEqual(["ten"]);
    expect(names.messages).toEqual([]);
    expect(names.memories).toEqual([]);

    const oldest = applyFindFilters(raw, { ...DEFAULT_FILTERS, sources: ["files"], sort: "oldest" }, files);
    expect(oldest.files.map((hit) => hit.id)).toEqual(["old", "two", "ten", "gone"]);
    expect(applyFindFilters(null, DEFAULT_FILTERS, files)).toEqual({ files: [], messages: [], memories: [] });
  });

  it("keeps fabricated files at each date cutoff boundary and excludes the older one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    try {
      const now = Date.now();
      const day = 86_400_000;
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const dates = {
        ancient: new Date(now - 365 * day - 1).toISOString(),
        month: new Date(now - 30 * day).toISOString(),
        today: midnight.toISOString(),
        week: new Date(now - 7 * day).toISOString(),
        year: new Date(now - 365 * day).toISOString(),
      };
      const fileById = new Map(Object.entries(dates).map(([id, createdAt]) => [
        id,
        meta(id, `${id}.md`, createdAt),
      ]));
      const raw: SearchResults = {
        files: ["today", "week", "month", "year", "ancient"].map((id) => ({ id, name: `${id}.md`, snippet: "" })),
        messages: [],
        memories: [],
      };
      const shown = (when: "any" | "today" | "week" | "month" | "year") =>
        applyFindFilters(raw, { ...DEFAULT_FILTERS, sources: ["files"], when }, fileById).files.map((file) => file.id);

      expect(shown("today")).toEqual(["today"]);
      expect(shown("week")).toEqual(["today", "week"]);
      expect(shown("month")).toEqual(["today", "week", "month"]);
      expect(shown("year")).toEqual(["today", "week", "month", "year"]);
      expect(shown("any")).toEqual(["today", "week", "month", "year", "ancient"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps flattened navigation and visible type/highlight helpers aligned with the shown results", () => {
    const raw = results();
    const files = currentFiles();
    expect(highlightTerms("a alpha alpha")).toEqual(["alpha"]);
    expect(kindsPresentOf(raw, files)).toEqual(["PDF", "note"]);
    expect(flattenShown({ files: raw.files.slice(0, 1), messages: raw.messages, memories: raw.memories })).toEqual([
      { kind: "file", id: "ten", name: "File 10.pdf", snippet: "" },
      { kind: "message", chatId: "chat", messageId: "message", snippet: "a conversation hit" },
      { kind: "memory", id: "memory", snippet: "a memory hit" },
    ]);
  });

  it("renders filter controls with fake data and preserves source/kind guardrails", async () => {
    const changes = vi.fn();
    const view = await render(createElement(SearchFiltersBar, {
      filters: { ...DEFAULT_FILTERS, when: "week" },
      onChange: changes,
      results: results(),
      kindsPresent: ["PDF", "note"],
      messagesOrMemoriesShown: true,
      showSort: true,
    }));
    expect(view.host.textContent).toContain("Dates come from when a file was added");
    await invoke(button(view.host, "Files"));
    expect(changes).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, sources: ["messages", "memories"], when: "week" });
    await invoke(button(view.host, "PDF"));
    expect(changes).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, kinds: ["PDF"], when: "week" });
    const selects = [...view.host.querySelectorAll("select")];
    await act(async () => reactHandler(selects[0], "onChange")({ target: { value: "month" } }));
    expect(changes).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, when: "month" });
    await act(async () => reactHandler(selects[1], "onChange")({ target: { value: "text" } }));
    expect(changes).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, when: "week", match: "text" });
    await act(async () => reactHandler(selects[2], "onChange")({ target: { value: "name" } }));
    expect(changes).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, when: "week", sort: "name" });
    await invoke(button(view.host, "All"));
    expect(changes).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, when: "week", kinds: [] });
    await invoke(button(view.host, "Clear filters"));
    expect(changes).toHaveBeenLastCalledWith(DEFAULT_FILTERS);

    const guardedChanges = vi.fn();
    const guarded = await render(createElement(SearchFiltersBar, {
      filters: { ...DEFAULT_FILTERS, sources: ["files"] },
      onChange: guardedChanges,
      results: results(),
      kindsPresent: ["PDF", "note"],
      messagesOrMemoriesShown: false,
      showSort: false,
    }));
    await invoke(button(guarded.host, "Files"));
    expect(guardedChanges).not.toHaveBeenCalled();

    const adding = vi.fn();
    const alternate = await render(createElement(SearchFiltersBar, {
      filters: { ...DEFAULT_FILTERS, sources: ["messages"], kinds: ["PDF"] },
      onChange: adding,
      results: results(),
      kindsPresent: ["PDF"],
      messagesOrMemoriesShown: true,
      showSort: false,
    }));
    await invoke(button(alternate.host, "Files"));
    expect(adding).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, sources: ["files", "messages"], kinds: ["PDF"] });

    const removingKind = vi.fn();
    const kindView = await render(createElement(SearchFiltersBar, {
      filters: { ...DEFAULT_FILTERS, sources: ["files"], kinds: ["PDF"] },
      onChange: removingKind,
      results: results(),
      kindsPresent: ["PDF", "note"],
      messagesOrMemoriesShown: false,
      showSort: false,
    }));
    await invoke(button(kindView.host, "PDF"));
    expect(removingKind).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, sources: ["files"], kinds: [] });
  });

  it("keeps file-row notes, fallback metadata, and open behavior intact", async () => {
    const onOpenFile = vi.fn();
    const onOpenResult = vi.fn();
    const shown: SearchResults = {
      files: [
        { id: "name", name: "Name.pdf", snippet: "" },
        { id: "partial", name: "Partial.pdf", snippet: "text" },
        { id: "generated", name: "Generated.pdf", snippet: "text" },
        { id: "plain", name: "Plain.pdf", snippet: "text" },
        { id: "gone", name: "Gone.pdf", snippet: "text" },
      ],
      messages: [],
      memories: [],
    };
    const fileById = new Map([
      ["name", meta("name", "Name.pdf", "2024-08-30T09:00:00.000Z")],
      ["partial", meta("partial", "Partial.pdf", "2026-08-30T09:00:00.000Z", { partiallyIndexed: true })],
      ["generated", meta("generated", "Generated.pdf", "2026-08-30T09:00:00.000Z", { source: "generated" })],
      ["plain", meta("plain", "Plain.pdf")],
    ]);
    const onSelectIndex = vi.fn();
    const view = await render(createElement(SearchResultRows, {
      shown,
      files: [...fileById.values()],
      fileById,
      terms: ["text"],
      selectedIndex: 1,
      registerRowRef: () => () => {},
      onSelectIndex,
      onOpenResult,
      onOpenFile,
    }));
    expect(view.host.textContent).toContain("the name matched, not the text");
    expect(view.host.textContent).toContain("only the first part of this file is indexed");
    expect(view.host.textContent).toContain("written by the AI in this room");
    expect(view.host.textContent).toContain("no longer in this room");
    expect(view.host.textContent).toContain("2024");
    await invoke(button(view.host, "Name.pdf"));
    await invoke(button(view.host, "Partial.pdf"));
    await invoke(button(view.host, "Partial.pdf"), "onMouseEnter");
    expect(onOpenFile).toHaveBeenCalledWith("name");
    expect(onOpenResult).toHaveBeenCalledWith({ kind: "file", id: "partial", name: "Partial.pdf", snippet: "text" });
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });

  it("keeps message and memory actions aligned with file-row selection offsets", async () => {
    const onOpenFile = vi.fn();
    const onOpenResult = vi.fn();
    const onSelectIndex = vi.fn();
    const registerRowRef = vi.fn<(index: number) => (element: HTMLButtonElement | null) => void>(() => () => {});
    const shown: SearchResults = {
      files: [{ id: "file", name: "File.pdf", snippet: "file text" }],
      messages: [{ chatId: "chat", messageId: "message", snippet: "message text" }],
      memories: [{ id: "memory", snippet: "memory text" }],
    };
    const file = meta("file", "File.pdf");
    const view = await render(createElement(SearchResultRows, {
      shown,
      files: [file],
      fileById: new Map([[file.id, file]]),
      terms: ["text"],
      selectedIndex: 2,
      registerRowRef,
      onSelectIndex,
      onOpenResult,
      onOpenFile,
    }));

    expect(view.host.textContent).toContain("Files1");
    expect(view.host.textContent).toContain("Conversations1");
    expect(view.host.textContent).toContain("Memories1");
    expect(button(view.host, "memory text").className).toContain("is-sel");
    expect([...new Set(registerRowRef.mock.calls.map(([index]) => index))].sort()).toEqual([0, 1, 2]);

    await invoke(button(view.host, "message text"), "onMouseEnter");
    await invoke(button(view.host, "message text"));
    await invoke(button(view.host, "memory text"), "onMouseEnter");
    await invoke(button(view.host, "memory text"));

    expect(onSelectIndex.mock.calls).toEqual([[1], [2]]);
    expect(onOpenResult.mock.calls).toEqual([
      [{ kind: "message", chatId: "chat", messageId: "message", snippet: "message text" }],
      [{ kind: "memory", id: "memory", snippet: "memory text" }],
    ]);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("renders an empty result boundary without registering rows or action handlers", async () => {
    const registerRowRef = vi.fn(() => () => {});
    const onOpenFile = vi.fn();
    const onOpenResult = vi.fn();
    const onSelectIndex = vi.fn();
    const view = await render(createElement(SearchResultRows, {
      shown: { files: [], messages: [], memories: [] },
      files: [],
      fileById: new Map(),
      terms: [],
      selectedIndex: 0,
      registerRowRef,
      onSelectIndex,
      onOpenResult,
      onOpenFile,
    }));

    expect(view.host.querySelector(".find-groups")).not.toBeNull();
    expect(view.host.querySelectorAll("section, button")).toHaveLength(0);
    expect(registerRowRef).not.toHaveBeenCalled();
    expect(onSelectIndex).not.toHaveBeenCalled();
    expect(onOpenResult).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("wires saved, recent, and ask actions with fake callbacks", async () => {
    const onAsk = vi.fn();
    const onToggleSaved = vi.fn();
    const onRunRecent = vi.fn();
    const onRunSaved = vi.fn();
    const onRemoveSaved = vi.fn();
    const onClearRecent = vi.fn();
    const saved: SavedSearch = { q: "quarterly report", filters: { ...DEFAULT_FILTERS, sources: ["files"] } };
    const view = await render(createElement(React.Fragment, null,
      createElement(SearchQueryActions, { query: "ask this", isSaved: true, onToggleSaved, onAsk }),
      createElement(SearchIdlePanel, {
        recent: ["recent report"], saved: [saved], onRunRecent, onRunSaved, onRemoveSaved, onClearRecent,
      }),
    ));
    await invoke(button(view.host, "Saved"));
    await invoke(button(view.host, "Ask the room instead"));
    await invoke(button(view.host, "quarterly report"));
    const remove = view.host.querySelector(".find-saved-del");
    if (!remove) throw new Error("saved remove button missing");
    await invoke(remove);
    await invoke(button(view.host, "recent report"));
    await invoke(button(view.host, "Clear recent"));
    expect(onToggleSaved).toHaveBeenCalledOnce();
    expect(onAsk).toHaveBeenCalledWith("ask this");
    expect(onRunSaved).toHaveBeenCalledWith(saved);
    expect(onRemoveSaved).toHaveBeenCalledWith("quarterly report");
    expect(onRunRecent).toHaveBeenCalledWith("recent report");
    expect(onClearRecent).toHaveBeenCalledOnce();
  });

  it("describes a saved default search as covering the whole room", async () => {
    const view = await render(createElement(SearchIdlePanel, {
      recent: [],
      saved: [{ q: "everything", filters: DEFAULT_FILTERS }],
      onRunRecent: vi.fn(),
      onRunSaved: vi.fn(),
      onRemoveSaved: vi.fn(),
      onClearRecent: vi.fn(),
    }));

    expect(view.host.textContent).toContain("the whole room");
  });
});
