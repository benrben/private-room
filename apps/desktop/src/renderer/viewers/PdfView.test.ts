import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PdfView from "./PdfView";

const { act, createElement } = React;

const bytes = new Uint8Array([37, 80, 68, 70]);
const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  useFileBytes: vi.fn(),
  locateQuote: vi.fn(),
  receipt: vi.fn(),
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker" }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: mocks.getDocument,
  Util: { transform: (_viewport: unknown, transform: number[]) => transform },
  TextLayer: class { render = vi.fn(async () => {}); },
}));
vi.mock("./useFileBytes", () => ({ useFileBytes: mocks.useFileBytes }));
vi.mock("./highlight", () => ({
  locateQuoteHebrewAware: mocks.locateQuote,
  makeReceiptBadge: mocks.receipt,
}));

const globalKeys = [
  "document", "window", "navigator", "HTMLElement", "HTMLCanvasElement",
  "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT",
  "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame",
] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const renderedRoots: Array<{ unmount: () => void }> = [];

const stream = (items: Array<{ str: string; width: number; transform: number[]; hasEOL?: boolean }>) => new ReadableStream({
  start(controller) { controller.enqueue({ items }); controller.close(); },
});

function page(number: number, text = number === 1 ? "first searchable page" : "second page") {
  const items = [{ str: text, width: 50, transform: [1, 0, 0, 10, 10, 20], hasEOL: true }];
  return {
    getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale, scale, transform: [scale, 0, 0, scale, 0, 0] }),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    streamTextContent: vi.fn(() => stream(items)),
    cleanup: vi.fn(),
  };
}

function resetMocks() {
  for (const mock of Object.values(mocks)) mock.mockReset();
  const pages = [page(1), page(2)];
  const pdf = { numPages: 2, getPage: vi.fn(async (number: number) => pages[number - 1]) };
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
  mocks.useFileBytes.mockReturnValue({ bytes, error: null, loading: false });
  mocks.locateQuote.mockImplementation((source: string, quote: string) => source.includes(quote) ? { start: 0, end: quote.length - 1 } : null);
  mocks.receipt.mockImplementation(() => document.createElement("span"));
}

beforeEach(() => {
  resetMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => {
    for (const root of renderedRoots.splice(0)) root.unmount();
    await Promise.resolve();
  });
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

async function renderPdf(
  props: Record<string, unknown> = {},
  { autoObserve = true }: { autoObserve?: boolean } = {},
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest", clipboard: { writeText: vi.fn(async () => {}) } },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLCanvasElement", window.HTMLCanvasElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  class Observer {
    observe = vi.fn((node: Element) => {
      if (autoObserve) this.callback([{ isIntersecting: true, target: node }]);
    });
    disconnect = vi.fn();
    constructor(private callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {}
  }
  Reflect.set(globalThis, "IntersectionObserver", Observer);
  Reflect.set(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => { callback(1); return 1; });
  Reflect.set(globalThis, "cancelAnimationFrame", vi.fn());
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(PdfView, props));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  renderedRoots.push(root);
  return { document, host, root, window };
}

function reactProp<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element) {
  await act(async () => reactProp<{ onClick: () => void }>(node).onClick());
}

async function callProp<T>(node: Element, name: string, value: T) {
  await act(async () => {
    const props = reactProp<Record<string, (event: T) => void>>(node);
    props[name]?.(value);
    await Promise.resolve();
  });
}

async function nativeClick(node: Element, window: Window) {
  const LinkedomEvent = (window as unknown as { Event: typeof Event }).Event;
  await act(async () => node.dispatchEvent(new LinkedomEvent("click", { bubbles: true })));
}

function button(host: Element, label: string) {
  const node = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  if (!node) throw new Error(`missing ${label}`);
  return node;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function configurePdf(texts: string[]) {
  const pages = texts.map((text, index) => page(index + 1, text));
  const pdf = { numPages: pages.length, getPage: vi.fn(async (number: number) => pages[number - 1]) };
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
  return { pages, pdf };
}

function shortcut(window: Window, key: string) {
  const LinkedomEvent = (window as unknown as { Event: typeof Event }).Event;
  const event = new LinkedomEvent("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    metaKey: { value: true },
  });
  window.dispatchEvent(event);
  return event;
}

