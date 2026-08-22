/**
 * Coverage for `fetchPageWindow.ts` — ported from `agent.rs`'s own
 * `fetch_page_window`/`fetch_page_reply` tests (~6930-6990).
 */

import { describe, expect, it } from "vitest";
import { FETCH_PAGE_WINDOW, fetchPageReply, fetchPageWindow } from "./fetchPageWindow.js";

describe("fetchPageWindow", () => {
  it("shows the whole page, with no truncation notice, when it fits in one window", () => {
    expect(fetchPageWindow("T", "https://e.com", "short", 0)).toBe("[T] https://e.com\n\nshort");
  });

  it("bounds a long page to one window and says how to get the rest", () => {
    const text = "x".repeat(FETCH_PAGE_WINDOW * 2 + 500);
    const first = fetchPageWindow("T", "https://e.com", text, 0);
    expect(first.length).toBeLessThan(FETCH_PAGE_WINDOW + 500);
    expect(first).toContain(`${FETCH_PAGE_WINDOW} of ${text.length} characters shown`);
    expect(first).toContain(`start ${FETCH_PAGE_WINDOW} for the rest`);

    const second = fetchPageWindow("T", "https://e.com", text, FETCH_PAGE_WINDOW);
    expect(second).toContain(`start ${FETCH_PAGE_WINDOW * 2}`);

    const last = fetchPageWindow("T", "https://e.com", text, FETCH_PAGE_WINDOW * 2);
    expect(last).not.toContain("characters shown");
    expect(last.endsWith("x".repeat(500))).toBe(true);
  });

  it("clamps a start past the end to the end rather than throwing or wrapping", () => {
    expect(fetchPageWindow("T", "https://e.com", "abc", 999)).toBe("[T] https://e.com\n\n");
  });

  it("windows by CODE POINT, so a Hebrew page is never sliced mid-character", () => {
    const text = "שלום ".repeat(FETCH_PAGE_WINDOW);
    const out = fetchPageWindow("T", "https://e.com", text, 0);
    expect(out).toContain(`start ${FETCH_PAGE_WINDOW}`);
    expect(out).not.toContain("�");
    // Rust counts `chars()`; the JS equivalent is Array.from, NOT `.length`.
    expect(Array.from(text).length).toBe(FETCH_PAGE_WINDOW * 5);
  });
});

describe("fetchPageReply", () => {
  it("notes a redirect the model never asked for, above the window", () => {
    const out = fetchPageReply("T", "https://short.link/x", "body", 0, "https://real.example/article");
    expect(out.startsWith("(Redirected to https://real.example/article)\n")).toBe(true);
    expect(out).toContain("[T] https://short.link/x");
  });

  it("adds no note for an ordinary fetch or a cache hit", () => {
    expect(fetchPageReply("T", "https://e.com", "body", 0, null)).toBe(fetchPageWindow("T", "https://e.com", "body", 0));
  });
});
