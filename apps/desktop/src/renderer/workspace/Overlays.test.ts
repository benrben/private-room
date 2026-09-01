import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Overlays from "./Overlays";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  checkpoint: vi.fn(async () => ({ name: "Before edits" })),
  focusDeclines: [] as Array<() => void>,
  focusKeyDown: vi.fn(),
  languageForFile: vi.fn(() => "markdown"),
  noteSearch: vi.fn(),
  removeSaved: vi.fn(),
  clearRecent: vi.fn(),
  toggleSaved: vi.fn(),
  toggleTheme: vi.fn(),
}));

vi.mock("../api", () => ({ api: { createRoomCheckpoint: mocks.checkpoint } }));
vi.mock("../icons", () => ({
  CheckIcon: () => null,
  CloseIcon: () => null,
  DownloadIcon: () => null,
  GlobeIcon: () => null,
  MicIcon: () => null,
  ScriptIcon: () => null,
  ShieldIcon: () => null,
}));
vi.mock("../settings/useFocusTrap", () => ({
  useFocusTrap: (onDecline: () => void) => {
    mocks.focusDeclines.push(onDecline);
    return { modalRef: { current: null }, onModalKeyDown: (event: unknown) => { mocks.focusKeyDown(event); onDecline(); } };
  },
}));
vi.mock("../viewers/DiffPreview", () => ({ default: () => createElement("div", { "data-testid": "diff" }, "diff") }));
vi.mock("../viewers/languages", () => ({ languageForFile: mocks.languageForFile }));
vi.mock("../theme", () => ({ toggleTheme: mocks.toggleTheme }));
vi.mock("./SealedExportDialog", () => ({ default: ({ onClose }: { onClose: () => void }) => createElement("button", { onClick: onClose }, "close sealed export") }));
vi.mock("./SearchExpanded", () => {
  const blank = { files: [], messages: [], memories: [] };
  const flatten = (shown: typeof blank) => [...shown.files, ...shown.messages, ...shown.memories];
  return {
    DEFAULT_FILTERS: { sources: ["files", "messages", "memories"], kinds: [], when: "any", match: "any", sort: "best" },
    applyFindFilters: (results: typeof blank | null, filters: { sources: string[] }) => filters.sources.length === 0 ? blank : results ?? blank,
    flattenShown: flatten,
    highlightTerms: (query: string) => query.split(/\s+/),
    kindsPresentOf: () => new Set(["note"]),
    SearchFiltersBar: ({ onChange }: { onChange: (filters: unknown) => void }) => createElement("button", { onClick: () => onChange({ sources: [], kinds: [], when: "any", match: "any", sort: "best" }) }, "narrow search"),
    SearchIdlePanel: ({ onRunRecent, onRunSaved, onRemoveSaved, onClearRecent }: { onRunRecent: (query: string) => void; onRunSaved: (saved: { q: string; filters: unknown }) => void; onRemoveSaved: (query: string) => void; onClearRecent: () => void }) => createElement("div", null,
      createElement("button", { onClick: () => onRunRecent("recent") }, "run recent"),
      createElement("button", { onClick: () => onRunSaved({ q: "saved", filters: { sources: ["files"], kinds: [], when: "any", match: "any", sort: "best" } }) }, "run saved"),
      createElement("button", { onClick: () => onRemoveSaved("saved") }, "remove saved"),
      createElement("button", { onClick: onClearRecent }, "clear recent"),
    ),
    SearchQueryActions: ({ onToggleSaved, onAsk }: { onToggleSaved: () => void; onAsk: (question: string) => void }) => createElement("div", null,
      createElement("button", { onClick: onToggleSaved }, "toggle saved"),
      createElement("button", { onClick: () => onAsk("ask the room") }, "ask the room"),
    ),
    SearchResultRows: ({ shown, onOpenResult, onOpenFile, onSelectIndex }: { shown: typeof blank; onOpenResult: (result: unknown) => void; onOpenFile: (id: string) => void; onSelectIndex: (index: number) => void }) => createElement("div", null,
      flatten(shown).map((result: { id: string }, index: number) => createElement("button", { key: result.id, onMouseEnter: () => onSelectIndex(index), onClick: () => onOpenResult(result) }, `open ${result.id}`)),
      createElement("button", { onClick: () => onOpenFile("file-1") }, "open a file"),
    ),
    useRecentAndSaved: () => ({
      recent: ["recent"],
      saved: [{ q: "saved", filters: { sources: ["files"], kinds: [], when: "any", match: "any", sort: "best" } }],
      noteSearch: mocks.noteSearch,
      toggleSaved: mocks.toggleSaved,
      removeSaved: mocks.removeSaved,
      clearRecent: mocks.clearRecent,
    }),
  };
});

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  Event: globalThis.Event,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

