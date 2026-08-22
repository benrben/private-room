import { describe, expect, it } from "vitest";
import { RoomPin, type RoomPinSource } from "./roomPin.js";

function source(path: string | null, epoch: number): RoomPinSource {
  return { roomEpoch: () => epoch, currentRoomPath: () => path };
}

describe("RoomPin", () => {
  it("is null when no room is open", () => {
    expect(RoomPin.take(source(null, 1))).toBeNull();
  });

  it("holds true against the exact (path, epoch) it was taken from", () => {
    const pin = RoomPin.take(source("/rooms/a.roomai", 5))!;
    expect(pin).not.toBeNull();
    expect(pin.holds(5, "/rooms/a.roomai")).toBe(true);
  });

  it("does not hold once the room's epoch has moved on (closed and reopened)", () => {
    const pin = RoomPin.take(source("/rooms/a.roomai", 5))!;
    // Same file, but a later open bumped the epoch.
    expect(pin.holds(6, "/rooms/a.roomai")).toBe(false);
  });

  it("does not hold against a DIFFERENT room file, even at the same epoch", () => {
    const pin = RoomPin.take(source("/rooms/a.roomai", 5))!;
    expect(pin.holds(5, "/rooms/b.roomai")).toBe(false);
  });

  it("a late-finishing write pinned to a stale room is correctly refused", () => {
    // The scenario RoomPin exists for: a turn starts against room A/epoch 1,
    // the user closes it and opens a DIFFERENT room before the turn's write
    // lands. The pin must say "no, that's not the room that's open now."
    const pin = RoomPin.take(source("/rooms/a.roomai", 1))!;
    const nowOpen = source("/rooms/b.roomai", 2); // a different room, later
    expect(pin.holds(nowOpen.roomEpoch(), nowOpen.currentRoomPath()!)).toBe(false);
  });

  it("the SAME room re-opened (new epoch, same path) is correctly refused too", () => {
    const pin = RoomPin.take(source("/rooms/a.roomai", 1))!;
    const reopened = source("/rooms/a.roomai", 2);
    expect(pin.holds(reopened.roomEpoch(), reopened.currentRoomPath()!)).toBe(false);
  });
});
