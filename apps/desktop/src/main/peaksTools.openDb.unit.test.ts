import { describe, expect, it, vi } from "vitest";

import { openDb, type RoomSource } from "./peaksTools.js";

describe("openDb", () => {
  it("returns the database from a fabricated currently open room", () => {
    const db = { prepare: vi.fn() };
    const currentRoom = vi.fn(() => ({ db, path: "/fake/room.roomai" }));
    const room: RoomSource = { currentRoom: currentRoom as RoomSource["currentRoom"] };

    expect(openDb(room)).toBe(db);
    expect(currentRoom).toHaveBeenCalledTimes(1);
  });

  it("refuses synchronously when the fabricated room source has no open room", () => {
    const room: RoomSource = { currentRoom: () => null };

    expect(() => openDb(room)).toThrow("No room is open.");
  });
});
