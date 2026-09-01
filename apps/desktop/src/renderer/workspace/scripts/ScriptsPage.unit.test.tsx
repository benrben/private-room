import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("../../icons", () => ({
  CloseIcon: () => null,
  PlusIcon: () => null,
  ScriptIcon: () => null,
}));
vi.mock("./ScriptRow", () => ({
  ScriptRow: (props: { sc: { fileId: string } }) => {
    rows.render(props);
    return React.createElement("div", { "data-script-id": props.sc.fileId }, `script ${props.sc.fileId}`);
  },
}));

import { ScriptsPage } from "./ScriptsPage";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function fakeActions(overrides: Record<string, unknown> = {}) {
  return {
    closeScripts: vi.fn(),
    createNewScript: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Record<string, unknown>;
}

function fakeState(scripts: Array<Record<string, unknown>>) {
  return { scripts } as Record<string, unknown>;
}

function installDom() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  return { document, window };
}

async function renderScripts(scripts: Array<Record<string, unknown>>, a = fakeActions()) {
  const { document, window } = installDom();
  const s = fakeState(scripts);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("Test root missing.");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ScriptsPage, { s: s as never, a: a as never }));
  });
  return { a, host, root, s, window };
}

async function click(view: Awaited<ReturnType<typeof renderScripts>>, label: string): Promise<void> {
  const button = Array.from(view.host.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  await act(async () => {
    button.dispatchEvent(new view.window.Event("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  rows.render.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("ScriptsPage with fabricated script state", () => {
  it("explains the empty state and routes its accessible header actions", async () => {
    const view = await renderScripts([]);

    expect(view.host.textContent).toContain("Before you write one:");
    expect(view.host.textContent).toContain("No scripts yet");
    expect(view.host.textContent).toContain("# dependencies = [\"yfinance\", \"pandas\"]");
    expect(view.host.textContent).toContain("can read and change files anywhere in your home folder");
    expect(view.host.querySelector(".scripts-list")).toBeNull();
    await click(view, "New script");
    await click(view, "Close");

    expect(view.a.createNewScript).toHaveBeenCalledTimes(1);
    expect(view.a.closeScripts).toHaveBeenCalledTimes(1);
    await act(async () => view.root.unmount());
  });

  it("renders every fabricated script through ScriptRow with the current state and actions", async () => {
    const first = { fileId: "script-one", name: "one.py" };
    const second = { fileId: "script-two", name: "two.js" };
    const a = fakeActions();
    const view = await renderScripts([first, second], a);

    expect(view.host.textContent).toContain("Every run:");
    expect(view.host.querySelector(".scripts-empty")).toBeNull();
    expect(Array.from(view.host.querySelectorAll("[data-script-id]"), (item) => item.getAttribute("data-script-id"))).toEqual([
      "script-one",
      "script-two",
    ]);
    expect(rows.render).toHaveBeenCalledTimes(2);
    expect(rows.render.mock.calls.map(([props]) => props.sc)).toEqual([first, second]);
    expect(rows.render.mock.calls.every(([props]) => props.s === view.s)).toBe(true);
    expect(rows.render.mock.calls.every(([props]) => props.a === a)).toBe(true);
    await act(async () => view.root.unmount());
  });
});
