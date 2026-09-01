import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => {
  const calls = {
    code: [] as Array<Record<string, unknown>>,
    markdown: [] as Array<Record<string, unknown>>,
    sheet: [] as Array<Record<string, unknown>>,
    sheetMounts: 0,
    sheetUnmounts: 0,
    preview: [] as Array<Record<string, unknown>>,
  };
  let throwCode = false;
  const CodeEditor = (props: Record<string, unknown>) => {
    calls.code.push(props);
    if (throwCode) throw new Error("chunk unavailable");
    return null;
  };
  const MarkdownEditor = (props: Record<string, unknown>) => {
    calls.markdown.push(props);
    return null;
  };
  const SheetView = (props: Record<string, unknown>) => {
    calls.sheet.push(props);
    const runtimeReact = Reflect.get(
      globalThis,
      "React",
    ) as typeof import("react");
    runtimeReact.useEffect(() => {
      calls.sheetMounts += 1;
      return () => {
        calls.sheetUnmounts += 1;
      };
    }, []);
    return null;
  };
  const lazy = { CodeEditor, MarkdownEditor, SheetView };
  const render = vi.fn((props: Record<string, unknown>) => {
    calls.preview.push(props);
    return null;
  });
  return {
    calls,
    clear: () => {
      calls.code.length = 0;
      calls.markdown.length = 0;
      calls.sheet.length = 0;
      calls.sheetMounts = 0;
      calls.sheetUnmounts = 0;
      calls.preview.length = 0;
      render.mockClear();
      throwCode = false;
    },
    getThrowCode: () => throwCode,
    lazy,
    makeLazyViewers: vi.fn(() => lazy),
    render,
    setThrowCode: (value: boolean) => {
      throwCode = value;
    },
  };
});

vi.mock("../viewers/registry", () => ({
  FORMATS: {
    binary: { render: routerMocks.render },
    preview: { render: routerMocks.render },
  },
  makeLazyViewers: routerMocks.makeLazyViewers,
}));
vi.mock("../viewers/languages", () => ({
  languageForFile: (name: string) => `language:${name}`,
}));
vi.mock("../viewers/TextEncoding", () => ({
  encodingSaveNote: (decoded: { note?: string } | null) =>
    decoded?.note ?? null,
}));
vi.mock("../viewers/PageSource", () => ({ default: () => null }));

import ViewerRouter from "./ViewerRouter";

const { act, createElement } = React;

