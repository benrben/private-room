import { listen, type UnlistenFn } from "./platform";
import type { AskTurn } from "./apiTypes";

/** The wire shape of every `ask-*` event: the payload the listener wants, in
 * `v`, under the ids of the run and chat that produced it. Built by
 * `crate::turn` on the host side — see `AskTurn`. */
interface AskEnvelope<T> {
  runId: string | null;
  chatId: string | null;
  v: T;
}

function isAskEnvelope<T>(payload: unknown): payload is AskEnvelope<T> {
  return payload !== null && typeof payload === "object" && "v" in payload;
}

function askEnvelopeValue<T>(payload: unknown): { value: T; turn: AskTurn } {
  if (!isAskEnvelope<T>(payload)) {
    return { value: payload as T, turn: { runId: null, chatId: null } };
  }
  return {
    value: payload.v,
    turn: { runId: payload.runId ?? null, chatId: payload.chatId ?? null },
  };
}

/** Subscribe to one identified turn event.
 *
 * Every listener gets `(payload, turn)` — never the bare payload — so no call
 * site can accidentally go back to guessing whose event it is reading. A
 * payload that arrives WITHOUT an envelope is impossible from this app's own
 * host (every emitter goes through `crate::turn`), so it is treated as
 * unowned rather than silently attributed. */
export function askEvent<T>(
  event: string,
  cb: (v: T, turn: AskTurn) => void,
): Promise<UnlistenFn> {
  return listen<AskEnvelope<T>>(event, (e) => {
    const { value, turn } = askEnvelopeValue<T>(e.payload);
    cb(value, turn);
  });
}
