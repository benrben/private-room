import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const databaseCalls = vi.hoisted(() => ({ close: vi.fn() }));

vi.mock("better-sqlite3-multiple-ciphers", () => ({
  default: class FabricatedDatabase {
    pragma(): void {}
    prepare(): { get(): never } {
      return { get: () => { throw { code: "SQLITE_NOTADB" }; } };
    }
    close(): never {
      databaseCalls.close();
      throw new Error("fabricated close refusal");
    }
  },
}));

import { createRoomFile, openRoom, openRoomReadonly } from "./open.js";

const roots: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function existingRoomPath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "arcelle-open-close-fake-"));
  roots.push(root);
  const room = path.join(root, "fixture.roomai");
  writeFileSync(room, "fabricated encrypted bytes");
  return room;
}

describe("room database close failure containment", () => {
  it("preserves a creation failure even when closing the partial handle also fails", () => {
    const room = existingRoomPath();
    expect(() => createRoomFile(room, () => { throw new Error("fabricated init failure"); }))
      .toThrow("fabricated init failure");
    expect(databaseCalls.close).toHaveBeenCalledOnce();
  });

  it("preserves the classified open failure when ordinary and readonly handles refuse to close", () => {
    const room = existingRoomPath();
    expect(() => openRoom(room, "correct horse battery staple")).toThrow("WRONG_PASSWORD");
    expect(() => openRoomReadonly(room, "correct horse battery staple")).toThrow("WRONG_PASSWORD");
    expect(databaseCalls.close).toHaveBeenCalledTimes(2);
  });
});
