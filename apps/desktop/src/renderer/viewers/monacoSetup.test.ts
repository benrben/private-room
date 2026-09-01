import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  defineTheme: vi.fn(),
  editorWorker: class EditorWorker {},
  jsonWorker: class JsonWorker {},
  remeasureFonts: vi.fn(),
  setTheme: vi.fn(),
}));

const contributionModules = [
  "monaco-editor/esm/vs/editor/edcore.main.js",
  "monaco-editor/esm/vs/language/json/monaco.contribution.js",
  "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js",
  "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js",
  "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js",
  "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js",
  "monaco-editor/esm/vs/basic-languages/protobuf/protobuf.contribution.js",
  "monaco-editor/esm/vs/basic-languages/restructuredtext/restructuredtext.contribution.js",
  "monaco-editor/esm/vs/basic-languages/css/css.contribution.js",
  "monaco-editor/esm/vs/basic-languages/go/go.contribution.js",
  "monaco-editor/esm/vs/basic-languages/html/html.contribution.js",
  "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js",
  "monaco-editor/esm/vs/basic-languages/java/java.contribution.js",
  "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js",
  "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js",
  "monaco-editor/esm/vs/basic-languages/less/less.contribution.js",
  "monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js",
  "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js",
  "monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js",
  "monaco-editor/esm/vs/basic-languages/php/php.contribution.js",
  "monaco-editor/esm/vs/basic-languages/python/python.contribution.js",
  "monaco-editor/esm/vs/basic-languages/r/r.contribution.js",
  "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js",
  "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js",
  "monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js",
  "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js",
  "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js",
  "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js",
  "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js",
  "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js",
  "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js",
  "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js",
] as const;

const workerModules = [
  "monaco-editor/esm/vs/editor/editor.worker?worker",
  "monaco-editor/esm/vs/language/json/json.worker?worker",
] as const;

const savedSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const savedMutationObserver = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");

function installDocument(theme: "dark" | "light" = "dark"): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { dataset: { theme } } },
  });
}

function restoreGlobal(name: "self" | "document", saved: PropertyDescriptor | undefined): void {
  if (saved === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }
  Object.defineProperty(globalThis, name, saved);
}

async function loadMonacoSetup() {
  vi.resetModules();
  vi.doMock("monaco-editor/esm/vs/editor/editor.api.js", () => ({
    editor: {
      defineTheme: mocks.defineTheme,
      remeasureFonts: mocks.remeasureFonts,
      setTheme: mocks.setTheme,
    },
  }));
  vi.doMock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
    default: mocks.editorWorker,
  }));
  vi.doMock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
    default: mocks.jsonWorker,
  }));
  for (const moduleName of contributionModules) {
    vi.doMock(moduleName, () => ({}));
  }
  return import("./monacoSetup.js");
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
  installDocument();
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("monaco-editor/esm/vs/editor/editor.api.js");
  for (const moduleName of [...contributionModules, ...workerModules]) {
    vi.doUnmock(moduleName);
  }
  restoreGlobal("self", savedSelf);
  restoreGlobal("document", savedDocument);
  if (savedMutationObserver === undefined) Reflect.deleteProperty(globalThis, "MutationObserver");
  else Object.defineProperty(globalThis, "MutationObserver", savedMutationObserver);
});

describe("Monaco theme setup", () => {
  it("registers Arcelle's dark and light palettes through the editor boundary", async () => {
    const { monacoTheme } = await loadMonacoSetup();

    expect(monacoTheme()).toBe("arcelle-dark");
    expect(mocks.defineTheme).toHaveBeenCalledTimes(2);
    expect(mocks.defineTheme).toHaveBeenCalledWith(
      "arcelle-dark",
      expect.objectContaining({
        base: "vs-dark",
        colors: expect.objectContaining({
          "editor.background": "#151716",
          "editorBracketHighlight.unexpectedBracket.foreground": "#cf8883",
        }),
        rules: expect.arrayContaining([
          expect.objectContaining({ token: "comment", foreground: "8f958c", fontStyle: "italic" }),
          expect.objectContaining({ token: "keyword", foreground: "cc7ecf" }),
        ]),
      }),
    );
    expect(mocks.defineTheme).toHaveBeenCalledWith(
      "arcelle-light",
      expect.objectContaining({
        base: "vs",
        colors: expect.objectContaining({ "editor.background": "#f4f1e8" }),
      }),
    );
  });

  it("does not register themes again when the public theme lookup repeats", async () => {
    const { monacoTheme } = await loadMonacoSetup();

    expect(monacoTheme()).toBe("arcelle-dark");
    document.documentElement.dataset.theme = "light";
    expect(monacoTheme()).toBe("arcelle-light");
    expect(mocks.defineTheme).toHaveBeenCalledTimes(2);
  });

  it("routes fabricated JSON and editor worker requests to their matching constructors", async () => {
    await loadMonacoSetup();
    const environment = (globalThis as typeof globalThis & {
      MonacoEnvironment: { getWorker(workerId: string, label: string): unknown };
    }).MonacoEnvironment;

    expect(environment.getWorker("worker", "json")).toBeInstanceOf(mocks.jsonWorker);
    expect(environment.getWorker("worker", "typescript")).toBeInstanceOf(mocks.editorWorker);
  });

  it("remeasures immediately when the FontFaceSet readiness API is unavailable", async () => {
    const { remeasureWhenFontReady } = await loadMonacoSetup();

    await remeasureWhenFontReady();

    expect(mocks.remeasureFonts).toHaveBeenCalledOnce();
  });

  it("waits for fonts before remeasuring the editor", async () => {
    const ready = Promise.resolve();
    Object.assign(document, { fonts: { ready } });
    const { remeasureWhenFontReady } = await loadMonacoSetup();

    await remeasureWhenFontReady();

    expect(mocks.remeasureFonts).toHaveBeenCalledOnce();
  });

  it("applies theme mutations and disconnects its observer", async () => {
    const observers: Array<{ callback: MutationCallback; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }> = [];
    class FakeMutationObserver {
      disconnect = vi.fn();
      observe = vi.fn();

      constructor(public callback: MutationCallback) {
        observers.push(this);
      }
    }
    Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: FakeMutationObserver });
    const { watchMonacoTheme } = await loadMonacoSetup();

    const stop = watchMonacoTheme();
    document.documentElement.dataset.theme = "light";
    observers[0]?.callback([], {} as MutationObserver);
    stop();

    expect(mocks.setTheme).toHaveBeenNthCalledWith(1, "arcelle-dark");
    expect(mocks.setTheme).toHaveBeenNthCalledWith(2, "arcelle-light");
    expect(observers[0]?.observe).toHaveBeenCalledWith(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
  });
});
