import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  officeHtml: vi.fn<(fileId: string) => Promise<string | null>>(),
  stagePreviewHtml: vi.fn<(html: string) => Promise<string>>(),
}));
const highlights = vi.hoisted(() => ({
  apply: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../workspace/TextView", () => ({
  default: ({ text, quote }: { text: string; quote?: string }) => (
    <div data-text-view="true" data-quote={quote}>{text}</div>
  ),
}));
vi.mock("./QuickLookView", () => ({
  default: ({ fileId, children }: { fileId: string; children: React.ReactNode }) => (
    <div data-quick-look={fileId}>{children}</div>
  ),
}));
vi.mock("./highlight", () => ({
  applyQuoteHighlight: highlights.apply,
  clearQuoteHighlight: highlights.clear,
}));

import OfficeDocView from "./OfficeDocView";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLPreElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Props = React.ComponentProps<typeof OfficeDocView>;

function props(overrides: Partial<Props> = {}): Props {
  return { fileId: "document-1", text: "Readable document text", ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(rounds = 5) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLPreElement", window.HTMLPreElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(OfficeDocView, input));
  });
  await flush();
  return { host, root, close: async () => act(async () => root.unmount()) };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(element: Element) {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React click handler missing");
  const onClick = (element as unknown as Record<string, { onClick: () => void }>)[key]?.onClick;
  if (!onClick) throw new Error("React click handler missing");
  await act(async () => {
    onClick();
  });
  await flush();
}

beforeEach(() => {
  bridge.officeHtml.mockReset().mockResolvedValue("<html><head><style>.source { color: blue; }</style></head><body>Source</body></html>");
  bridge.stagePreviewHtml.mockReset().mockResolvedValue("staged-document");
  highlights.apply.mockReset();
  highlights.clear.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("OfficeDocView", () => {
  it("stages formatted HTML, opens a quote in text mode, and preserves both reading modes", async () => {
    const view = await render(props({ quote: "marked fragment", text: "A marked fragment is readable." }));
    const staged = bridge.stagePreviewHtml.mock.calls[0]?.[0];
    expect(bridge.officeHtml).toHaveBeenCalledWith("document-1");
    expect(staged).toContain("<head><style>");
    expect(staged).toContain("background: #f7f4ec");
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("roomdoc://localhost/staged-document");
    const pre = view.host.querySelector("pre.html-doc");
    expect(pre?.textContent).toBe("A marked fragment is readable.");
    expect(highlights.apply).toHaveBeenCalledWith(pre, "marked fragment");

    await click(button(view.host, "Page"));
    expect(view.host.querySelector("iframe")?.hasAttribute("hidden")).toBe(false);
    expect(view.host.querySelector("pre.html-doc")).toBeNull();
    expect(highlights.clear).toHaveBeenCalled();

    await click(button(view.host, "Text"));
    expect(view.host.querySelector("pre.html-doc")?.textContent).toBe("A marked fragment is readable.");
    await view.close();
  });

  it("keeps the opening state until conversion finishes and stages documents without a head", async () => {
    const html = deferred<string | null>();
    bridge.officeHtml.mockImplementationOnce(() => html.promise);
    const view = await render();
    expect(view.host.textContent).toContain("Opening document…");

    html.resolve("<body>Headless source</body>");
    await flush();
    expect(bridge.stagePreviewHtml.mock.calls[0]?.[0]).toMatch(/^<style>/);
    expect(view.host.querySelector("iframe")?.getAttribute("src")).toBe("roomdoc://localhost/staged-document");
    await view.close();
  });

  it("falls back to Quick Look and extracted text when formatting is absent or conversion fails", async () => {
    bridge.officeHtml.mockResolvedValueOnce(null);
    const unavailable = await render();
    expect(unavailable.host.querySelector("[data-quick-look]")?.getAttribute("data-quick-look")).toBe("document-1");
    expect(unavailable.host.querySelector("[data-text-view]")?.textContent).toBe("Readable document text");
    await unavailable.close();

    bridge.stagePreviewHtml.mockRejectedValueOnce(new Error("TextEdit stopped"));
    const failed = await render(props({ quote: "quote" }));
    expect(failed.host.textContent).toContain("formatting could not be read (Error: TextEdit stopped)");
    expect(failed.host.querySelector("[data-text-view]")?.getAttribute("data-quote")).toBe("quote");
    await failed.close();
  });

  it("honestly says when the formatted document has no extracted text to quote", async () => {
    const view = await render(props({ quote: "missing", text: "   " }));
    expect(view.host.textContent).toContain("No text could be read out of this document.");
    expect(view.host.querySelector("pre.html-doc")).toBeNull();
    await view.close();
  });
});
