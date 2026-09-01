import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  monacoTheme: vi.fn(() => "arcelle-dark"),
  remeasureWhenFontReady: vi.fn(() => Promise.resolve()),
  watchMonacoTheme: vi.fn(() => () => {}),
  Range: class {
    constructor(
      readonly startLineNumber: number,
      readonly startColumn: number,
      readonly endLineNumber: number,
      readonly endColumn: number,
    ) {}

    static lift<T>(value: T): T {
      return value;
    }
  },
}));

vi.mock("./monacoSetup", () => ({
  default: {
    KeyCode: { KeyS: 1 },
    KeyMod: { CtrlCmd: 2 },
    Range: mocks.Range,
    editor: { create: mocks.create },
  },
  EDITOR_FONT: "test-mono",
  monacoTheme: mocks.monacoTheme,
  remeasureWhenFontReady: mocks.remeasureWhenFontReady,
  watchMonacoTheme: mocks.watchMonacoTheme,
}));
vi.mock("../icons", () => ({ SaveIcon: () => null }));

import CodeEditor, { type EditorFormatApi } from "./CodeEditor";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Props = React.ComponentProps<typeof CodeEditor>;

function disposable() {
  return { dispose: vi.fn() };
}

function fakeEditor(
  initialValue: string,
  format: { model?: Record<string, unknown> | null; selection?: Record<string, unknown> | null } = {},
) {
  let value = initialValue;
  let onChange: (() => void) | null = null;
  const model = format.model === undefined ? {
    findMatches: vi.fn(() => []),
    getLineContent: vi.fn(() => ""),
    getLineMaxColumn: vi.fn(() => 1),
    getValueInRange: vi.fn(() => value),
    getWordAtPosition: vi.fn(() => null),
  } : format.model;
  return {
    addCommand: vi.fn(),
    dispose: vi.fn(),
    executeEdits: vi.fn(),
    focus: vi.fn(),
    getAction: vi.fn(),
    getModel: vi.fn(() => model),
    getScrollTop: vi.fn(() => 0),
    getSelection: vi.fn(() => format.selection ?? null),
    getValue: vi.fn(() => value),
    onDidChangeCursorPosition: vi.fn(disposable),
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      onChange = listener;
      return disposable();
    }),
    onKeyDown: vi.fn((_listener: () => void) => disposable()),
    onMouseDown: vi.fn(disposable),
    setScrollTop: vi.fn(),
    update(next: string) {
      value = next;
      onChange?.();
    },
  };
}

