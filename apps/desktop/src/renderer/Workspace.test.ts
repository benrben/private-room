import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activityRail: null as null | Record<string, any>,
  actions: {} as Record<string, any>,
  browserError: null as null | ((message: string) => void),
  closeWindow: vi.fn(),
  confirm: vi.fn(),
  customizeSidebar: null as null | Record<string, any>,
  fileKindLabel: vi.fn(),
  nativeMenu: null as null | Record<string, any>,
  newItemOf: vi.fn(),
  pages: {} as Record<string, any>,
  quitGuardConfirm: vi.fn(),
  quitGuardRearm: vi.fn(),
  quitRequested: null as null | (() => Promise<void>),
  registerWorkspaceCopy: vi.fn(),
  setUnsavedEdits: vi.fn(),
  state: {} as Record<string, any>,
  statusBar: null as null | Record<string, any>,
  tabStrip: null as null | Record<string, any>,
  tabs: {} as Record<string, any>,
  topBar: null as null | Record<string, any>,
}));

vi.mock("./platform", () => ({ closeWindow: mocks.closeWindow, confirm: mocks.confirm }));
vi.mock("./api", () => ({
  api: {
    getSetting: vi.fn(() => Promise.resolve(null)),
    onQuitRequested: vi.fn((listener: () => Promise<void>) => {
      mocks.quitRequested = listener;
      return Promise.resolve(() => {});
    }),
    quitGuardConfirm: mocks.quitGuardConfirm,
    quitGuardRearm: mocks.quitGuardRearm,
    registerWorkspaceCopy: mocks.registerWorkspaceCopy,
    setSetting: vi.fn(() => Promise.resolve()),
    setUnsavedEdits: mocks.setUnsavedEdits,
  },
  fileKindLabel: mocks.fileKindLabel,
}));
vi.mock("./workspace/tabs", () => ({ tabId: (kind: string, ref: string) => `${kind}:${ref}`, useTabs: () => mocks.tabs }));
vi.mock("./workspace/browserPages", () => ({
  useBrowserPages: (_enabled: boolean, _active: boolean, onError: (message: string) => void) => {
    mocks.browserError = onError;
    return mocks.pages;
  },
}));
vi.mock("./workspace/destinations", () => ({
  newItemOf: mocks.newItemOf,
  showsDocumentTabs: (area: string) => area === "files" || area === "home",
  sidebarMenuLabel: () => "Sidebar",
  sidebarRegionLabel: () => "Library",
}));
vi.mock("./workspace/fileVisibility", () => ({ libraryFiles: (files: unknown[]) => files }));
vi.mock("./workspace/composer", () => ({ fileLabel: (name: string) => name }));
vi.mock("./workspace/state", () => ({ useWorkspaceState: () => mocks.state }));
vi.mock("./workspace/actions", () => ({ useWorkspaceActions: () => mocks.actions }));
vi.mock("./workspace/effects", () => ({ useWorkspaceEffects: () => {} }));
vi.mock("./shell/useLayout", () => ({ useLayout: () => ({
  dragging: false,
  gridRef: { current: null },
  gridStyle: {},
  setFocusedPage: vi.fn(),
  showPane: vi.fn(),
  visible: ["library", "center", "ai"],
}) }));
vi.mock("./shell/useNativeMenu", () => ({
  useNativeMenu: (_layout: unknown, _title: string, handlers: Record<string, any>) => {
    mocks.nativeMenu = handlers;
  },
}));
vi.mock("./shell/activity", () => ({ pendingApprovalCount: () => 0, runningJobCount: () => 0 }));
vi.mock("./workspace/markup", () => ({ isCloudRoute: () => false }));