afterEach(() => {
  vi.clearAllMocks();
  mocks.focusDeclines.length = 0;
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function file(id: string, name = `${id}.md`, folderId: string | null = null) {
  return { id, name, folderId, kind: "note", size: 1, modifiedAt: "2026-08-31T10:00:00Z" };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    dictState: "idle", dictOwner: null, dictPartial: "", recorderRef: { current: { stop: vi.fn() } }, dictStreamRef: { current: vi.fn() },
    showShortcuts: false, area: "files", webOn: true,
    mcpApprovals: [], browseConsents: [], editApprovals: [], scriptApprovals: [],
    ctxMenu: null, ctxMenuElRef: { current: null }, moveMenuFor: null, moveMenuElRef: { current: null }, confirmDelete: null, attachments: [], aiActionDefs: [], folders: [{ id: "folder-1", name: "Ideas" }],
    dragOver: false, showSearch: true, searchQuery: "report", searchError: "", searchSel: 0,
    searchResults: { files: [file("file-1")], messages: [{ id: "message-1" }], memories: [{ id: "memory-1" }] },
    files: [file("file-1"), file("file-2", "second.md", "folder-1")], recLive: null,
    setShowMap: vi.fn(), setShowWorkflows: vi.fn(), setShowScripts: vi.fn(), setOpenFile: vi.fn(), setShowSearch: vi.fn(),
    setSearchQuery: vi.fn(), setSearchSel: vi.fn(), setQuestion: vi.fn(), setCtxMenu: vi.fn(), setMoveMenuFor: vi.fn(),
    setRenamingFile: vi.fn(), setArea: vi.fn(), setLibraryTab: vi.fn(), setAiTab: vi.fn(), setShowSettings: vi.fn(),
    setShowShortcuts: vi.fn(), setShowFeedback: vi.fn(), setLinkUrl: vi.fn(), setShowAddLink: vi.fn(), pushToast: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

function actions(overrides: Record<string, unknown> = {}) {
  return {
    micState: () => ({ disabled: false }),
    newChat: vi.fn(), importFiles: vi.fn(), createNewNote: vi.fn(), startLiveRecording: vi.fn(), recordVoiceNote: vi.fn(),
    startDeepSummary: vi.fn(), revealBrowser: vi.fn(), openWorkflows: vi.fn(), openScripts: vi.fn(), revealMemory: vi.fn(),
    exportAllFiles: vi.fn(), handleLock: vi.fn(), resolveScriptApproval: vi.fn(), resolveMcpApproval: vi.fn(),
    resolveBrowseConsent: vi.fn(), resolveEditApproval: vi.fn(), alwaysAllowEdits: vi.fn(), viewFile: vi.fn(),
    toggleAttach: vi.fn(), attachFiles: vi.fn(), exportFiles: vi.fn(), exportOne: vi.fn(), openAiAction: vi.fn(),
    cancelConfirm: vi.fn(), askConfirm: vi.fn(), removeFiles: vi.fn(), removeFile: vi.fn(), moveFiles: vi.fn(),
    activateResult: vi.fn(), focusComposer: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

async function renderOverlays(s = state(), a = actions()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
  const originalAddEventListener = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, listener: (event: Record<string, unknown>) => void, options?: unknown) => {
    if (type === "keydown") listeners[type] = listener;
    return originalAddEventListener(type, listener as never, options as never);
  }) as never;
  const layout = { showPane: vi.fn(), togglePane: vi.fn(), toggleFocus: vi.fn(), applyPreset: vi.fn(), resetLayout: vi.fn() };
  const draw = async (next = s) => act(async () => {
    root.render(createElement(Overlays, { s: next as never, a: a as never, layout: layout as never }));
    await Promise.resolve();
  });
  await draw();
  return { a, document, draw, host, layout, listeners, root, s, window };
}

function prop(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

async function invoke(view: Awaited<ReturnType<typeof renderOverlays>>, element: Element, name = "onClick") {
  void view;
  await act(async () => prop(element, name)({ preventDefault: vi.fn(), stopPropagation: vi.fn(), target: element, currentTarget: element }));
}

async function clickText(view: Awaited<ReturnType<typeof renderOverlays>>, text: string) {
  const button = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  await invoke(view, button);
}

describe("Overlays", () => {
  it("keeps all approval, menu, capture, and palette actions wired", async () => {
    const s = state({
      dictState: "recording", dictOwner: "note", dictPartial: "partial transcript", dragOver: true, showShortcuts: true,
      scriptApprovals: [{ id: "script-1", name: "cleanup.py", interpreterLine: "python cleanup.py", deps: ["pandas"], inputs: ["notes.md"], outputs: ["summary.md"] }],
      mcpApprovals: [{ id: "mcp-1", tool: "search", server: "web", args: "{\"query\":\"report\"}" }],
      browseConsents: [{ id: "browse-1", field: "message", url: "https://example.com/path", text: "secret", entities: ["email"] }],
      editApprovals: [{ id: "edit-1", allowTurn: true, files: Array.from({ length: 6 }, (_, index) => ({ name: `edit-${index}.md`, before: "before", after: "after", clipped: false })) }, {}, {}],
      ctxMenu: { file: file("file-1"), files: [file("file-1"), file("file-2")], x: 10, y: 20 },
      moveMenuFor: { ids: ["file-1", "file-2"], x: 30, y: 40 },
      aiActionDefs: [{ id: "summarize", scope: "file", title: "Summarize", description: "Make a summary" }],
    });
    const view = await renderOverlays(s);
    expect(view.host.textContent).toContain("Voice note");
    expect(view.host.textContent).toContain("Run a script from this room?");
    expect(view.host.textContent).toContain("Drop to add to this room");
    for (const card of [...view.host.querySelectorAll(".approve-card")]) {
      await act(async () => prop(card, "onKeyDown")({ key: "Escape", stopPropagation: vi.fn() }));
    }
    for (const decline of mocks.focusDeclines) decline();
    view.listeners.keydown?.({ key: "Escape", stopPropagation: vi.fn() });
    const shortcutBackdrop = view.host.querySelector(".settings-backdrop");
    if (!shortcutBackdrop) throw new Error("shortcuts missing");
    await act(async () => prop(shortcutBackdrop, "onMouseDown")({ target: shortcutBackdrop, currentTarget: shortcutBackdrop }));
    await clickText(view, "Stop & save");
    expect(s.recorderRef.current.stop).toHaveBeenCalled();
    expect(s.dictStreamRef.current).toHaveBeenCalled();
    for (const label of ["Allow once", "Always allow this exact script", "Don't run", "Always allow this connector", "Don't allow", "Type it", "Don't", "Apply", "Apply for the rest", "Always allow in this room", "Don't apply", "Attach 2", "Move 2", "Export 2", "Summarize", "Remove 2", "No folder", "Ideas"]) {
      await clickText(view, label);
    }
    const menu = view.host.querySelector(".ctx-menu");
    if (!menu) throw new Error("context menu missing");
    await act(async () => prop(menu, "onKeyDown")({ key: "ArrowDown", preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    await act(async () => prop(menu, "onKeyDown")({ key: "ArrowUp", preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    await act(async () => prop(menu, "onKeyDown")({ key: "Home", preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    await act(async () => prop(menu, "onKeyDown")({ key: "End", preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    await act(async () => prop(menu, "onKeyDown")({ key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    const [contextBackdrop, moveBackdrop] = [...view.host.querySelectorAll(".ctx-backdrop")];
    if (!contextBackdrop) throw new Error("context backdrop missing");
    await invoke(view, contextBackdrop, "onContextMenu");
    await invoke(view, contextBackdrop, "onMouseDown");
    if (!moveBackdrop) throw new Error("move backdrop missing");
    await invoke(view, moveBackdrop, "onMouseDown");
    await invoke(view, moveBackdrop, "onContextMenu");
    const input = view.host.querySelector(".search-input");
    if (!input) throw new Error("search input missing");
    for (const key of ["ArrowDown", "ArrowUp", "Enter"]) {
      await act(async () => prop(input, "onKeyDown")({ key, preventDefault: vi.fn(), stopPropagation: vi.fn() }));
    }
    await act(async () => prop(input, "onChange")({ target: { value: "changed" } }));
    const resultButton = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "open file-1");
    if (!resultButton) throw new Error("search result missing");
    await invoke(view, resultButton, "onMouseEnter");
    await clickText(view, "open a file");
    const searchBackdrop = view.host.querySelector(".search-overlay");
    if (!searchBackdrop) throw new Error("search overlay missing");
    await act(async () => prop(searchBackdrop, "onMouseDown")({ target: searchBackdrop, currentTarget: searchBackdrop }));
    await view.draw(state({ showSearch: true, searchQuery: "", searchResults: null }));
    const newChat = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("New chat"));
    if (!newChat) throw new Error("new-chat command missing");
    await invoke(view, newChat, "onMouseEnter");
    await invoke(view, newChat);
    for (const button of [...view.host.querySelectorAll("button")].filter((candidate) => candidate.className.includes("search-result action"))) await invoke(view, button);
    await clickText(view, "close sealed export");
    await view.draw(s);
    await clickText(view, "open file-1");
    await clickText(view, "toggle saved");
    await clickText(view, "ask the room");
    await clickText(view, "narrow search");
    await Promise.resolve();
    expect(view.a.resolveScriptApproval).toHaveBeenCalled();
    expect(view.a.resolveMcpApproval).toHaveBeenCalled();
    expect(view.a.resolveBrowseConsent).toHaveBeenCalled();
    expect(view.a.resolveEditApproval).toHaveBeenCalled();
    expect(view.a.moveFiles).toHaveBeenCalled();
    expect(view.a.activateResult).toHaveBeenCalled();
  });

  it("renders the alternate consent, menu, search, and capture paths", async () => {
    const initial = state({ showSearch: false, dictState: "preparing" });
    const view = await renderOverlays(initial);
    expect(view.host.textContent).toContain("Preparing the microphone");
    await view.draw(state({ showSearch: false, dictState: "busy", dictOwner: "memory" }));
    expect(view.host.textContent).toContain("Spoken memory");
    await view.draw(state({
      showSearch: true, searchQuery: "none", searchError: "offline", searchResults: { files: [], messages: [], memories: [] },
      mcpApprovals: [{ id: "delete-1", tool: "connector", server: "web", confirm: "This cannot be undone." }],
      browseConsents: [{ id: "browse-2", field: "form", url: "not a url", text: "plain", entities: [] }],
      ctxMenu: { file: file("file-1"), files: [file("file-1")], x: 0, y: 0 }, attachments: [file("file-1")],
      moveMenuFor: { ids: ["file-1"], x: 0, y: 0 }, folders: [], confirmDelete: "ctx-remove-file-1",
    }));
    expect(view.host.textContent).toContain("This room could not be searched");
    expect(view.host.textContent).toContain("Delete the connector");
    expect(view.host.textContent).toContain("no list of protected details");
    await clickText(view, "Delete it");
    await clickText(view, "Keep it");
    await clickText(view, "Open");
    await clickText(view, "Detach from chat");
    await clickText(view, "Rename");
    await clickText(view, "Move to trash");
    await clickText(view, "Keep");
    await clickText(view, "Export a copy");
    expect(view.host.textContent).toContain("No folders yet");
    await view.draw(state({
      showSearch: false,
      ctxMenu: { file: file("file-1"), files: [file("file-1"), file("file-2")], x: 0, y: 0 },
      confirmDelete: "ctx-remove-file-1",
    }));
    await clickText(view, "Move to trash");
    await view.draw(state({ showSearch: true, searchQuery: "report", searchResults: { files: [file("file-1")], messages: [], memories: [] }, searchError: "" }));
    await clickText(view, "narrow search");
    expect(view.host.textContent).toContain("hidden by them");
    await clickText(view, "Clear filters");
    await view.draw(state({ showSearch: true, searchQuery: "", searchResults: null }));
    for (const label of ["run recent", "run saved", "remove saved", "clear recent"]) await clickText(view, label);
    expect(mocks.removeSaved).toHaveBeenCalledWith("saved");
    expect(mocks.clearRecent).toHaveBeenCalled();
  });
});
