import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";

import SvgView from "./SvgView";

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

async function render(text: string) {
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
  await act(async () => root.render(createElement(SvgView, { text })));
  return {
    host,
    root,
    rerender: async (nextText: string) => act(async () => root.render(createElement(SvgView, { text: nextText }))),
  };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function onClick(element: Element): () => unknown {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React click handler missing");
  return (element as unknown as Record<string, Record<string, () => unknown>>)[key]!.onClick!;
}

async function click(element: Element) {
  await act(async () => { onClick(element)(); });
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("SvgView with an in-memory SVG string", () => {
  it("switches safely between encoded picture and source views while preserving the chosen backdrop", async () => {
    const drawing = '<svg><text>fake & drawing</text></svg>';
    const view = await render(drawing);
    const picture = button(view.host, "Picture");
    const source = button(view.host, "Source");
    const image = view.host.querySelector("img");
    if (!image) throw new Error("SVG image missing");

    expect(picture.getAttribute("aria-pressed")).toBe("true");
    expect(source.getAttribute("aria-pressed")).toBe("false");
    expect(image.getAttribute("src")).toBe(`data:image/svg+xml;utf8,${encodeURIComponent(drawing)}`);
    expect(image.getAttribute("alt")).toBe("SVG drawing");
    expect(button(view.host, "Dark backdrop").title).toContain("flip the backdrop");

    await click(button(view.host, "Dark backdrop"));
    expect(view.host.querySelector(".svg-stage")?.className).toBe("svg-stage dark");
    expect(button(view.host, "Light backdrop")).not.toBeNull();

    await click(source);
    expect(view.host.querySelector(".svg-source")?.textContent).toBe(drawing);
    expect(view.host.querySelector("img")).toBeNull();
    expect(view.host.querySelector(".rdr-bar-end")).toBeNull();
    expect(button(view.host, "Source").getAttribute("aria-pressed")).toBe("true");

    await click(button(view.host, "Picture"));
    expect(view.host.querySelector(".svg-stage")?.className).toBe("svg-stage dark");
    await click(button(view.host, "Light backdrop"));
    expect(view.host.querySelector(".svg-stage")?.className).toBe("svg-stage");
    await act(async () => view.root.unmount());
  });

  it("re-encodes a replacement in-memory drawing without interpreting its markup", async () => {
    const view = await render("<svg><title>first</title></svg>");
    const next = '<svg><script>fake()</script><title>second</title></svg>';
    await view.rerender(next);

    expect(view.host.querySelector("img")?.getAttribute("src")).toBe(`data:image/svg+xml;utf8,${encodeURIComponent(next)}`);
    expect(view.host.querySelector("script")).toBeNull();
    await act(async () => view.root.unmount());
  });
});
