import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: vi.fn() }));
vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  closeSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: fakes.readFileSync,
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("node:os", () => ({ default: { hostname: vi.fn() } }));
vi.mock("../db-host/open.js", () => ({ createRoom: vi.fn(), openRoom: vi.fn(), openRoomReadonly: vi.fn() }));
vi.mock("../db-host/migrate.js", () => ({ migrate: vi.fn() }));
vi.mock("../db-host/meta.js", () => ({ setMeta: vi.fn() }));
vi.mock("../db-host/recovery.js", () => ({ recoverySidecarPath: vi.fn() }));
vi.mock("./pathSafety.js", () => ({ PRIVATE_DIR: ".arcelle" }));

import { readWorkspaceMarker } from "./roomLayout.js";

const rootPath = "/fake/workspace";

beforeEach(() => {
  fakes.readFileSync.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("readWorkspaceMarker", () => {
  it("returns a complete supported marker from the fabricated private metadata path", () => {
    const marker = { format: "arcelle-workspace", formatVersion: 2, roomId: "room-12345678" };
    fakes.readFileSync.mockReturnValue(JSON.stringify(marker));

    expect(readWorkspaceMarker(rootPath)).toEqual(marker);
    expect(fakes.readFileSync).toHaveBeenCalledWith("/fake/workspace/.arcelle/room.json", "utf8");
  });

  it.each([
    ["a missing marker", () => { throw new Error("fabricated missing file"); }],
    ["malformed marker JSON", () => "{not-json"],
  ])("reports %s as a non-workspace folder", (_case, answer) => {
    fakes.readFileSync.mockImplementation(answer);

    expect(() => readWorkspaceMarker(rootPath)).toThrow("This folder is not an Arcelle workspace.");
  });

  it.each([
    ["another format", { format: "other", formatVersion: 2, roomId: "room-12345678" }],
    ["another version", { format: "arcelle-workspace", formatVersion: 1, roomId: "room-12345678" }],
    ["a non-string room id", { format: "arcelle-workspace", formatVersion: 2, roomId: 42 }],
    ["a short room id", { format: "arcelle-workspace", formatVersion: 2, roomId: "short" }],
  ])("rejects %s as an unsupported workspace format", (_case, marker) => {
    fakes.readFileSync.mockReturnValue(JSON.stringify(marker));

    expect(() => readWorkspaceMarker(rootPath)).toThrow("This folder uses an unsupported Arcelle workspace format.");
  });
});
