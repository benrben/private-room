import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  closeSync: vi.fn(),
  lockContent: null as string | null,
  openSync: vi.fn(),
  randomUUID: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: fakes.randomUUID }));
vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  closeSync: fakes.closeSync,
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  openSync: fakes.openSync,
  readFileSync: fakes.readFileSync,
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: fakes.writeFileSync,
}));
vi.mock("node:os", () => ({ default: { hostname: () => "fake-host" } }));
vi.mock("../db-host/open.js", () => ({ createRoom: vi.fn(), openRoom: vi.fn(), openRoomReadonly: vi.fn() }));
vi.mock("../db-host/migrate.js", () => ({ migrate: vi.fn() }));
vi.mock("../db-host/meta.js", () => ({ setMeta: vi.fn() }));
vi.mock("../db-host/recovery.js", () => ({ recoverySidecarPath: vi.fn() }));

import { acquireWorkspaceLease, releaseWorkspaceLease } from "./roomLayout";

const rootPath = "/fake/workspace";
const lockPath = "/fake/workspace/.arcelle/room.lock";
const originalSetInterval = globalThis.setInterval;

function missingFile(path: string): Error & { code: string } {
  return Object.assign(new Error(`Missing fake file: ${path}`), { code: "ENOENT" });
}

function parseLock(): Record<string, unknown> {
  if (!fakes.lockContent) throw new Error("Fake lock was not written.");
  return JSON.parse(fakes.lockContent) as Record<string, unknown>;
}

let renewals: Array<() => void>;
let renewalHandle: { unref: ReturnType<typeof vi.fn> };

beforeEach(() => {
  renewals = [];
  renewalHandle = { unref: vi.fn() };
  fakes.lockContent = null;
  fakes.randomUUID.mockReset().mockReturnValue("fake-lease-token");
  fakes.closeSync.mockReset();
  fakes.openSync.mockReset().mockImplementation((file: string, flag: string) => {
    if (file !== lockPath || flag !== "wx") throw new Error("Unexpected fake filesystem open.");
    if (fakes.lockContent !== null) throw Object.assign(new Error("Lock already exists"), { code: "EEXIST" });
    fakes.lockContent = "";
    return 71;
  });
  fakes.readFileSync.mockReset().mockImplementation((file: string) => {
    if (file === "/fake/workspace/.arcelle/room.json") {
      return JSON.stringify({ format: "arcelle-workspace", formatVersion: 2, roomId: "fake-room-id" });
    }
    if (file === lockPath && fakes.lockContent !== null) return fakes.lockContent;
    throw missingFile(file);
  });
  fakes.writeFileSync.mockReset().mockImplementation((destination: string | number, data: string) => {
    if (destination !== 71 && destination !== lockPath) throw new Error("Unexpected fake filesystem write.");
    fakes.lockContent = data;
  });
  vi.stubGlobal("setInterval", vi.fn((callback: () => void) => {
    renewals.push(callback);
    return renewalHandle;
  }));
  vi.stubGlobal("clearInterval", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.set(globalThis, "setInterval", originalSetInterval);
  vi.restoreAllMocks();
});

describe("workspace lease renewal with a fabricated filesystem", () => {
  it("rewrites the lease only while the fabricated lock still carries its token", () => {
    const lease = acquireWorkspaceLease(rootPath);
    const initial = parseLock();
    expect(initial).toMatchObject({ token: "fake-lease-token", host: "fake-host", rootPath });
    expect(renewalHandle.unref).toHaveBeenCalledTimes(1);
    expect(renewals).toHaveLength(1);

    fakes.writeFileSync.mockClear();
    renewals[0]?.();

    expect(fakes.writeFileSync).toHaveBeenCalledWith(
      lockPath,
      expect.stringContaining('"token":"fake-lease-token"'),
      { encoding: "utf8", mode: 0o600 },
    );
    expect(parseLock()).toMatchObject({ token: lease.token, host: "fake-host", rootPath });
  });

  it("never overwrites a different, missing, or malformed fabricated lease", () => {
    acquireWorkspaceLease(rootPath);
    const renew = renewals[0];
    if (!renew) throw new Error("Fake renewal callback missing.");
    fakes.writeFileSync.mockClear();

    fakes.lockContent = JSON.stringify({ token: "another-owner" });
    expect(renew).not.toThrow();
    expect(fakes.writeFileSync).not.toHaveBeenCalled();

    fakes.lockContent = "not valid JSON";
    expect(renew).not.toThrow();
    expect(fakes.writeFileSync).not.toHaveBeenCalled();

    fakes.lockContent = null;
    expect(renew).not.toThrow();
    expect(fakes.writeFileSync).not.toHaveBeenCalled();
  });

  it("treats a missing or malformed lock as already released", () => {
    const lease = acquireWorkspaceLease(rootPath);
    fakes.lockContent = "not-json";

    expect(() => releaseWorkspaceLease(lease)).not.toThrow();
    expect(clearInterval).toHaveBeenCalledWith(renewalHandle);
  });
});
