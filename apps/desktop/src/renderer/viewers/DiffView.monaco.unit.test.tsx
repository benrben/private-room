import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDiffEditor: vi.fn(),
  createModel: vi.fn(),
  languageForFile: vi.fn(),
  monacoTheme: vi.fn(),
  remeasureWhenFontReady: vi.fn(),
  watchMonacoTheme: vi.fn(),
}));

vi.mock("./monacoSetup", () => ({
  default: {
    editor: {
      createDiffEditor: mocks.createDiffEditor,
      createModel: mocks.createModel,
    },
  },
  EDITOR_FONT: "fabricated-mono",
  languageForFile: mocks.languageForFile,
  monacoTheme: mocks.monacoTheme,
  remeasureWhenFontReady: mocks.remeasureWhenFontReady,
  watchMonacoTheme: mocks.watchMonacoTheme,
}));

import DiffView from "./DiffView";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

async function render() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("Fabricated diff root missing.");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(DiffView, {
      fileName: "notes.md",
      modified: "new fabricated text",
      original: "old fabricated text",
    }));
    await Promise.resolve();
  });
  return { host, root };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.languageForFile.mockReturnValue("markdown");
  mocks.monacoTheme.mockReturnValue("fabricated-dark");
  mocks.remeasureWhenFontReady.mockResolvedValue(undefined);
  mocks.watchMonacoTheme.mockReturnValue(() => undefined);
});

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("DiffView with fabricated Monaco", () => {
  it("creates a read-only fabricated diff and disposes its editor and models on unmount", async () => {
    const editor = { dispose: vi.fn(), setModel: vi.fn() };
    const originalModel = { dispose: vi.fn() };
    const modifiedModel = { dispose: vi.fn() };
    mocks.createDiffEditor.mockReturnValue(editor);
    mocks.createModel.mockReturnValueOnce(originalModel).mockReturnValueOnce(modifiedModel);

    const view = await render();
    const diffHost = view.host.querySelector<HTMLDivElement>(".compare-diff-host");
    if (!diffHost) throw new Error("Fabricated diff host missing.");

    expect(mocks.createDiffEditor).toHaveBeenCalledWith(diffHost, expect.objectContaining({
      automaticLayout: true,
      fontFamily: "fabricated-mono",
      minimap: { enabled: false },
      readOnly: true,
      theme: "fabricated-dark",
      wordWrap: "on",
    }));
    expect(mocks.languageForFile).toHaveBeenCalledWith("notes.md");
    expect(mocks.createModel).toHaveBeenNthCalledWith(1, "old fabricated text", "markdown");
    expect(mocks.createModel).toHaveBeenNthCalledWith(2, "new fabricated text", "markdown");
    expect(editor.setModel).toHaveBeenCalledWith({ modified: modifiedModel, original: originalModel });
    expect(mocks.watchMonacoTheme).toHaveBeenCalledOnce();
    expect(mocks.remeasureWhenFontReady).toHaveBeenCalledOnce();

    await act(async () => view.root.unmount());
    expect(editor.dispose).toHaveBeenCalledOnce();
    expect(originalModel.dispose).toHaveBeenCalledOnce();
    expect(modifiedModel.dispose).toHaveBeenCalledOnce();
  });
});
