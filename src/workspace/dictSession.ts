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

/** Connect the renderer directly to Whisper's sidecar session. */
export async function connectDictSession(
  info: DictSessionInfo,
  onPartial: (text: string) => void,
): Promise<DictSession> {
  const socket = new WebSocket(info.url);
  socket.binaryType = "arraybuffer";
  let capturedSecs = 0;
  let stopped = false;
  let settled = false;
  let resolveFinal!: (text: string) => void;
  let rejectFinal!: (error: Error) => void;
  const final = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  // A rejection is consumed by stop(); attach a handler now so a socket that
  // dies while the user is still speaking never creates an unhandled promise.
  void final.catch(() => {});

  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    rejectFinal(new Error(message));
  };
  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let message: DictWireMessage;
    try {
      message = JSON.parse(event.data) as DictWireMessage;
    } catch {
      return;
    }
    if (message.type === "partial" && typeof message.text === "string") {
      onPartial(message.text);
      return;
    }
    if (message.type !== "final" || settled) return;
    settled = true;
    if (message.ok === true) {
      resolveFinal(typeof message.text === "string" ? message.text : "");
    } else {
      rejectFinal(new Error(typeof message.error === "string" ? message.error : "Dictation failed."));
    }
  });
  socket.addEventListener("error", () => fail("The dictation connection failed."));
  socket.addEventListener("close", (event: CloseEvent) => {
    if (event.code === 4404) fail("STT_MODEL_MISSING");
    else if (!settled) fail(event.reason || "The dictation connection closed before a transcript arrived.");
  });

  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) return resolve();
    const opened = (): void => {
      cleanup();
      resolve();
    };
    const closed = (event: CloseEvent): void => {
      cleanup();
      reject(new Error(event.code === 4404 ? "STT_MODEL_MISSING" : event.reason || "Could not open dictation."));
    };
    const cleanup = (): void => {
      socket.removeEventListener("open", opened);
      socket.removeEventListener("close", closed);
    };
    socket.addEventListener("open", opened);
    socket.addEventListener("close", closed);
  });

  return {
    async push(rate, dataB64) {
      if (stopped || socket.readyState !== WebSocket.OPEN) return;
      const frame = encodeDictAudioFrame(rate, dataB64);
      capturedSecs += (frame.byteLength - DICT_HEADER_BYTES) / 4 / rate;
      socket.send(frame);
    },
    async stop() {
      if (stopped) return final;
      stopped = true;
      if (socket.readyState !== WebSocket.OPEN) return final;
      socket.send(JSON.stringify({ type: "stop" }));
      const timeoutMs = info.stopBaseMs + capturedSecs * info.stopPerAudioSecondMs;
      let timer: number | undefined;
      try {
        return await Promise.race([
          final,
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
      if (stopped) return;
      stopped = true;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
      socket.close();
    },
  };
}
