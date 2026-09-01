import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import LibraryPane from "./Sidebar";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  displayName: vi.fn((name: string) => name.replace(/\.md$/, "")),
  libraryStatus: vi.fn((file: { linked?: boolean }) => ({ linked: file.linked ?? false })),
}));

vi.mock("../icons", () => ({
  CloseIcon: () => null, CollapseLeftIcon: () => null, CreateIcon: () => null, DownloadIcon: () => null,
  FolderIcon: () => null, GlobeIcon: () => null, LinkIcon: () => null, MemoryIcon: () => null,
  MicIcon: () => null, PaperclipIcon: () => null, PencilIcon: () => null, PlusIcon: () => null,
  ScriptIcon: () => null, BookOpenIcon: () => null, SearchIcon: () => null, TrashIcon: () => null,
  UndoIcon: () => null, WorkflowsIcon: () => null,
}));
vi.mock("./composer", () => ({ displayName: mocks.displayName, fileLabel: (name: string) => name }));
vi.mock("../api", () => ({
  isRecordingFile: (file: { kind?: string }) => file.kind === "recording",
  fileKindLabel: (file: { mimeType?: string }) => file.mimeType ?? "note",
}));
vi.mock("./DeleteControl", () => ({
  default: ({ k, onConfirm }: { k: string; onConfirm: () => void }) => createElement("button", { onClick: onConfirm }, `delete ${k}`),
}));
vi.mock("./FileRow", () => ({
  default: ({ f, a }: { f: { id: string; name: string }; a: { viewFile: (id: string) => void } }) => createElement("button", { className: "file-row", onClick: () => a.viewFile(f.id) }, f.name),
}));
vi.mock("./TrashPanel", () => ({ default: () => createElement("div", null, "trash panel") }));
vi.mock("./destinations", () => ({
  SIDEBAR_TITLES: { files: "Library", home: "Library", recordings: "Recordings", workflows: "Workflows", scripts: "Scripts", skills: "Skills", memory: "Memory", connectors: "Connectors", browser: "Private pages", sketch: "Sketches", create: "Creations", map: "Map" },
  newItemOf: (area: string) => ({ browser: "page", sketch: "sketch", create: "creation" } as Record<string, string>)[area] ?? "note",
  newItemLabel: (area: string) => ({ browser: "New page", sketch: "New sketch", create: "New creation" } as Record<string, string>)[area] ?? "New page",
}));
vi.mock("./fileVisibility", () => ({
  libraryFiles: (files: unknown[]) => files,
  libraryStatus: mocks.libraryStatus,
}));
vi.mock("./browserPages", () => ({
  pageAccessibleName: (page: { title: string }) => `Page: ${page.title}`,
  pageLabel: (page: { title: string }) => page.title,
  pageSubtitle: (page: { subtitle?: string }) => page.subtitle ?? "",
}));
vi.mock("./workflows/selectors", () => ({ visibleWorkflows: (workflows: Array<{ createdBy?: string }>) => workflows.filter((workflow) => workflow.createdBy !== "script") }));
vi.mock("./fileSort", () => ({
  FILE_SORTS: ["recent", "name"],
  FILE_SORT_LABELS: { recent: "Recent", name: "Name" },
  sortFiles: <T,>(files: T[]) => files,
}));

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  HTMLSelectElement: globalThis.HTMLSelectElement,
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