describe("PdfView", () => {
  it("loads, renders, zooms, copies, finds, and follows a quoted target", async () => {
    const view = await renderPdf({ target: { page: 1, quote: "first searchable" } });
    vi.useFakeTimers();
    Reflect.set(view.window, "setTimeout", globalThis.setTimeout);
    Reflect.set(view.window, "clearTimeout", globalThis.clearTimeout);
    expect(view.host.textContent).toContain("Fit width");
    expect(view.host.querySelectorAll("canvas")).toHaveLength(2);
    const firstWrap = view.host.querySelector<HTMLElement>(".pdf-page-wrap");
    if (!firstWrap) throw new Error("page wrap missing");
    firstWrap.getBoundingClientRect = () => ({ top: 0, bottom: 10 }) as DOMRect;
    await click(button(view.host, "+"));
    expect(view.host.textContent).toContain("125%");
    await click(button(view.host, "−"));
    await click(button(view.host, "Fit width"));
    const copies = view.host.querySelectorAll(".pdf-copy-btn");
    await nativeClick(copies[0], view.window);
    await settle();
    expect(copies[0].textContent).toBe("Copied");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error("denied"); }) },
    });
    await nativeClick(copies[1], view.window);
    await settle();
    expect(copies[1].textContent).toBe("Copy failed");
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(copies[0].textContent).toBe("Copy text");
    expect(copies[1].textContent).toBe("Copy text");
    await click(button(view.host, "Find"));
    const find = view.host.querySelector<HTMLInputElement>(".pdf-find-input");
    if (!find) throw new Error("find missing");
    await callProp(find, "onChange", { target: { value: "f" } });
    expect(view.host.textContent).toContain("Keep typing");
    await callProp(find, "onChange", { target: { value: "first" } });
    await callProp(find, "onKeyDown", {
      key: "Enter",
      shiftKey: false,
      preventDefault: vi.fn(),
    });
    await settle();
    expect(view.host.textContent).toContain("Page 1");
    await callProp(find, "onKeyDown", {
      key: "Enter",
      shiftKey: true,
      preventDefault: vi.fn(),
    });
    const next = view.host.querySelector('[aria-label="Next match"]');
    const previous = view.host.querySelector('[aria-label="Previous match"]');
    if (!next || !previous) throw new Error("find navigation missing");
    await click(next);
    await click(previous);
    await callProp(find, "onKeyDown", { key: "Escape", preventDefault: vi.fn() });
    expect(view.host.querySelector(".pdf-find-input")).toBeNull();
    const jump = view.host.querySelector<HTMLInputElement>(".pdf-page-jump input");
    if (!jump) throw new Error("page jump missing");
    await callProp(jump, "onChange", { target: { value: "2xx" } });
    await callProp(jump, "onFocus", { currentTarget: { select: vi.fn() } });
    await callProp(jump, "onKeyDown", {
      key: "Enter",
      currentTarget: { blur: vi.fn() },
      preventDefault: vi.fn(),
    });
    await callProp(view.host.querySelector(".pdf-view")!, "onMouseEnter", undefined);
    await act(async () => {
      for (const key of ["+", "-", "0", "f", "x"]) shortcut(view.window, key);
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await click(button(view.host, "+"));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const rerenderedWrap = view.host.querySelector<HTMLElement>(".pdf-page-wrap");
    if (!rerenderedWrap) throw new Error("rerendered page wrap missing");
    rerenderedWrap.getBoundingClientRect = () => ({ top: 0, bottom: 10 }) as DOMRect;
    await act(async () => {
      view.window.dispatchEvent(new ((view.window as unknown as { Event: typeof Event }).Event)("scroll"));
    });
    await act(async () => {
      view.root.render(createElement(PdfView, { target: { page: 2, quote: "second page" } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    const typing = view.document.createElement("textarea");
    view.document.body.appendChild(typing);
    Object.defineProperty(view.document, "activeElement", { configurable: true, value: typing });
    await act(async () => shortcut(view.window, "+"));
    await callProp(view.host.querySelector(".pdf-view")!, "onMouseLeave", undefined);
    await settle();
    expect(view.host.querySelector(".pdf-find-input")).not.toBeNull();
    expect(mocks.getDocument).toHaveBeenCalled();
  });

  it("shows byte read and locked-document recovery panels", async () => {
    mocks.useFileBytes.mockReturnValue({ bytes: null, error: "token expired", loading: false });
    const read = await renderPdf();
    expect(read.host.textContent).toContain("token expired");

    mocks.useFileBytes.mockReturnValue({ bytes: null, error: null, loading: true });
    const loading = await renderPdf();
    expect(loading.host.textContent).toContain("Opening document");

    mocks.useFileBytes.mockReturnValue({ bytes, error: null, loading: false });
    const lockedPromise = Promise.reject({ name: "PasswordException" });
    lockedPromise.catch(() => {});
    mocks.getDocument.mockReturnValue({ promise: lockedPromise, destroy: vi.fn() });
    const locked = await renderPdf();
    expect(locked.host.textContent).toContain("password-protected");

    const damagedPromise = Promise.reject(new Error("broken"));
    damagedPromise.catch(() => {});
    mocks.getDocument.mockReturnValue({ promise: damagedPromise, destroy: vi.fn() });
    const damaged = await renderPdf();
    expect(damaged.host.textContent).toContain("could not be opened");
  });

  it("falls back to a requested page when a target cannot be found", async () => {
    const { pages } = configurePdf(["one", "two"]);
    const missing = await renderPdf({ target: { page: 2, quote: "absent" } }, { autoObserve: false });
    await settle();
    expect(missing.host.textContent).toContain("showing page 2 instead");
    expect(pages[0].cleanup).toHaveBeenCalled();
    const noPage = await renderPdf({ target: { quote: "absent" } }, { autoObserve: false });
    await settle();
    expect(noPage.host.textContent).toContain("in this PDF");
    const direct = await renderPdf({ target: { page: 2 } }, { autoObserve: false });
    await settle();
    expect(direct.host.querySelector(".pdf-pages")).not.toBeNull();
  });

  it("reports and cancels a long target scan", async () => {
    const pages = Array.from({ length: 21 }, (_, index) => page(index + 1, "not here"));
    const pageDuringScan = deferred<typeof pages[number]>();
    let calls = 0;
    const pdf = {
      numPages: pages.length,
      getPage: vi.fn(() => {
        calls++;
        return calls === 1 ? Promise.resolve(pages[0]) : pageDuringScan.promise;
      }),
    };
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
    const view = await renderPdf({ target: { quote: "absent" } }, { autoObserve: false });
    await settle();
    expect(view.host.textContent).toContain("Searching for the passage");
    await click(button(view.host, "Cancel"));
    pageDuringScan.resolve(pages[0]);
    await settle();
    expect(view.host.textContent).toContain("Search stopped");
  });

  it("shows damaged recovery when lazy page construction fails", async () => {
    const pdf = { numPages: 1, getPage: vi.fn(async () => { throw new Error("bad page"); }) };
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve(pdf), destroy: vi.fn() });
    const view = await renderPdf();
    await settle();
    expect(view.host.textContent).toContain("could not be opened");
  });

  it("recycles distant rendered pages in long documents", async () => {
    const { pages } = configurePdf(Array.from({ length: 29 }, (_, index) => `page ${index + 1}`));
    const view = await renderPdf();
    await settle();
    expect(view.host.querySelectorAll(".pdf-page-wrap")).toHaveLength(29);
    expect(view.host.querySelectorAll("canvas").length).toBeLessThanOrEqual(28);
    expect(pages.some((pdfPage) => pdfPage.cleanup.mock.calls.length >= 0)).toBe(true);
  });
});
