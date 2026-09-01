import type { DictSessionInfo } from "../apiTypes";

const DICT_HEADER_BYTES = 8;

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode the sidecar's `<u32 rate><u32 sample count><f32…>` frame. */
export function encodeDictAudioFrame(rate: number, dataB64: string): ArrayBuffer {
  const samples = decodeBase64(dataB64);
  if (samples.byteLength % 4 !== 0) {
    throw new Error("Dictation PCM payload is not a whole number of float32 samples.");
  }
  const frame = new ArrayBuffer(DICT_HEADER_BYTES + samples.byteLength);
  const view = new DataView(frame);
  view.setUint32(0, rate >>> 0, true);
  view.setUint32(4, samples.byteLength / 4, true);
  new Uint8Array(frame, DICT_HEADER_BYTES).set(samples);
  return frame;
}

export interface DictSession {
  push(rate: number, dataB64: string): Promise<void>;
  stop(): Promise<string>;
  cancel(): void;
}

type DictWireMessage =
  | { type: "partial"; text?: unknown }
  | { type: "final"; ok?: unknown; text?: unknown; error?: unknown };

interface DictSessionState {
  capturedSecs: number;
  stopped: boolean;
  settled: boolean;
  final: Promise<string>;
  resolveFinal: (text: string) => void;
  rejectFinal: (error: Error) => void;
}

function createSessionState(): DictSessionState {
  let resolveFinal = (_text: string): void => {};
  let rejectFinal = (_error: Error): void => {};
  const final = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  // A rejection is consumed by stop(); attach a handler now so a socket that
  // dies while the user is still speaking never creates an unhandled promise.
  void final.catch(() => {});
  return { capturedSecs: 0, stopped: false, settled: false, final, resolveFinal, rejectFinal };
}

function failFinal(state: DictSessionState, message: string): void {
  if (state.settled) return;
  state.settled = true;
  state.rejectFinal(new Error(message));
}

function parseWireMessage(data: unknown): DictWireMessage | undefined {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data) as DictWireMessage;
  } catch {
    return undefined;
  }
}

function deliverPartial(message: DictWireMessage, onPartial: (text: string) => void): boolean {
  if (message.type !== "partial") return false;
  if (typeof message.text === "string") onPartial(message.text);
  return true;
}

function finalText(message: Extract<DictWireMessage, { type: "final" }>): string {
  return typeof message.text === "string" ? message.text : "";
}

function finalError(message: Extract<DictWireMessage, { type: "final" }>): string {
  return typeof message.error === "string" ? message.error : "Dictation failed.";
}

function settleFinal(state: DictSessionState, message: DictWireMessage): void {
  if (message.type !== "final" || state.settled) return;
  state.settled = true;
  if (message.ok === true) {
    state.resolveFinal(finalText(message));
    return;
  }
  state.rejectFinal(new Error(finalError(message)));
}

function handleSocketMessage(
  state: DictSessionState,
  onPartial: (text: string) => void,
  event: MessageEvent,
): void {
  const message = parseWireMessage(event.data);
  if (message === undefined || deliverPartial(message, onPartial)) return;
  settleFinal(state, message);
}

function closeFailure(event: CloseEvent): string {
  if (event.code === 4404) return "STT_MODEL_MISSING";
  return event.reason || "The dictation connection closed before a transcript arrived.";
}

function addSessionListeners(
  socket: WebSocket,
  state: DictSessionState,
  onPartial: (text: string) => void,
): void {
  socket.addEventListener("message", (event) => handleSocketMessage(state, onPartial, event));
  socket.addEventListener("error", () => failFinal(state, "The dictation connection failed."));
  socket.addEventListener("close", (event) => failFinal(state, closeFailure(event)));
}

function openFailure(event: CloseEvent): Error {
  const message = event.code === 4404 ? "STT_MODEL_MISSING" : event.reason || "Could not open dictation.";
  return new Error(message);
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const opened = (): void => {
      cleanup();
      resolve();
    };
    const closed = (event: CloseEvent): void => {
      cleanup();
      reject(openFailure(event));
    };
    const cleanup = (): void => {
      socket.removeEventListener("open", opened);
      socket.removeEventListener("close", closed);
    };
    socket.addEventListener("open", opened);
    socket.addEventListener("close", closed);
  });
}

function createDictSession(socket: WebSocket, state: DictSessionState, info: DictSessionInfo): DictSession {
  return {
    async push(rate, dataB64) {
      if (state.stopped || socket.readyState !== WebSocket.OPEN) return;
      const frame = encodeDictAudioFrame(rate, dataB64);
      state.capturedSecs += (frame.byteLength - DICT_HEADER_BYTES) / 4 / rate;
      socket.send(frame);
    },
    async stop() {
      if (state.stopped) return state.final;
      state.stopped = true;
      if (socket.readyState !== WebSocket.OPEN) return state.final;
      socket.send(JSON.stringify({ type: "stop" }));
      const timeoutMs = info.stopBaseMs + state.capturedSecs * info.stopPerAudioSecondMs;
      let timer: number | undefined;
      try {
        return await Promise.race([
          state.final,
          new Promise<string>((_resolve, reject) => {
            timer = window.setTimeout(
              () => reject(new Error("Dictation timed out while producing the final transcript.")),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) window.clearTimeout(timer);
        socket.close();
      }
    },
    cancel() {
      if (state.stopped) return;
      state.stopped = true;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
      socket.close();
    },
  };
}

/** Connect the renderer directly to Whisper's sidecar session. */
export async function connectDictSession(
  info: DictSessionInfo,
  onPartial: (text: string) => void,
): Promise<DictSession> {
  const socket = new WebSocket(info.url);
  socket.binaryType = "arraybuffer";
  const state = createSessionState();
  addSessionListeners(socket, state, onPartial);
  await waitForSocketOpen(socket);
  return createDictSession(socket, state, info);
}