function file(id: string, name = `${id}.md`, extra: Record<string, unknown> = {}) {
  return { id, name, folderId: null, kind: "note", mimeType: "text/markdown", createdAt: "2026-08-31T10:00:00Z", aiSummary: null, ...extra };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    fileFilter: "match", fileSort: "recent", files: [file("file-1", "match.md"), file("file-2", "match-folder.md", { folderId: "folder-1" })],
    attachments: [file("file-1", "match.md")], trashed: [{ id: "trash-1" }], selectedTrashIds: new Set(["trash-1"]),
    libraryTab: "browse", addMenuOpen: true, webOn: true, recLive: null, mcpStatuses: [], scripts: [], skills: [], memories: [], workflows: [],
    folders: [{ id: "folder-1", name: "Folder" }], collapsedFolders: new Set<string>(), dragOverFolder: null, creatingFolder: "", renamingFolder: null, renamingFile: null,
    dragOver: false, confirmDelete: null, openFile: null, wfDetailId: null, selectedSkillId: null, jobs: [], jobProgress: {},
    setAddMenuOpen: vi.fn(), setSelectedTrashIds: vi.fn(), setLibraryTab: vi.fn(), setFileFilter: vi.fn(), setFileSort: vi.fn(),
    setVisibleFileOrder: vi.fn(), setSelectedFileIds: vi.fn(), setDragOverFolder: vi.fn(), setCreatingFolder: vi.fn(), setRenamingFolder: vi.fn(),
    setRenamingFile: vi.fn(), setCtxMenu: vi.fn(), setMoveMenuFor: vi.fn(), setLinkUrl: vi.fn(), setShowAddLink: vi.fn(), setSearchQuery: vi.fn(), setShowSearch: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

function actions(overrides: Record<string, unknown> = {}) {
  return {
    selectedFiles: vi.fn(() => [file("file-1"), file("file-2")]), clearSelection: vi.fn(), selectAllVisible: vi.fn(),
    attachFiles: vi.fn(), exportFiles: vi.fn(), removeFiles: vi.fn(), askConfirm: vi.fn(), cancelConfirm: vi.fn(),
    moveFiles: vi.fn(), commitCreateFolder: vi.fn(), toggleFolderCollapse: vi.fn(), commitFolderRename: vi.fn(), deleteFolder: vi.fn(),
    viewFile: vi.fn(), toggleAttach: vi.fn(), startLiveRecording: vi.fn(), recordVoiceNote: vi.fn(), importFiles: vi.fn(),
    createNewNote: vi.fn(), startCreateFolder: vi.fn(), dictateJournal: vi.fn(), micState: vi.fn(() => ({ disabled: false })),
    restoreFiles: vi.fn(), openWorkflows: vi.fn(), openWorkflowDetail: vi.fn(), openSkill: vi.fn(), openScratchPad: vi.fn(),
    commitRenameFile: vi.fn(), removeFile: vi.fn(), startDeepSummary: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

function pages(overrides: Record<string, unknown> = {}) {
  return {
    pages: [], activeId: null, move: vi.fn(), select: vi.fn(), close: vi.fn(),
    ...overrides,
  } as Record<string, any>;
}

async function renderSidebar(s = state(), a = actions(), pageApi = pages(), area = "files") {
  const parsed = parseHTML("<html><body><div class='pane-library'><div id='root'></div></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLSelectElement", window.HTMLSelectElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.HTMLElement.prototype.focus = vi.fn();
  const listeners: Array<(event: Record<string, unknown>) => void> = [];
  const nativeAdd = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, listener: (event: Record<string, unknown>) => void, options?: unknown) => {
    if (type === "keydown") listeners.push(listener);
    return nativeAdd(type, listener as never, options as never);
  }) as never;
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const layout = { collapsePane: vi.fn() };
  const onNewItem = vi.fn();
  const draw = async (next = s, nextArea = area, nextPages = pageApi) => act(async () => {
    root.render(createElement(LibraryPane, { s: next as never, a: a as never, layout: layout as never, area: nextArea as never, pages: nextPages as never, onNewItem }));
    await Promise.resolve();
  });
  await draw();
  return { a, document, draw, host, layout, listeners, onNewItem, pageApi, root, s, window };
}

function reactProp(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

async function invoke(element: Element, name = "onClick", event: Record<string, unknown> = {}) {
  await act(async () => reactProp(element, name)({ preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: element, target: element, ...event }));
}

async function clickText(view: Awaited<ReturnType<typeof renderSidebar>>, text: string) {
  const button = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  await invoke(button);
}

function dataTransfer(ids = "file-1\nfile-2") {
  return { dropEffect: "", getData: vi.fn(() => ids) };
}

describe("LibraryPane", () => {
  it("preserves the home library, selection, folder, filter, and add-menu actions", async () => {
    const s = state({
      creatingFolder: "New folder", renamingFolder: { id: "folder-1", name: "Folder" }, dragOverFolder: "__root__",
      setSelectedTrashIds: vi.fn((update: unknown) => typeof update === "function" && (update as (value: Set<string>) => Set<string>)(new Set(["trash-1", "gone"]))),
      setSelectedFileIds: vi.fn((update: unknown) => typeof update === "function" && (update as (value: Set<string>) => Set<string>)(new Set(["file-1", "gone"]))),
    });
    const view = await renderSidebar(s);
    expect(view.host.textContent).toContain("Library");
    const collapse = view.host.querySelector(".pane-icon-btn");
    if (!collapse) throw new Error("collapse button missing");
    await invoke(collapse);
    for (const label of ["Browse", "AI sources", "Trash", "Move", "Attach", "Export", "delete selection-remove", "Add page or source", "Upload files", "New page", "New folder", "Web link", "Live recording", "Voice note", "Speak a journal entry"]) await clickText(view, label);
    const clearFilter = view.host.querySelector(".side-search-clear");
    if (!clearFilter) throw new Error("clear filter button missing");
    await invoke(clearFilter);
    const addBackdrop = view.host.querySelector(".menu-backdrop");
    if (!addBackdrop) throw new Error("add backdrop missing");
    await invoke(addBackdrop, "onMouseDown");
    const search = view.host.querySelector("input[type='search']");
    const sort = view.host.querySelector("select");
    if (!search || !sort) throw new Error("library controls missing");
    await invoke(search, "onChange", { target: { value: "next" } });
    await invoke(sort, "onChange", { target: { value: "name" } });
    const folderInput = view.host.querySelector(".folder-rename");
    if (!folderInput) throw new Error("folder input missing");
    await invoke(folderInput, "onChange", { target: { value: "Renamed" } });
    await invoke(folderInput, "onKeyDown", { key: "Enter" });
    await invoke(folderInput, "onKeyDown", { key: "Escape" });
    const createFolder = view.host.querySelector(".folder-create-input");
    if (!createFolder) throw new Error("folder create input missing");
    await invoke(createFolder, "onChange", { target: { value: "Created" } });
    await invoke(createFolder, "onBlur");
    await invoke(createFolder, "onKeyDown", { key: "Enter" });
    await invoke(createFolder, "onKeyDown", { key: "Escape" });
    const scroll = view.host.querySelector(".library-scroll");
    const folderHead = view.host.querySelector(".folder-head");
    if (!scroll || !folderHead) throw new Error("drop targets missing");
    await invoke(scroll, "onDragOver", { dataTransfer: dataTransfer() });
    await invoke(scroll, "onDragLeave");
    await invoke(scroll, "onDrop", { dataTransfer: dataTransfer() });
    await invoke(folderHead, "onDragOver", { dataTransfer: dataTransfer() });
    await invoke(folderHead, "onDragLeave");
    await invoke(folderHead, "onDrop", { dataTransfer: dataTransfer() });
    const renameFolder = view.host.querySelector('[aria-label="Rename folder"]');
    if (!renameFolder) throw new Error("rename folder button missing");
    await invoke(renameFolder);
    await clickText(view, "delete folder:folder-1");
    for (const listener of view.listeners) listener({ key: "Escape", target: null, stopPropagation: vi.fn(), preventDefault: vi.fn() });
    Object.defineProperty(view.document, "activeElement", { configurable: true, value: view.host });
    for (const listener of view.listeners) listener({ key: "a", metaKey: true, ctrlKey: false, target: null, stopPropagation: vi.fn(), preventDefault: vi.fn() });
    expect(view.a.importFiles).toHaveBeenCalled();
    expect(view.a.moveFiles).toHaveBeenCalled();
    expect(view.a.clearSelection).toHaveBeenCalled();
  });

  it("renders source and trash panes and performs their row actions", async () => {
    const sourceState = state({ libraryTab: "sources", fileFilter: "", attachments: [file("file-1")], openFile: { id: "file-1" } });
    const view = await renderSidebar(sourceState);
    expect(view.host.textContent).toContain("Attached to the next question");
    const checkbox = view.host.querySelector("input[type='checkbox']");
    if (!checkbox) throw new Error("source checkbox missing");
    await invoke(checkbox, "onChange");
    await clickText(view, "match.md");
    await view.draw(state({ libraryTab: "trash", selectedTrashIds: new Set(["trash-1", "trash-2"]) }));
    expect(view.host.textContent).toContain("trash panel");
    await clickText(view, "Restore selected");
    expect(view.a.restoreFiles).toHaveBeenCalled();
  });

  it("keeps every destination lens and its navigation handlers active", async () => {
    const view = await renderSidebar(state({ fileFilter: "", files: [file("rec", "meeting.m4a", { kind: "recording" })] }), actions(), pages(), "recordings");
    await clickText(view, "New live recording");
    await clickText(view, "Voice note");
    await view.draw(state({ fileFilter: "", files: [] }), "recordings");
    expect(view.host.textContent).toContain("No recordings yet");
    await view.draw(state({ workflows: [{ id: "wf-1", name: "Research", status: "active", pinned: true, createdBy: "agent", emoji: "✨", binding: { scope: "file" } }], wfDetailId: "wf-1" }), "workflows");
    await clickText(view, "New workflow");
    await clickText(view, "Research");
    await view.draw(state({ workflows: [{ id: "wf-2", name: "Plain", status: "draft", pinned: false, createdBy: "user", binding: { scope: "general" } }] }), "workflows");
    expect(view.host.textContent).toContain("Plain");
    await view.draw(state({ scripts: [{ fileId: "script-1", name: "tool.py", approved: false, changedSinceApproval: true, shortcut: "global", lang: "py" }] }), "scripts");
    await clickText(view, "tool.py");
    await view.draw(state({ scripts: [{ fileId: "review", name: "review.js", approved: false, changedSinceApproval: false, shortcut: "room", lang: "js" }] }), "scripts");
    expect(view.host.textContent).toContain("Needs review");
    await view.draw(state({ skills: [{ id: "skill-1", name: "Research skill", description: "Find sources", enabled: true, resourceCount: 2, createdBy: "agent" }], selectedSkillId: "skill-1" }), "skills");
    await clickText(view, "Research skill");
    await view.draw(state({ memories: [{ category: "fact" }, { category: "project" }] }), "memory");
    await clickText(view, "Scratch pad");
    await view.draw(state({ mcpStatuses: [{ name: "Local tool", status: "connected", tools: [{}, {}], remote: false }] }), "connectors");
    expect(view.host.textContent).toContain("2 tools");
    const browserPages = pages({ pages: [{ id: "page-1", title: "Example", subtitle: "example.com" }, { id: "page-2", title: "Second" }], activeId: "page-1" });
    await view.draw(state(), "browser", browserPages);
    const headerNewPage = view.host.querySelector(".pane-new-btn");
    if (!headerNewPage) throw new Error("header new page button missing");
    await invoke(headerNewPage);
    const page = view.host.querySelector("[role='tab']");
    if (!page) throw new Error("browser page missing");
    await invoke(page, "onClick");
    await invoke(page, "onAuxClick", { button: 1 });
    for (const key of ["Enter", "Backspace", "ArrowDown"]) await invoke(page, "onKeyDown", { key });
    await invoke(page, "onDragStart");
    await invoke(page, "onDragOver", { dataTransfer: dataTransfer() });
    await invoke(page, "onDragEnd");
    const closePage = view.host.querySelector(".page-close");
    if (!closePage) throw new Error("close page button missing");
    await invoke(closePage);
    await view.draw(state({ fileFilter: "", files: [file("sketch-1", "drawing.sketch", { kind: "sketch", aiSummary: "A flow" })], renamingFile: { id: "sketch-1", name: "drawing.sketch", where: "library" } }), "sketch");
    const sketchRow = view.host.querySelector("[role='listitem']");
    const renameSketch = view.host.querySelector(".chip-btn");
    if (!sketchRow || !renameSketch) throw new Error("sketch actions missing");
    await invoke(sketchRow);
    await invoke(renameSketch);
    await clickText(view, "delete sketch:sketch-1");
    const newSketch = [...view.host.querySelectorAll(".area-nav-row")].find((button) => button.textContent?.includes("New sketch"));
    if (!newSketch) throw new Error("new sketch button missing");
    await invoke(newSketch);
    await view.draw(state({ files: [file("image-1", "picture.png", { originDestination: "create", mimeType: "image/png", linked: true })], jobs: [{ id: "run", kind: "create", status: "running", title: "Making" }, { id: "bad", kind: "create", status: "error", title: "Broken", error: "No model" }], jobProgress: { run: { label: "40%" } } }), "create");
    await clickText(view, "Images");
    await clickText(view, "picture.png");
    await view.draw(state({ files: [file("file-1"), file("sketch-1", "drawing.sketch", { kind: "sketch" })], folders: [{ id: "folder-1", name: "Folder" }] }), "map");
    await clickText(view, "Search this room");
    await clickText(view, "Summarize the room");
    expect(view.a.startDeepSummary).toHaveBeenCalled();
  });

  it("keeps empty, filtered, and alternate-status states honest", async () => {
    const view = await renderSidebar(state({ files: [], fileFilter: "none", folders: [], creatingFolder: null, renamingFolder: null }), actions());
    expect(view.host.textContent).toContain("Add PDFs");
    await view.draw(state({ files: [file("folder-1", "other.md")], fileFilter: "none", folders: [], collapsedFolders: new Set(), renamingFolder: null }), "files");
    expect(view.host.textContent).toContain("No files match");
    await view.draw(state({ files: [file("folder-1", "other.md")], fileFilter: "", folders: [{ id: "folder-1", name: "Folder" }], collapsedFolders: new Set(["folder-1"]), renamingFolder: null }), "files");
    const folderLabel = view.host.querySelector(".folder-label");
    if (!folderLabel) throw new Error("folder label missing");
    await invoke(folderLabel);
    await view.draw(state({ libraryTab: "sources", files: [], attachments: [], fileFilter: "missing" }), "files");
    expect(view.host.textContent).toContain("Scope: Whole room");
    expect(view.host.textContent).toContain("No files yet");
    await view.draw(state({ files: [], workflows: [] }), "workflows");
    expect(view.host.textContent).toContain("No workflows yet");
    await view.draw(state({ scripts: [] }), "scripts");
    expect(view.host.textContent).toContain("No scripts yet");
    await view.draw(state({ skills: [] }), "skills");
    expect(view.host.textContent).toContain("No skills yet");
    await view.draw(state({ mcpStatuses: [] }), "connectors");
    expect(view.host.textContent).toContain("No connectors yet");
    await view.draw(state({ memories: [] }), "memory");
    expect(view.host.textContent).toContain("Durable context");
    await view.draw(state({ files: [] }), "map");
    expect(view.host.textContent).toContain("Nothing to draw yet");
    const noPages = pages();
    await view.draw(state(), "browser", noPages);
    expect(view.host.textContent).toContain("No pages open");
    const newPage = [...view.host.querySelectorAll(".area-nav-row")].find((button) => button.textContent?.includes("New page"));
    if (!newPage) throw new Error("new page button missing");
    await invoke(newPage);
    await view.draw(state({ fileFilter: "", files: [file("sketch", "plain.sketch", { aiSummary: null, createdAt: "not-a-date" })], renamingFile: { id: "sketch", name: "plain.sketch", where: "library" } }), "sketch");
    const sketch = view.host.querySelector("[role='listitem']");
    const sketchRename = view.host.querySelector<HTMLInputElement>(".folder-rename");
    if (!sketch || !sketchRename) throw new Error("alternate sketch controls missing");
    await invoke(sketch, "onKeyDown", { key: "Enter" });
    await invoke(sketchRename, "onChange", { target: { value: "changed.sketch" } });
    await invoke(sketchRename, "onBlur");
    await invoke(sketchRename, "onKeyDown", { key: "Enter" });
    await invoke(sketchRename, "onKeyDown", { key: "Escape" });
    await view.draw(state({ scripts: [{ fileId: "script", name: "approved.js", approved: true, changedSinceApproval: false, shortcut: "room", lang: "js" }] }), "scripts");
    expect(view.host.textContent).toContain("Approved");
    await view.draw(state({ skills: [{ id: "skill", name: "Incomplete", description: "", enabled: false, resourceCount: 1, createdBy: "user" }] }), "skills");
    expect(view.host.textContent).toContain("Needs a description");
    await view.draw(state({ mcpStatuses: [{ name: "Disabled", status: "disabled", tools: [], remote: true }, { name: "Connecting", status: "connecting", tools: [], remote: false }, { name: "Failed", status: "failed", tools: [], error: "No bridge", remote: false }] }), "connectors");
    expect(view.host.textContent).toContain("No bridge");
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const sameYear = new Date(now.getFullYear(), (now.getMonth() + 6) % 12, 1, 12);
    const earlierYear = new Date(now.getFullYear() - 1, 0, 1, 12);
    await view.draw(state({ fileFilter: "", files: [
      file("today", "today.sketch", { createdAt: now.toISOString() }),
      file("yesterday", "yesterday.sketch", { createdAt: yesterday.toISOString() }),
      file("same-year", "same-year.sketch", { createdAt: sameYear.toISOString() }),
      file("earlier-year", "earlier-year.sketch", { createdAt: earlierYear.toISOString(), linked: true }),
    ] }), "sketch");
    expect(view.host.textContent).toContain("Started today");
    expect(view.host.textContent).toContain("Started yesterday");
    expect(view.host.textContent).toContain("In Library");
    await view.draw(state({ files: [], fileFilter: "" }), "sketch");
    expect(view.host.textContent).toContain("Nothing sketched yet");
    await view.draw(state({ files: [file("sketch", "plain.sketch")], fileFilter: "missing" }), "sketch");
    expect(view.host.textContent).toContain("No sketches match");
  });
});
