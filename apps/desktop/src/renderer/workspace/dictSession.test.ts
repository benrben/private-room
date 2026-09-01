import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectDictSession, encodeDictAudioFrame } from "./dictSession";

type Listener = (event: Event) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static nextReadyState = FakeWebSocket.OPEN;
  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Listener[]>();
  readonly sent: unknown[] = [];
  binaryType = "";
  closeCalls = 0;
  readyState = FakeWebSocket.nextReadyState;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1000, reason: "" });
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as Event);
  }
}

const originalWebSocket = globalThis.WebSocket;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const timers = new Map<number, () => void>();
let nextTimer = 0;
const setTimeoutMock = vi.fn((callback: () => void) => {
  const timer = ++nextTimer;
  timers.set(timer, callback);
  return timer;
});
const clearTimeoutMock = vi.fn((timer: number) => timers.delete(timer));

function info() {
  return { url: "ws://dictation.invalid/session", stopBaseMs: 10, stopPerAudioSecondMs: 20 };
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("dictation socket missing");
  return socket;
}

function emitMessage(socket: FakeWebSocket, data: unknown): void {
  socket.emit("message", { data });
}

function emitClose(socket: FakeWebSocket, code: number, reason = ""): void {
  socket.readyState = FakeWebSocket.CLOSED;
  socket.emit("close", { code, reason });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.nextReadyState = FakeWebSocket.OPEN;
  timers.clear();
  nextTimer = 0;
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { setTimeout: setTimeoutMock, clearTimeout: clearTimeoutMock },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: originalWebSocket });
  if (originalWindowDescriptor) Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("dictSession", () => {
  it("encodes PCM frames and rejects incomplete float samples", () => {
    const frame = encodeDictAudioFrame(16_000, "AACAPw==");
    const view = new DataView(frame);
    expect(view.getUint32(0, true)).toBe(16_000);
    expect(view.getUint32(4, true)).toBe(1);
    expect(view.getFloat32(8, true)).toBe(1);
    expect(() => encodeDictAudioFrame(16_000, "AAA=")).toThrow("whole number");
  });

  it("forwards partials, ignores malformed frames, and stops with an empty final transcript", async () => {
    const onPartial = vi.fn();
    const session = await connectDictSession(info(), onPartial);
    const socket = latestSocket();
    emitMessage(socket, new ArrayBuffer(0));
    emitMessage(socket, "not json");
    emitMessage(socket, JSON.stringify({ type: "partial" }));
    emitMessage(socket, JSON.stringify({ type: "partial", text: "draft" }));
    await session.push(4, "AACAPw==");
    expect(socket.sent[0]).toBeInstanceOf(ArrayBuffer);
    const transcript = session.stop();
    expect(socket.sent[1]).toBe(JSON.stringify({ type: "stop" }));
    emitMessage(socket, JSON.stringify({ type: "final", ok: true }));
    emitMessage(socket, JSON.stringify({ type: "final", ok: true, text: "ignored" }));
    await expect(transcript).resolves.toBe("");
    expect(onPartial).toHaveBeenCalledWith("draft");
    expect(clearTimeoutMock).toHaveBeenCalledOnce();
    expect(socket.closeCalls).toBe(1);
  });

  it("returns final failures from the socket and leaves a closed session settled", async () => {
    const session = await connectDictSession(info(), vi.fn());
    const socket = latestSocket();
    const transcript = session.stop();
    emitMessage(socket, JSON.stringify({ type: "final", ok: false, error: "sidecar unavailable" }));
    await expect(transcript).rejects.toThrow("sidecar unavailable");

    const missingModel = await connectDictSession(info(), vi.fn());
    const missingSocket = latestSocket();
    emitClose(missingSocket, 4404);
    await expect(missingModel.stop()).rejects.toThrow("STT_MODEL_MISSING");

    const connectionError = await connectDictSession(info(), vi.fn());
    const errorSocket = latestSocket();
    errorSocket.emit("error", {});
    await expect(connectionError.stop()).rejects.toThrow("dictation connection failed");
  });

  it("waits for opening sockets and reports a close that happens before opening", async () => {
    FakeWebSocket.nextReadyState = FakeWebSocket.CONNECTING;
    const opening = connectDictSession(info(), vi.fn());
    const socket = latestSocket();
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open", {});
    const session = await opening;
    session.cancel();
    await session.push(4, "AACAPw==");
    session.cancel();
    expect(socket.sent).toEqual([JSON.stringify({ type: "cancel" })]);
    expect(socket.closeCalls).toBe(1);
    await expect(session.stop()).rejects.toThrow("The dictation connection closed before a transcript arrived.");

    FakeWebSocket.nextReadyState = FakeWebSocket.CONNECTING;
    const missing = connectDictSession(info(), vi.fn());
    emitClose(latestSocket(), 4404);
    await expect(missing).rejects.toThrow("STT_MODEL_MISSING");

    FakeWebSocket.nextReadyState = FakeWebSocket.CONNECTING;
    const closed = connectDictSession(info(), vi.fn());
    emitClose(latestSocket(), 1000, "open rejected");
    await expect(closed).rejects.toThrow("open rejected");
  });

  it("times out a final transcript and closes the session", async () => {
    const session = await connectDictSession(info(), vi.fn());
    const socket = latestSocket();
    const transcript = session.stop();
    const timeout = timers.values().next().value;
    if (!timeout) throw new Error("dictation timeout missing");
    timeout();
    await expect(transcript).rejects.toThrow("Dictation timed out");
    expect(socket.closeCalls).toBe(1);
  });
});
