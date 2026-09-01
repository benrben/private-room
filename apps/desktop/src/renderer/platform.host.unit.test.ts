import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ask,
  closeWindow,
  confirm,
  droppedFilePaths,
  emitLocal,
  invoke,
  listen,
  message,
  open,
  setWindowTitle,
} from "./platform";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function installBridge(arcelle?: unknown): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { arcelle },
    writable: true,
  });
}

function bridgeDouble() {
  const unlisten = vi.fn();
  return {
    dialog: {
      ask: vi.fn(),
      confirm: vi.fn(),
      message: vi.fn(),
      open: vi.fn(async () => "/fake/selected"),
      save: vi.fn(),
    },
    files: {
      paths: vi.fn(() => ["/fake/dropped.txt"]),
    },
    invoke: vi.fn(async () => "reply"),
    on: vi.fn(() => unlisten),
    shell: {
      openPath: vi.fn(),
      openUrl: vi.fn(),
      revealItemInDir: vi.fn(),
    },
    unlisten,
  };
}

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

describe("renderer platform preload bridge", () => {
  it("reports a clear error when the fabricated preload bridge is absent", () => {
    installBridge();

    expect(() => invoke("room_load")).toThrow("Electron preload bridge is unavailable");
  });

  it("routes requests and file paths through a fabricated preload bridge", async () => {
    const bridge = bridgeDouble();
    installBridge(bridge);

    await expect(invoke<string>("room_load", { roomId: "room-1" })).resolves.toBe("reply");
    await expect(open({ title: "Select file" })).resolves.toBe("/fake/selected");
    expect(droppedFilePaths([{ name: "dropped.txt" } as File])).toEqual(["/fake/dropped.txt"]);

    expect(bridge.invoke).toHaveBeenCalledWith("room_load", { roomId: "room-1" });
    expect(bridge.dialog.open).toHaveBeenCalledWith({ title: "Select file" });
    expect(bridge.files.paths).toHaveBeenCalledTimes(1);
  });

  it("routes dialog helpers and handles renderer-owned window controls", async () => {
    const bridge = bridgeDouble();
    bridge.dialog.message.mockResolvedValue(undefined);
    bridge.dialog.ask.mockResolvedValue(true);
    bridge.dialog.confirm.mockResolvedValue(false);
    const close = vi.fn();
    installBridge(bridge);
    Object.assign(window, { close });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { title: "Before" },
    });

    await message("Saved", { kind: "info" });
    await expect(ask("Continue?", { okLabel: "Continue" })).resolves.toBe(true);
    await expect(confirm("Delete?", { kind: "warning" })).resolves.toBe(false);
    await setWindowTitle("Room title");
    await closeWindow();

    expect(bridge.dialog.message).toHaveBeenCalledWith("Saved", { kind: "info" });
    expect(bridge.dialog.ask).toHaveBeenCalledWith("Continue?", { okLabel: "Continue" });
    expect(bridge.dialog.confirm).toHaveBeenCalledWith("Delete?", { kind: "warning" });
    expect(document.title).toBe("Room title");
    expect(close).toHaveBeenCalledOnce();
  });

  it("delivers local events then tears down both fabricated subscriptions", async () => {
    const bridge = bridgeDouble();
    installBridge(bridge);
    const callback = vi.fn();

    const unlisten = await listen<string>("recording_state", callback);
    emitLocal("recording_state", "ready");
    unlisten();
    emitLocal("recording_state", "stopped");

    expect(bridge.on).toHaveBeenCalledWith("recording_state", expect.any(Function));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ payload: "ready" });
    expect(bridge.unlisten).toHaveBeenCalledTimes(1);
  });
});
