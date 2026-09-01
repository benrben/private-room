import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomPicture } from "../../api";
import { Attached, PicturePicker } from "./PicturePicker";

const { storyPictures, onModalKeyDown } = vi.hoisted(() => ({
  storyPictures: vi.fn(),
  onModalKeyDown: vi.fn(),
}));

vi.mock("../../api", () => ({ api: { storyPictures } }));
vi.mock("../../settings/useFocusTrap", () => ({
  useFocusTrap: () => ({ modalRef: null, onModalKeyDown }),
}));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const pictures: RoomPicture[] = [
  { fileId: "pic-aurora", name: "Aurora portrait", thumbB64: "first" },
  { fileId: "pic-cabin", name: "Cabin reference", thumbB64: "second" },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    title: "Choose a picture",
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  } as React.ComponentProps<typeof PicturePicker>;
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
    root.render(createElement(PicturePicker, input));
    await Promise.resolve();
  });
  return {
    host,
    input,
    rerender: async (next: React.ComponentProps<typeof PicturePicker>) => act(async () => {
      root.render(createElement(PicturePicker, next));
      await Promise.resolve();
      await Promise.resolve();
    }),
    close: async () => act(async () => root.unmount()),
  };
}

function reactHandler(element: Element, name: string) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key][name];
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

beforeEach(() => {
  onModalKeyDown.mockReset();
});

describe("PicturePicker", () => {
  it("does not read pictures until the sheet is open", async () => {
    const view = await render(props({ open: false }));
    expect(view.host.textContent).toBe("");
    expect(storyPictures).not.toHaveBeenCalled();
    await view.close();
  });

  it("filters the current room pictures and picks one before closing", async () => {
    let resolvePictures!: (value: RoomPicture[]) => void;
    const pendingPictures = new Promise<RoomPicture[]>((resolve) => { resolvePictures = resolve; });
    storyPictures.mockReturnValueOnce(pendingPictures);
    const view = await render();
    expect(view.host.textContent).toContain("Looking through this room");
    resolvePictures(pictures);
    await flush();
    expect(view.host.textContent).toContain("Aurora portrait");
    const search = view.host.querySelector("input");
    if (!search) throw new Error("picture search missing");
    await act(async () => reactHandler(search, "onChange")({ target: { value: "AURORA" } }));
    expect(view.host.textContent).toContain("Aurora portrait");
    expect(view.host.textContent).not.toContain("Cabin reference");
    const selected = [...view.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Aurora portrait"));
    if (!selected) throw new Error("filtered picture missing");
    reactHandler(selected, "onClick")();
    expect(view.input.onPick).toHaveBeenCalledWith(pictures[0]);
    expect(view.input.onClose).toHaveBeenCalledOnce();
    await view.close();
  });

  it("keeps distinct loading, empty, no-match, and failure states", async () => {
    storyPictures.mockResolvedValueOnce([]);
    const empty = await render();
    await flush();
    expect(empty.host.textContent).toContain("There are no pictures in this room yet");
    await empty.close();

    storyPictures.mockResolvedValueOnce(pictures);
    const noMatch = await render();
    await flush();
    const search = noMatch.host.querySelector("input");
    if (!search) throw new Error("picture search missing");
    await act(async () => reactHandler(search, "onChange")({ target: { value: "missing" } }));
    expect(noMatch.host.textContent).toContain("No picture here is called “missing”");
    await noMatch.close();

    storyPictures.mockRejectedValueOnce(new Error("room unavailable"));
    const failed = await render();
    await flush();
    expect(failed.host.textContent).toContain("Could not read this room’s pictures");
    expect(failed.host.textContent).toContain("room unavailable");
    await failed.close();
  });

  it("cancels stale reads, preserves the query across closes, and wires the sheet controls", async () => {
    let resolveOld!: (value: RoomPicture[]) => void;
    const oldRead = new Promise<RoomPicture[]>((resolve) => { resolveOld = resolve; });
    storyPictures.mockReturnValueOnce(oldRead).mockResolvedValueOnce(pictures);
    const current = props();
    const view = await render(current);
    const search = view.host.querySelector("input");
    if (!search) throw new Error("picture search missing");
    await act(async () => reactHandler(search, "onChange")({ target: { value: "aurora" } }));
    await view.rerender({ ...current, open: false });
    resolveOld(pictures);
    await flush();
    expect(view.host.textContent).toBe("");

    await view.rerender(current);
    await flush();
    expect(storyPictures).toHaveBeenCalledTimes(2);
    expect(view.host.textContent).toContain("Aurora portrait");
    expect(view.host.textContent).not.toContain("Cabin reference");
    const sheet = view.host.querySelector('[role="dialog"]');
    if (!sheet) throw new Error("sheet missing");
    const stopPropagation = vi.fn();
    reactHandler(sheet, "onKeyDown")({ key: "Escape", stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onModalKeyDown).toHaveBeenCalledOnce();
    reactHandler(sheet, "onClick")();
    expect(current.onClose).toHaveBeenCalledOnce();
    await view.close();
  });

  it("shows an attached picture and clears it on request", async () => {
    const onClear = vi.fn();
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
    await act(async () => root.render(createElement(Attached, { picture: pictures[0], role: "First frame", onClear })));
    expect(host.textContent).toContain("First frame");
    const remove = host.querySelector("button");
    if (!remove) throw new Error("remove control missing");
    reactHandler(remove, "onClick")();
    expect(onClear).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
