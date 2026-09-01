import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageMeta } from "../apiTypes";
import PageSource, { sourceFacts } from "./PageSource";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

async function render(meta: PageMeta | null) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(PageSource, { meta })));
  return host;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("PageSource", () => {
  it("keeps only declared, nonblank facts and preserves invalid dates verbatim", () => {
    vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("Jan 2, 2024");
    const meta: PageMeta = {
      siteName: "  Example Gazette  ",
      byline: "  Ada Example ",
      published: "2024-01-02T10:00:00Z",
      modified: "written-by-the-page",
      sourceUrl: "https://example.test/article",
      capturedAt: "   ",
    };

    expect(sourceFacts(null)).toEqual([]);
    expect(sourceFacts(meta)).toEqual([
      { label: "Site", value: "Example Gazette" },
      { label: "Author", value: "Ada Example" },
      { label: "Published", value: "Jan 2, 2024" },
      { label: "Updated", value: "written-by-the-page" },
      { label: "Source", value: "https://example.test/article", href: "https://example.test/article" },
    ]);
  });

  it("renders provenance as text rather than a live link and omits an empty strip", async () => {
    vi.spyOn(Date.prototype, "toLocaleDateString").mockReturnValue("Mar 4, 2024");
    const empty = await render({ title: "No declared provenance" });
    expect(empty.querySelector(".page-source")).toBeNull();

    const host = await render({
      siteName: "Example Gazette",
      published: "2024-03-04T10:00:00Z",
      sourceUrl: "https://example.test/article",
    });
    const note = host.querySelector('[role="note"]');
    expect(note?.getAttribute("aria-label")).toBe("Where this page came from");
    expect([...host.querySelectorAll(".page-source-label")].map((label) => label.textContent)).toEqual([
      "Site",
      "Published",
      "Source",
    ]);
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector(".page-source-url")?.getAttribute("title")).toBe("https://example.test/article");
    expect(host.querySelector(".page-source-when")?.textContent).toBe("Mar 4, 2024");
  });
});
