import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import ViewerPane from "./ViewerPane";

const { act, createElement } = React;

const { actions, encoding, visibility, frameSelection, composer } = vi.hoisted(() => ({
  actions: {
    exportOne: vi.fn(),
    setQuestion: vi.fn(),
    toggleFocus: vi.fn(),
    collapsePane: vi.fn(),
    importFiles: vi.fn(),
  },
  encoding: { useTextEncoding: vi.fn(() => ({ text: null, picker: null })) },
  visibility: { libraryStatus: vi.fn(() => null) },
  frameSelection: { frameSelectionOf: vi.fn(() => null) },
  composer: { provenanceLine: vi.fn(() => "") },
}));

vi.mock("../api", () => ({ formatSize: (bytes: number) => `${bytes} B` }));
vi.mock("../icons", () => ({
  BookOpenIcon: () => null,
  CloseIcon: () => null,
  CollapseLeftIcon: () => null,
  DotsIcon: () => null,
  DownloadIcon: () => null,
  EmptyViewerArt: () => null,
  EyeIcon: () => null,
  FocusIcon: () => null,
  LockIcon: () => null,
  MicIcon: () => null,
  PencilIcon: () => null,
  PlayIcon: () => null,
  PlusIcon: () => null,
  ScriptIcon: () => null,
  SendIcon: () => null,
  SparkIcon: () => null,
  TimeMachineIcon: () => null,
}));
vi.mock("../viewers/RoomMap", () => ({ default: () => createElement("div", null, "room map") }));
vi.mock("./composer", () => ({
  displayName: (name: string) => name,
  fileLabel: (name: string) => name,
  formatWhen: () => "now",
  provenanceLine: composer.provenanceLine,
}));
vi.mock("./fileVisibility", () => ({ libraryStatus: visibility.libraryStatus }));
vi.mock("./ViewerRouter", () => ({ default: () => createElement("div", { "data-testid": "viewer-router" }, "viewer router") }));
vi.mock("../viewers/CloudView", () => ({ default: () => createElement("div", { "data-testid": "cloud-view" }, "cloud preview") }));
vi.mock("../viewers/frameSelection", () => ({ frameSelectionOf: frameSelection.frameSelectionOf }));
vi.mock("../viewers/htmlText", () => ({ textOf: (text: string) => text }));
vi.mock("./FrontPage", () => ({ default: () => createElement("div", null, "front page") }));
vi.mock("./MemoryView", () => ({ default: () => createElement("div", null, "memory") }));
vi.mock("./RecordingsPage", () => ({ default: () => createElement("div", null, "recordings") }));
vi.mock("../viewers/TextEncoding", () => ({ useTextEncoding: encoding.useTextEncoding }));
vi.mock("./ReaderShell", () => ({
  DocSourceCard: () => createElement("div", null, "source"),
  READER_KINDS: new Set(["prose", "markdown"]),
  ReadingProgress: () => createElement("div", null, "progress"),
  useReadingProgress: () => ({ progress: 0, ref: null }),
}));
vi.mock("./quoteSelection", () => ({
  inExcludedSurface: () => false,
  inQuotableDocument: () => true,
  quotableText: (text: string) => text.trim() || null,
  searchableDocument: () => ({}),
  verifiedFrameQuote: (text: string) => text,
  withQuote: (question: string, quote: string) => `${question}${quote}`,
}));
vi.mock("./markup", () => ({
  isCloudRoute: () => false,
  isModelReady: () => true,
  trustState: () => ({ tone: "good", title: "Nothing leaves the device" }),
}));
vi.mock("./ConnectorsView", () => ({ default: () => createElement("div", null, "connectors") }));
vi.mock("./BrowserView", () => ({ BrowserView: ({ onAsk }: { onAsk: (query: string) => void }) => createElement("button", { onClick: () => onAsk("browser question") }, "browser") }));
vi.mock("./workflows/WorkflowsPage", () => ({ WorkflowsPage: () => createElement("div", null, "workflows") }));
vi.mock("./workflows/workflowGlyph", () => ({ WorkflowGlyph: () => null }));
vi.mock("./scripts/ScriptsPage", () => ({ ScriptsPage: () => createElement("div", null, "scripts") }));
vi.mock("./skills/SkillsView", () => ({ default: () => createElement("div", null, "skills") }));
vi.mock("./create/CreatePage", () => ({ CreatePage: () => createElement("div", null, "create") }));
vi.mock("./QuickActions", () => ({
  QuickActionsMenu: ({ actions: quickActions }: { actions: Array<{ id: string; label: string; onRun: () => void }> }) => createElement("div", null, quickActions.map((action) => createElement("button", { key: action.id, onClick: action.onRun }, action.label))),
  bindingMatches: () => true,
}));

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  Event: globalThis.Event,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

