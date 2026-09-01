import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToText, fileUrl, useFileBytes } from "./useFileBytes";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "fetch",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type FileBytes = ReturnType<typeof useFileBytes>;
let state: FileBytes | null = null;

function FileBytesProbe({ token, dataB64 }: { token?: string | null; dataB64?: string | null }) {
  state = useFileBytes(token, dataB64);
  return null;
}

function current(): FileBytes {
  if (!state) throw new Error("File-bytes hook has not rendered.");
  return state;
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function renderHook(token?: string | null, dataB64?: string | null) {
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
  const draw = async (nextToken = token, nextData = dataB64) => {
    await act(async () => root.render(createElement(FileBytesProbe, { token: nextToken, dataB64: nextData })));
  };
  await draw();
  return { close: async () => act(async () => root.unmount()), draw };
}

beforeEach(() => {
  state = null;
  Reflect.set(globalThis, "fetch", vi.fn());
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useFileBytes with a fabricated room-media bridge", () => {
  it("builds only room-media URLs and decodes plain in-memory utility values", () => {
    expect(fileUrl(undefined)).toBeNull();
    expect(fileUrl(null)).toBeNull();
    expect(fileUrl("")).toBeNull();
    expect(fileUrl("fake token")).toBe("roommedia://localhost/fake token");
    expect(bytesToText(null)).toBe("");
    expect(bytesToText(new TextEncoder().encode("fake text"))).toBe("fake text");
  });

  it("honours a fabricated legacy payload before any bridge request, including decoding errors", async () => {
    const valid = await renderHook("ignored-token", "SGk=");
    await flush();
    expect(current()).toEqual({ bytes: new Uint8Array([72, 105]), error: "", loading: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await valid.close();

    const invalid = await renderHook(undefined, "not valid base64!");
    await flush();
    expect(current()).toEqual({ bytes: null, error: "This file could not be decoded.", loading: false });
    await invalid.close();
  });

  it("settles empty input without a request and reads a fabricated streamed buffer", async () => {
    const empty = await renderHook();
    await flush();
    expect(current()).toEqual({ bytes: null, error: "", loading: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await empty.close();

    let resolve!: (response: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const streamed = await renderHook("fake-stream-token");
    expect(current()).toEqual({ bytes: null, error: "", loading: true });
    expect(globalThis.fetch).toHaveBeenCalledWith("roommedia://localhost/fake-stream-token");
    resolve({ ok: true, arrayBuffer: async () => new Uint8Array([3, 4, 5]).buffer });
    await flush();
    expect(current()).toEqual({ bytes: new Uint8Array([3, 4, 5]), error: "", loading: false });
    await streamed.close();
  });

  it("reports fabricated bridge failures and ignores work that resolves after close", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status: 410 });
    const rejected = await renderHook("gone-token");
    await flush();
    expect(current().error).toContain("Error: the room returned 410");
    expect(current().loading).toBe(false);
    await rejected.close();

    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fake transport failure"));
    const broken = await renderHook("broken-token");
    await flush();
    expect(current().error).toContain("Error: fake transport failure");
    await broken.close();

    let resolve!: (response: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const late = await renderHook("late-token");
    await late.close();
    resolve({ ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer });
    await flush();
    expect(current()).toEqual({ bytes: null, error: "", loading: true });

    let reject!: (reason: Error) => void;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const lateFailure = await renderHook("late-failure-token");
    await lateFailure.close();
    reject(new Error("fake failure after close"));
    await flush();
    expect(current()).toEqual({ bytes: null, error: "", loading: true });
  });
});
