import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import LayoutMenu from "./LayoutMenu";

const { act, createElement } = React;

function icon(name: string) {
  return ({ size, className }: { size: number; className?: string }) => createElement("i", { "data-icon": name, "data-size": size, className });
}

vi.mock("../icons", () => ({
  CheckIcon: icon("check"),
  ChevronDownIcon: icon("chevron"),
  FocusIcon: icon("focus"),
  PanelLeftIcon: icon("left"),
  PanelRightIcon: icon("right"),
}));
vi.mock("../shell/useLayout", () => ({
  PRESETS: {
    reading: { label: "Reading", hint: "Keep the document wide" },
    research: { label: "Research", hint: "Show every pane" },
  },
}));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function layout(overrides: Record<string, unknown> = {}) {
  return {
    visible: ["library"],
    focusPane: null,
    applyPreset: vi.fn(),
    resetLayout: vi.fn(),
    toggleFocus: vi.fn(),
    togglePane: vi.fn(),
    ...overrides,
  } as unknown as React.ComponentProps<typeof LayoutMenu>["layout"];
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function renderMenu(props: Partial<React.ComponentProps<typeof LayoutMenu>> = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const menuProps = {
    layout: layout(),
    sidebarTitle: "Notebook",
    open: true,
    onOpenChange: vi.fn(),
    ...props,
  } as React.ComponentProps<typeof LayoutMenu>;
  await act(async () => root.render(createElement(LayoutMenu, menuProps)));
  await flush();
  return { host, root, window, menuProps };
}

async function click(node: Element, window: Window & typeof globalThis, event = "click") {
  await act(async () => node.dispatchEvent(new window.Event(event, { bubbles: true })));
  await flush();
}

function testId(host: Element, id: string) {
  const node = host.querySelector(`[data-testid="${id}"]`);
  if (!node) throw new Error(`missing ${id}`);
  return node;
}

function menuButton(host: Element, label: string) {
  const node = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim().includes(label));
  if (!node) throw new Error(`missing menu button: ${label}`);
  return node;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("LayoutMenu", () => {
  it("opens from its accessible trigger", async () => {
    const onOpenChange = vi.fn();
    const view = await renderMenu({ open: false, onOpenChange });
    const trigger = testId(view.host, "layout-menu");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(view.host.querySelector('[role="menu"]')).toBeNull();
    await click(trigger, view.window);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    await act(async () => view.root.unmount());
  });

  it("reports pane state semantically and routes pane, preset, reset, and backdrop actions", async () => {
    const menuLayout = layout();
    const onOpenChange = vi.fn();
    const view = await renderMenu({ layout: menuLayout, onOpenChange });
    expect(view.host.querySelector('[role="menu"]')).not.toBeNull();
    expect(view.host.querySelectorAll('[role="menuitemcheckbox"]')).toHaveLength(3);
    const library = testId(view.host, "layout-toggle-library");
    const assistant = testId(view.host, "layout-toggle-assistant");
    const focus = testId(view.host, "layout-toggle-focus");
    expect(library.getAttribute("aria-checked")).toBe("true");
    expect(library.querySelector('[data-icon="check"]')?.getAttribute("data-size")).toBe("14");
    expect(assistant.getAttribute("aria-checked")).toBe("false");
    expect(focus.getAttribute("aria-checked")).toBe("false");
    expect(library.textContent).toContain("Notebook");
    expect(library.textContent).toContain("⌘1");
    expect(assistant.textContent).toContain("⌘2");
    expect(focus.textContent).not.toContain("Esc to leave");

    await click(library, view.window);
    await click(assistant, view.window);
    await click(focus, view.window);
    await click(menuButton(view.host, "Reading"), view.window);
    await click(menuButton(view.host, "Reset layout"), view.window);
    const backdrop = view.host.querySelector(".menu-backdrop");
    if (!backdrop) throw new Error("menu backdrop missing");
    await click(backdrop, view.window, "mousedown");
    expect(menuLayout.togglePane).toHaveBeenNthCalledWith(1, "library");
    expect(menuLayout.togglePane).toHaveBeenNthCalledWith(2, "ai");
    expect(menuLayout.toggleFocus).toHaveBeenCalledWith("center");
    expect(menuLayout.applyPreset).toHaveBeenCalledWith("reading");
    expect(menuLayout.resetLayout).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledTimes(6);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(view.host.querySelectorAll('[role="separator"]')).toHaveLength(2);
    await act(async () => view.root.unmount());
  });

  it("marks focused and hidden panes with screen-reader state and the focus escape hint", async () => {
    const view = await renderMenu({ layout: layout({ visible: [], focusPane: "center" }) });
    const library = testId(view.host, "layout-toggle-library");
    const assistant = testId(view.host, "layout-toggle-assistant");
    const focus = testId(view.host, "layout-toggle-focus");
    expect(library.getAttribute("aria-checked")).toBe("false");
    expect(assistant.getAttribute("aria-checked")).toBe("false");
    expect(focus.getAttribute("aria-checked")).toBe("true");
    expect(focus.textContent).toContain("Esc to leave");
    expect(focus.querySelector('[data-icon="check"]')).not.toBeNull();
    await act(async () => view.root.unmount());
  });
});
