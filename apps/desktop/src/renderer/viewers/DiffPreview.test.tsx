import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const models: Array<{ dispose: ReturnType<typeof vi.fn>; language: string | undefined; text: string }> = [];
  const editor = { dispose: vi.fn(), setModel: vi.fn() };
  const createModel = vi.fn((text: string, language: string | undefined) => {
    const model = { dispose: vi.fn(), language, text };
    models.push(model);
    return model;
  });
  return {
    createDiffEditor: vi.fn(() => editor),
    createModel,
    editor,
    models,
    monacoTheme: vi.fn(() => "fabricated-monaco-theme"),
    remeasureWhenFontReady: vi.fn(async () => undefined),
    stopWatchingTheme: vi.fn(),
    watchMonacoTheme: vi.fn(() => fakes.stopWatchingTheme),
  };
});

vi.mock("./monacoSetup", () => ({
  default: { editor: { createDiffEditor: fakes.createDiffEditor, createModel: fakes.createModel } },
  EDITOR_FONT: "Fabricated Mono",
  monacoTheme: fakes.monacoTheme,
  remeasureWhenFontReady: fakes.remeasureWhenFontReady,
  watchMonacoTheme: fakes.watchMonacoTheme,
}));

import DiffPreview from "./DiffPreview";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

async function render(
  input: React.ComponentProps<typeof DiffPreview>,
  width: number,
  Component: typeof DiffPreview = DiffPreview,
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("DiffPreview test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Component, input));
    await Promise.resolve();
  });
  return { host, root };
}

async function close(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.models.length = 0;
  fakes.createDiffEditor.mockReturnValue(fakes.editor);
  fakes.createModel.mockImplementation((text: string, language: string | undefined) => {
    const model = { dispose: vi.fn(), language, text };
    fakes.models.push(model);
    return model;
  });
  fakes.monacoTheme.mockReturnValue("fabricated-monaco-theme");
  fakes.remeasureWhenFontReady.mockResolvedValue(undefined);
  fakes.watchMonacoTheme.mockReturnValue(fakes.stopWatchingTheme);
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("DiffPreview", () => {
  it("creates and disposes a fabricated inline Monaco diff with its truncated-note state", async () => {
    const view = await render({ after: "after text", before: "before text", clipped: true, language: "markdown" }, 719);
    const diffHost = view.host.querySelector(".diff-preview-host");
    if (!diffHost) throw new Error("DiffPreview host missing");

    expect(view.host.textContent).toContain("Preview truncated");
    expect(fakes.createDiffEditor).toHaveBeenCalledWith(diffHost, expect.objectContaining({
      fontFamily: "Fabricated Mono",
      renderSideBySide: false,
      theme: "fabricated-monaco-theme",
    }));
    expect(fakes.createModel).toHaveBeenNthCalledWith(1, "before text", "markdown");
    expect(fakes.createModel).toHaveBeenNthCalledWith(2, "after text", "markdown");
    expect(fakes.editor.setModel).toHaveBeenCalledWith({ original: fakes.models[0], modified: fakes.models[1] });
    expect(fakes.watchMonacoTheme).toHaveBeenCalledOnce();
    expect(fakes.remeasureWhenFontReady).toHaveBeenCalledOnce();

    await close(view);
    expect(fakes.editor.dispose).toHaveBeenCalledOnce();
    expect(fakes.models.map((model) => model.dispose)).toEqual([expect.any(Function), expect.any(Function)]);
    expect(fakes.models[0]?.dispose).toHaveBeenCalledOnce();
    expect(fakes.models[1]?.dispose).toHaveBeenCalledOnce();
    expect(fakes.stopWatchingTheme).toHaveBeenCalledOnce();
  });

  it("uses a fabricated side-by-side editor for a wide unclipped preview", async () => {
    const view = await render({ after: "next", before: "previous" }, 720);

    expect(view.host.querySelector(".diff-preview-note")).toBeNull();
    expect(fakes.createDiffEditor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ renderSideBySide: true }),
    );
    await close(view);
  });

  it("does not create a fabricated editor when its host ref remains unavailable", async () => {
    const unavailableRef = {
      get current(): null { return null; },
      set current(_value: unknown) {},
    };
    vi.resetModules();
    vi.doMock("react", async (importOriginal) => ({
      ...await importOriginal<typeof import("react")>(),
      useRef: () => unavailableRef,
    }));
    try {
      const { default: NoHostDiffPreview } = await import("./DiffPreview");
      const view = await render({ after: "next", before: "previous" }, 720, NoHostDiffPreview);

      expect(fakes.createDiffEditor).not.toHaveBeenCalled();
      await close(view);
    } finally {
      vi.doUnmock("react");
      vi.resetModules();
    }
  });
});
