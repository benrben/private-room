import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrashActorKind, TrashedFile } from "../api";
import type { WSActions } from "./actions";
import type { WSState } from "./state";
import TrashPanel from "./TrashPanel";

vi.mock("../icons", () => ({ TrashIcon: () => null, UndoIcon: () => null }));
vi.mock("./composer", () => ({ displayName: (name: string) => `shown:${name}` }));
vi.mock("./DeleteControl", () => ({
  default: ({ k, onConfirm }: { k: string; onConfirm: () => void }) =>
    createElement("button", { "data-delete": k, onClick: onConfirm }, `confirm ${k}`),
}));

const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type TestState = WSState & { selectedTrashIds: Set<string> };

function file(
  id: string,
  overrides: Partial<TrashedFile> = {},
): TrashedFile {
  return {
    id,
    name: `${id}.txt`,
    trashedAt: "2026-08-31T12:00:00.000Z",
    trashedBy: "user" as TrashActorKind,
    trashedById: null,
    sizeBytes: 1,
    ...overrides,
  } as TrashedFile;
}

function state(
  trashed: TrashedFile[],
  {
    selected = [],
    confirmDelete = null,
  }: {
    selected?: string[];
    confirmDelete?: string | null;
  } = {},
): TestState {
  const setSelectedTrashIds = vi.fn();
  const workspace = {
    trashed,
    confirmDelete,
    selectedTrashIds: new Set(selected),
    setSelectedTrashIds,
  } as unknown as TestState;
  setSelectedTrashIds.mockImplementation((next: React.SetStateAction<Set<string>>) => {
    workspace.selectedTrashIds = typeof next === "function"
      ? next(workspace.selectedTrashIds)
      : next;
  });
  return workspace;
}

function actions(): WSActions {
  return {
    restoreFiles: vi.fn(),
    destroyFiles: vi.fn(),
    restoreFile: vi.fn(),
    destroyFile: vi.fn(),
    emptyTrash: vi.fn(),
    askConfirm: vi.fn(),
    cancelConfirm: vi.fn(),
  } as unknown as WSActions;
}

async function render(workspace: WSState, workspaceActions: WSActions) {
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
    root.render(createElement(TrashPanel, { s: workspace, a: workspaceActions }));
    await Promise.resolve();
  });
  return { host, close: async () => act(async () => root.unmount()) };
}

function reactHandler(element: Element, name: string) {
  const propKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));
  if (!propKey) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, () => void>>)[propKey][name];
}

function click(element: Element) {
  reactHandler(element, "onClick")();
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("TrashPanel", () => {
  it("explains an empty trash without rendering destructive controls", async () => {
    const view = await render(state([]), actions());
    expect(view.host.textContent).toContain("Nothing deleted.");
    expect(view.host.querySelector("button")).toBeNull();
    await view.close();
  });

  it("labels varied trash rows and clears a selected batch before restoring or destroying it", async () => {
    const files = [
      file("first"),
      file("agent", { trashedAt: "not-a-date", trashedBy: "agent" as TrashActorKind, trashedById: "run-7", sizeBytes: 1024 }),
      file("app", { trashedBy: "app" as TrashActorKind, trashedById: "sync", sizeBytes: 2 * 1024 * 1024 }),
      file("legacy", { trashedBy: "unknown" as TrashActorKind, sizeBytes: 1023 }),
    ];
    const workspace = state(files, { selected: files.map((item) => item.id) });
    const workspaceActions = actions();
    const view = await render(workspace, workspaceActions);
    expect(view.host.textContent).toContain("by you");
    expect(view.host.textContent).toContain("by the AI · run-7");
    expect(view.host.textContent).toContain("by Arcelle · sync");
    expect(view.host.textContent).toContain("by an unrecorded actor");
    expect(view.host.textContent).toContain("not-a-date");
    expect(view.host.textContent).toContain("1023 B");
    expect(view.host.textContent).toContain("1 KB");
    expect(view.host.textContent).toContain("2.0 MB");

    const restore = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Restore"));
    if (!restore) throw new Error("batch restore missing");
    click(restore);
    expect(workspaceActions.restoreFiles).toHaveBeenCalledWith(files.map((item) => item.id));
    expect(workspace.selectedTrashIds).toEqual(new Set());

    const destroy = view.host.querySelector('[data-delete="trash-destroy-selection"]');
    if (!destroy) throw new Error("batch destroy missing");
    click(destroy);
    expect(workspaceActions.destroyFiles).toHaveBeenCalledWith(files.map((item) => item.id));
    expect(workspace.selectedTrashIds).toEqual(new Set());

    const rowRestore = view.host.querySelector('[aria-label="Restore shown:first.txt"]');
    if (!rowRestore) throw new Error("row restore missing");
    click(rowRestore);
    expect(workspaceActions.restoreFile).toHaveBeenCalledWith("first");

    const rowDestroy = view.host.querySelector('[data-delete="trash-destroy-first"]');
    if (!rowDestroy) throw new Error("row destroy missing");
    click(rowDestroy);
    expect(workspaceActions.destroyFile).toHaveBeenCalledWith("first");
    await view.close();
  });

  it("updates selection and makes the empty-trash confirmation explicit", async () => {
    const selectedFile = file("picked");
    const selectedWorkspace = state([selectedFile], { selected: [selectedFile.id] });
    const selectedActions = actions();
    const selectedView = await render(selectedWorkspace, selectedActions);
    const rowCheck = selectedView.host.querySelector('[aria-label="Select shown:picked.txt"]');
    if (!rowCheck) throw new Error("row checkbox missing");
    reactHandler(rowCheck, "onChange")();
    expect(selectedWorkspace.selectedTrashIds).toEqual(new Set());
    await selectedView.close();

    const unselectedWorkspace = state([file("new")]);
    const unselectedActions = actions();
    const unselectedView = await render(unselectedWorkspace, unselectedActions);
    const unselectedRow = unselectedView.host.querySelector('[aria-label="Select shown:new.txt"]');
    const selectAll = unselectedView.host.querySelector('[aria-label="Select all deleted files"]');
    if (!unselectedRow || !selectAll) throw new Error("selection control missing");
    reactHandler(unselectedRow, "onChange")();
    expect(unselectedWorkspace.selectedTrashIds).toEqual(new Set(["new"]));
    reactHandler(selectAll, "onChange")();
    expect(unselectedWorkspace.selectedTrashIds).toEqual(new Set(["new"]));
    const empty = [...unselectedView.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Empty the trash"));
    if (!empty) throw new Error("empty trash action missing");
    click(empty);
    expect(unselectedActions.askConfirm).toHaveBeenCalledWith("trash-empty-all");
    await unselectedView.close();

    const confirmedWorkspace = state([file("only")], { confirmDelete: "trash-empty-all" });
    const confirmedActions = actions();
    const confirmedView = await render(confirmedWorkspace, confirmedActions);
    expect(confirmedView.host.textContent).toContain("Delete 1 file for good?");
    const deleteForGood = [...confirmedView.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete for good"));
    const keep = [...confirmedView.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Keep them"));
    if (!deleteForGood || !keep) throw new Error("empty-trash confirmation actions missing");
    click(deleteForGood);
    click(keep);
    expect(confirmedActions.emptyTrash).toHaveBeenCalledOnce();
    expect(confirmedActions.cancelConfirm).toHaveBeenCalledTimes(2);
    await confirmedView.close();
  });
});
