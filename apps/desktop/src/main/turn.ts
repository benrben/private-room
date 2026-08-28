/**
 * Run/chat identity for every event a chat turn emits.
 *
 * Ported from `src-tauri/src/turn.rs` (163 lines). Owner replacement #4,
 * 2026-08-03. Two live-QA symptoms shared one cause: an answer streamed into
 * whatever conversation happened to be on screen, and a brand-new chat showed
 * a 30,034-token budget bar. Neither is a bug in the turn itself — the answer
 * is filed against the right chat and the history really is empty. The events
 * were simply anonymous: a bare broadcast, so the only way the UI could guess
 * who an event belonged to was "whatever is mounted right now".
 *
 * So every `ask-*` event travels in an envelope naming the run that produced
 * it and the chat that owns it:
 *
 * ```json
 * { "runId": "…", "chatId": "…", "v": <the payload the listener used to get> }
 * ```
 *
 * `runId` is the ask id the FRONTEND minted and passed to `ask`/`run_command`,
 * so the chat registers the run before the first event can arrive and can then
 * reject anything that does not match — including a late event from a turn it
 * has already finished. The same id is the `/cancel` handle (see `cancel.ts`)
 * and the sidecar's own `run_id`, so it is stable across the whole turn: tool
 * calls over the MCP bridge and sub-agent delegation inside the graph all
 * report under it.
 *
 * IDs only. Nothing here carries room content — the envelope is two opaque
 * handles and the payload the listener already received.
 *
 * The wire shape is reused verbatim from `shared/events.ts`'s
 * `AskEnvelope<T>` rather than redefined here: that interface IS the exact
 * camelCase shape `crate::turn::TurnEvent<T>` serialized to, it already
 * compiles, and every `ask-*` channel in `EventPayloads` is declared in terms
 * of it. A second local definition of the same three fields is how the two
 * drift.
 */

import type { AskEnvelope } from "../shared/events.js";

/**
 * Whatever mechanism actually delivers an event to the renderer —
 * `BrowserWindow#webContents.send` bound to a specific window, most commonly,
 * or a test spy. Kept abstract (rather than importing `electron` here) so
 * this module stays unit-testable with a plain function and has no runtime
 * dependency on Electron at all, mirroring how the Rust source is generic
 * over `tauri::Runtime`/`Emitter` rather than naming a concrete window.
 */
export type EventSender = (event: string, payload: unknown) => void;

/**
 * The identity of one chat turn. Cheap to hold and pass around (two plain
 * strings), because it is threaded down every path an event can be emitted
 * from.
 */
export class TurnId {
  constructor(
    /** The run handle — the frontend's ask id, the `/cancel` token, and the
     * `run_id` the sidecar echoes on every NDJSON line of this run. */
    readonly runId: string,
    readonly chatId: string
  ) {}

  /**
   * Emit one identified turn event. Failures are ignored exactly as the bare
   * `window.emit` calls this replaced did (Rust: `let _ = to.emit(...)`): a
   * closed window must never fail a running turn.
   */
  emit<T>(send: EventSender, event: string, payload: T): void {
    try {
      send(event, envelope(this, payload));
    } catch {
      // Swallowed deliberately — see the doc above.
    }
  }

  /** The overwhelmingly common case: one step chip. */
  step(send: EventSender, label: string): void {
    this.emit(send, "ask-step", label);
  }
}

/**
 * A turn event emitted by something that genuinely has no turn — today only
 * the AI-actions menu command, which runs from the file header and belongs to
 * no conversation at all.
 *
 * The ids are null RATHER than borrowed from whatever is on screen, and the
 * frontend treats a null-id event as "show it only if the chat in front of me
 * is actually running something". Guessing an owner here is precisely the
 * behaviour this module exists to delete.
 */
export function emitUnowned<T>(send: EventSender, event: string, payload: T): void {
  try {
    send(event, envelope(null, payload));
  } catch {
    // Same swallow as TurnId.emit — see there.
  }
}

/**
 * A step chip from a caller that may not know its turn. A tool executed over
 * a PERSISTENT bridge (a Leash server, a nested advisor) genuinely has no ask
 * behind it, so it emits null ids rather than borrowing the screen's chat.
 */
export function stepFor(turn: TurnId | null, send: EventSender, label: string): void {
  if (turn !== null) {
    turn.step(send, label);
  } else {
    emitUnowned(send, "ask-step", label);
  }
}

/**
 * Wrap a payload for `turn` (or for nobody). Split out from
 * {@link TurnId.emit} so the wire shape can be asserted without any real
 * event sender, exactly as Rust split `envelope` out of `TurnId::emit` so it
 * could be asserted without a Tauri runtime.
 */
export function envelope<T>(turn: TurnId | null, v: T): AskEnvelope<T> {
  return {
    runId: turn !== null ? turn.runId : null,
    chatId: turn !== null ? turn.chatId : null,
    v,
  };
}
