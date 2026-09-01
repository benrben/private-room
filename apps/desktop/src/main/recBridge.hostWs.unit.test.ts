import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sidecar = vi.hoisted(() => ({
  authToken: vi.fn<() => string>(),
  ensureUp: vi.fn<() => Promise<string>>(),
}));

vi.mock("./sidecar.js", () => ({
  authToken: sidecar.authToken,
  authedHeaders: vi.fn(),
  busy: vi.fn(),
  ensureUp: sidecar.ensureUp,
}));

type Listener = (event: { data?: unknown }) => void;

/** A completely in-memory WebSocket: it is never allowed to connect. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const registered = this.listeners.get(type) ?? [];
    registered.push(listener);
    this.listeners.set(type, registered);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  open(): void {
    this.readyState = this.OPEN;
    this.emit("open");
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

let originalWebSocket: unknown;

beforeEach(() => {
  originalWebSocket = Reflect.get(globalThis, "WebSocket");
  Reflect.set(globalThis, "WebSocket", FakeWebSocket);
  FakeWebSocket.instances = [];
  vi.clearAllMocks();
  sidecar.authToken.mockReturnValue("fake token");
});

afterEach(() => {
  if (originalWebSocket === undefined) {
    Reflect.deleteProperty(globalThis, "WebSocket");
  } else {
    Reflect.set(globalThis, "WebSocket", originalWebSocket);
  }
  vi.restoreAllMocks();
});

describe("recBridge default host socket with a fabricated transport", () => {
  it("queues sends until the fake socket opens, then sends subsequent data directly", async () => {
    let makeSidecarAvailable: (base: string) => void = () => undefined;
    sidecar.ensureUp.mockImplementation(
      () => new Promise<string>((resolve) => { makeSidecarAvailable = resolve; }),
    );
    const { createRecBridgeCtx } = await import("./recBridge.js");
    const hostSocket = createRecBridgeCtx({ currentRoom: () => null }).deps.connectHostWs("file / one");

    hostSocket.send("before-sidecar");
    makeSidecarAvailable("http://fake-sidecar");
    await flushPromises();

    const socket = FakeWebSocket.instances[0];
    expect(socket?.url).toBe("ws://fake-sidecar/rec/host?token=fake%20token&fileId=file%20%2F%20one");
    hostSocket.send("before-open");
    expect(socket?.sent).toEqual([]);

    socket?.open();
    hostSocket.send("after-open");
    expect(socket?.sent).toEqual(["before-sidecar", "before-open", "after-open"]);
  });

  it("serializes fake incoming messages and forwards close without opening a real transport", async () => {
    sidecar.ensureUp.mockResolvedValue("https://fake-sidecar");
    const { createRecBridgeCtx } = await import("./recBridge.js");
    const hostSocket = createRecBridgeCtx({ currentRoom: () => null }).deps.connectHostWs("fake-file");
    const messages: string[] = [];
    const onClose = vi.fn();
    hostSocket.onMessage = (message) => messages.push(message);
    hostSocket.onClose = onClose;
    await flushPromises();

    const socket = FakeWebSocket.instances[0];
    socket?.emit("message", { data: 42 });
    socket?.emit("close");
    hostSocket.close();

    expect(messages).toEqual(["42"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(socket?.closed).toBe(true);
    expect(socket?.url).toBe("wss://fake-sidecar/rec/host?token=fake%20token&fileId=fake-file");
  });

  it("does not create a socket after close wins the fake sidecar-start race", async () => {
    let makeSidecarAvailable: (base: string) => void = () => undefined;
    sidecar.ensureUp.mockImplementation(
      () => new Promise<string>((resolve) => { makeSidecarAvailable = resolve; }),
    );
    const { createRecBridgeCtx } = await import("./recBridge.js");
    const hostSocket = createRecBridgeCtx({ currentRoom: () => null }).deps.connectHostWs("fake-file");

    hostSocket.send("never-delivered");
    hostSocket.close();
    makeSidecarAvailable("http://fake-sidecar");
    await flushPromises();

    expect(FakeWebSocket.instances).toEqual([]);
  });

  it("reports a fabricated sidecar startup failure through its close callback", async () => {
    sidecar.ensureUp.mockRejectedValue(new Error("fake sidecar unavailable"));
    const { createRecBridgeCtx } = await import("./recBridge.js");
    const hostSocket = createRecBridgeCtx({ currentRoom: () => null }).deps.connectHostWs("fake-file");
    const onClose = vi.fn();
    hostSocket.onClose = onClose;
    await flushPromises();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toEqual([]);
  });
});
