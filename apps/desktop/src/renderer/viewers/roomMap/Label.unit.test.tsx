import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";

import { LABEL_PAD } from "./constants";
import Label from "./Label";
import type { LabelBox } from "./types";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function label(overrides: Partial<LabelBox> = {}): LabelBox {
  return {
    id: "file-1",
    name: "notes.md",
    textX: 25,
    textY: 35,
    boxX: 10,
    boxY: 20,
    boxW: 120,
    boxH: 24,
    prio: 1,
    kind: "file",
    ...overrides,
  };
}

async function render(l: LabelBox) {
  const parsed = parseHTML("<html><body><svg id='root'></svg></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    SVGElement: window.SVGElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test SVG root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Label, { l })));
  return { host, root };
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("Label", () => {
  it("renders a focused file label as an opaque card without a memory marker", async () => {
    const view = await render(label({ prio: 3 }));

    const card = view.host.querySelector("rect");
    const text = view.host.querySelector("text");
    expect(card?.getAttribute("class")).toBe("rm-label-bg is-focus");
    expect(card?.getAttribute("x")).toBe("10");
    expect(card?.getAttribute("y")).toBe("20");
    expect(card?.getAttribute("width")).toBe("120");
    expect(card?.getAttribute("height")).toBe("24");
    expect(card?.getAttribute("rx")).toBe("3");
    expect(view.host.querySelector("circle")).toBeNull();
    expect(text?.getAttribute("class")).toBe("rm-label-text");
    expect(text?.getAttribute("x")).toBe("25");
    expect(text?.getAttribute("y")).toBe("35");
    expect(text?.textContent).toBe("notes.md");
    await act(async () => view.root.unmount());
  });

  it("renders the memory ring and memory text treatment at the label geometry", async () => {
    const memory = label({
      name: "remember this",
      boxX: 40,
      boxY: 18,
      boxH: 30,
      kind: "memory",
    });
    const view = await render(memory);

    const card = view.host.querySelector("rect");
    const marker = view.host.querySelector("circle");
    const text = view.host.querySelector("text");
    expect(card?.getAttribute("class")).toBe("rm-label-bg");
    expect(marker?.getAttribute("class")).toBe("rm-label-mark");
    expect(marker?.getAttribute("cx")).toBe(String(memory.boxX + LABEL_PAD + 4));
    expect(marker?.getAttribute("cy")).toBe(String(memory.boxY + memory.boxH / 2));
    expect(marker?.getAttribute("r")).toBe("3.4");
    expect(text?.getAttribute("class")).toBe("rm-label-text is-memory");
    expect(text?.textContent).toBe("remember this");
    await act(async () => view.root.unmount());
  });
});
