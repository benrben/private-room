import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import OnlineSection from "./OnlineSection";

vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function props(overrides: Record<string, unknown> = {}) {
  return {
    webOn: false,
    setWebOn: vi.fn(),
    webTesting: false,
    testWebSearch: vi.fn(),
    saveWebAccess: vi.fn().mockResolvedValue(undefined),
    webSaved: false,
    webDirty: false,
    webError: "",
    webTestResult: "",
    AlertIcon: () => null,
    searchAgent: false,
    setSearchAgent: vi.fn(),
    browseAgent: false,
    setBrowseAgent: vi.fn(),
    resultPreviews: false,
    setResultPreviews: vi.fn(),
    ...overrides,
  };
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(OnlineSection, input));
    await Promise.resolve();
  });
  return { host, input, close: async () => act(async () => root.unmount()) };
}

function reactHandler(element: Element, name: string) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key][name];
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("OnlineSection", () => {
  it("keeps agent controls hidden until the master switch is enabled", async () => {
    const view = await render();
    expect(view.host.textContent).toContain("Let this room reach the internet");
    expect(view.host.textContent).not.toContain("What the AI may do online");
    const toggle = view.host.querySelector("input");
    if (!toggle) throw new Error("master switch missing");
    reactHandler(toggle, "onChange")({ target: { checked: true } });
    expect(view.input.setWebOn).toHaveBeenCalledWith(true);
    await view.close();
  });

  it("states the no-agent and unsaved warnings while preserving all controls", async () => {
    const view = await render(props({ webOn: true, webDirty: true, webError: "offline", webTestResult: "search works" }));
    expect(view.host.textContent).toContain("Both are off");
    expect(view.host.textContent).toContain("Browser area stays yours");
    expect(view.host.textContent).toContain("Not saved yet");
    expect(view.host.textContent).toContain("offline");
    expect(view.host.textContent).toContain("search works");
    const controls = [...view.host.querySelectorAll("input")];
    reactHandler(controls[1], "onChange")({ target: { checked: true } });
    reactHandler(controls[2], "onChange")({ target: { checked: true } });
    reactHandler(controls[3], "onChange")({ target: { checked: true } });
    expect(view.input.setSearchAgent).toHaveBeenCalledWith(true);
    expect(view.input.setBrowseAgent).toHaveBeenCalledWith(true);
    expect(view.input.setResultPreviews).toHaveBeenCalledWith(true);
    await view.close();
  });

  it("shows saved/testing action labels and swallows a failed save", async () => {
    const saveWebAccess = vi.fn().mockRejectedValue(new Error("save failed"));
    const view = await render(props({ webOn: true, searchAgent: true, browseAgent: true, resultPreviews: true, webSaved: true, webTesting: true, saveWebAccess }));
    expect(view.host.textContent).toContain("Testing…");
    expect(view.host.textContent).toContain("Saved");
    expect(view.host.textContent).not.toContain("Both are off");
    const buttons = [...view.host.querySelectorAll("button")];
    expect(buttons[0].hasAttribute("disabled")).toBe(true);
    reactHandler(buttons[1], "onClick")();
    await act(async () => { await Promise.resolve(); });
    expect(saveWebAccess).toHaveBeenCalledOnce();
    await view.close();
  });
});
