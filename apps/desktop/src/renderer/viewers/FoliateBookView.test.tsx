import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  makeFB2: vi.fn(),
  makeComicBook: vi.fn(),
  mobiOpen: vi.fn(),
  mobiOptions: null as { unzlib: (data: ArrayBuffer) => Promise<Uint8Array> } | null,
  unzipSync: vi.fn(),
  unzlib: vi.fn(),
  fetch: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
  createdBlobs: [] as Blob[],
}));

vi.mock("fflate", () => ({ unzipSync: bridge.unzipSync, unzlib: bridge.unzlib }));
vi.mock("foliate-js/fb2.js", () => ({ makeFB2: bridge.makeFB2 }));
vi.mock("foliate-js/comic-book.js", () => ({ makeComicBook: bridge.makeComicBook }));
vi.mock("foliate-js/mobi.js", () => ({
  MOBI: class {
    constructor(options: { unzlib: (data: ArrayBuffer) => Promise<Uint8Array> }) {
      bridge.mobiOptions = options;
    }

    open(file: File) {
      return bridge.mobiOpen(file);
    }
  },
}));

import FoliateBookView from "./FoliateBookView";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
  "fetch",
  "URL",
] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function section(load: () => Promise<string> | string) {
  return { load: vi.fn(load), unload: vi.fn() };
}

function book(sections: ReturnType<typeof section>[], title = "A fabricated book") {
  return { metadata: { title }, sections, destroy: vi.fn() };
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

function response(
  body: string,
  options: { ok?: boolean; status?: number; contentType?: string | null } = {},
) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: { get: vi.fn().mockReturnValue(options.contentType ?? null) },
    text: vi.fn().mockResolvedValue(body),
  };
}

async function flush(rounds = 3) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function renderBook(name: string, bytes = new Uint8Array([1, 2, 3])) {
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
  })) {
    Reflect.set(globalThis, key, value);
  }
  Reflect.set(globalThis, "fetch", bridge.fetch);
  Reflect.set(globalThis, "URL", {
    createObjectURL: bridge.createObjectURL,
    revokeObjectURL: bridge.revokeObjectURL,
  });
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(FoliateBookView, { name, bytes })));
  return { host, root, window };
}

async function mount(name: string, bytes = new Uint8Array([1, 2, 3])) {
  const view = await renderBook(name, bytes);
  await flush();
  return view;
}