function props(overrides: Partial<Props> = {}): Props {
  return {
    value: "const opened = true;",
    language: "typescript",
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(input = props()) {
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
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: Props) => {
    await act(async () => root.render(createElement(CodeEditor, next)));
    await flush();
  };
  await draw(input);
  return { host, root, window, draw };
}

function button(host: Element): HTMLButtonElement {
  const found = host.querySelector("button");
  if (!found) throw new Error("save button not found");
  return found as HTMLButtonElement;
}

function editorFormat(registerFormat: ReturnType<typeof vi.fn>): EditorFormatApi {
  const api = registerFormat.mock.calls[0]?.[0] as EditorFormatApi | null | undefined;
  if (!api) throw new Error("format API was not registered");
  return api;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.monacoTheme.mockClear();
  mocks.remeasureWhenFontReady.mockClear();
  mocks.watchMonacoTheme.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("CodeEditor with mocked Monaco", () => {
  it("keeps the edit-only banner and save controls out of a read-only editor", async () => {
    mocks.create.mockReturnValue(fakeEditor("const opened = true;"));
    const editable = await render(props({ banner: "Saving rewrites this file", saveLabel: "Save copy" }));

    expect(editable.host.textContent).toContain("Saving rewrites this file");
    expect(editable.host.textContent).toContain("typescript");
    expect(button(editable.host).textContent).toContain("Save copy");

    await editable.draw(props({ banner: "Saving rewrites this file", readOnly: true }));

    expect(editable.host.querySelector(".editor-banner")).toBeNull();
    expect(editable.host.querySelector(".editor-bar")).toBeNull();
    await act(async () => editable.root.unmount());
  });

  it("propagates mocked edits, marks dirty, and saves the exact mocked buffer", async () => {
    const editor = fakeEditor("const opened = true;");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onChange = vi.fn();
    const onDirtyChange = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ onSave, onChange, onDirtyChange }));

    await act(async () => editor.update("const changed = true;"));
    await flush();
    expect(view.host.textContent).toContain("unsaved changes");
    expect(onChange).toHaveBeenLastCalledWith("const changed = true;");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await click(button(view.host), view.window);

    expect(onSave).toHaveBeenCalledWith("const changed = true;");
    expect(view.host.textContent).toContain("all changes saved");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    await act(async () => view.root.unmount());
  });

  it("wraps the selected text through Monaco's undoable edit API", async () => {
    const selection = {
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 8,
      isEmpty: () => false,
      getStartPosition: () => ({ lineNumber: 2, column: 3 }),
    };
    const model = { getValueInRange: vi.fn(() => "title") };
    const editor = fakeEditor("# title", { model, selection });
    const registerFormat = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ registerFormat }));

    editorFormat(registerFormat).wrap("**", "**");

    expect(editor.executeEdits).toHaveBeenCalledWith("toolbar", [{
      range: selection,
      text: "**title**",
      forceMoveMarkers: true,
    }]);
    expect(editor.focus).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("widens a caret to its word and removes matching wrapping on a second press", async () => {
    const selection = {
      startLineNumber: 3,
      startColumn: 6,
      endLineNumber: 3,
      endColumn: 6,
      isEmpty: () => true,
      getStartPosition: () => ({ lineNumber: 3, column: 6 }),
    };
    const model = {
      getValueInRange: vi.fn()
        .mockReturnValueOnce("word")
        .mockReturnValueOnce("**word**"),
      getWordAtPosition: vi.fn(() => ({ startColumn: 2, endColumn: 6 })),
    };
    const editor = fakeEditor("a word", { model, selection });
    const registerFormat = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ registerFormat }));

    const format = editorFormat(registerFormat);
    format.wrap("**", "**");
    format.wrap("**", "**");

    expect(editor.executeEdits).toHaveBeenNthCalledWith(1, "toolbar", [{
      range: expect.objectContaining({
        startLineNumber: 3,
        startColumn: 2,
        endLineNumber: 3,
        endColumn: 6,
      }),
      text: "**word**",
      forceMoveMarkers: true,
    }]);
    expect(editor.executeEdits).toHaveBeenNthCalledWith(2, "toolbar", [{
      range: expect.any(mocks.Range),
      text: "word",
      forceMoveMarkers: true,
    }]);
    await act(async () => view.root.unmount());
  });

  it("wraps from the default range when selection state disappears and leaves line commands alone", async () => {
    const model = { getValueInRange: vi.fn(() => "fallback") };
    const editor = fakeEditor("fallback", { model, selection: null });
    const registerFormat = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ registerFormat }));

    const format = editorFormat(registerFormat);
    format.wrap("`", "`");
    format.linePrefix("> ");

    expect(editor.executeEdits).toHaveBeenCalledOnce();
    expect(editor.executeEdits).toHaveBeenCalledWith("toolbar", [{
      range: expect.objectContaining({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      }),
      text: "`fallback`",
      forceMoveMarkers: true,
    }]);
    await act(async () => view.root.unmount());
  });

  it("uses an empty caret when Monaco finds no word to widen", async () => {
    const selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
      isEmpty: () => true,
      getStartPosition: () => ({ lineNumber: 1, column: 1 }),
    };
    const model = {
      getValueInRange: vi.fn(() => ""),
      getWordAtPosition: vi.fn(() => null),
    };
    const editor = fakeEditor("", { model, selection });
    const registerFormat = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ registerFormat }));

    editorFormat(registerFormat).wrap("**", "**");

    expect(editor.executeEdits).toHaveBeenCalledWith("toolbar", [{
      range: selection,
      text: "****",
      forceMoveMarkers: true,
    }]);
    await act(async () => view.root.unmount());
  });

  it("does not format after Monaco disposes its model", async () => {
    const editor = fakeEditor("disposed", { model: null });
    const registerFormat = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ registerFormat }));

    const format = editorFormat(registerFormat);
    format.wrap("**", "**");
    format.linePrefix("> ");

    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(editor.focus).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("inserts text through Monaco's undoable edit operation", async () => {
    const selection = {
      startLineNumber: 2,
      startColumn: 4,
      endLineNumber: 2,
      endColumn: 4,
    };
    const editor = fakeEditor("some text", { selection });
    const registerFormat = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ registerFormat }));

    editorFormat(registerFormat).insert("[link](url)");

    expect(editor.executeEdits).toHaveBeenCalledWith("toolbar", [{
      range: selection,
      text: "[link](url)",
      forceMoveMarkers: true,
    }]);
    expect(editor.focus).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("saves through Monaco's keyboard command and treats navigation as an intentional move", async () => {
    const editor = fakeEditor("keyboard save");
    const onSave = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ onSave }));
    const command = editor.addCommand.mock.calls[0]?.[1] as (() => void) | undefined;
    const markMoved = editor.onKeyDown.mock.calls[0]?.[0] as (() => void) | undefined;

    markMoved?.();
    command?.();
    await flush();

    expect(onSave).toHaveBeenCalledWith("keyboard save");
    expect(editor.setScrollTop).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("reveals the first requested match and opens Monaco's find action", async () => {
    const range = { startLineNumber: 4, startColumn: 2, endLineNumber: 4, endColumn: 8 };
    const run = vi.fn().mockResolvedValue(undefined);
    const model = {
      findMatches: vi.fn(() => [{ range }]),
      getLineContent: vi.fn(() => ""),
      getLineMaxColumn: vi.fn(() => 1),
      getValueInRange: vi.fn(() => ""),
      getWordAtPosition: vi.fn(() => null),
    };
    const editor = {
      ...fakeEditor("find this", { model }),
      setSelection: vi.fn(),
      revealRangeInCenter: vi.fn(),
      getAction: vi.fn(() => ({ run })),
    };
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ find: "needle" }));

    expect(model.findMatches).toHaveBeenCalledWith("needle", false, false, false, null, false);
    expect(editor.setSelection).toHaveBeenCalledWith(range);
    expect(editor.revealRangeInCenter).toHaveBeenCalledWith(range);
    expect(run).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("toggles a common line prefix across the selected lines with an undoable edit", async () => {
    const selection = { startLineNumber: 4, endLineNumber: 5 };
    const model = {
      getLineContent: vi.fn()
        .mockReturnValueOnce("first")
        .mockReturnValueOnce("second")
        .mockReturnValueOnce("> first")
        .mockReturnValueOnce("> second"),
      getLineMaxColumn: vi.fn(() => 8),
    };
    const editor = fakeEditor("first\nsecond", { model, selection });
    const registerFormat = vi.fn();
    mocks.create.mockReturnValue(editor);
    const view = await render(props({ registerFormat }));

    const format = editorFormat(registerFormat);
    format.linePrefix("> ");
    format.linePrefix("> ");

    expect(editor.executeEdits).toHaveBeenNthCalledWith(1, "toolbar", [{
      range: expect.objectContaining({
        startLineNumber: 4,
        startColumn: 1,
        endLineNumber: 5,
        endColumn: 8,
      }),
      text: "> first\n> second",
      forceMoveMarkers: true,
    }]);
    expect(editor.executeEdits).toHaveBeenNthCalledWith(2, "toolbar", [{
      range: expect.any(mocks.Range),
      text: "first\nsecond",
      forceMoveMarkers: true,
    }]);
    await act(async () => view.root.unmount());
  });
});
