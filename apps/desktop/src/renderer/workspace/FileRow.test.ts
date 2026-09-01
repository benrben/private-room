import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileMeta } from "../apiTypes";
import type { WSActions } from "./actions";
import type { WSState } from "./state";

vi.mock("../api", () => ({ formatSize: (bytes: number) => `${bytes} bytes` }));
vi.mock("../icons", () => ({
  DotsIcon: () => null,
  FileTypeIcon: () => null,
  PaperclipIcon: () => null,
}));
vi.mock("./composer", () => ({
  fileLabel: (name: string) => `Label: ${name}`,
}));

import FileRow from "./FileRow";

const { act, createElement } = React;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = Object.fromEntries(
  keys.map((key) => [key, Reflect.get(globalThis, key)]),
);
const file: FileMeta = {
  id: "file-1",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 12,
  source: "library",
  hasText: false,
  createdAt: "2026",
  folderId: null,
  partiallyIndexed: true,
  aiSummary: "A bright image.",
  originDestination: "library",
  libraryVisibility: "linked",
};

function state(overrides: Record<string, unknown> = {}): WSState {
  return {
    attachments: [],
    openFile: null,
    selectedFileIds: new Set<string>(),
    files: [file],
    sttStatus: {},
    internalDragRef: { current: false },
    setDragOverFolder: vi.fn(),
    setMoveMenuFor: vi.fn(),
    setCtxMenu: vi.fn(),
    renamingFile: null,
    setRenamingFile: vi.fn(),
    ...overrides,
  } as unknown as WSState;
}
function actions() {
  return {
    selectedFiles: vi.fn(() => [file]),
    cancelConfirm: vi.fn(),
    clearSelection: vi.fn(),
    clickFile: vi.fn(),
    toggleAttach: vi.fn(),
    commitRenameFile: vi.fn(),
  } as unknown as WSActions;
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function render(s: WSState, a: WSActions) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(FileRow, { f: file, s, a })));
  await flush();
  return { host, root, window };
}
function props<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}
async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () =>
    node.dispatchEvent(new window.Event("click", { bubbles: true })),
  );
  await flush();
}
afterEach(() => {
  file.mimeType = "image/png";
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("FileRow", () => {
  it("renders selected attachment/status facts and wires main/action controls", async () => {
    const s = state({
      attachments: [file],
      openFile: { id: file.id },
      selectedFileIds: new Set([file.id]),
      sttStatus: { [file.name]: "processing" },
    });
    const a = actions();
    const view = await render(s, a);
    expect(view.host.querySelector(".file-row")?.className).toContain(
      "selected",
    );
    expect(view.host.querySelector(".file-row")?.className).toContain(
      "attached",
    );
    expect(view.host.textContent).toContain("Selected.");
    expect(view.host.textContent).toContain("Label: photo.png");
    expect(view.host.textContent).toContain("A bright image.");
    expect(
      view.host.querySelector('[aria-label="Partially indexed"]'),
    ).not.toBeNull();
    expect(
      view.host.querySelector('[aria-label="Transcribing"]'),
    ).not.toBeNull();
    const main = view.host.querySelector<HTMLButtonElement>(".file-main");
    if (!main) throw new Error("main missing");
    await click(main, view.window);
    expect(a.clickFile).toHaveBeenCalledWith(file, {
      meta: undefined,
      shift: undefined,
    });
    await click(
      view.host.querySelector<HTMLButtonElement>(
        '[aria-label^="Attach image"]',
      )!,
      view.window,
    );
    expect(a.toggleAttach).toHaveBeenCalledWith(file);
    await click(
      view.host.querySelector<HTMLButtonElement>(
        '[aria-label="More actions"]',
      )!,
      view.window,
    );
    expect(a.selectedFiles).toHaveBeenCalled();
    expect(s.setMoveMenuFor).toHaveBeenCalledWith(null);
    expect(a.cancelConfirm).toHaveBeenCalled();
    expect(s.setCtxMenu).toHaveBeenCalledWith(
      expect.objectContaining({ file, files: [file] }),
    );
    await act(async () => view.root.unmount());
  });
  it("keeps outside context actions singular and finishes drag and rename keyboard paths", async () => {
    file.mimeType = "text/plain";
    const s = state({
      renamingFile: { id: file.id, name: "New name", where: "library" },
    });
    const a = actions();
    const view = await render(s, a);
    const row = view.host.querySelector<HTMLDivElement>(".file-row");
    const input =
      view.host.querySelector<HTMLInputElement>(".file-rename-input");
    if (!row || !input) throw new Error("row controls missing");
    expect(
      view.host.querySelector(
        '[aria-label="Pin this file into your next question"]',
      ),
    ).not.toBeNull();
    await act(async () =>
      props<{ onChange: (event: { target: { value: string } }) => void }>(
        input,
      ).onChange({ target: { value: "Renamed" } }),
    );
    const transfer = { setData: vi.fn(), effectAllowed: "" };
    await act(async () =>
      props<{ onDragStart: (e: { dataTransfer: typeof transfer }) => void }>(
        row,
      ).onDragStart({ dataTransfer: transfer }),
    );
    expect(transfer.setData).toHaveBeenCalledWith("text/plain", file.id);
    expect(s.internalDragRef.current).toBe(true);
    await act(async () => props<{ onDragEnd: () => void }>(row).onDragEnd());
    expect(s.internalDragRef.current).toBe(false);
    expect(s.setDragOverFolder).toHaveBeenCalledWith(null);
    const preventDefault = vi.fn();
    await act(async () =>
      props<{
        onContextMenu: (e: {
          preventDefault: () => void;
          clientX: number;
          clientY: number;
        }) => void;
      }>(row).onContextMenu({ preventDefault, clientX: 3, clientY: 4 }),
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(a.clearSelection).toHaveBeenCalledOnce();
    expect(s.setCtxMenu).toHaveBeenCalledWith(
      expect.objectContaining({ files: [file], x: 3, y: 4 }),
    );
    await act(async () =>
      props<{ onKeyDown: (e: { key: string }) => void }>(input).onKeyDown({
        key: "Enter",
      }),
    );
    await act(async () =>
      props<{ onKeyDown: (e: { key: string }) => void }>(input).onKeyDown({
        key: "Escape",
      }),
    );
    expect(a.commitRenameFile).toHaveBeenCalledOnce();
    expect(s.setRenamingFile).toHaveBeenCalledWith({
      id: file.id,
      name: "Renamed",
      where: "library",
    });
    expect(s.setRenamingFile).toHaveBeenCalledWith(null);
    await act(async () => view.root.unmount());
  });
});
