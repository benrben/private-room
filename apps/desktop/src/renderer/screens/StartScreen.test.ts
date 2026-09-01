import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecentRoom } from "../api";
import { StartScreen } from "./StartScreen";

vi.mock("../icons", () => ({
  CloseIcon: () => null,
  FolderIcon: () => null,
  PlusIcon: () => null,
  TrashIcon: () => null,
}));
vi.mock("../rooms/helpers", () => ({
  relativeTime: (openedAt?: number | null) => (openedAt ? `at ${openedAt}` : ""),
}));

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

type ScreenProps = React.ComponentProps<typeof StartScreen>;

function room(path: string, overrides: Partial<RecentRoom> = {}): RecentRoom {
  return { name: path.split("/").pop() ?? "Room", path, openedAt: 42, ...overrides };
}

function props(overrides: Partial<ScreenProps> = {}): ScreenProps {
  return {
    recent: [],
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onDemo: vi.fn(),
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onTrashRoom: vi.fn(),
    onClearRecent: vi.fn(),
    ...overrides,
  };
}

async function render(screenProps: ScreenProps) {
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
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(StartScreen, screenProps));
    await Promise.resolve();
  });
  return { host, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("StartScreen", () => {
  it("keeps room creation, opening, and demo entry available without recents", async () => {
    const screenProps = props();
    const view = await render(screenProps);
    expect(view.host.textContent).toContain("Offline except a launch update check");
    expect(view.host.querySelector(".recent")).toBeNull();
    await click(button(view.host, "Create New Room"), view.window);
    await click(button(view.host, "Open Room"), view.window);
    await click(button(view.host, "Create a demo room"), view.window);
    expect(screenProps.onCreate).toHaveBeenCalledOnce();
    expect(screenProps.onOpen).toHaveBeenCalledOnce();
    expect(screenProps.onDemo).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("renders known room locations and routes normal and missing recent-room actions", async () => {
    const local = room("/Users/ben/Rooms/Local");
    const cloud = room("/Users/ben/Library/Mobile Documents/com~apple~CloudDocs/Cloud");
    const external = room("/Volumes/Archive/External", { openedAt: null });
    const missing = room("/Volumes/Offline/Gone", { missing: true });
    const screenProps = props({ recent: [local, cloud, external, missing] });
    const view = await render(screenProps);
    expect(view.host.textContent).toContain("Opened at 42");
    expect(view.host.textContent).toContain("iCloud Drive");
    expect(view.host.textContent).toContain("External volume");
    expect(view.host.textContent).toContain("Room not found — moved, deleted");
    expect(view.host.querySelectorAll(".recent-missing")).toHaveLength(1);
    expect(view.host.querySelectorAll(".nb-sem-pending")).toHaveLength(1);
    expect(view.host.querySelectorAll(".nb-sem-linked")).toHaveLength(1);
    const missingOpen = view.host.querySelectorAll<HTMLButtonElement>(".recent-open")[3];
    if (!missingOpen) throw new Error("missing recent opener absent");
    expect(missingOpen.title).toContain("opens the room picker");
    await click(missingOpen, view.window);
    expect(screenProps.onOpenRecent).toHaveBeenCalledWith(missing.path);

    const forget = view.host.querySelectorAll<HTMLButtonElement>('[aria-label="Forget this shortcut"]')[0];
    const trash = view.host.querySelector<HTMLButtonElement>(`[aria-label="Move ${local.name} to Trash"]`);
    if (!forget || !trash) throw new Error("recent action missing");
    await click(forget, view.window);
    await click(trash, view.window);
    await click(button(view.host, "Clear list"), view.window);
    expect(screenProps.onRemoveRecent).toHaveBeenCalledWith(local.path);
    expect(screenProps.onTrashRoom).toHaveBeenCalledWith(local);
    expect(screenProps.onClearRecent).toHaveBeenCalledOnce();
    expect(view.host.querySelector(`[aria-label="Move ${missing.name} to Trash"]`)).toBeNull();
    await act(async () => view.root.unmount());
  });
});
