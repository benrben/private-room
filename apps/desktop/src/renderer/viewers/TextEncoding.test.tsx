import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecodedFileText, FileContent } from "../api";
import { encodingSaveNote, RE_DECODABLE_KINDS, useTextEncoding } from "./TextEncoding";

const { decodeFileText } = vi.hoisted(() => ({ decodeFileText: vi.fn() }));

vi.mock("../api", () => ({ api: { decodeFileText } }));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function content(overrides: Partial<FileContent> = {}): FileContent {
  return {
    kind: "code",
    name: "legacy.txt",
    mime: "text/plain",
    editable: true,
    text: "original",
    dataB64: null,
    mediaToken: null,
    mediaMeta: null,
    webMeta: null,
    ...overrides,
  };
}

function decoded(overrides: Partial<DecodedFileText> = {}): DecodedFileText {
  return {
    text: "decoded text",
    encoding: "windows-1254",
    source: "detected",
    lossy: false,
    editable: true,
    options: [{ name: "windows-1254", title: "Turkish (Windows-1254)" }],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe({ fileId, file }: { fileId: string; file: FileContent }) {
  const state = useTextEncoding(fileId, file);
  return (
    <div data-key={state.key} data-text={state.text ?? ""}>
      {state.alert}
      {state.picker}
    </div>
  );
}

async function render(file = content(), fileId = "file-1") {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Probe, { fileId, file }));
    await Promise.resolve();
  });
  return {
    host,
    rerender: async (nextFile: FileContent, nextFileId = fileId) => act(async () => {
      root.render(createElement(Probe, { fileId: nextFileId, file: nextFile }));
      await Promise.resolve();
      await Promise.resolve();
    }),
    close: async () => act(async () => root.unmount()),
  };
}

function reactHandler(element: Element, name: string) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key][name];
}

function probe(host: Element): Element {
  const element = host.firstElementChild;
  if (!element) throw new Error("encoding probe missing");
  return element;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("TextEncoding", () => {
  it("keeps encoding controls out of non-byte and MSG container viewers", async () => {
    const pdf = await render(content({ kind: "pdf" }));
    expect(pdf.host.querySelector("select")).toBeNull();
    expect(decodeFileText).not.toHaveBeenCalled();
    await pdf.close();

    const msg = await render(content({ kind: "email", name: "mail.MSG" }));
    expect(msg.host.querySelector("select")).toBeNull();
    expect(decodeFileText).not.toHaveBeenCalled();
    await msg.close();
  });

  it("discards a stale re-read after its file bytes change and applies the user choice", async () => {
    const oldRead = deferred<DecodedFileText>();
    const newRead = deferred<DecodedFileText>();
    const chosenRead = deferred<DecodedFileText>();
    decodeFileText
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(newRead.promise)
      .mockReturnValueOnce(chosenRead.promise);
    const view = await render(content({ text: "old bytes" }));
    expect(decodeFileText).toHaveBeenCalledWith("file-1", null);

    await view.rerender(content({ text: "new bytes" }));
    expect(decodeFileText).toHaveBeenCalledTimes(2);
    oldRead.resolve(decoded({ text: "stale decoding" }));
    await flush();
    expect(probe(view.host).getAttribute("data-text")).not.toBe("stale decoding");

    newRead.resolve(decoded({ text: "fresh decoding", lossy: true }));
    await flush();
    expect(probe(view.host).getAttribute("data-text")).toBe("fresh decoding");
    expect(view.host.textContent).toContain("a guess");
    expect(view.host.textContent).toContain("Some bytes have no meaning");
    const select = view.host.querySelector("select");
    if (!select) throw new Error("encoding picker missing");
    await act(async () => reactHandler(select, "onChange")({ target: { value: "windows-1254" } }));
    expect(decodeFileText).toHaveBeenLastCalledWith("file-1", "windows-1254");
    chosenRead.resolve(decoded({ text: "chosen decoding", source: "chosen" }));
    await flush();
    expect(probe(view.host).getAttribute("data-key")).toBe("windows-1254");
    expect(view.host.textContent).toContain("your choice");
    expect(view.host.textContent).toContain("Let Arcelle decide");
    await view.close();
  });

  it("shows a failed reread without offering a picker", async () => {
    decodeFileText.mockRejectedValueOnce(new Error("decoder unavailable"));
    const view = await render();
    await flush();
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain("couldn't be checked");
    expect(view.host.textContent).toContain("decoder unavailable");
    expect(view.host.querySelector("select")).toBeNull();
    await view.close();
  });

  it("describes save conversion and all automatic-reading sources", async () => {
    expect(RE_DECODABLE_KINDS.has("subtitle")).toBe(true);
    expect(encodingSaveNote(null)).toBeNull();
    expect(encodingSaveNote(decoded({ encoding: "UTF-8" }))).toBeNull();
    expect(encodingSaveNote(decoded({ source: "chosen" }))).toContain("as you chose");
    expect(encodingSaveNote(decoded({ source: "bom" }))).toContain("byte-order mark");
    expect(encodingSaveNote(decoded({ source: "detected" }))).toContain("Arcelle guessed");

    decodeFileText.mockResolvedValueOnce(decoded({ source: "bom" }));
    const bom = await render();
    await flush();
    expect(bom.host.textContent).toContain("which this file states");
    await bom.close();

    decodeFileText.mockResolvedValueOnce(decoded({ source: "utf8", encoding: "UTF-8" }));
    const utf8 = await render();
    await flush();
    expect(utf8.host.textContent).toContain("Read as UTF-8.");
    await utf8.close();
  });
});
