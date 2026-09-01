import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useFileBytes: vi.fn(), unzip: vi.fn(), formatSize: vi.fn((size: number) => `${size} B`), archiveInit: vi.fn(), archiveOpen: vi.fn() }));
vi.mock("./useFileBytes", () => ({ useFileBytes: mocks.useFileBytes }));
vi.mock("fflate", () => ({ unzip: mocks.unzip }));
vi.mock("../api", () => ({ formatSize: mocks.formatSize }));
vi.mock("libarchive.js", () => ({ Archive: { init: mocks.archiveInit, open: mocks.archiveOpen } }));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

async function render(input: Record<string, unknown> = { name: "bundle.zip" }) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>"); const document = parsed.document as unknown as Document; const window = parsed.window as unknown as Window & typeof globalThis;
  Object.defineProperty(window, "location", { configurable: true, value: { href: "http://local.test/" } });
  Reflect.set(globalThis, "window", window); Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "navigator", window.navigator); Reflect.set(globalThis, "HTMLElement", window.HTMLElement); Reflect.set(globalThis, "Event", window.Event); Reflect.set(globalThis, "React", React); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const [{ createRoot }, { default: ArchiveView }] = await Promise.all([import("react-dom/client"), import("./ArchiveView")]); const host = document.getElementById("root"); if (!host) throw new Error("test root missing"); const root = createRoot(host);
  await act(async () => { root.render(createElement(ArchiveView, input)); await Promise.resolve(); await Promise.resolve(); });
  return { host, close: async () => act(async () => root.unmount()) };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function reactClick(element: Element) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  (element as unknown as Record<string, Record<string, () => void>>)[key].onClick();
}

beforeEach(() => { mocks.useFileBytes.mockReset(); mocks.unzip.mockReset(); mocks.formatSize.mockClear(); mocks.archiveInit.mockReset(); mocks.archiveOpen.mockReset(); mocks.useFileBytes.mockReturnValue({ bytes: new Uint8Array([1]), error: null, loading: false }); });
afterEach(() => { vi.clearAllMocks(); for (const [key, value] of Object.entries(originalGlobals)) { if (value === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, value); } });

describe("ArchiveView", () => {
  it("ignores an invalid empty archive path while building the folder tree", async () => {
    const { buildTree } = await import("./ArchiveView");
    expect(buildTree([{ path: "/", size: 0 }]).files).toEqual([]);
  });

  it("lists zip entries without extraction and summarizes their unpacked size", async () => {
    mocks.unzip.mockImplementation((_bytes: Uint8Array, options: { filter: (file: { name: string; originalSize: number }) => boolean }, done: (error: Error | null) => void) => { options.filter({ name: "docs/readme.txt", originalSize: 12 }); options.filter({ name: "misc/empty.txt", originalSize: 0 }); options.filter({ name: "empty/", originalSize: 0 }); done(null); });
    const view = await render();
    expect(view.host.textContent).toContain("2 files"); expect(view.host.textContent).toContain("12 B unpacked"); expect(view.host.textContent).toContain("readme.txt");
    const folder = view.host.querySelector(".zip-folder"); if (!folder) throw new Error("folder toggle missing"); await act(async () => reactClick(folder));
    await view.close();
  });

  it("states read and empty-list outcomes rather than claiming an archive is empty", async () => {
    mocks.unzip.mockImplementation((_bytes: Uint8Array, _options: unknown, done: (error: Error | null) => void) => done(null));
    let view = await render(); expect(view.host.textContent).toContain("No files could be listed"); await view.close();
    mocks.unzip.mockImplementation((_bytes: Uint8Array, _options: unknown, done: (error: Error | null) => void) => done(new Error("bad central directory")));
    view = await render(); expect(view.host.textContent).toContain("This archive could not be read: bad central directory"); await view.close();
  });

  it("keeps file-byte loading and read errors separate from archive parsing", async () => {
    mocks.useFileBytes.mockReturnValueOnce({ bytes: null, error: null, loading: true }); let view = await render(); expect(view.host.textContent).toContain("Opening archive"); await view.close();
    mocks.useFileBytes.mockReturnValueOnce({ bytes: null, error: "file unavailable", loading: false }); view = await render(); expect(view.host.textContent).toContain("file unavailable"); await view.close();
  });

  it("lists a fabricated non-zip archive after its reader opens", async () => {
    const reader = { close: vi.fn().mockResolvedValue(undefined), hasEncryptedData: vi.fn().mockResolvedValue(false), getFilesArray: vi.fn().mockResolvedValue([{ path: "/inside/", file: { name: "note.txt", size: 7 } }]) };
    const opening = deferred<typeof reader>();
    const openingRequested = deferred<void>();
    mocks.archiveOpen.mockImplementationOnce(() => {
      openingRequested.resolve();
      return opening.promise;
    });
    const view = await render({ name: "bundle.7z" });
    await act(async () => {
      await openingRequested.promise;
    });
    expect(view.host.textContent).toContain("Reading archive…");
    await act(async () => {
      opening.resolve(reader);
      await opening.promise;
    });
    expect(view.host.textContent).toContain("note.txt");
    expect(mocks.archiveInit).toHaveBeenCalledOnce();
    await view.close();
    expect(reader.close).toHaveBeenCalled();
  });

  it("reports a password-protected fabricated archive without prompting", async () => {
    const openingRequested = deferred<void>();
    const encryptionChecked = deferred<void>();
    const encryptedResult = deferred<boolean>();
    const closeRequested = deferred<void>();
    const closeFinished = deferred<void>();
    const encrypted = {
      close: vi.fn()
        .mockImplementationOnce(() => { closeRequested.resolve(); return closeFinished.promise; })
        .mockResolvedValue(undefined),
      hasEncryptedData: vi.fn(() => { encryptionChecked.resolve(); return encryptedResult.promise; }),
      getFilesArray: vi.fn(),
    };
    const opening = deferred<typeof encrypted>();
    mocks.archiveOpen.mockImplementationOnce(() => { openingRequested.resolve(); return opening.promise; });
    const view = await render({ name: "locked.rar" });
    await act(async () => { await openingRequested.promise; });
    expect(view.host.textContent).toContain("Reading archive…");
    await act(async () => {
      opening.resolve(encrypted);
      await opening.promise;
      await encryptionChecked.promise;
    });
    await act(async () => {
      encryptedResult.resolve(true);
      await encryptedResult.promise;
      await closeRequested.promise;
    });
    expect(view.host.textContent).toContain("password-protected");
    expect(encrypted.getFilesArray).not.toHaveBeenCalled();
    await act(async () => {
      closeFinished.resolve(undefined);
      await closeFinished.promise;
    });
    await view.close();
    expect(encrypted.close).toHaveBeenCalledTimes(2);
  });
});
