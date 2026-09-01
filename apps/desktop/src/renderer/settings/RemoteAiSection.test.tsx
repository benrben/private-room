import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RemoteAiSection from "./RemoteAiSection";

const { act, createElement } = React;

vi.mock("../icons", () => ({
  CircleCheckIcon: ({ size }: { size: number }) => createElement("i", { "data-size": size }),
}));

const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function sectionProps(overrides: Record<string, unknown> = {}) {
  const AlertIcon = ({ size, className }: { size: number; className?: string }) => createElement("i", { "data-size": size, className });
  return {
    closetUrl: "http://remote:11434",
    setClosetUrl: vi.fn(),
    saveOllamaUrl: vi.fn(),
    closetSaved: false,
    testOllama: vi.fn(),
    closetTesting: false,
    closetTestResult: "",
    AlertIcon,
    ...overrides,
  } as React.ComponentProps<typeof RemoteAiSection>;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function renderSection(props = sectionProps()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(RemoteAiSection, props)));
  await flush();
  return { host, root, window, props };
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
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("RemoteAiSection", () => {
  it("updates the remote address and invokes save only for Enter or the Save action", async () => {
    const props = sectionProps();
    const view = await renderSection(props);
    const input = view.host.querySelector("input");
    if (!input) throw new Error("remote address input missing");
    const inputHandlers = reactProps<{
      onChange: (event: { target: { value: string } }) => void;
      onKeyDown: (event: { key: string }) => void;
    }>(input);

    await act(async () => inputHandlers.onChange({ target: { value: "http://other:11434" } }));
    await act(async () => inputHandlers.onKeyDown({ key: "Tab" }));
    expect(props.setClosetUrl).toHaveBeenCalledWith("http://other:11434");
    expect(props.saveOllamaUrl).not.toHaveBeenCalled();

    await act(async () => inputHandlers.onKeyDown({ key: "Enter" }));
    const buttons = [...view.host.querySelectorAll("button")];
    const save = buttons.find((button) => button.textContent?.trim() === "Save");
    const test = buttons.find((button) => button.textContent?.trim() === "Test connection");
    if (!save || !test) throw new Error("remote AI actions missing");
    await click(save, view.window);
    await click(test, view.window);
    expect(props.saveOllamaUrl).toHaveBeenCalledTimes(2);
    expect(props.testOllama).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("shows its in-progress, saved, and reported connection states", async () => {
    const view = await renderSection(sectionProps({ closetSaved: true, closetTesting: true, closetTestResult: "✗ Connection refused" }));
    const buttons = [...view.host.querySelectorAll("button")];
    const test = buttons.find((button) => button.textContent?.trim() === "Testing…");
    const saved = buttons.find((button) => button.textContent?.trim() === "Saved");
    if (!test || !saved) throw new Error("remote AI status controls missing");
    expect(test.hasAttribute("disabled")).toBe(true);
    expect(saved.querySelector("i")?.getAttribute("data-size")).toBe("14");
    expect(view.host.textContent).toContain("✗ Connection refused");
    expect(view.host.querySelector(".warn-ic")?.getAttribute("data-size")).toBe("16");
    await act(async () => view.root.unmount());
  });
});
