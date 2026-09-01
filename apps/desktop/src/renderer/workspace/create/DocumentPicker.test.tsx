import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ storyDocuments: vi.fn() }));
vi.mock("../../api", () => ({ api: { storyDocuments: mocks.storyDocuments } }));

import { DocumentPicker } from "./DocumentPicker";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
type PickerProps = React.ComponentProps<typeof DocumentPicker>;

function props(overrides: Partial<PickerProps> = {}): PickerProps {
  return { open: true, title: "Choose a document", hint: "For the story", onClose: vi.fn(), onPick: vi.fn(), ...overrides };
}

async function flush() {
  await act(async () => {
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
  });
}

async function render(pickerProps: PickerProps) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(DocumentPicker, pickerProps)));
  return { host, root, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
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

beforeEach(() => mocks.storyDocuments.mockReset());

describe("DocumentPicker", () => {
  it("loads, filters, picks, and closes a readable document", async () => {
    let resolveDocuments: ((docs: Array<{ fileId: string; name: string; words: number; snippet: string }>) => void) | undefined;
    mocks.storyDocuments.mockImplementationOnce(() => new Promise((resolve) => { resolveDocuments = resolve; }));
    const pickerProps = props();
    const view = await render(pickerProps);
    expect(view.host.textContent).toContain("Reading this room’s files");
    await act(async () => resolveDocuments?.([
      { fileId: "one", name: "Story Outline", words: 1200, snippet: "A plan" },
      { fileId: "two", name: "Cast", words: 0, snippet: "People" },
    ]));
    await flush();
    expect(view.host.textContent).toContain("≈1,200 words");
    const input = view.host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error("search input missing");
    await act(async () => reactProps<{ onChange: (event: { target: { value: string } }) => void }>(input).onChange({ target: { value: "cast" } }));
    await flush();
    expect(view.host.textContent).toContain("Cast");
    expect(view.host.textContent).not.toContain("Story Outline");
    const card = view.host.querySelector<HTMLButtonElement>(".cr-doc");
    if (!card) throw new Error("document card missing");
    await click(card, view.window);
    expect(pickerProps.onPick).toHaveBeenCalledWith({ fileId: "two", name: "Cast", words: 0, snippet: "People" });
    expect(pickerProps.onClose).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("distinguishes an empty room, a query miss, and an API error", async () => {
    mocks.storyDocuments.mockResolvedValueOnce([]);
    let view = await render(props());
    await flush();
    expect(view.host.textContent).toContain("No file in this room has readable text yet.");
    const input = view.host.querySelector<HTMLInputElement>('input[type="search"]');
    if (!input) throw new Error("search input missing");
    await act(async () => reactProps<{ onChange: (event: { target: { value: string } }) => void }>(input).onChange({ target: { value: "missing" } }));
    await flush();
    expect(view.host.textContent).toContain("Nothing matches “missing”.");
    await act(async () => view.root.unmount());
    mocks.storyDocuments.mockRejectedValueOnce(new Error("room unavailable"));
    view = await render(props());
    await flush();
    expect(view.host.textContent).toContain("room unavailable");
    await act(async () => view.root.unmount());
  });

  it("does not load a document list while closed", async () => {
    const view = await render(props({ open: false }));
    await flush();
    expect(view.host.textContent).toBe("");
    expect(mocks.storyDocuments).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });
});
