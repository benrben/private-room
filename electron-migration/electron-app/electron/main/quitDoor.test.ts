import { describe, expect, it } from "vitest";
import { holdQuit, QuitDoor } from "./quitDoor.js";

describe("holdQuit", () => {
  it("cmd_q_with_unsaved_edits_is_held_exactly_once", () => {
    // Cmd+Q raises a quit request with no code and no window close request,
    // so before this the renderer guard never ran and the buffer went with
    // the process.
    expect(holdQuit(null, true, false)).toBe(true);
    // ...and a second press must quit anyway: a guard that cannot be
    // answered would be a Quit that does nothing.
    expect(holdQuit(null, true, true)).toBe(false);
    // Nothing to lose: never hold.
    expect(holdQuit(null, false, false)).toBe(false);
    // The window's own close guard already asked and then called exit(0);
    // holding that would ask the same question forever.
    expect(holdQuit(0, true, false)).toBe(false);
  });
});

describe("QuitDoor", () => {
  it("the_hold_latch_re_arms_once_the_buffer_is_clean", () => {
    const door = new QuitDoor();
    door.setUnsavedEdits(true);
    expect(door.holdForUnsaved(null)).toBe(true); // first ⌘Q asks
    expect(door.holdForUnsaved(null)).toBe(false); // second ⌘Q quits
    // Saving (or discarding) clears the flag, which re-arms the guard for
    // the NEXT edit — otherwise one answered dialog disabled the door for
    // the rest of the session.
    door.setUnsavedEdits(false);
    door.setUnsavedEdits(true);
    expect(door.holdForUnsaved(null)).toBe(true); // a fresh edit is guarded again
  });

  // Cancel means "not this time", not "never again for this buffer".
  it("cancelling_the_dialog_re_arms_the_door_for_the_same_buffer", () => {
    const door = new QuitDoor();
    door.setUnsavedEdits(true);
    expect(door.holdForUnsaved(null)).toBe(true); // first ⌘Q asks
    // The window asked, the user said Cancel, and the buffer is STILL
    // dirty — so `setUnsavedEdits(false)` is exactly what must not happen
    // here.
    door.rearm();
    expect(door.holdForUnsaved(null)).toBe(true); // a later ⌘Q must ask again, not quit and discard the buffer
    // The fail-open property survives: an UNANSWERED hold still lets the
    // next press through, because nothing re-armed it.
    expect(door.holdForUnsaved(null)).toBe(false);
  });
});
