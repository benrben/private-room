import { afterEach, describe, expect, it, vi } from "vitest";

import { onDragDropEvent } from "./platform";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

type Registered = Map<string, EventListener>;

function installWindow(paths: (files: readonly File[]) => string[]): {
  listeners: Registered;
  removeEventListener: ReturnType<typeof vi.fn>;
} {
  const listeners: Registered = new Map();
  const removeEventListener = vi.fn((name: string, listener: EventListener) => {
    if (listeners.get(name) === listener) listeners.delete(name);
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
      arcelle: { files: { paths } },
      removeEventListener,
    },
    writable: true,
  });
  return { listeners, removeEventListener };
}

function registered(listeners: Registered, name: string): EventListener {
  const listener = listeners.get(name);
  if (!listener) throw new Error(`Fabricated ${name} listener was not registered.`);
  return listener;
}

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("onDragDropEvent with a fabricated renderer bridge", () => {
  it("maps a fabricated native drop to renderer paths and removes every listener on cleanup", async () => {
    const resolvePaths = vi.fn(() => ["/fabricated/drop.txt"]);
    const { listeners, removeEventListener } = installWindow(resolvePaths);
    const callback = vi.fn();

    const unlisten = await onDragDropEvent(callback);
    const preventDefault = vi.fn();
    registered(listeners, "drop")({
      dataTransfer: { files: [{ name: "drop.txt" } as File] },
      preventDefault,
    } as unknown as Event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(resolvePaths).toHaveBeenCalledWith([{ name: "drop.txt" }]);
    expect(callback).toHaveBeenCalledWith({ payload: { type: "drop", paths: ["/fabricated/drop.txt"] } });

    unlisten();
    expect(removeEventListener).toHaveBeenCalledTimes(4);
    expect(listeners.size).toBe(0);
  });

  it("delivers an empty fabricated path list when the drop has no data transfer", async () => {
    const resolvePaths = vi.fn(() => []);
    const { listeners } = installWindow(resolvePaths);
    const callback = vi.fn();

    await onDragDropEvent(callback);
    registered(listeners, "drop")({ preventDefault: vi.fn() } as unknown as Event);

    expect(resolvePaths).toHaveBeenCalledWith([]);
    expect(callback).toHaveBeenCalledWith({ payload: { type: "drop", paths: [] } });
  });

  it("prevents default handling and emits every fabricated drag lifecycle event", async () => {
    const { listeners } = installWindow(() => []);
    const callback = vi.fn();
    await onDragDropEvent(callback);

    for (const [eventName, type] of [
      ["dragenter", "enter"],
      ["dragover", "over"],
      ["dragleave", "leave"],
    ] as const) {
      const preventDefault = vi.fn();
      registered(listeners, eventName)({ preventDefault } as unknown as Event);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenLastCalledWith({ payload: { type, paths: [] } });
    }
  });
});