vi.mock("./workspace/Overlays", () => ({ default: () => null }));
vi.mock("./workspace/TopBar", () => ({
  default: (props: Record<string, any>) => {
    mocks.topBar = props;
    return null;
  },
}));
vi.mock("./workspace/StudioModal", () => ({ default: () => null }));
vi.mock("./workspace/CompareModal", () => ({ default: () => null }));
vi.mock("./workspace/UnsavedEditsDialog", () => ({ default: () => null }));
vi.mock("./workspace/AiActionModal", () => ({ default: () => null }));
vi.mock("./workspace/FeedbackModal", () => ({ default: () => null }));
vi.mock("./workspace/SettingsModals", () => ({ default: () => null }));
vi.mock("./workspace/Sidebar", () => ({ default: () => null }));
vi.mock("./workspace/ViewerPane", () => ({ default: () => null }));
vi.mock("./workspace/AiPane", () => ({ default: () => null }));
vi.mock("./workspace/Toasts", () => ({ default: () => null }));
vi.mock("./shell/ActivityRail", () => ({
  default: (props: Record<string, any>) => {
    mocks.activityRail = props;
    return null;
  },
}));
vi.mock("./shell/CustomizeSidebar", () => ({
  default: (props: Record<string, any>) => {
    mocks.customizeSidebar = props;
    return null;
  },
}));
vi.mock("./shell/Splitter", () => ({ default: () => null }));
vi.mock("./shell/StatusBar", () => ({
  default: (props: Record<string, any>) => {
    mocks.statusBar = props;
    return null;
  },
}));
vi.mock("./shell/ErrorBoundary", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./shell/TabStrip", () => ({
  default: (props: Record<string, any>) => {
    mocks.tabStrip = props;
    return null;
  },
}));

import Workspace from "./Workspace";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

interface FixtureOptions {
  activeTabId?: string;
  area?: string;
  duplicateRoomIdentity?: boolean;
  files?: Array<{ hasText?: boolean; id: string; libraryVisibility?: string; name?: string }>;
  openFileId?: string;
  readOnly?: boolean;
  showMap?: boolean;
  showScripts?: boolean;
  showWorkflows?: boolean;
  webOn?: boolean;
}

function resetFixture(overrides: FixtureOptions = {}) {
  const guardLeave = vi.fn((_what: string, proceed: () => void) => proceed());
  mocks.actions = {
    createNewNote: vi.fn(),
    createSketch: vi.fn(),
    engineLabelOf: vi.fn(() => "Local"),
    guardLeave,
    handleLock: vi.fn(),
    openScripts: vi.fn(),
    openWorkflows: vi.fn(),
    viewFile: vi.fn(),
  };
  mocks.closeWindow.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.browserError = null;
  mocks.quitGuardConfirm.mockReset().mockResolvedValue(undefined);
  mocks.quitGuardRearm.mockReset().mockResolvedValue(undefined);
  mocks.quitRequested = null;
  mocks.setUnsavedEdits.mockReset().mockResolvedValue(undefined);
  mocks.fileKindLabel.mockReset().mockReturnValue("text");
  mocks.newItemOf.mockReset().mockReturnValue(null);
  mocks.pages = { activeId: "", close: vi.fn(), open: vi.fn() };
  mocks.tabs = {
    active: null,
    activeId: overrides.activeTabId ?? "",
    activate: vi.fn(),
    activateIndex: vi.fn(),
    close: vi.fn(),
    open: vi.fn(),
    restored: false,
    retitle: vi.fn(),
    step: vi.fn(),
    tabs: [
      { id: "file:gone", kind: "file", ref: "gone", title: "Gone" },
      { id: "file:live", kind: "file", ref: "live", title: "Live" },
    ],
    unlist: vi.fn(),
  };
  mocks.state = {
    ai: "",
    area: overrides.area ?? "files",
    bumpNewCreation: vi.fn(),
    dismissToast: vi.fn(),
    editModeRef: { current: false },
    editorDirtyRef: { current: false },
    files: overrides.files ?? [{ id: "live", name: "Live" }],
    mcpTools: [],
    model: "",
    openFile: overrides.openFileId ? { id: overrides.openFileId, content: { kind: "text" } } : null,
    openFileRef: { current: overrides.openFileId ? { id: overrides.openFileId } : null },
    privacyOn: false,
    pushToast: vi.fn(),
    scripts: [],
    setAiTab: vi.fn(),
    setArea: vi.fn(),
    setOpenFile: vi.fn(),
    setSettingsSection: vi.fn(),
    setShowMap: vi.fn(),
    setShowMemoryIntro: vi.fn(),
    setShowScripts: vi.fn(),
    setShowSettings: vi.fn(),
    setShowWorkflows: vi.fn(),
    showFeedback: false,
    showMap: overrides.showMap ?? false,
    showScripts: overrides.showScripts ?? false,
    showWorkflows: overrides.showWorkflows ?? false,
    toasts: [],
    webOn: overrides.webOn ?? true,
  };
  mocks.activityRail = null;
  mocks.customizeSidebar = null;
  mocks.nativeMenu = null;
  mocks.registerWorkspaceCopy.mockResolvedValue({ name: "Registered" });
  mocks.statusBar = null;
  mocks.tabStrip = null;
  mocks.topBar = null;
  return {
    guardLeave,
    info: {
      duplicateRoomIdentity: overrides.duplicateRoomIdentity,
      name: "Room",
      path: "/room",
      readOnly: overrides.readOnly ?? false,
    },
    viewFile: mocks.actions.viewFile as ReturnType<typeof vi.fn>,
  };
}

