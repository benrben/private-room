import { beforeEach, describe, expect, it } from "vitest";
import { peekPendingOpen, setPendingOpen, takePendingOpen } from "./pendingOpen.js";

describe("pendingOpen", () => {
  // The slot is a module-level singleton (mirroring Rust's single
  // process-global `AppState.pending_open`), so drain it before each test —
  // `takePendingOpen` is itself the only way to clear it, and doing so here
  // is exactly the consume-once behavior under test.
  beforeEach(() => {
    takePendingOpen();
  });

  it("take_with_nothing_ever_set_returns_null", () => {
    expect(takePendingOpen()).toBeNull();
  });

  it("set_then_take_returns_the_path", () => {
    setPendingOpen("/Users/qa/room.roomai");
    expect(takePendingOpen()).toBe("/Users/qa/room.roomai");
  });

  it("a_second_take_right_after_the_first_returns_null", () => {
    // The consume-once property: `Option::take()` leaves `None` behind, so
    // the same pending path can never be handed to two different callers.
    setPendingOpen("/Users/qa/room.roomai");
    expect(takePendingOpen()).toBe("/Users/qa/room.roomai");
    expect(takePendingOpen()).toBeNull();
  });

  it("a_second_set_before_any_take_replaces_the_first", () => {
    // Matches Rust's `*state.pending_open.lock().unwrap() = Some(path.clone())`
    // — an unconditional overwrite, not an error and not a queue. Only the
    // second path is ever observable.
    setPendingOpen("/Users/qa/first.roomai");
    setPendingOpen("/Users/qa/second.roomai");
    expect(peekPendingOpen()).toBe("/Users/qa/second.roomai");
    expect(takePendingOpen()).toBe("/Users/qa/second.roomai");
    expect(takePendingOpen()).toBeNull();
  });
});
