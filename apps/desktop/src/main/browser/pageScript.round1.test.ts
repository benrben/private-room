import { describe, expect, it } from "vitest";
import { loadPageScript } from "./pageScriptHarness.js";

type Snapshot = {
  count: number;
  crossOriginFrames: number;
  elements: Array<{ ref: string; label: string; state?: string }>;
};

async function takeAfterMicrotasks(h: ReturnType<typeof loadPageScript>, ticket: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    await Promise.resolve();
    const taken = h.call("take", { ticket }) as {
      done?: boolean;
      value?: Record<string, unknown>;
    };
    if (taken.done) return taken;
  }
  return h.call("take", { ticket }) as { done?: boolean; value?: Record<string, unknown> };
}

async function takeEventually(h: ReturnType<typeof loadPageScript>, ticket: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const taken = h.call("take", { ticket }) as {
      done?: boolean;
      value?: Record<string, unknown>;
    };
    if (taken.done) return taken;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return h.call("take", { ticket }) as { done?: boolean; value?: Record<string, unknown> };
}

describe("page script round-one fallback behavior", () => {
  it("still exports a working protocol when listeners or Electron exposure refuse", () => {
    const listenerRefusal = loadPageScript("<main>Readable</main>", {
      globals: {
        addEventListener: () => {
          throw new Error("listener refused");
        },
      },
    });
    expect(listenerRefusal.call("ping", {})).toMatchObject({ ok: true });

    const bridgeRefusal = loadPageScript("<main>Readable</main>", {
      globals: {
        require: () => {
          throw new Error("Electron unavailable");
        },
      },
    });
    expect(bridgeRefusal.call("ping", {})).toMatchObject({ ok: true });
  });

  it("handles geometry, native visibility, computed-style, and mark failures independently", () => {
    const geometry = loadPageScript(
      '<button id="rect">Bad rect</button><button id="native">Native hidden</button>' +
        '<input id="computed" aria-label="Query" value="Ada">',
    );
    const rect = geometry.document.getElementById("rect") as unknown as {
      getBoundingClientRect: () => unknown;
    };
    rect.getBoundingClientRect = () => {
      throw new Error("layout unavailable");
    };
    const native = geometry.document.getElementById("native") as unknown as {
      checkVisibility: (options: unknown) => boolean;
    };
    native.checkVisibility = (options) => {
      expect(options).toEqual({ checkVisibilityCSS: true });
      return false;
    };
    geometry.window["getComputedStyle"] = () => {
      throw new Error("computed style unavailable");
    };

    const snap = geometry.call("snapshot", {}) as Snapshot;
    expect(snap.elements).toEqual([
      expect.objectContaining({ label: "Query", state: 'has "Ada"' }),
    ]);

    const visibilityFallback = loadPageScript('<button id="fallback">Fallback</button>');
    const fallback = visibilityFallback.document.getElementById("fallback") as unknown as {
      checkVisibility: () => boolean;
    };
    fallback.checkVisibility = () => {
      throw new Error("native probe unavailable");
    };
    expect((visibilityFallback.call("snapshot", {}) as Snapshot).elements[0]?.label).toBe("Fallback");

    const marking = loadPageScript('<button id="unmarkable">Cannot mark</button>');
    const unmarkable = marking.document.getElementById("unmarkable") as unknown as {
      setAttribute: (name: string, value: string) => void;
    };
    const originalSetAttribute = unmarkable.setAttribute.bind(unmarkable);
    unmarkable.setAttribute = (name, value) => {
      if (name === "data-arcelle-mark") throw new Error("attribute refused");
      originalSetAttribute(name, value);
    };
    expect(marking.call("snapshot", {})).toMatchObject({ count: 0 });
  });

  it("keeps modal, canvas, and frame probes best-effort", () => {
    const modal = loadPageScript('<dialog id="modal" open>Modal</dialog><button>Outside</button>');
    const dialog = modal.document.getElementById("modal") as unknown as { contains: (node: unknown) => boolean };
    Object.defineProperty(dialog, "contains", {
      configurable: true,
      value: () => {
        throw new Error("detached modal tree");
      },
    });
    expect((modal.call("snapshot", {}) as Snapshot).elements.map((entry) => entry.label)).toContain("Outside");

    const canvas = loadPageScript("<canvas id='small'></canvas><canvas id='scene'></canvas>");
    const small = canvas.document.getElementById("small") as unknown as {
      getBoundingClientRect: () => { width: number; height: number };
    };
    small.getBoundingClientRect = () => ({ width: 10, height: 10 });
    const scene = canvas.document.getElementById("scene") as unknown as {
      getBoundingClientRect: () => { width: number; height: number };
    };
    scene.getBoundingClientRect = () => ({ width: 900, height: 700 });
    expect(canvas.internals.lowSignal([])).toBe("canvas covers most of the viewport");

    const originalQuery = canvas.document.querySelectorAll.bind(canvas.document);
    (canvas.document as unknown as { querySelectorAll: (selector: string) => unknown }).querySelectorAll = (
      selector,
    ) => {
      if (selector === "iframe") throw new Error("frame enumeration refused");
      return originalQuery(selector);
    };
    expect((canvas.call("snapshot", {}) as Snapshot).crossOriginFrames).toBe(0);
  });

  it("chooses the largest readable paragraph block and tolerates selector failure", () => {
    const h = loadPageScript(
      "<section><p>Short one.</p><p>Short two.</p><p>Short three.</p></section>" +
        "<div><p>Long passage alpha.</p><p>Long passage beta.</p><p>Long passage gamma.</p></div>",
    );
    const markdown = h.internals.readMarkdown("main");
    expect(markdown).toContain("Long passage gamma.");
    expect(markdown).not.toContain("Short one.");

    const originalQuery = h.document.querySelectorAll.bind(h.document);
    (h.document as unknown as { querySelectorAll: (selector: string) => unknown }).querySelectorAll = (
      selector,
    ) => {
      if (selector === "div, section, article") throw new Error("read-root enumeration refused");
      return originalQuery(selector);
    };
    expect(h.internals.readMarkdown("main")).toContain("Short one.");
  });

  it("retains an unresolved href when URL parsing fails", () => {
    const h = loadPageScript('<main><a href="/broken">Broken destination</a></main>');
    h.window["URL"] = class RefusingUrl {
      constructor() {
        throw new Error("invalid URL");
      }
    };

    expect(h.internals.readMarkdown("full")).toContain("[Broken destination](/broken)");
  });

  it("captures a real selection, handles selection refusal, and tolerates a missing document element", () => {
    const h = loadPageScript("<main>Selected passage</main>");
    h.window["getSelection"] = () => {
      throw new Error("selection unavailable");
    };
    expect(h.call("info", {})).toMatchObject({ ok: true, hasSelection: false });

    h.window["getSelection"] = () => "  Selected passage  ";
    expect(h.call("capture", { what: "selection" })).toMatchObject({
      ok: true,
      what: "selection",
      text: "Selected passage",
      total: 16,
      html: "",
    });

    Object.defineProperty(h.document, "documentElement", { configurable: true, value: null });
    expect(h.internals.pageHtml()).toBe("");

    Object.defineProperty(h.document, "documentElement", {
      configurable: true,
      get() {
        throw new Error("document root unavailable");
      },
    });
    expect(h.internals.pageHtml()).toBe("");
  });

  it("snapshots on a first find and fences a field that becomes secret after numbering", () => {
    const h = loadPageScript('<input id="query" aria-label="Search">');
    expect(h.call("find", { text: "search" })).toMatchObject({
      ok: true,
      matches: [expect.objectContaining({ label: "Search" })],
    });

    h.document.getElementById("query")?.setAttribute("name", "account-password");
    expect(h.internals.resolve("e1")).toMatchObject({ error: expect.stringContaining("fenced") });
  });

  it("falls back to direct value assignment when a prototype descriptor probe throws", () => {
    const h = loadPageScript('<input id="name" aria-label="Name">');
    const snap = h.call("snapshot", {}) as Snapshot;
    const input = h.document.getElementById("name") as unknown as { value: string };
    const prototype = Object.getPrototypeOf(input) as object;
    Object.setPrototypeOf(
      input,
      new Proxy(prototype, {
        getOwnPropertyDescriptor() {
          throw new Error("descriptor unavailable");
        },
      }),
    );

    expect(h.internals.doOne({ type: { ref: snap.elements[0]?.ref, text: "Ada" } })).toMatchObject({
      ok: true,
    });
    expect(input.value).toBe("Ada");
  });

  it("disconnects mutation observers and completes annotation frames", async () => {
    let disconnects = 0;
    let networkNotifications = 0;
    let mutationNotifications = 0;
    const h = loadPageScript("<button>Save</button>");
    h.window["MutationObserver"] = class FakeMutationObserver {
      constructor(private readonly callback: () => void) {}
      observe() {
        mutationNotifications++;
        this.callback();
      }
      disconnect() {
        disconnects++;
        throw new Error("already disconnected");
      }
    };
    h.window["PerformanceObserver"] = class FakePerformanceObserver {
      constructor(private readonly callback: () => void) {}
      observe() {
        networkNotifications++;
        this.callback();
      }
      disconnect() {
        disconnects++;
      }
    };
    h.window["requestAnimationFrame"] = (callback: (time: number) => void) => {
      callback(0);
      return 1;
    };
    Object.defineProperty(h.document, "readyState", { configurable: true, value: "complete" });

    h.call("snapshot", {});
    const annotation = h.call("begin", { op: "annotate", args: { on: true } }) as { ticket: string };
    expect((await takeAfterMicrotasks(h, annotation.ticket)).value).toMatchObject({
      ok: true,
      badges: true,
    });

    const snap = h.call("snapshot", {}) as Snapshot;
    const acting = h.call("begin", {
      op: "act",
      args: { actions: [{ click: snap.elements[0]?.ref, settle_ms: 1 }] },
    }) as { ticket: string };
    let acted = h.call("take", { ticket: acting.ticket }) as { done?: boolean };
    for (let attempt = 0; !acted.done && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      acted = h.call("take", { ticket: acting.ticket }) as { done?: boolean };
    }
    expect(acted.done).toBe(true);
    expect(networkNotifications).toBeGreaterThan(0);
    expect(mutationNotifications).toBeGreaterThan(0);
    expect(disconnects).toBeGreaterThan(0);
  });

  it("times out an empty wait predicate instead of reporting a false hit", async () => {
    const h = loadPageScript("<main>Page</main>");
    Object.defineProperty(h.document, "readyState", { configurable: true, value: "complete" });
    const waiting = h.call("begin", {
      op: "act",
      args: { actions: [{ wait_for: { timeout_ms: 1 } }] },
    }) as { ticket: string };

    expect((await takeEventually(h, waiting.ticket)).value).toMatchObject({
      ok: false,
      results: [{ ok: false, did: "waited, but it never appeared" }],
    });
  });

  it("tickets synchronous async-dispatch failures and totals public handler throws", async () => {
    const h = loadPageScript("<main>Page</main>");
    const malformed = h.call("begin", { op: "__defineGetter__", args: {} }) as { ticket: string };
    expect((await takeAfterMicrotasks(h, malformed.ticket)).value).toMatchObject({ ok: false });

    Object.defineProperty(h.document, "readyState", {
      configurable: true,
      get() {
        throw new Error("ready state unavailable");
      },
    });
    expect(h.call("ping", {})).toEqual({ ok: false, error: "ready state unavailable" });
  });
});