function nativeMenuActions() {
  if (!mocks.nativeMenu) throw new Error("native menu did not receive workspace actions");
  return mocks.nativeMenu;
}

function topBarActions() {
  const actions = mocks.topBar?.a;
  if (!actions) throw new Error("top bar did not receive workspace actions");
  return actions;
}

async function renderWorkspace(options: FixtureOptions = {}) {
  const fixture = resetFixture(options);
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
  await act(async () => {
    root.render(createElement(Workspace, {
      info: fixture.info as never,
      onLock: async () => {},
    }));
    await Promise.resolve();
  });
  const rerender = async () => {
    await act(async () => {
      root.render(createElement(Workspace, { info: fixture.info as never, onLock: async () => {} }));
      await Promise.resolve();
    });
  };
  return { ...fixture, rerender, root, window };
}

async function key(view: Awaited<ReturnType<typeof renderWorkspace>>, options: Record<string, unknown>) {
  const event = new view.window.Event("keydown", { bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  for (const [name, value] of Object.entries(options)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  await act(async () => {
    view.window.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

async function openRailArea(area: string): Promise<void> {
  const openArea = mocks.activityRail?.onArea as ((next: string) => void) | undefined;
  if (openArea === undefined) throw new Error("activity rail did not receive its area callback");
  await act(async () => {
    openArea(area);
    await Promise.resolve();
  });
}

async function unmountWorkspace(view: Awaited<ReturnType<typeof renderWorkspace>>): Promise<void> {
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

describe("Workspace keyboard shortcuts", () => {
  it("uses guarded alt-digit selection only while document tabs are visible", async () => {
    const view = await renderWorkspace();
    const selected = await key(view, { altKey: true, code: "Digit2", metaKey: true });
    expect(selected.defaultPrevented).toBe(true);
    expect(view.guardLeave).toHaveBeenCalledWith("Switching tabs", expect.any(Function));
    expect(mocks.tabs.activateIndex).toHaveBeenCalledWith(1);

    const noTabs = await renderWorkspace({ area: "skills" });
    const ignored = await key(noTabs, { altKey: true, code: "Digit2", ctrlKey: true });
    expect(ignored.defaultPrevented).toBe(false);
    expect(noTabs.guardLeave).not.toHaveBeenCalled();
  });

  it("steps document tabs with shifted brackets without claiming native-menu keys", async () => {
    const view = await renderWorkspace();
    const forward = await key(view, { ctrlKey: true, key: "}", shiftKey: true });
    const backward = await key(view, { key: "[", metaKey: true, shiftKey: true });
    const nativeMenu = await key(view, { key: "t", metaKey: true });
    const nativeClose = await key(view, { key: "w", metaKey: true });
    const ordinaryTyping = await key(view, { key: "t" });

    expect(forward.defaultPrevented).toBe(true);
    expect(backward.defaultPrevented).toBe(true);
    expect(nativeMenu.defaultPrevented).toBe(false);
    expect(nativeClose.defaultPrevented).toBe(false);
    expect(ordinaryTyping.defaultPrevented).toBe(false);
    expect(mocks.tabs.step).toHaveBeenNthCalledWith(1, 1);
    expect(mocks.tabs.step).toHaveBeenNthCalledWith(2, -1);
  });

  it("leaves non-tab alt shortcuts for their native owner", async () => {
    const view = await renderWorkspace();
    const shortcut = await key(view, { altKey: true, code: "Digit0", metaKey: true });

    expect(shortcut.defaultPrevented).toBe(false);
    expect(view.guardLeave).not.toHaveBeenCalled();
  });

  it("reopens the newest live closed file, skipping deleted entries before calling viewFile", async () => {
    const view = await renderWorkspace({ files: [{ id: "live", name: "Live" }] });
    const close = mocks.tabStrip?.tabs.close as (id: string) => void;
    if (!close) throw new Error("tab strip did not mount");
    await act(async () => {
      close("file:live");
      close("file:gone");
      await Promise.resolve();
    });
    const reopened = await key(view, { key: "T", metaKey: true, shiftKey: true });

    expect(reopened.defaultPrevented).toBe(true);
    expect(view.viewFile).toHaveBeenCalledWith("live");
  });

  it("removes the listener on unmount", async () => {
    const view = await renderWorkspace();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
    const event = new view.window.Event("keydown", { bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
    Object.defineProperties(event, { altKey: { value: true }, code: { value: "Digit1" }, metaKey: { value: true } });
    view.window.dispatchEvent(event);
    expect(mocks.tabs.activateIndex).not.toHaveBeenCalled();
  });
});

describe("Workspace lock and tab-title callbacks", () => {
  it("locks a clean editor without requesting confirmation", async () => {
    const view = await renderWorkspace();

    await act(async () => {
      await topBarActions().handleLock();
    });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.actions.handleLock).toHaveBeenCalledOnce();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("keeps a dirty editor unlocked until its discard warning is confirmed", async () => {
    const view = await renderWorkspace();
    mocks.state.editModeRef.current = true;
    mocks.state.editorDirtyRef.current = true;
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await act(async () => {
      await topBarActions().handleLock();
    });
    expect(mocks.actions.handleLock).not.toHaveBeenCalled();
    expect(mocks.state.editorDirtyRef.current).toBe(true);

    await act(async () => {
      await topBarActions().handleLock();
    });
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.stringContaining("edits you haven't saved"),
      expect.objectContaining({ kind: "warning", okLabel: "Lock and discard" }),
    );
    expect(mocks.actions.handleLock).toHaveBeenCalledOnce();
    expect(mocks.state.editorDirtyRef.current).toBe(false);
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("fails closed when the dirty-editor lock confirmation cannot be shown", async () => {
    const view = await renderWorkspace();
    mocks.state.editModeRef.current = true;
    mocks.state.editorDirtyRef.current = true;
    mocks.confirm.mockRejectedValueOnce(new Error("dialog unavailable"));

    await act(async () => {
      await topBarActions().handleLock();
    });

    expect(mocks.actions.handleLock).not.toHaveBeenCalled();
    expect(mocks.state.editorDirtyRef.current).toBe(true);
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("supplies title facts only for a known text-bearing file tab", async () => {
    const view = await renderWorkspace({ files: [{ hasText: true, id: "readme", name: "Readme.md" }] });
    const titleFacts = mocks.tabStrip?.titleFacts as ((tab: Record<string, string>) => unknown) | undefined;
    if (!titleFacts) throw new Error("tab strip did not receive title facts");

    expect(titleFacts({ id: "area:memory", kind: "area", ref: "memory" })).toBeNull();
    expect(titleFacts({ id: "file:missing", kind: "file", ref: "missing" })).toBeNull();
    mocks.state.files = [{ hasText: false, id: "empty", name: "Empty.md" }];
    expect(titleFacts({ id: "file:empty", kind: "file", ref: "empty" })).toBeNull();
    mocks.state.files = [{ hasText: true, id: "readme", name: "Readme.md" }];
    expect(titleFacts({ id: "file:readme", kind: "file", ref: "readme" })).toEqual({
      kind: "text",
      name: "Readme.md",
    });
    expect(mocks.fileKindLabel).toHaveBeenCalledWith({ hasText: true, id: "readme", name: "Readme.md" });
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("rearms a declined quit and confirms a later discard without losing the dirty flag early", async () => {
    const view = await renderWorkspace();
    mocks.state.editModeRef.current = true;
    mocks.state.editorDirtyRef.current = true;
    mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    if (!mocks.quitRequested) throw new Error("quit listener missing");

    await act(async () => mocks.quitRequested?.());
    expect(mocks.quitGuardRearm).toHaveBeenCalledOnce();
    expect(mocks.state.editorDirtyRef.current).toBe(true);
    expect(mocks.quitGuardConfirm).not.toHaveBeenCalled();

    await act(async () => mocks.quitRequested?.());
    expect(mocks.state.editorDirtyRef.current).toBe(false);
    expect(mocks.setUnsavedEdits).toHaveBeenLastCalledWith(false);
    expect(mocks.quitGuardConfirm).toHaveBeenCalledOnce();
    await unmountWorkspace(view);
  });

  it("fails open when the native quit confirmation cannot be displayed", async () => {
    const view = await renderWorkspace();
    mocks.state.editorDirtyRef.current = true;
    mocks.confirm.mockRejectedValueOnce(new Error("dialog unavailable"));
    if (!mocks.quitRequested) throw new Error("quit listener missing");

    await act(async () => mocks.quitRequested?.());

    expect(mocks.state.editorDirtyRef.current).toBe(false);
    expect(mocks.quitGuardConfirm).toHaveBeenCalledOnce();
    await unmountWorkspace(view);
  });
});

describe("Workspace native-menu item actions", () => {
  it.each([
    {
      area: "browser",
      expected: "Opening a new page",
      kind: "page",
      verify: () => expect(mocks.pages.open).toHaveBeenCalledOnce(),
    },
    {
      area: "sketch",
      expected: "Starting a new sketch",
      kind: "sketch",
      verify: () => expect(mocks.actions.createSketch).toHaveBeenCalledOnce(),
    },
    {
      area: "create",
      expected: "Starting a new creation",
      kind: "creation",
      verify: () => {
        expect(mocks.state.setOpenFile).toHaveBeenCalledWith(null);
        expect(mocks.state.bumpNewCreation).toHaveBeenCalledOnce();
      },
    },
    {
      area: "files",
      expected: "Making a new note",
      kind: "note",
      verify: () => expect(mocks.actions.createNewNote).toHaveBeenCalledOnce(),
    },
  ])("guards and completes the $kind native-menu action", async ({ area, expected, kind, verify }) => {
    const view = await renderWorkspace({ area });
    mocks.newItemOf.mockReturnValue(kind);

    await act(async () => {
      nativeMenuActions().newItem();
      await Promise.resolve();
    });

    expect(view.guardLeave).toHaveBeenCalledWith(expected, expect.any(Function));
    verify();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("does not start a missing or offline page action", async () => {
    const view = await renderWorkspace({ area: "browser", webOn: false });
    mocks.newItemOf.mockReturnValue("page");

    await act(async () => {
      nativeMenuActions().newItem();
      await Promise.resolve();
    });
    expect(view.guardLeave).not.toHaveBeenCalled();
    expect(mocks.pages.open).not.toHaveBeenCalled();

    mocks.newItemOf.mockReturnValue(null);
    await act(async () => {
      nativeMenuActions().newItem();
      await Promise.resolve();
    });
    expect(view.guardLeave).not.toHaveBeenCalled();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("closes the active browser page before other closable workspace state", async () => {
    const view = await renderWorkspace({ area: "browser", openFileId: "live" });
    mocks.pages.activeId = "page-1";

    await act(async () => {
      nativeMenuActions().closeItem();
      await Promise.resolve();
    });

    expect(mocks.pages.close).toHaveBeenCalledWith("page-1");
    expect(view.guardLeave).not.toHaveBeenCalled();
    expect(mocks.tabs.close).not.toHaveBeenCalled();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("guards closing the active document tab", async () => {
    const view = await renderWorkspace();
    mocks.tabs.activeId = "file:live";

    await act(async () => {
      nativeMenuActions().closeItem();
      await Promise.resolve();
    });

    expect(view.guardLeave).toHaveBeenCalledWith("Closing this tab", expect.any(Function));
    expect(mocks.tabs.close).toHaveBeenCalledWith("file:live");
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("guards a file without a tab before closing the window", async () => {
    const view = await renderWorkspace({ openFileId: "live" });

    await act(async () => {
      nativeMenuActions().closeItem();
      await Promise.resolve();
    });

    expect(view.guardLeave).toHaveBeenCalledWith("Closing this file", expect.any(Function));
    expect(mocks.state.setOpenFile).toHaveBeenCalledWith(null);
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("closes the window only when the current area has nothing to close", async () => {
    const view = await renderWorkspace();

    await act(async () => {
      nativeMenuActions().closeItem();
      await Promise.resolve();
    });

    expect(mocks.closeWindow).toHaveBeenCalledOnce();
    expect(view.guardLeave).not.toHaveBeenCalled();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });
});

describe("Workspace composition", () => {
  it("routes browser reconciliation failures and guarded tab activation", async () => {
    const view = await renderWorkspace();
    mocks.browserError?.("Private pages unavailable");
    const activate = mocks.tabStrip?.tabs.activate as ((id: string) => void) | undefined;
    if (!activate) throw new Error("tab activation callback missing");

    await act(async () => activate("file:live"));

    expect(mocks.state.pushToast).toHaveBeenCalledWith("error", "Private pages unavailable");
    expect(view.guardLeave).toHaveBeenCalledWith("Switching tabs", expect.any(Function));
    expect(mocks.tabs.activate).toHaveBeenCalledWith("file:live");
    await unmountWorkspace(view);
  });

  it("clears an active document tab when a full-pane flag is raised", async () => {
    const view = await renderWorkspace({ activeTabId: "file:live", showScripts: true });

    expect(mocks.tabs.activate).toHaveBeenCalledWith("");
    await unmountWorkspace(view);
  });

  it("restores a valid saved area only after tab restoration finishes", async () => {
    const { api } = await import("./api");
    vi.mocked(api.getSetting).mockResolvedValueOnce("memory" as never);

    const view = await renderWorkspace();
    mocks.tabs.restored = true;
    await view.rerender();

    expect(api.getSetting).toHaveBeenCalledWith("workspace_area");
    expect(mocks.state.setArea).toHaveBeenCalledWith("memory");
    expect(mocks.state.setOpenFile).toHaveBeenCalledWith(null);
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it.each([
    { saved: "retired-area" },
    { saved: null },
  ])("leaves the default area alone for an unusable saved area %#", async ({ saved }) => {
    const { api } = await import("./api");
    vi.mocked(api.getSetting).mockResolvedValueOnce(saved as never);

    const view = await renderWorkspace();
    mocks.tabs.restored = true;
    await view.rerender();

    expect(mocks.state.setArea).not.toHaveBeenCalled();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("keeps the default area when saved-area lookup fails", async () => {
    const { api } = await import("./api");
    vi.mocked(api.getSetting).mockRejectedValueOnce(new Error("settings unavailable"));

    const view = await renderWorkspace();
    mocks.tabs.restored = true;
    await view.rerender();

    expect(mocks.state.setArea).not.toHaveBeenCalled();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it.each([
    {
      active: { id: "file:other", kind: "file", ref: "other", title: "Other" },
      expectedFile: "other",
      name: "opens a newly selected file tab",
    },
    {
      active: { id: "area:memory", kind: "area", ref: "memory", title: "Memory" },
      expectedArea: "memory",
      name: "applies a legacy area tab while it is being pruned",
    },
  ])("$name", async ({ active, expectedArea, expectedFile }) => {
    const view = await renderWorkspace();
    mocks.tabs.active = active;
    await view.rerender();

    if (expectedFile) expect(view.viewFile).toHaveBeenCalledWith(expectedFile);
    if (expectedArea) expect(mocks.state.setArea).toHaveBeenCalledWith(expectedArea);
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("does not reopen the file already applied from the active tab", async () => {
    const view = await renderWorkspace({ openFileId: "live" });
    mocks.tabs.active = { id: "file:live", kind: "file", ref: "live", title: "Live" };
    await view.rerender();

    expect(view.viewFile).not.toHaveBeenCalled();
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("preserves file tabs while synchronizing new, renamed, and section-only files", async () => {
    const opened = await renderWorkspace({ openFileId: "live" });
    expect(mocks.tabs.open).toHaveBeenCalledWith("file", "live", "Live");

    mocks.state.files = [{ id: "live", name: "Renamed" }];
    await opened.rerender();
    expect(mocks.tabs.retitle).toHaveBeenCalledWith("file:live", "Renamed");

    const sectionOnly = await renderWorkspace({
      files: [{ id: "sketch", libraryVisibility: "sectionOnly", name: "Sketch" }],
      openFileId: "sketch",
    });
    expect(mocks.tabs.open).not.toHaveBeenCalled();
    await act(async () => {
      sectionOnly.root.unmount();
      await Promise.resolve();
    });
  });

  it("remembers and restores an area's visible file through the guarded rail action", async () => {
    const view = await renderWorkspace({ openFileId: "live" });
    const openArea = mocks.activityRail?.onArea as (area: string) => void;
    if (!openArea) throw new Error("activity rail did not mount");

    await act(async () => {
      openArea("files");
      await Promise.resolve();
    });
    expect(view.viewFile).toHaveBeenCalledWith("live");

    mocks.state.openFileRef.current = null;
    await act(async () => {
      openArea("skills");
      await Promise.resolve();
    });
  });

  it("opens workflows through its full-pane action without ordinary-area cleanup", async () => {
    const view = await renderWorkspace({ openFileId: "live" });
    mocks.state.setArea.mockClear();
    mocks.state.setOpenFile.mockClear();

    await openRailArea("workflows");

    expect(view.guardLeave).toHaveBeenCalledWith("Opening this area", expect.any(Function));
    expect(mocks.state.setArea).toHaveBeenCalledWith("files");
    expect(mocks.actions.openWorkflows).toHaveBeenCalledOnce();
    expect(mocks.state.setOpenFile).not.toHaveBeenCalled();
    expect(mocks.tabs.activate).toHaveBeenCalledWith("");
    await unmountWorkspace(view);
  });

  it("opens scripts through its full-pane action without ordinary-area cleanup", async () => {
    const view = await renderWorkspace({ openFileId: "live" });
    mocks.state.setArea.mockClear();
    mocks.state.setOpenFile.mockClear();

    await openRailArea("scripts");

    expect(mocks.state.setArea).toHaveBeenCalledWith("files");
    expect(mocks.actions.openScripts).toHaveBeenCalledOnce();
    expect(mocks.state.setOpenFile).not.toHaveBeenCalled();
    expect(mocks.tabs.activate).toHaveBeenCalledWith("");
    await unmountWorkspace(view);
  });

  it("clears full panes and the open file before showing the map", async () => {
    const view = await renderWorkspace({ showScripts: true, showWorkflows: true, openFileId: "live" });
    mocks.state.setArea.mockClear();
    mocks.state.setOpenFile.mockClear();

    await openRailArea("map");

    expect(mocks.state.setShowWorkflows).toHaveBeenCalledWith(false);
    expect(mocks.state.setShowScripts).toHaveBeenCalledWith(false);
    expect(mocks.state.setArea).toHaveBeenCalledWith("files");
    expect(mocks.state.setOpenFile).toHaveBeenCalledWith(null);
    expect(mocks.state.setShowMap).toHaveBeenCalledWith(true);
    await unmountWorkspace(view);
  });

  it("clears full panes, map, and the open file before showing an ordinary area", async () => {
    const view = await renderWorkspace({ showMap: true, showScripts: true, showWorkflows: true, openFileId: "live" });
    mocks.state.setArea.mockClear();
    mocks.state.setOpenFile.mockClear();

    await openRailArea("skills");

    expect(mocks.state.setShowWorkflows).toHaveBeenCalledWith(false);
    expect(mocks.state.setShowScripts).toHaveBeenCalledWith(false);
    expect(mocks.state.setShowMap).toHaveBeenCalledWith(false);
    expect(mocks.state.setOpenFile).toHaveBeenCalledWith(null);
    expect(mocks.state.setArea).toHaveBeenCalledWith("skills");
    expect(mocks.state.setShowMemoryIntro).not.toHaveBeenCalled();
    await unmountWorkspace(view);
  });

  it("dismisses the memory introduction after the ordinary-area cleanup", async () => {
    const view = await renderWorkspace({ showMap: true, openFileId: "live" });
    mocks.state.setArea.mockClear();
    mocks.state.setOpenFile.mockClear();

    await openRailArea("memory");

    expect(mocks.state.setShowMap).toHaveBeenCalledWith(false);
    expect(mocks.state.setOpenFile).toHaveBeenCalledWith(null);
    expect(mocks.state.setArea).toHaveBeenCalledWith("memory");
    expect(mocks.state.setShowMemoryIntro).toHaveBeenCalledWith(false);
    await unmountWorkspace(view);
  });

  it("wires rail and status controls without a real Electron window", async () => {
    const view = await renderWorkspace({ showMap: true });
    expect(mocks.activityRail?.area).toBe("map");
    const rail = mocks.activityRail;
    const status = mocks.statusBar;
    if (!rail || !status) throw new Error("workspace controls did not mount");

    await act(async () => {
      rail.onSettings();
      rail.onCustomize();
      status.onOpenPrivacy();
      status.onShowActivity();
      await Promise.resolve();
    });
    expect(mocks.state.setShowSettings).toHaveBeenCalledWith(true);
    expect(mocks.state.setSettingsSection).toHaveBeenCalledWith("set-cloud-privacy");
    expect(mocks.state.setAiTab).toHaveBeenCalledWith("activity");
    const closeCustomize = mocks.customizeSidebar?.onClose as (() => void) | undefined;
    if (!closeCustomize) throw new Error("customize sidebar did not mount");
    await act(async () => {
      closeCustomize();
      await Promise.resolve();
    });
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it("registers a duplicate read-only copy and reports a registration failure", async () => {
    mocks.registerWorkspaceCopy.mockRejectedValueOnce(new Error("registration failed"));
    const view = await renderWorkspace({ duplicateRoomIdentity: true, readOnly: true });
    const button = view.window.document.querySelector("button");
    if (!button) throw new Error("registration button did not mount");
    await act(async () => {
      button.dispatchEvent(new view.window.Event("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.registerWorkspaceCopy).toHaveBeenCalledOnce();
    expect(mocks.state.pushToast).toHaveBeenCalledWith("error", "registration failed");
  });

  it("explains a writer lease when the read-only room is not a duplicate", async () => {
    const view = await renderWorkspace({ readOnly: true });
    expect(view.window.document.body.textContent).toContain("Another Arcelle process owns the writer lease");
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });

  it.each([
    { showScripts: true },
    { showWorkflows: true },
  ])("prefers full-pane workspace area flags %#", async (options) => {
    const view = await renderWorkspace(options);
    expect(mocks.activityRail?.area).toBe(options.showScripts ? "scripts" : "workflows");
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
  });
});