const globalKeys = [
  "document",
  "window",
  "Node",
  "HTMLElement",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function content(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    kind,
    name: "report.txt",
    text: "original text",
    editable: true,
    mediaToken: "media-token",
    dataB64: "bytes",
    webMeta: null,
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  const file = {
    id: "file-1",
    content: content("text"),
    target: { sheet: "January", cell: "B2", find: "needle" },
  };
  return {
    openFile: file,
    viewerRev: 4,
    editMode: false,
    editModeOf: vi.fn(() => null),
    enc: { text: null, key: "utf8", decoded: null, alert: null },
    editCell: vi.fn(async () => {}),
    saveEdit: vi.fn(async () => true),
    saveEditAsCopy: vi.fn(async () => true),
    onDirtyChange: vi.fn(),
    registerSave: vi.fn(),
    sttStatus: { "report.txt": "processing" },
    recording: { live: null, saveProgress: null } as never,
    ...overrides,
  };
}

async function renderRouter(overrides: Record<string, unknown> = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const value = props(overrides);
  await act(async () => {
    root.render(createElement(ViewerRouter, value as never));
    await Promise.resolve();
  });
  return { document, root, value };
}

async function rerender(
  root: { render: (node: React.ReactNode) => void },
  value: Record<string, unknown>,
) {
  await act(async () => {
    root.render(createElement(ViewerRouter, value as never));
    await Promise.resolve();
  });
}

beforeEach(() => routerMocks.clear());

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("ViewerRouter", () => {
  it("routes editable grids with the sheet target and preserves its stable key", async () => {
    const view = await renderRouter({
      editMode: true,
      editModeOf: () => "grid",
      openFile: {
        id: "sheet-1",
        content: content("csv"),
        target: { sheet: "Budget", cell: "C3" },
      },
    });
    expect(routerMocks.calls.sheet).toHaveLength(1);
    expect(routerMocks.calls.sheet[0]).toMatchObject({
      mediaToken: "media-token",
      dataB64: "bytes",
      text: "original text",
      target: { sheet: "Budget", range: "C3" },
      editable: true,
    });
    await rerender(view.root, {
      ...view.value,
      viewerRev: 5,
    });
    expect(routerMocks.calls.sheet).toHaveLength(2);
    expect(routerMocks.calls.sheetMounts).toBe(1);
    expect(routerMocks.calls.sheetUnmounts).toBe(0);
    await act(async () => view.root.unmount());
  });

  it("routes Markdown and in-place editors with their save and encoding contracts", async () => {
    const markdown = await renderRouter({
      editMode: true,
      editModeOf: () => "editor",
      openFile: {
        id: "note",
        content: content("markdown"),
        target: { find: "find" },
      },
    });
    expect(routerMocks.calls.markdown[0]).toMatchObject({
      value: "original text",
      find: "find",
    });
    expect(routerMocks.calls.markdown[0].onSave).toBe(markdown.value.saveEdit);
    await act(async () => markdown.root.unmount());

    const code = await renderRouter({
      editMode: true,
      editModeOf: () => "editor",
      enc: {
        text: "decoded text",
        key: "latin1",
        decoded: { editable: true, note: "Saving converts this file." },
        alert: createElement("div", null, "encoding alert"),
      },
    });
    expect(routerMocks.calls.code.at(-1)).toMatchObject({
      value: "decoded text",
      language: "language:report.txt",
      banner: "Saving converts this file.",
      find: "needle",
    });
    expect(routerMocks.calls.code.at(-1)?.onSave).toBe(code.value.saveEdit);
    await act(async () => code.root.unmount());
  });

  it("uses the document rewrite and copy routes with their distinct saves", async () => {
    const docx = await renderRouter({
      editMode: true,
      editModeOf: () => "docx",
      openFile: { id: "docx", content: content("docx") },
    });
    expect(routerMocks.calls.code.at(-1)).toMatchObject({
      language: "plaintext",
      saveLabel: "Save into the Word file",
    });
    expect(routerMocks.calls.code.at(-1)?.onSave).toBe(docx.value.saveEdit);
    await act(async () => docx.root.unmount());

    const copy = await renderRouter({
      editMode: true,
      editModeOf: () => "copy",
      openFile: { id: "pdf", content: content("pdf") },
    });
    expect(routerMocks.calls.code.at(-1)).toMatchObject({
      language: "markdown",
      saveLabel: "Save as a new note",
    });
    expect(routerMocks.calls.code.at(-1)?.onSave).toBe(
      copy.value.saveEditAsCopy,
    );
    await act(async () => copy.root.unmount());
  });

  it("renders previews through the binary fallback with decoded content and full context", async () => {
    const view = await renderRouter({
      editMode: true,
      editModeOf: () => null,
      openFile: {
        id: "preview-id",
        content: content("missing-format", { editable: true }),
        target: { find: "word" },
      },
      enc: {
        text: "replacement-safe text",
        key: "detected",
        decoded: { editable: false },
        alert: createElement("div", { id: "encoding-alert" }, "alert"),
      },
    });
    expect(view.document.getElementById("encoding-alert")?.textContent).toBe(
      "alert",
    );
    expect(view.document.querySelector(".viewer-host")).not.toBeNull();
    expect(routerMocks.render).toHaveBeenCalledOnce();
    expect(routerMocks.calls.preview[0]).toMatchObject({
      fileId: "preview-id",
      content: expect.objectContaining({
        text: "replacement-safe text",
        editable: false,
      }),
      target: { find: "word" },
      viewerRev: 4,
      lazy: routerMocks.lazy,
    });
    await act(async () => view.root.unmount());
  });

  it("shows a recoverable chunk failure and retries when a different file opens", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    routerMocks.setThrowCode(true);
    const view = await renderRouter({
      editMode: true,
      editModeOf: () => "editor",
    });
    expect(view.document.body.textContent).toContain(
      "This viewer couldn't load",
    );
    expect(consoleError).toHaveBeenCalled();
    routerMocks.setThrowCode(false);
    await rerender(view.root, {
      ...view.value,
      openFile: { id: "next-file", content: content("text") },
    });
    expect(view.document.body.textContent).not.toContain(
      "This viewer couldn't load",
    );
    expect(routerMocks.makeLazyViewers).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });
});
