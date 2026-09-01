import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  areaDef: vi.fn(),
  move: vi.fn(),
  onModalKeyDown: vi.fn(),
  reset: vi.fn(),
  togglePin: vi.fn(),
  useFocusTrap: vi.fn(),
  useNavPrefs: vi.fn(),
}));

vi.mock("./navPrefs", () => ({ areaDef: fakes.areaDef, useNavPrefs: fakes.useNavPrefs }));
vi.mock("../settings/useFocusTrap", () => ({ useFocusTrap: fakes.useFocusTrap }));
vi.mock("../icons", () => ({ ChevronDownIcon: () => null, ChevronUpIcon: () => null, CloseIcon: () => null }));

import CustomizeSidebar from "./CustomizeSidebar";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function nav() {
  return { pinned: [], more: [], move: fakes.move, reset: fakes.reset, togglePin: fakes.togglePin };
}

async function render(onClose = vi.fn()) {
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
  if (!host) throw new Error("CustomizeSidebar modal test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(CustomizeSidebar, { onClose }));
    await Promise.resolve();
  });
  return { host, onClose, root };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing from test control");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function close(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.areaDef.mockImplementation((key: string) => ({ blurb: key, icon: () => null, label: key }));
  fakes.useNavPrefs.mockReturnValue(nav());
  fakes.useFocusTrap.mockReturnValue({ modalRef: { current: null }, onModalKeyDown: fakes.onModalKeyDown });
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("CustomizeSidebar modal backdrop", () => {
  it("closes only when a fabricated mouse press lands on the backdrop itself", async () => {
    const view = await render();
    const backdrop = view.host.querySelector(".settings-backdrop");
    const dialog = view.host.querySelector('[role="dialog"]');
    if (!backdrop || !dialog) throw new Error("CustomizeSidebar modal controls missing");
    const onMouseDown = reactProps<{
      onMouseDown: (event: { currentTarget: Element; target: Element }) => void;
    }>(backdrop).onMouseDown;

    onMouseDown({ currentTarget: backdrop, target: dialog });
    expect(view.onClose).not.toHaveBeenCalled();
    onMouseDown({ currentTarget: backdrop, target: backdrop });
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(reactProps<{ onKeyDown: unknown }>(dialog).onKeyDown).toBe(fakes.onModalKeyDown);
    await close(view);
  });

  it("forwards the fabricated close-button action", async () => {
    const view = await render();
    const closeButton = view.host.querySelector('[aria-label="Close the sidebar settings"]');
    if (!closeButton) throw new Error("CustomizeSidebar close button missing");

    reactProps<{ onClick: () => void }>(closeButton).onClick();

    expect(view.onClose).toHaveBeenCalledOnce();
    await close(view);
  });
});
