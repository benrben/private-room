import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DecodedRaster, type RasterFormat, useDecodedRaster } from "./useDecodedRaster";

const { act, createElement, useEffect } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT", "Worker", "ImageData"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalUrlMethods = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
};

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<{ id: number; ok: boolean; width?: number; height?: number; rgba?: ArrayBuffer; error?: string }>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(_url: URL, _options: WorkerOptions) {
    FakeWorker.instances.push(this);
  }
}

function Probe({ format, bytes, onState }: { format: RasterFormat | null; bytes: Uint8Array | null; onState: (state: DecodedRaster) => void }) {
  const state = useDecodedRaster(format, bytes);
  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return null;
}

async function flush() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
}

async function render(format: RasterFormat | null, bytes: Uint8Array | null, states: DecodedRaster[]) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true, Worker: FakeWorker, ImageData: class { constructor(..._args: unknown[]) {} } })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe, { format, bytes, onState: (state) => states.push(state) })));
  await flush();
  return { document, root };
}

function lastState(states: DecodedRaster[]): DecodedRaster {
  const state = states.at(-1);
  if (!state) throw new Error("state missing");
  return state;
}

beforeEach(() => {
  FakeWorker.instances = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:decoded") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalUrlMethods.create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalUrlMethods.revoke });
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useDecodedRaster", () => {
  it("keeps non-raster and byte-loading states out of the worker", async () => {
    const states: DecodedRaster[] = [];
    let view = await render(null, new Uint8Array([1]), states);
    expect(lastState(states)).toEqual({ url: null, loading: false, error: "" });
    expect(FakeWorker.instances).toHaveLength(0);
    await act(async () => view.root.unmount());
    states.length = 0;
    view = await render("psd", null, states);
    expect(lastState(states)).toEqual({ url: null, loading: true, error: "" });
    expect(FakeWorker.instances).toHaveLength(0);
    await act(async () => view.root.unmount());
  });

  it("uses only the matching worker reply, draws its pixels, and releases the resulting URL", async () => {
    const states: DecodedRaster[] = [];
    const view = await render("tiff", new Uint8Array([1, 2]), states);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("worker missing");
    const sent = worker.postMessage.mock.calls[0]?.[0] as { id: number } | undefined;
    if (!sent) throw new Error("worker request missing");
    const putImageData = vi.fn();
    const nativeCreateElement = view.document.createElement.bind(view.document);
    vi.spyOn(view.document, "createElement").mockImplementation(((tagName: string) => tagName === "canvas"
      ? { width: 0, height: 0, getContext: () => ({ putImageData }), toBlob: (callback: (blob: Blob | null) => void) => callback({} as Blob) }
      : nativeCreateElement(tagName)) as typeof view.document.createElement);
    await act(async () => worker.onmessage?.({ data: { id: sent.id + 1, ok: false, error: "ignored" } } as MessageEvent));
    expect(lastState(states).loading).toBe(true);
    await act(async () => worker.onmessage?.({ data: { id: sent.id, ok: true, width: 2, height: 1, rgba: new ArrayBuffer(8) } } as MessageEvent));
    await flush();
    expect(putImageData).toHaveBeenCalledOnce();
    expect(lastState(states)).toEqual({ url: "blob:decoded", loading: false, error: "" });
    await act(async () => view.root.unmount());
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:decoded");
  });

  it("reports invalid replies and worker crashes without rendering a misleading image", async () => {
    const states: DecodedRaster[] = [];
    const view = await render("jxl", new Uint8Array([1]), states);
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("worker missing");
    const sent = worker.postMessage.mock.calls[0]?.[0] as { id: number } | undefined;
    if (!sent) throw new Error("worker request missing");
    await act(async () => worker.onmessage?.({ data: { id: sent.id, ok: true, width: 0, height: 1, rgba: new ArrayBuffer(0) } } as MessageEvent));
    expect(lastState(states).error).toBe("This picture could not be decoded.");
    await act(async () => worker.onerror?.({ message: "decoder stopped" } as ErrorEvent));
    expect(lastState(states).error).toBe("decoder stopped");
    await act(async () => view.root.unmount());
  });

  it("reports canvas allocation and blob conversion failures", async () => {
    const states: DecodedRaster[] = [];
    let view = await render("psd", new Uint8Array([1]), states);
    let worker: FakeWorker | undefined = FakeWorker.instances[0];
    if (!worker) throw new Error("worker missing");
    let sent = worker.postMessage.mock.calls[0]?.[0] as { id: number } | undefined;
    if (!sent) throw new Error("worker request missing");
    const nativeCreateElement = view.document.createElement.bind(view.document);
    vi.spyOn(view.document, "createElement").mockImplementation(((tagName: string) => tagName === "canvas"
      ? { width: 0, height: 0, getContext: () => null }
      : nativeCreateElement(tagName)) as typeof view.document.createElement);

    await act(async () => worker?.onmessage?.({ data: { id: sent?.id, ok: true, width: 1, height: 1, rgba: new ArrayBuffer(4) } } as MessageEvent));
    expect(lastState(states).error).toBe("This Mac could not create an image canvas.");
    await act(async () => view.root.unmount());

    states.length = 0;
    view = await render("tiff", new Uint8Array([2]), states);
    worker = FakeWorker.instances.at(-1);
    if (!worker) throw new Error("worker missing");
    sent = worker.postMessage.mock.calls[0]?.[0] as { id: number } | undefined;
    if (!sent) throw new Error("worker request missing");
    const nativeCreateElementAgain = view.document.createElement.bind(view.document);
    vi.spyOn(view.document, "createElement").mockImplementation(((tagName: string) => tagName === "canvas"
      ? { width: 0, height: 0, getContext: () => ({ putImageData: vi.fn() }), toBlob: (callback: (blob: Blob | null) => void) => callback(null) }
      : nativeCreateElementAgain(tagName)) as typeof view.document.createElement);

    await act(async () => worker?.onmessage?.({ data: { id: sent?.id, ok: true, width: 1, height: 1, rgba: new ArrayBuffer(4) } } as MessageEvent));
    expect(lastState(states).error).toBe("The decoded picture could not be drawn.");
    await act(async () => view.root.unmount());
  });
});
