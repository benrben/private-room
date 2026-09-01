import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const observers: FakeResizeObserver[] = [];

class FakeResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();

  constructor(_callback: ResizeObserverCallback) {
    observers.push(this);
  }
}

import { DocSourceCard, ReadingProgress, useReadingProgress } from "./ReaderShell";

const globalKeys = ["document", "window", "HTMLElement", "ResizeObserver", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

beforeEach(() => {
  observers.length = 0;
});

afterEach(() => {
  for (const key of globalKeys) {
    const value = originalGlobals[key];
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useReadingProgress", () => {
  it("measures scroll position, clamps it, and releases observers on unmount", async () => {
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Reflect.set(globalThis, "window", parsed.window);
    Reflect.set(globalThis, "document", parsed.document);
    Reflect.set(globalThis, "HTMLElement", parsed.window.HTMLElement);
    Reflect.set(globalThis, "ResizeObserver", FakeResizeObserver);
    Reflect.set(globalThis, "React", React);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);

    function Probe(): React.ReactNode {
      const { ref, progress } = useReadingProgress("file-a");
      return createElement("div", { ref, "data-progress": String(progress) }, createElement("span", null, "content"));
    }

    await act(async () => {
      root.render(createElement(Probe));
      await Promise.resolve();
    });
    const scroller = host.firstElementChild as HTMLDivElement | null;
    if (!scroller) throw new Error("scroller missing");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });

    await act(async () => {
      scroller.dispatchEvent(new parsed.window.Event("scroll"));
    });
    expect(scroller.dataset.progress).toBe("0.5");

    scroller.scrollTop = 1000;
    await act(async () => {
      scroller.dispatchEvent(new parsed.window.Event("scroll"));
    });
    expect(scroller.dataset.progress).toBe("1");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observe).toHaveBeenCalledWith(scroller);
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
  });
});

describe("DocSourceCard", () => {
  it("renders known document facts and omits a blank provenance", async () => {
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Reflect.set(globalThis, "window", parsed.window);
    Reflect.set(globalThis, "document", parsed.document);
    Reflect.set(globalThis, "HTMLElement", parsed.window.HTMLElement);
    Reflect.set(globalThis, "React", React);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);
    const file = {
      id: "file-1",
      name: "research.pdf",
      kind: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      createdAt: "2026-09-01T00:00:00.000Z",
      source: "   ",
    };

    await act(async () => {
      root.render(createElement(DocSourceCard, { file: undefined }));
      await Promise.resolve();
    });
    expect(host.textContent).toBe("");

    await act(async () => {
      root.render(createElement(DocSourceCard, { file: file as never }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("research.pdf");
    expect(host.textContent).toContain("Kind");
    expect(host.textContent).toContain("Size");
    expect(host.textContent).toContain("Added");
    expect(host.textContent).not.toContain("From");

    await act(async () => {
      root.render(createElement(DocSourceCard, { file: { ...file, source: " imported file " } as never }));
      await Promise.resolve();
    });
    expect(host.textContent).toContain("From");
    expect(host.textContent).toContain("imported file");

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe("ReadingProgress", () => {
  it("renders an inert scale transform for the measured reading position", async () => {
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Reflect.set(globalThis, "window", parsed.window);
    Reflect.set(globalThis, "document", parsed.document);
    Reflect.set(globalThis, "HTMLElement", parsed.window.HTMLElement);
    Reflect.set(globalThis, "React", React);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.getElementById("root");
    if (!host) throw new Error("test root missing");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);

    await act(async () => root.render(createElement(ReadingProgress, { value: 0.625 })));

    const progress = host.querySelector(".doc-progress");
    expect(progress?.getAttribute("aria-hidden")).not.toBeNull();
    expect((host.querySelector(".doc-progress-ink") as HTMLElement | null)?.style.transform).toBe("scaleX(0.625)");
    await act(async () => root.unmount());
  });
});