async function expectRenderedText(host: Element, expected: string) {
  await act(async () => {
    await vi.waitFor(() => {
      expect(host.textContent).toContain(expected);
    });
  });
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

beforeEach(() => {
  bridge.makeFB2.mockReset();
  bridge.makeComicBook.mockReset();
  bridge.mobiOpen.mockReset();
  bridge.mobiOptions = null;
  bridge.unzipSync.mockReset().mockReturnValue({});
  bridge.unzlib.mockReset();
  bridge.fetch.mockReset();
  bridge.createObjectURL.mockReset().mockImplementation((blob: Blob) => {
    bridge.createdBlobs.push(blob);
    return `blob:repaired-${bridge.createdBlobs.length}`;
  });
  bridge.revokeObjectURL.mockReset();
  bridge.createdBlobs = [];
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("FoliateBookView", () => {
  it("opens a fabricated FB2, draws pages, and cleans up page and book ownership", async () => {
    const first = section(() => "blob:first-page");
    const second = section(() => "blob:second-page");
    const opened = book([first, second], "Two pages");
    const opening = deferred<ReturnType<typeof book>>();
    const openingRequested = deferred<void>();
    bridge.makeFB2.mockImplementationOnce(() => {
      openingRequested.resolve();
      return opening.promise;
    });
    const view = await renderBook("novel.fb2");
    await act(async () => {
      await openingRequested.promise;
    });
    expect(view.host.textContent).toContain("Opening book…");
    await act(async () => {
      opening.resolve(opened);
      await opening.promise;
    });

    expect(view.host.querySelector(".book-where")?.textContent).toContain("Two pages · 1 of 2");
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("blob:first-page");
    expect(button(view.host, "Previous").disabled).toBe(true);
    await click(button(view.host, "Next"), view.window);
    expect(first.unload).toHaveBeenCalledOnce();
    expect(view.host.querySelector(".book-where")?.textContent).toContain("2 of 2");
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("blob:second-page");
    expect(button(view.host, "Next").disabled).toBe(true);
    await click(button(view.host, "Previous"), view.window);
    expect(second.unload).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
    expect(opened.destroy).toHaveBeenCalledOnce();
    expect(first.unload).toHaveBeenCalledTimes(2);
  });

  it("shows fabricated unsupported, empty-book, and page-load failures", async () => {
    const unsupported = await mount("notes.pdf");
    expect(unsupported.host.textContent).toContain("This book format is not supported.");
    await act(async () => unsupported.root.unmount());

    const noPages = book([]);
    bridge.makeFB2.mockResolvedValueOnce(noPages);
    const empty = await mount("empty.fb2");
    expect(empty.host.textContent).toContain("No readable pages were found.");
    await act(async () => empty.root.unmount());
    expect(noPages.destroy).toHaveBeenCalledOnce();

    const unreadable = section(() => Promise.reject(new Error("page source was lost")));
    bridge.makeFB2.mockResolvedValueOnce(book([unreadable]));
    const failedPage = await mount("broken.fb2");
    await expectRenderedText(
      failedPage.host,
      "This page could not be shown: page source was lost",
    );
    await act(async () => failedPage.root.unmount());

    const opening = deferred<ReturnType<typeof book>>();
    const openingRequested = deferred<void>();
    bridge.makeFB2.mockImplementationOnce(() => {
      openingRequested.resolve();
      return opening.promise;
    });
    const rawBookFailure = await renderBook("raw-book.fb2");
    await act(async () => {
      await openingRequested.promise;
    });
    expect(rawBookFailure.host.textContent).toContain("Opening book…");
    await act(async () => {
      opening.reject("raw book failure");
      await opening.promise.catch(() => undefined);
    });
    expect(rawBookFailure.host.textContent).toContain("This book could not be read: raw book failure");
    await act(async () => rawBookFailure.root.unmount());

    bridge.makeFB2.mockResolvedValueOnce(book([section(() => Promise.reject("raw page failure"))]));
    const rawPageFailure = await mount("raw-page.fb2");
    await expectRenderedText(rawPageFailure.host, "This page could not be shown: raw page failure");
    await act(async () => rawPageFailure.root.unmount());
  });

  it("opens a fabricated comic archive and exposes only mocked comic entries", async () => {
    const comicSection = section(() => "blob:comic-page");
    const opened = book([comicSection], "A comic");
    const opening = deferred<ReturnType<typeof book>>();
    const openingRequested = deferred<void>();
    bridge.unzipSync.mockReturnValue({ "cover.jpg": new Uint8Array([3, 4]) });
    bridge.makeComicBook.mockImplementationOnce(() => {
      openingRequested.resolve();
      return opening.promise;
    });
    const view = await renderBook("comic.cbz");
    await act(async () => {
      await openingRequested.promise;
    });
    expect(view.host.textContent).toContain("Opening book…");

    const [source] = bridge.makeComicBook.mock.calls[0]!;
    expect(source.entries).toEqual([{ filename: "cover.jpg" }]);
    expect(source.getSize("cover.jpg")).toBe(2);
    expect(source.getSize("missing.jpg")).toBe(0);
    expect(await source.getComment()).toBeNull();
    expect(await source.loadBlob("cover.jpg")).toBeInstanceOf(Blob);
    await act(async () => {
      opening.resolve(opened);
      await opening.promise;
    });
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("blob:comic-page");
    await act(async () => view.root.unmount());
  });

  it("repairs fabricated MOBI markup, uses the content-type fallback, and handles its injected inflater", async () => {
    const first = section(() => "blob:mobi-first");
    const second = section(() => "blob:mobi-second");
    bridge.mobiOpen.mockResolvedValue(book([first, second], "MOBI title"));
    bridge.fetch
      .mockResolvedValueOnce(response('<meta charset="windows-1252">it’s first', { contentType: "application/xhtml+xml; charset=windows-1252" }))
      .mockResolvedValueOnce(response("second"));
    const view = await mount("book.mobi");

    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("blob:repaired-1");
    expect(view.host.querySelector("iframe")?.getAttribute("title")).toBe("MOBI title, page 1");
    expect(bridge.createdBlobs[0]?.type).toBe("application/xhtml+xml;charset=utf-8");
    expect(await bridge.createdBlobs[0]?.text()).toContain('charset="utf-8"');
    await click(button(view.host, "Next"), view.window);
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("blob:repaired-2");
    expect(bridge.createdBlobs[1]?.type).toBe("text/html;charset=utf-8");

    bridge.unzlib.mockImplementationOnce((_data: Uint8Array, callback: (error: Error | null, output?: Uint8Array) => void) => callback(null, new Uint8Array([9])));
    await expect(bridge.mobiOptions?.unzlib(new ArrayBuffer(1))).resolves.toEqual(new Uint8Array([9]));
    bridge.unzlib.mockImplementationOnce((_data: Uint8Array, callback: (error: Error | null, output?: Uint8Array) => void) => callback(new Error("inflate failed")));
    await expect(bridge.mobiOptions?.unzlib(new ArrayBuffer(1))).rejects.toThrow("inflate failed");
    bridge.unzlib.mockImplementationOnce((_data: Uint8Array, callback: (error: Error | null, output?: Uint8Array) => void) => callback(null));
    await expect(bridge.mobiOptions?.unzlib(new ArrayBuffer(1))).rejects.toThrow("compressed book resource was empty");

    await act(async () => view.root.unmount());
    expect(bridge.revokeObjectURL).toHaveBeenCalledWith("blob:repaired-2");
  });

  it("reports a fabricated generated-page response failure", async () => {
    const opened = book([section(() => "blob:generated")]);
    const opening = deferred<ReturnType<typeof book>>();
    const openingRequested = deferred<void>();
    const pageResponse = deferred<ReturnType<typeof response>>();
    const fetchRequested = deferred<void>();
    bridge.mobiOpen.mockImplementationOnce(() => {
      openingRequested.resolve();
      return opening.promise;
    });
    bridge.fetch.mockImplementationOnce(() => {
      fetchRequested.resolve();
      return pageResponse.promise;
    });
    const view = await renderBook("unavailable.azw3");
    await act(async () => {
      await openingRequested.promise;
    });
    expect(view.host.textContent).toContain("Opening book…");
    await act(async () => {
      opening.resolve(opened);
      await opening.promise;
    });
    await act(async () => {
      await fetchRequested.promise;
    });
    expect(view.host.textContent).toContain("Drawing page…");
    await act(async () => {
      pageResponse.resolve(response("", { ok: false, status: 503 }));
      await pageResponse.promise;
    });
    expect(view.host.textContent).toContain("The generated page returned 503.");
    await act(async () => view.root.unmount());
  });

  it("releases late ordinary and generated page resources after unmount", async () => {
    const lateOrdinary = deferred<string>();
    const ordinaryLoadRequested = deferred<void>();
    const ordinarySection = section(() => {
      ordinaryLoadRequested.resolve();
      return lateOrdinary.promise;
    });
    const ordinaryOpened = book([ordinarySection]);
    const ordinaryOpening = deferred<ReturnType<typeof book>>();
    const ordinaryOpeningRequested = deferred<void>();
    bridge.makeFB2.mockImplementationOnce(() => {
      ordinaryOpeningRequested.resolve();
      return ordinaryOpening.promise;
    });
    const ordinary = await renderBook("late.fb2");
    await act(async () => { await ordinaryOpeningRequested.promise; });
    await act(async () => {
      ordinaryOpening.resolve(ordinaryOpened);
      await ordinaryOpening.promise;
    });
    await act(async () => { await ordinaryLoadRequested.promise; });
    expect(ordinary.host.textContent).toContain("Drawing page…");
    await act(async () => ordinary.root.unmount());
    expect(ordinarySection.unload).toHaveBeenCalledOnce();
    const lateOrdinaryUnloaded = deferred<void>();
    ordinarySection.unload.mockImplementationOnce(() => lateOrdinaryUnloaded.resolve());
    await act(async () => {
      lateOrdinary.resolve("blob:late");
      await lateOrdinary.promise;
      await lateOrdinaryUnloaded.promise;
    });
    expect(ordinarySection.unload).toHaveBeenCalledTimes(2);

    const lateText = deferred<string>();
    const generatedTextRequested = deferred<void>();
    const generatedUrlCreated = deferred<void>();
    const generatedSection = section(() => "blob:late-generated");
    const generatedOpened = book([generatedSection]);
    const generatedOpening = deferred<ReturnType<typeof book>>();
    const generatedOpeningRequested = deferred<void>();
    bridge.mobiOpen.mockImplementationOnce(() => {
      generatedOpeningRequested.resolve();
      return generatedOpening.promise;
    });
    bridge.fetch.mockImplementationOnce(() => ({
      ok: true,
      status: 200,
      headers: { get: vi.fn().mockReturnValue("text/html") },
      text: vi.fn(() => {
        generatedTextRequested.resolve();
        return lateText.promise;
      }),
    }));
    bridge.createObjectURL.mockImplementationOnce((blob: Blob) => {
      bridge.createdBlobs.push(blob);
      generatedUrlCreated.resolve();
      return "blob:repaired-1";
    });
    const generated = await renderBook("late.mobi");
    await act(async () => { await generatedOpeningRequested.promise; });
    await act(async () => {
      generatedOpening.resolve(generatedOpened);
      await generatedOpening.promise;
    });
    await act(async () => { await generatedTextRequested.promise; });
    expect(generated.host.textContent).toContain("Drawing page…");
    await act(async () => generated.root.unmount());
    await act(async () => {
      lateText.resolve("<html>late</html>");
      await lateText.promise;
      await generatedUrlCreated.promise;
    });
    expect(bridge.revokeObjectURL).toHaveBeenCalledWith("blob:repaired-1");
  });

  it("destroys a fabricated book that resolves after the reader unmounts", async () => {
    const lateBook = deferred<ReturnType<typeof book>>();
    bridge.makeFB2.mockReturnValue(lateBook.promise);
    const view = await mount("late-open.fb2");
    expect(view.host.textContent).toContain("Opening book…");
    await act(async () => view.root.unmount());
    const opened = book([section(() => "blob:unused")]);
    await act(async () => {
      lateBook.resolve(opened);
      await vi.waitFor(() => expect(opened.destroy).toHaveBeenCalledOnce());
    });
  });
});
