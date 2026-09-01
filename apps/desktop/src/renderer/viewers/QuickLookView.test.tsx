import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ quicklookPreview: vi.fn() }));

vi.mock("../api", () => ({ api: bridge }));

import QuickLookView from "./QuickLookView";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLImageElement",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Props = React.ComponentProps<typeof QuickLookView>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush(rounds = 5) {
  await act(async () => {
    for (let tick = 0; tick < rounds; tick += 1) await Promise.resolve();
  });
}

async function render(input: Props = { fileId: "file-1" }) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLImageElement", window.HTMLImageElement);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async (next: Props) => {
    await act(async () => {
      root.render(createElement(QuickLookView, next));
    });
    await flush();
  };
  await draw(input);
  return { host, root, draw, close: async () => act(async () => root.unmount()) };
}

beforeEach(() => {
  bridge.quicklookPreview.mockReset().mockResolvedValue({ pngB64: "preview-png" });
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("QuickLookView", () => {
  it("keeps the loading state until a mocked preview is ready, then describes the image honestly", async () => {
    const pending = deferred<{ pngB64: string } | null>();
    bridge.quicklookPreview.mockImplementationOnce(() => pending.promise);
    const view = await render();
    expect(view.host.textContent).toContain("Asking macOS to draw a preview…");
    expect(view.host.querySelector("img")).toBeNull();

    pending.resolve({ pngB64: "rendered-png" });
    await flush();
    expect(bridge.quicklookPreview).toHaveBeenCalledWith("file-1");
    expect(view.host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,rendered-png");
    expect(view.host.textContent).toContain("a picture of the file");
    await view.close();
  });

  it("shows absent and failed previews only when no readable fallback was supplied", async () => {
    bridge.quicklookPreview.mockResolvedValueOnce(null);
    const absent = await render();
    expect(absent.host.textContent).toContain("No preview available for this file type");
    await absent.close();

    bridge.quicklookPreview.mockRejectedValueOnce(new Error("renderer stopped"));
    const failed = await render();
    expect(failed.host.textContent).toContain("preview couldn't be drawn (Error: renderer stopped)");
    await failed.close();

    bridge.quicklookPreview.mockResolvedValueOnce(null);
    const fallback = await render({ fileId: "file-2", children: createElement("p", null, "Readable fallback") });
    expect(fallback.host.textContent).toContain("Readable fallback");
    expect(fallback.host.textContent).not.toContain("No preview available for this file type");
    await fallback.close();
  });

  it("discards a stale preview after the file changes", async () => {
    const first = deferred<{ pngB64: string } | null>();
    bridge.quicklookPreview
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ pngB64: "second-png" });
    const view = await render({ fileId: "file-1" });
    await view.draw({ fileId: "file-2" });
    first.resolve({ pngB64: "stale-png" });
    await flush();
    expect(bridge.quicklookPreview).toHaveBeenNthCalledWith(1, "file-1");
    expect(bridge.quicklookPreview).toHaveBeenNthCalledWith(2, "file-2");
    expect(view.host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,second-png");
    await view.close();
  });
});
