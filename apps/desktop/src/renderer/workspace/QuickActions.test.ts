import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowBinding } from "../api";
import { bindingMatches, QuickActionsMenu, type QuickAction } from "./QuickActions";

const { act, createElement } = React;
const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type MenuProps = React.ComponentProps<typeof QuickActionsMenu>;
type View = Awaited<ReturnType<typeof renderMenu>>;

function binding(overrides: Partial<WorkflowBinding> = {}): WorkflowBinding {
  return { scope: "file", ...overrides } as WorkflowBinding;
}

function quick(
  id: string,
  events: string[],
  overrides: Partial<QuickAction> = {},
): QuickAction {
  return {
    id,
    label: id,
    onRun: () => events.push(`run:${id}`),
    ...overrides,
  };
}

function props(overrides: Partial<MenuProps> = {}): MenuProps {
  return {
    actions: [],
    open: false,
    onOpenChange: vi.fn(),
    buttonLabel: "More actions",
    buttonIcon: createElement("span", { "data-icon": "trigger" }, "⋯"),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderMenu(overrides: Partial<MenuProps> = {}) {
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
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  let current = props(overrides);
  const update = async (next: Partial<MenuProps>) => {
    current = { ...current, ...next };
    await act(async () => {
      root.render(createElement(QuickActionsMenu, current));
      await Promise.resolve();
    });
    await flush();
  };
  await update({});
  return {
    close: async () => act(async () => root.unmount()),
    document,
    host,
    props: () => current,
    update,
    window,
  };
}

function reactProps<T>(element: Element): T {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, unknown>)[key] as T;
}

async function invoke(
  element: Element,
  name = "onClick",
  event: Record<string, unknown> = {},
) {
  await act(async () => {
    const handler = reactProps<Record<string, (event: Record<string, unknown>) => void>>(element)[name];
    if (!handler) throw new Error(`React ${name} handler missing`);
    handler({
      currentTarget: element,
      preventDefault: vi.fn(),
      target: element,
      ...event,
    });
    await Promise.resolve();
  });
  await flush();
}

function trigger(view: View): HTMLButtonElement {
  const element = view.host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  if (!element) throw new Error("menu trigger missing");
  return element;
}

function menuItems(view: View): HTMLButtonElement[] {
  return [...view.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

beforeEach(() => vi.clearAllMocks());

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("bindingMatches", () => {
  it("matches only file-scoped bindings, preserving file-id, kind, and suffix precedence", () => {
    expect(bindingMatches(null, "text", "notes.md", "file-1")).toBe(false);
    expect(bindingMatches(binding({ scope: "general" }), "text", "notes.md", "file-1")).toBe(false);
    expect(bindingMatches(binding({ file_id: "file-1", kinds: ["other"] }), "text", "notes.md", "file-1")).toBe(true);
    expect(bindingMatches(binding({ file_id: "other", kinds: ["text"] }), "text", "notes.md", "file-1")).toBe(false);
    expect(bindingMatches(binding({ kinds: ["text"] }), "text", "notes.md", "file-1")).toBe(true);
    expect(bindingMatches(binding({ exts: ["MD", ".txt"] }), "other", "NOTES.md", "file-1")).toBe(true);
    expect(bindingMatches(binding({ exts: [".txt"] }), "other", "NOTES.md", "file-1")).toBe(false);
    expect(bindingMatches(binding(), "other", "NOTES.md", "file-1")).toBe(false);
  });
});

describe("QuickActionsMenu", () => {
  it("has no footprint without actions or a footer", async () => {
    const view = await renderMenu();
    expect(view.host.textContent).toBe("");
    await view.close();

    const footerOnly = await renderMenu({
      footer: { label: "All actions", onClick: () => undefined },
      open: true,
    });
    expect(trigger(footerOnly).getAttribute("aria-expanded")).toBe("true");
    expect(menuItems(footerOnly).map((item) => item.textContent)).toEqual(["All actions"]);
    await footerOnly.close();
  });

  it("renders inline actions with labels, hints, icons, and disabled semantics", async () => {
    const events: string[] = [];
    const first = quick("first", events, {
      hint: "First helpful hint",
      icon: createElement("span", { "data-icon": "first" }, "1"),
    });
    const disabled = quick("disabled", events, { disabled: true });
    const view = await renderMenu({
      actions: [first, disabled, quick("overflow", events)],
      inlineMax: 2,
      pill: true,
    });
    const buttons = [...view.host.querySelectorAll<HTMLButtonElement>("button")];
    const inlineFirst = buttons.find((item) => item.getAttribute("aria-label") === "first");
    const inlineDisabled = buttons.find((item) => item.getAttribute("aria-label") === "disabled");
    if (!inlineFirst || !inlineDisabled) throw new Error("inline action missing");
    expect(inlineFirst.className).toBe("qa-pill");
    expect(inlineFirst.title).toBe("First helpful hint");
    expect(inlineFirst.querySelector('[data-icon="first"]')).not.toBeNull();
    expect(inlineDisabled.getAttribute("aria-disabled")).toBe("true");
    expect(inlineDisabled.hasAttribute("disabled")).toBe(false);
    expect(reactProps<{ onClick?: unknown }>(inlineDisabled).onClick).toBeUndefined();
    await invoke(inlineFirst);
    expect(events).toEqual(["run:first"]);
    expect(trigger(view).getAttribute("aria-label")).toBe("More actions");
    expect(trigger(view).getAttribute("aria-expanded")).toBe("false");
    expect(trigger(view).title).toBe("More actions");
    await view.close();

    const onlyInline = await renderMenu({ actions: [quick("only", events)], inlineMax: 1 });
    expect(onlyInline.host.querySelector('[aria-haspopup="menu"]')).toBeNull();
    await onlyInline.close();
  });

  it("groups overflow actions in order and closes before running a menu action or footer", async () => {
    const events: string[] = [];
    const onOpenChange = vi.fn((open: boolean) => events.push(`open:${open}`));
    const footer = { label: "All actions", onClick: () => events.push("footer") };
    const view = await renderMenu({
      actions: [
        quick("inline", events),
        quick("second", events, { disabled: true }),
        quick("third", events, { icon: createElement("span", { "data-icon": "third" }, "3") }),
      ],
      footer,
      inlineMax: 1,
      onOpenChange,
      open: true,
    });
    expect(menuItems(view).map((item) => {
      const labels = [...item.querySelectorAll("span")];
      return labels.at(-1)?.textContent ?? item.textContent;
    })).toEqual(["second", "third", "All actions"]);
    expect(menuItems(view)[0].disabled).toBe(true);
    expect(menuItems(view)[1].querySelector('[data-icon="third"]')).not.toBeNull();
    await invoke(menuItems(view)[1]);
    await invoke(menuItems(view)[2]);
    expect(events).toEqual(["open:false", "run:third", "open:false", "footer"]);
    const backdrop = view.host.querySelector(".menu-backdrop");
    if (!backdrop) throw new Error("menu backdrop missing");
    await invoke(backdrop, "onMouseDown");
    expect(events.at(-1)).toBe("open:false");
    await view.close();
  });

  it("supports trigger activation, keyboard navigation, Escape, and focus recovery", async () => {
    const events: string[] = [];
    const onOpenChange = vi.fn((open: boolean) => events.push(`open:${open}`));
    const view = await renderMenu({
      actions: [quick("first", events), quick("second", events)],
      footer: { label: "All actions", onClick: () => undefined },
      inlineMax: 0,
      onOpenChange,
      open: true,
    });
    await invoke(trigger(view));
    expect(events).toEqual(["open:false"]);
    const menu = view.host.querySelector('[role="menu"]');
    if (!menu) throw new Error("menu missing");
    const focuses = menuItems(view).map((item) => vi.spyOn(item, "focus"));
    for (const [key, focusIndex] of [["ArrowDown", 1], ["End", 2], ["Home", 0], ["ArrowUp", 2]] as const) {
      const preventDefault = vi.fn();
      await invoke(menu, "onKeyDown", { key, preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(focuses[focusIndex]).toHaveBeenCalled();
    }
    const escapePrevent = vi.fn();
    await invoke(menu, "onKeyDown", { key: "Escape", preventDefault: escapePrevent });
    await invoke(menu, "onKeyDown", { key: "Enter" });
    expect(escapePrevent).toHaveBeenCalledOnce();
    expect(events).toEqual(["open:false", "open:false"]);
    const button = trigger(view);
    const focus = vi.spyOn(button, "focus");
    Object.defineProperty(view.document, "activeElement", { configurable: true, value: view.document.body });
    await view.update({ open: false });
    expect(focus).toHaveBeenCalledOnce();
    await view.close();
  });
});