afterEach(() => {
  vi.clearAllMocks();
  visibility.libraryStatus.mockReturnValue(null);
  frameSelection.frameSelectionOf.mockReturnValue(null);
  composer.provenanceLine.mockReturnValue("");
  encoding.useTextEncoding.mockReturnValue({ text: null, picker: null });
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function workspaceState(openFile: unknown, overrides: Record<string, unknown> = {}) {
  const base = {
    openFile,
    openFileRef: { current: openFile },
    files: [{ id: "file-1", name: "note.txt", folderId: null, aiSummary: null }],
    folders: [],
    scripts: [],
    workflows: [],
    jobProgress: {},
    asking: false,
    qaScriptMenuOpen: false,
    qaFileMenuOpen: false,
    showHistory: false,
    showWorkflows: false,
    showScripts: false,
    showMap: false,
    editMode: false,
    editorDirtyRef: { current: false },
    editorSaveRef: { current: null },
    viewerRev: 0,
    recLive: null,
    recSave: null,
    sttStatus: null,
    staleFile: null,
    openingFileId: null,
    renamingFile: null,
    headProvenance: null,
    versions: [],
    versionsKept: 10,
    confirmRestore: null,
    dictOwner: null,
    dictState: null,
    question: "",
    model: "",
    ai: null,
    privacyOn: true,
    webOn: false,
    mcpTools: [],
    fp: null,
    browseConsents: [],
    mcpApprovals: [],
    editApprovals: [],
    scriptApprovals: [],
    showSearch: false,
    showSettings: false,
    showShortcuts: false,
    showFeedback: false,
    showAddLink: false,
    aiPrompt: null,
    studioPrompt: null,
    compare: null,
    ctxMenu: null,
    summaryStarting: false,
    jobs: [],
    setShowHistory: vi.fn(),
    setShowMap: vi.fn(),
    setShowScripts: vi.fn(),
    setShowWorkflows: vi.fn(),
    setArea: vi.fn(),
    setLibraryTab: vi.fn(),
    setConfirmRestore: vi.fn(),
    setEditMode: vi.fn(),
    setRenamingFile: vi.fn(),
    setQuestion: actions.setQuestion,
    setOpenFile: vi.fn(),
    setStaleFile: vi.fn(),
    setQaScriptMenuOpen: vi.fn(),
    setQaFileMenuOpen: vi.fn(),
    pushToast: vi.fn(),
  };
  return { ...base, ...overrides, openFile, openFileRef: { current: openFile } } as never;
}

function workspaceActions(overrides: Record<string, unknown> = {}) {
  return {
    editModeOf: () => "editor",
    exportOne: actions.exportOne,
    commitRenameFile: vi.fn(),
    runScript: vi.fn(),
    makeMinutes: vi.fn(),
    exportSketchAs: vi.fn(),
    runWorkflowOn: vi.fn(),
    duplicateOpenFile: vi.fn(),
    copyAllText: vi.fn(),
    dictateIntoFile: vi.fn(),
    micState: () => ({ cls: "", disabled: false }),
    openHistory: vi.fn(),
    deleteVersion: vi.fn(),
    restoreVersion: vi.fn(),
    openCompare: vi.fn(),
    pinVersion: vi.fn(),
    guardLeave: vi.fn(),
    viewFile: vi.fn(),
    toggleAttach: vi.fn(),
    importFiles: actions.importFiles,
    startDeepSummary: vi.fn(),
    focusComposer: vi.fn(),
    setInLibrary: vi.fn(),
    createSketch: vi.fn(),
    ...overrides,
  } as never;
}

async function renderPane(openFile: unknown, stateOverrides: Record<string, unknown> = {}, area = "files", actionOverrides: Record<string, unknown> = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const layout = { showPane: vi.fn(), toggleFocus: actions.toggleFocus, collapsePane: actions.collapsePane };
  await act(async () => {
    root.render(createElement(ViewerPane, {
      s: workspaceState(openFile, stateOverrides),
      a: workspaceActions(actionOverrides),
      info: { name: "Room", path: "/tmp/Room" } as never,
      layout: layout as never,
      area: area as never,
    }));
  });
  return { host, root, window };
}

describe("ViewerPane", () => {
  it("renders an open file and preserves the header actions", async () => {
    const openFile = {
      id: "file-1",
      content: {
        kind: "text",
        name: "note.txt",
        mime: "text/plain",
        editable: true,
        text: "hello",
        dataB64: null,
        mediaToken: null,
        mediaMeta: null,
        webMeta: null,
      },
    };
    const { host, root, window } = await renderPane(openFile);

    expect(host.querySelector('[data-testid="viewer-router"]')).not.toBeNull();
    expect(host.textContent).toContain("note.txt");
    const exportButton = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Export"));
    await act(async () => exportButton?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(actions.exportOne).toHaveBeenCalledWith("file-1", "note.txt");
    await act(async () => root.unmount());
  });

  it("keeps overflow, history, and editor-specific actions available", async () => {
    (encoding.useTextEncoding as never as { mockReturnValue: (value: unknown) => void }).mockReturnValue({ text: "print('ok')", picker: createElement("span", null, "encoding") });
    const openFile = {
      id: "file-1",
      content: { kind: "code", name: "script.py", mime: "text/x-python", editable: true, text: "print('ok')", dataB64: null, mediaToken: null, mediaMeta: null, webMeta: null },
    };
    const version = { id: "v1", cause: "Saved", pinned: true, provenance: null, savedAt: 1, bytes: 3 };
    composer.provenanceLine.mockReturnValue("Saved locally");
    const { host, root, window } = await renderPane(openFile, { showHistory: true, versions: [version], headProvenance: null });
    const overflow = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "More actions on this file");
    await act(async () => overflow?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(host.textContent).toContain("Show me exactly what would be sent");
    expect(host.textContent).toContain("Duplicate");
    expect(host.textContent).toContain("Copy all text");
    expect(host.textContent).toContain("Dictate");
    expect(host.textContent).toContain("Saved");
    expect(host.textContent).toContain("encoding");
    const review = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Review script"));
    await act(async () => review?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const rename = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Rename this file");
    await act(async () => rename?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const input = host.querySelector<HTMLInputElement>(".file-rename-input");
    const enter = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    await act(async () => input?.dispatchEvent(enter));
    const deleteVersion = [...host.querySelectorAll("button")].find((button) => button.title.startsWith("Delete this saved version"));
    await act(async () => deleteVersion?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const cancelDelete = [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
    await act(async () => cancelDelete?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const restoreVersion = [...host.querySelectorAll("button")].find((button) => button.textContent === "Restore");
    await act(async () => restoreVersion?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const cancelRestore = [...host.querySelectorAll("button")].find((button) => button.textContent === "Cancel");
    await act(async () => cancelRestore?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const escape = new window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => window.dispatchEvent(escape));
    await act(async () => root.unmount());
  });

  it("offers section promotion and linked-library navigation", async () => {
    const openFile = {
      id: "file-1",
      content: { kind: "text", name: "note.txt", mime: "text/plain", editable: true, text: "hello", dataB64: null, mediaToken: null, mediaMeta: null, webMeta: null },
    };
    (visibility.libraryStatus as never as { mockReturnValue: (value: unknown) => void }).mockReturnValue({ linked: false, label: "Section only", where: "Sketches" });
    const section = await renderPane(openFile);
    expect(section.host.textContent).toContain("Add to Library");
    const add = [...section.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add to Library"));
    await act(async () => add?.dispatchEvent(new section.window.Event("click", { bubbles: true })));
    expect(section.host.textContent).toContain("Add to Library?");
    const confirm = [...section.host.querySelectorAll("button")].find((button) => button.textContent === "Add");
    await act(async () => confirm?.dispatchEvent(new section.window.Event("click", { bubbles: true })));
    await act(async () => section.root.unmount());

    (visibility.libraryStatus as never as { mockReturnValue: (value: unknown) => void }).mockReturnValue({ linked: true, label: "In Library", where: "Sketches" });
    const linked = await renderPane(openFile);
    const status = [...linked.host.querySelectorAll("button")].find((button) => button.textContent?.includes("In Library"));
    await act(async () => status?.dispatchEvent(new linked.window.Event("click", { bubbles: true })));
    expect(linked.host.textContent).toContain("View in Library");
    expect(linked.host.textContent).toContain("Remove from Library");
    const view = [...linked.host.querySelectorAll("button")].find((button) => button.textContent === "View in Library");
    await act(async () => view?.dispatchEvent(new linked.window.Event("click", { bubbles: true })));
    await act(async () => status?.dispatchEvent(new linked.window.Event("click", { bubbles: true })));
    const freshRemove = [...linked.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Remove from Library"));
    await act(async () => freshRemove?.dispatchEvent(new linked.window.Event("click", { bubbles: true })));
    await act(async () => linked.root.unmount());
  });

  it("renders reader source and switches to the cloud payload preview", async () => {
    const openFile = {
      id: "file-1",
      content: { kind: "prose", name: "article.md", mime: "text/markdown", editable: true, text: "article", dataB64: null, mediaToken: null, mediaMeta: null, webMeta: null },
    };
    const { host, root, window } = await renderPane(openFile);
    expect(host.textContent).toContain("source");
    const overflow = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "More actions on this file");
    await act(async () => overflow?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const cloud = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Show me exactly"));
    await act(async () => cloud?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(host.querySelector('[data-testid="cloud-view"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("quotes verified document and saved-page selections", async () => {
    const openFile = {
      id: "file-1",
      content: { kind: "text", name: "note.txt", mime: "text/plain", editable: true, text: "quoted text", dataB64: null, mediaToken: null, mediaMeta: null, webMeta: null },
    };
    const plain = await renderPane(openFile);
    const selection = {
      anchorNode: plain.host,
      focusNode: plain.host,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "quoted text",
      getRangeAt: () => ({ getBoundingClientRect: () => ({ width: 10, height: 4, top: 2, left: 3 }) }),
      removeAllRanges: vi.fn(),
    };
    Object.defineProperty(plain.window, "getSelection", { value: () => selection });
    Reflect.set(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Reflect.set(globalThis, "cancelAnimationFrame", () => undefined);
    await act(async () => plain.window.document.dispatchEvent(new plain.window.Event("selectionchange")));
    const quote = plain.host.querySelector<HTMLButtonElement>(".quote-selection-btn");
    expect(quote?.textContent).toContain("Quote in chat");
    await act(async () => quote?.dispatchEvent(new plain.window.Event("mousedown", { bubbles: true })));
    expect(actions.setQuestion).toHaveBeenCalled();
    await act(async () => plain.root.unmount());

    const htmlFile = { ...openFile, content: { ...openFile.content, kind: "html", name: "saved.html" } };
    (encoding.useTextEncoding as never as { mockReturnValue: (value: unknown) => void }).mockReturnValue({ text: "quoted text", picker: null });
    (frameSelection.frameSelectionOf as never as { mockReturnValue: (value: unknown) => void }).mockReturnValue({ text: "quoted text", rect: { top: 1, left: 2, width: 3 } });
    const framed = await renderPane(htmlFile);
    const frame = framed.window.document.createElement("iframe");
    Object.defineProperty(frame, "contentWindow", { value: framed.window });
    Object.defineProperty(frame, "getBoundingClientRect", { value: () => ({ top: 10, left: 20 }) });
    framed.window.document.body.append(frame);
    const message = new framed.window.Event("message");
    Object.defineProperty(message, "data", { value: { kind: "frame-selection" } });
    Object.defineProperty(message, "source", { value: framed.window });
    await act(async () => framed.window.dispatchEvent(message));
    expect(framed.host.querySelector(".quote-selection-btn")).not.toBeNull();
    await act(async () => framed.root.unmount());
  });

  it("executes media, sketch, stale-file, and file-scoped quick actions", async () => {
    const audio = {
      id: "file-1",
      content: { kind: "audio", name: "meeting.m4a", mime: "audio/mp4", editable: true, text: "[0:01] hello", dataB64: null, mediaToken: null, mediaMeta: null, webMeta: null },
    };
    const media = await renderPane(audio, { staleFile: "file-1", openingFileId: "other-file" });
    expect(media.host.textContent).toContain("Opening…");
    const minutes = [...media.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Minutes"));
    const load = [...media.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Load AI version"));
    await act(async () => minutes?.dispatchEvent(new media.window.Event("click", { bubbles: true })));
    await act(async () => load?.dispatchEvent(new media.window.Event("click", { bubbles: true })));
    await act(async () => media.root.unmount());

    const sketch = {
      id: "file-1",
      content: { kind: "sketch", name: "drawing.sketch", mime: "application/json", editable: true, text: "{}", dataB64: null, mediaToken: null, mediaMeta: null, webMeta: null },
    };
    const quick = await renderPane(sketch, {
      scripts: [{ fileId: "script-2", name: "related", inputs: ["drawing.sketch"], outputs: [] }],
      workflows: [{ id: "workflow-1", name: "related workflow", status: "active", binding: {}, emoji: "⚡" }],
    });
    for (const label of ["related", "Save a picture (PNG) in this room", "Save a drawing (SVG) in this room", "related workflow"]) {
      const button = [...quick.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
      await act(async () => button?.dispatchEvent(new quick.window.Event("click", { bubbles: true })));
    }
    await act(async () => quick.root.unmount());

    const copy = await renderPane(sketch, {}, "files", { editModeOf: () => "copy" });
    expect(copy.host.textContent).toContain("Edit as text");
    await act(async () => copy.root.unmount());
    const docx = await renderPane(sketch, {}, "files", { editModeOf: () => "docx" });
    expect(docx.host.textContent).toContain("Edit");
    await act(async () => docx.root.unmount());
  });

  it("covers guarded file controls and both history confirmations", async () => {
    const openFile = {
      id: "file-1",
      content: { kind: "code", name: "guarded.py", mime: "text/x-python", editable: true, text: "print(1)", dataB64: null, mediaToken: null, mediaMeta: null, webMeta: null },
    };
    const version = { id: "v1", cause: "Saved", pinned: false, provenance: null, savedAt: 1, bytes: 3 };
    const state = {
      showHistory: true,
      versions: [version],
      renamingFile: { id: "file-1", name: "guarded.py", where: "viewer" },
      editMode: true,
      editorDirtyRef: { current: true },
      files: [{ id: "file-1", name: "guarded.py", folderId: null, aiSummary: "A guarded script" }],
    };
    const guarded = await renderPane(openFile, state);
    expect(guarded.host.textContent).toContain("A guarded script");
    const input = guarded.host.querySelector<HTMLInputElement>(".file-rename-input");
    const enter = new guarded.window.Event("keydown", { bubbles: true });
    Object.defineProperty(enter, "key", { value: "Enter" });
    await act(async () => input?.dispatchEvent(enter));
    const escape = new guarded.window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => input?.dispatchEvent(escape));
    const review = [...guarded.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Review script"));
    await act(async () => review?.dispatchEvent(new guarded.window.Event("click", { bubbles: true })));
    const overflow = [...guarded.host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "More actions on this file");
    await act(async () => overflow?.dispatchEvent(new guarded.window.Event("click", { bubbles: true })));
    const duplicate = [...guarded.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Duplicate"));
    await act(async () => duplicate?.dispatchEvent(new guarded.window.Event("click", { bubbles: true })));
    await act(async () => overflow?.dispatchEvent(new guarded.window.Event("click", { bubbles: true })));
    const copy = [...guarded.host.querySelectorAll("button")].find((button) => button.textContent === "Copy all text");
    await act(async () => copy?.dispatchEvent(new guarded.window.Event("click", { bubbles: true })));
    const deleteVersion = [...guarded.host.querySelectorAll("button")].find((button) => button.title.startsWith("Delete this saved version"));
    await act(async () => deleteVersion?.dispatchEvent(new guarded.window.Event("click", { bubbles: true })));
    const confirmDelete = [...guarded.host.querySelectorAll("button")].find((button) => button.textContent === "Delete");
    await act(async () => confirmDelete?.dispatchEvent(new guarded.window.Event("click", { bubbles: true })));
    await act(async () => guarded.root.unmount());

    const restore = await renderPane(openFile, { ...state, confirmRestore: "v1" });
    const confirmRestore = [...restore.host.querySelectorAll("button")].find((button) => button.textContent === "Restore");
    await act(async () => confirmRestore?.dispatchEvent(new restore.window.Event("click", { bubbles: true })));
    await act(async () => restore.root.unmount());

    const markdown = await renderPane({ ...openFile, content: { ...openFile.content, kind: "markdown", name: "reader.md" } });
    expect(markdown.host.textContent).toContain("progress");
    await act(async () => markdown.root.unmount());
  });

  it("selects every area surface when no file is open", async () => {
    const examples = [
      ["browser", "browser"], ["connectors", "connectors"], ["skills", "skills"],
      ["memory", "memory"], ["recordings", "recordings"], ["create", "create"],
      ["sketch", "New sketch"], ["files", "Your room is sealed"],
    ] as const;
    for (const [area, expected] of examples) {
      const { host, root } = await renderPane(null, {}, area);
      expect(host.textContent).toContain(expected);
      if (area === "browser") {
        const browser = [...host.querySelectorAll("button")].find((button) => button.textContent === "browser");
        await act(async () => browser?.dispatchEvent(new Event("click", { bubbles: true })));
      }
      await act(async () => root.unmount());
    }
    const workflow = await renderPane(null, { showWorkflows: true });
    expect(workflow.host.textContent).toContain("workflows");
    await act(async () => workflow.root.unmount());
    const script = await renderPane(null, { showScripts: true });
    expect(script.host.textContent).toContain("scripts");
    await act(async () => script.root.unmount());
    const map = await renderPane(null, { showMap: true });
    expect(map.host.textContent).toContain("room map");
    await act(async () => map.root.unmount());
  });
});
