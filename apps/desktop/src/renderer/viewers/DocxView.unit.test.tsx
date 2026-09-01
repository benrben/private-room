import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  renderAsync: vi.fn<(data: ArrayBuffer, container: HTMLElement, style: undefined, options: Record<string, boolean>) => Promise<void>>(),
  useFileBytes: vi.fn(),
  applyQuoteHighlight: vi.fn(),
  clearQuoteHighlight: vi.fn(),
}));

vi.mock("docx-preview", () => ({ renderAsync: fakes.renderAsync }));
vi.mock("./useFileBytes", () => ({ useFileBytes: fakes.useFileBytes }));
vi.mock("./highlight", () => ({
  applyQuoteHighlight: fakes.applyQuoteHighlight,
  clearQuoteHighlight: fakes.clearQuoteHighlight,
}));

import DocxView from "./DocxView";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type FileBytes = { bytes?: Uint8Array; error: string; loading: boolean };

function fileBytes(overrides: Partial<FileBytes> = {}): FileBytes {
  return { bytes: undefined, error: "", loading: false, ...overrides };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(props: React.ComponentProps<typeof DocxView>) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(DocxView, props)));
  return { host, root };
}

beforeEach(() => {
  fakes.renderAsync.mockReset().mockResolvedValue(undefined);
  fakes.useFileBytes.mockReset().mockReturnValue(fileBytes());
  fakes.applyQuoteHighlight.mockReset();
  fakes.clearQuoteHighlight.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("DocxView with fabricated byte and document-preview APIs", () => {
  it("keeps a pending document visibly opening without asking a parser to run", async () => {
    fakes.useFileBytes.mockReturnValue(fileBytes({ loading: true }));
    const view = await render({ mediaToken: "fake-media-token", dataB64: "fake-base64" });

    expect(fakes.useFileBytes).toHaveBeenCalledWith("fake-media-token", "fake-base64");
    expect(view.host.querySelector(".viewer-status")?.textContent).toBe("Opening document…");
    expect(fakes.renderAsync).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
    expect(fakes.clearQuoteHighlight).not.toHaveBeenCalled();
  });

  it("renders fabricated bytes with the complete preview options and highlights a requested quote", async () => {
    const bytes = new Uint8Array([11, 22, 33]);
    fakes.useFileBytes.mockReturnValue(fileBytes({ bytes }));
    const view = await render({ mediaToken: "fake-media-token", target: { quote: "fake quote" } });
    await flush();

    expect(fakes.renderAsync).toHaveBeenCalledOnce();
    const [buffer, container, style, options] = fakes.renderAsync.mock.calls[0]!;
    expect(Array.from(new Uint8Array(buffer))).toEqual([11, 22, 33]);
    expect(container).toBe(view.host.querySelector(".docx-view > div:last-child"));
    expect(style).toBeUndefined();
    expect(options).toEqual({
      inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
      renderHeaders: true, renderFooters: true, renderFootnotes: true,
      renderEndnotes: true, renderComments: true, ignoreWidth: false,
      ignoreHeight: false, experimental: true,
    });
    expect(fakes.applyQuoteHighlight).toHaveBeenCalledWith(container, "fake quote");
    await act(async () => view.root.unmount());
    expect(fakes.clearQuoteHighlight).toHaveBeenCalledOnce();
  });

  it("surfaces fabricated read and render errors instead of presenting a dead preview as loading", async () => {
    fakes.useFileBytes.mockReturnValue(fileBytes({ error: "fake read failure" }));
    const unreadable = await render({});
    expect(unreadable.host.querySelector('[role="alert"]')?.textContent).toBe("fake read failure");
    await act(async () => unreadable.root.unmount());

    fakes.useFileBytes.mockReturnValue(fileBytes({ bytes: new Uint8Array([7]) }));
    fakes.renderAsync.mockRejectedValueOnce("fake renderer failure");
    const broken = await render({});
    await flush();
    expect(broken.host.querySelector('[role="alert"]')?.textContent).toBe("Could not render document: fake renderer failure");
    await act(async () => broken.root.unmount());
  });

  it("does not apply a quote after its fabricated render is cancelled", async () => {
    let resolve!: () => void;
    fakes.useFileBytes.mockReturnValue(fileBytes({ bytes: new Uint8Array([9]) }));
    fakes.renderAsync.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = await render({ target: { quote: "not after close" } });

    await act(async () => view.root.unmount());
    resolve();
    await flush();
    expect(fakes.applyQuoteHighlight).not.toHaveBeenCalled();
    expect(fakes.clearQuoteHighlight).toHaveBeenCalledOnce();
  });
});
