import { describe, expect, it, vi } from "vitest";
import { TurnId, emitUnowned, envelope, stepFor } from "./turn.js";
import type { EventSender } from "./turn.js";

// Port of src-tauri/src/turn.rs's `#[cfg(test)] mod tests` (3 tests, named
// after their Rust counterparts below), plus coverage for
// `TurnId.emit`/`step`/`emitUnowned`/`stepFor`, which have no Rust unit test
// of their own (they need a real Tauri `Emitter` there) but are trivially
// testable here against a fake sender.

describe("envelope (the wire shape)", () => {
  it("an_identified_event_names_its_run_and_its_chat", () => {
    const turn = new TurnId("run-1", "chat-a");
    // Asserted through JSON, not just object identity: what matters is the
    // three keys the renderer's `askEvent` unwraps, spelled exactly as
    // serde's `rename_all` spelled them.
    expect(JSON.parse(JSON.stringify(envelope(turn, "half an answer")))).toEqual({
      runId: "run-1",
      chatId: "chat-a",
      v: "half an answer",
    });
  });

  it("the_payload_shape_the_listener_used_to_get_is_untouched", () => {
    // `ask-step` carries an object, `ask-round` carries nothing. Both must
    // survive the envelope byte-identically inside `v`.
    const turn = new TurnId("run-2", "chat-b");
    const step = { label: "Reading part 2/9", node: "file#1" };
    const wire = envelope(turn, step);
    expect(wire.v).toEqual(step);
    // Rust's `()` (unit) serializes to JSON `null` via serde_json; the direct
    // TS analogue of "no payload" is `null` passed through unchanged.
    expect(envelope(turn, null).v).toBeNull();
  });

  it("an_unowned_event_says_so_instead_of_borrowing_an_owner", () => {
    // The whole point: no turn means NULL ids, never "the chat on screen".
    const wire = envelope(null, "Summarize");
    expect(wire.runId).toBeNull();
    expect(wire.chatId).toBeNull();
    expect(wire.v).toBe("Summarize");
    // And null on the WIRE too — `undefined` would drop the key entirely and
    // the renderer could not tell "unowned" from "unwrapped payload".
    expect(JSON.stringify(wire)).toBe('{"runId":null,"chatId":null,"v":"Summarize"}');
  });
});

describe("TurnId.emit / step / emitUnowned / stepFor", () => {
  it("delivers the envelope on the named channel", () => {
    const sent: Array<[string, unknown]> = [];
    const send: EventSender = (event, payload) => sent.push([event, payload]);
    const turn = new TurnId("run-3", "chat-c");

    turn.emit(send, "ask-delta", "partial");
    turn.step(send, "Reading"); // step() is sugar for emit(..., "ask-step", label)

    expect(sent).toEqual([
      ["ask-delta", { runId: "run-3", chatId: "chat-c", v: "partial" }],
      ["ask-step", { runId: "run-3", chatId: "chat-c", v: "Reading" }],
    ]);
  });

  it("emitUnowned sends null ids on the named channel", () => {
    const send = vi.fn();
    emitUnowned(send, "ask-step", "Summarize");
    expect(send).toHaveBeenCalledWith("ask-step", { runId: null, chatId: null, v: "Summarize" });
  });

  it("stepFor picks the owned path when a turn is known, and the unowned path otherwise", () => {
    const send = vi.fn();
    const turn = new TurnId("run-5", "chat-e");

    stepFor(turn, send, "Reading");
    stepFor(null, send, "Summarize");

    expect(send).toHaveBeenNthCalledWith(1, "ask-step", {
      runId: "run-5",
      chatId: "chat-e",
      v: "Reading",
    });
    expect(send).toHaveBeenNthCalledWith(2, "ask-step", {
      runId: null,
      chatId: null,
      v: "Summarize",
    });
  });

  it("a sender that throws (a closed window) never fails the running turn", () => {
    const send: EventSender = () => {
      throw new Error("window is destroyed");
    };
    const turn = new TurnId("run-4", "chat-d");

    expect(() => turn.emit(send, "ask-delta", "x")).not.toThrow();
    expect(() => turn.step(send, "Reading")).not.toThrow();
    expect(() => emitUnowned(send, "ask-step", "x")).not.toThrow();
    expect(() => stepFor(turn, send, "x")).not.toThrow();
    expect(() => stepFor(null, send, "x")).not.toThrow();
  });
});
