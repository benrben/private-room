import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyQuoteHighlight,
  clearQuoteHighlight,
  locateQuoteHebrewAware,
  makeReceiptBadge,
  normalizeForMatch,
  parseA1Range,
} from "./highlight.js";

const globalKeys = ["window", "document", "HTMLElement", "NodeFilter", "CSS", "requestAnimationFrame"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

afterEach(() => {
  try { clearQuoteHighlight(); } catch { /* no DOM was installed */ }
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function installDom(body: string, rangeNodes = { commonText: false, startElement: false }): {
  highlights: Map<string, unknown>;
  root: HTMLElement;
  scheduled: FrameRequestCallback[];
  window: Window & typeof globalThis;
} {
  const parsed = parseHTML(`<html><body>${body}</body></html>`);
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const root = document.getElementById("root") as HTMLElement | null;
  if (!root) throw new Error("test root missing");
  const highlights = new Map<string, unknown>();
  const scheduled: FrameRequestCallback[] = [];
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "NodeFilter", window.NodeFilter ?? { SHOW_TEXT: 4 });
  Reflect.set(globalThis, "CSS", { highlights });
  Reflect.set(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    scheduled.push(callback);
    return scheduled.length;
  });
  document.createRange = (() => {
    let startNode: Node | null = null;
    return {
      setStart(node: Node) { startNode = node; },
      setEnd() {},
      get startContainer() {
        return rangeNodes.startElement ? startNode?.parentNode ?? root : startNode;
      },
      get commonAncestorContainer() {
        return rangeNodes.commonText ? startNode ?? root : startNode?.parentNode ?? root;
      },
    } as unknown as Range;
  }) as typeof document.createRange;
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  return { highlights, root, scheduled, window };
}

describe("quote normalization", () => {
  it("folds typographic groups and Hebrew marks without dropping excluded punctuation", () => {
    expect(normalizeForMatch(" “A—B” ﬁ ﬂ C­D ")).toBe('"a-b" fi fl cd');
    expect(normalizeForMatch("שָׁלוֹם־עולם\u05c0\u05c3\u05c6")).toBe("שלום-עולם\u05c0\u05c3\u05c6");
  });

  it("maps a folded multi-character quote back to the original source offsets", () => {
    const source = "x co­operate infor-\nmation";
    expect(locateQuoteHebrewAware(source, "cooperate information")).toEqual({
      start: source.indexOf("c"),
      end: source.length - 1,
    });
  });

  it("uses the whitespace-free fallback only after normalized matching misses", () => {
    expect(locateQuoteHebrewAware("alpha beta", "alphabeta")).toEqual({ start: 0, end: 9 });
    expect(locateQuoteHebrewAware("alpha beta", "not present")).toBeNull();
  });
});

describe("Hebrew visual-order quote location", () => {
  it("mirrors Hebrew-bearing source lines and returns original source bounds", () => {
    const source = "heading\nםולש\nfooter";
    expect(locateQuoteHebrewAware(source, "שלום")).toEqual({ start: 8, end: 11 });
  });

  it("does not mirror a non-Hebrew quote that is absent from the source", () => {
    expect(locateQuoteHebrewAware("heading\nםולש\nfooter", "missing")).toBeNull();
  });
});

describe("DOM quote highlighting", () => {
  it("highlights a quote spanning text nodes and clears the CSS registry entry", () => {
    const { highlights, root, window } = installDom("<div id='root'><span>First </span><em>second</em> part</div>");
    class TestHighlight {
      constructor(readonly range: Range) {}
    }
    Reflect.set(window, "Highlight", TestHighlight);

    expect(applyQuoteHighlight(root, "first second part")).toBe(true);
    expect(highlights.get("pr-annotation")).toBeInstanceOf(TestHighlight);
    clearQuoteHighlight();
    expect(highlights.has("pr-annotation")).toBe(false);
  });

  it("uses and clears the older-WebKit flash fallback when CSS Highlight is unavailable", () => {
    const { root, window } = installDom("<div id='root'><p>Quoted words</p></div>", {
      commonText: true,
      startElement: true,
    });
    Reflect.deleteProperty(window, "Highlight");

    expect(applyQuoteHighlight(root, "quoted words")).toBe(true);
    expect(root.querySelector("p")?.classList.contains("quote-flash")).toBe(true);
    clearQuoteHighlight();
    expect(root.querySelector("p")?.classList.contains("quote-flash")).toBe(false);
  });

  it("uses an element common ancestor for the WebKit fallback when the range supplies one", () => {
    const { root, window } = installDom("<div id='root'><p>Element range</p></div>");
    Reflect.deleteProperty(window, "Highlight");

    expect(applyQuoteHighlight(root, "element range")).toBe(true);
    expect(root.querySelector("p")?.classList.contains("quote-flash")).toBe(true);
  });

  it("retries once the text layer arrives on a later animation frame", () => {
    const { highlights, root, scheduled, window } = installDom("<div id='root'></div>");
    class TestHighlight {
      constructor(readonly range: Range) {}
    }
    Reflect.set(window, "Highlight", TestHighlight);

    expect(applyQuoteHighlight(root, "late quote")).toBe(false);
    scheduled.shift()?.(0);
    expect(scheduled).toHaveLength(1);
    root.textContent = "late quote";
    scheduled.shift()?.(0);
    expect(highlights.get("pr-annotation")).toBeInstanceOf(TestHighlight);
  });
});

describe("viewer utility exports", () => {
  it("creates receipt badges and normalizes spreadsheet ranges", () => {
    installDom("<div id='root'></div>");
    const badge = makeReceiptBadge("Confirmed");
    expect([badge.tagName, badge.className, badge.textContent]).toEqual(["SPAN", "receipt-badge", "✓ Confirmed"]);
    expect(parseA1Range("D5:B2")).toEqual({ r1: 1, c1: 1, r2: 4, c2: 3 });
    expect(parseA1Range("B7")).toEqual({ r1: 6, c1: 1, r2: 6, c2: 1 });
    expect(parseA1Range("A0")).toBeNull();
    expect(parseA1Range(undefined)).toBeNull();
  });
});
