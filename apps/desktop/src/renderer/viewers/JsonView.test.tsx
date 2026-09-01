import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import JsonView from "./JsonView";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(text: string, name = "data.json") {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(JsonView, { text, name })));
  await flush();
  return { host, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("JsonView", () => {
  it("renders an expanded tree and lets readers switch to the exact source", async () => {
    const text = '{"title":"Report","items":[true,2]}';
    const view = await render(text);
    expect(view.host.textContent).toContain("{} 2 keys");
    expect(view.host.textContent).toContain('"Report"');
    expect(view.host.textContent).toContain("[] 2 items");
    await click(button(view.host, "Raw"), view.window);
    expect(view.host.querySelector("pre")?.textContent).toBe(text);
    await click(button(view.host, "Tree"), view.window);
    expect(view.host.textContent).toContain("Report");
    await act(async () => view.root.unmount());
  });

  it("shows malformed data as source rather than dropping it", async () => {
    const view = await render("{not valid}");
    expect(view.host.textContent).toContain("isn't valid JSON");
    expect(view.host.querySelector("pre")?.textContent).toBe("{not valid}");
    expect(view.host.querySelector("button")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("uses singular summaries for one-key objects and one-item arrays", async () => {
    const view = await render('{"only":[1]}');

    expect(view.host.textContent).toContain("{} 1 key");
    expect(view.host.textContent).toContain("[] 1 item");
    await act(async () => view.root.unmount());
  });

  it.each([
    ["an empty object", "{}", "{} 0 keys"],
    ["a one-key object", '{"only":true}', "{} 1 key"],
    ["a multi-key object", '{"left":true,"right":false}', "{} 2 keys"],
    ["an empty array", "[]", "[] 0 items"],
    ["a one-item array", "[1]", "[] 1 item"],
    ["a multi-item array", "[1,2]", "[] 2 items"],
  ])("shows the exact top-level summary for %s", async (_kind, text, expected) => {
    const view = await render(text);

    expect(view.host.querySelector(".json-bar .json-summary")?.textContent).toBe(expected);
    await act(async () => view.root.unmount());
  });

  it.each([
    ["null", "null", "json-null", "null"],
    ["a boolean", "true", "json-boolean", "true"],
    ["a number", "42", "json-number", "42"],
    ["a string", '"fabricated"', "json-string", '"fabricated"'],
  ])("leaves the structural summary blank for %s while rendering its scalar", async (_kind, text, className, shown) => {
    const view = await render(text);

    expect(view.host.querySelector(".json-bar .json-summary")?.textContent).toBe("");
    expect(view.host.querySelector(`.${className}`)?.textContent).toBe(shown);
    await act(async () => view.root.unmount());
  });

  it("identifies JSON Lines and offers each hidden record", async () => {
    const text = Array.from({ length: 201 }, (_, index) => `{"row":${index}}`).join("\n");
    const view = await render(text, "events.ndjson");
    expect(view.host.textContent).toContain("JSON Lines — one record per line");
    expect(view.host.textContent).toContain("Show more — 1 of 201 still hidden");
    await click(button(view.host, "Show more"), view.window);
    expect(view.host.textContent).not.toContain("still hidden");
    expect(view.host.textContent).toContain("200");
    await act(async () => view.root.unmount());
  });
});
