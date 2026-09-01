import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  closeSync: vi.fn(),
  lockContent: null as string | null,
  openSync: vi.fn(),
  randomUUID: vi.fn(),
  readFileSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: fakes.randomUUID }));
vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  closeSync: fakes.closeSync,
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: fakes.openSync,
  readFileSync: fakes.readFileSync,
  renameSync: vi.fn(),
  rmSync: fakes.rmSync,
  statSync: vi.fn(),
  writeFileSync: fakes.writeFileSync,
}));
vi.mock("node:os", () => ({ default: { hostname: () => "fake-host" } }));
vi.mock("../db-host/open.js", () => ({ createRoom: vi.fn(), openRoom: vi.fn(), openRoomReadonly: vi.fn() }));
vi.mock("../db-host/migrate.js", () => ({ migrate: vi.fn() }));
vi.mock("../db-host/meta.js", () => ({ setMeta: vi.fn() }));
vi.mock("../db-host/recovery.js", () => ({ recoverySidecarPath: vi.fn() }));

import { acquireWorkspaceLease, WorkspaceLeaseConflictError } from "./roomLayout.js";

const rootPath = "/fake/workspace";
const lockPath = "/fake/workspace/.arcelle/room.lock";
const now = Date.UTC(2026, 0, 1, 12, 0, 0);

function missing(path: string): Error & { code: string } {
  return Object.assign(new Error(`Missing fake path: ${path}`), { code: "ENOENT" });
}

function existingLease(record: Record<string, unknown>): void {
  fakes.lockContent = JSON.stringify(record);
}

beforeEach(() => {
  fakes.lockContent = null;
  fakes.randomUUID.mockReset().mockReturnValue("fake-lease-token");
  fakes.closeSync.mockReset();
  fakes.openSync.mockReset().mockImplementation((file: string, flag: string) => {
    if (file !== lockPath || flag !== "wx") throw new Error("Unexpected fake lease open.");
    if (fakes.lockContent !== null) throw Object.assign(new Error("Lease exists"), { code: "EEXIST" });
    fakes.lockContent = "";
    return 71;
  });
  fakes.readFileSync.mockReset().mockImplementation((file: string) => {
    if (file === "/fake/workspace/.arcelle/room.json") {
      return JSON.stringify({ format: "arcelle-workspace", formatVersion: 2, roomId: "fake-room-id" });
    }
    if (file === lockPath && fakes.lockContent !== null) return fakes.lockContent;
    throw missing(file);
  });
  fakes.writeFileSync.mockReset().mockImplementation((target: string | number, content: string) => {
    if (target !== 71 && target !== lockPath) throw new Error("Unexpected fake lease write.");
    fakes.lockContent = content;
  });
  fakes.rmSync.mockReset().mockImplementation((file: string) => {
    if (file !== lockPath) throw new Error("Unexpected fake lease removal.");
    fakes.lockContent = null;
  });
  vi.stubGlobal("setInterval", vi.fn(() => ({ unref: vi.fn() })));
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("acquireWorkspaceLease", () => {
  it("creates a private lease record in a fabricated workspace", () => {
    const lease = acquireWorkspaceLease(rootPath);

    expect(lease).toMatchObject({ token: "fake-lease-token", lockPath });
    expect(JSON.parse(fakes.lockContent ?? "{}")).toMatchObject({
      token: "fake-lease-token",
      host: "fake-host",
      rootPath,
    });
    expect(fakes.closeSync).toHaveBeenCalledWith(71);
  });

  it("reclaims a copied workspace's stale lock before writing its own lease", () => {
    existingLease({ rootPath: "/fake/copied-from", host: "fake-host", pid: 42 });

    const lease = acquireWorkspaceLease(rootPath);

    expect(lease.token).toBe("fake-lease-token");
    expect(fakes.rmSync).toHaveBeenCalledWith(lockPath, { force: true });
    expect(JSON.parse(fakes.lockContent ?? "{}")).toMatchObject({ rootPath, token: "fake-lease-token" });
  });

  it("refuses a lease held by a live local fabricated process", () => {
    existingLease({ host: "fake-host", pid: 42, rootPath });

    let error: unknown;
    try {
      acquireWorkspaceLease(rootPath);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WorkspaceLeaseConflictError);
    expect(error).toMatchObject({ remote: false, message: expect.stringMatching(/already open for writing/i) });
    expect(fakes.rmSync).not.toHaveBeenCalled();
  });

  it("refuses a freshly renewed lease from another fabricated host", () => {
    existingLease({ host: "other-fake-host", renewedAt: new Date(now).toISOString(), rootPath });

    let error: unknown;
    try {
      acquireWorkspaceLease(rootPath);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WorkspaceLeaseConflictError);
    expect(error).toMatchObject({ remote: true, message: expect.stringMatching(/another device/i) });
    expect(fakes.rmSync).not.toHaveBeenCalled();
  });

  it("reclaims an expired remote lease before the second create attempt", () => {
    existingLease({
      host: "other-fake-host",
      renewedAt: new Date(now - 5 * 60_000 - 1).toISOString(),
      rootPath,
    });

    const lease = acquireWorkspaceLease(rootPath);

    expect(lease.lockPath).toBe(lockPath);
    expect(fakes.rmSync).toHaveBeenCalledWith(lockPath, { force: true });
  });

  it("reports a lease acquisition error after two fabricated stale-lock retries", () => {
    fakes.openSync.mockImplementation(() => {
      throw Object.assign(new Error("Lease exists"), { code: "EEXIST" });
    });
    fakes.rmSync.mockImplementation(() => {});
    existingLease({ host: "other-fake-host", renewedAt: "not a date", rootPath });

    expect(() => acquireWorkspaceLease(rootPath)).toThrow("Could not acquire the room write lease.");
    expect(fakes.rmSync).toHaveBeenCalledTimes(2);
  });

  it("treats EPERM as a live local process and ESRCH as a reclaimable dead process", () => {
    existingLease({ host: "fake-host", pid: 42, rootPath });
    vi.mocked(process.kill).mockImplementationOnce(() => {
      throw Object.assign(new Error("fabricated permission denial"), { code: "EPERM" });
    });
    expect(() => acquireWorkspaceLease(rootPath)).toThrow(WorkspaceLeaseConflictError);

    vi.mocked(process.kill).mockImplementationOnce(() => {
      throw Object.assign(new Error("fabricated dead pid"), { code: "ESRCH" });
    });
    const lease = acquireWorkspaceLease(rootPath);
    expect(lease.token).toBe("fake-lease-token");
    expect(fakes.rmSync).toHaveBeenCalledWith(lockPath, { force: true });
  });

  it("preserves a non-collision error from the first exclusive lock create", () => {
    fakes.openSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("fabricated permission failure"), { code: "EACCES" });
    });

    expect(() => acquireWorkspaceLease(rootPath)).toThrow("fabricated permission failure");
    expect(fakes.rmSync).not.toHaveBeenCalled();
  });

  it("reclaims a malformed existing lease record", () => {
    fakes.lockContent = "not-json";

    const lease = acquireWorkspaceLease(rootPath);

    expect(lease.token).toBe("fake-lease-token");
    expect(fakes.rmSync).toHaveBeenCalledWith(lockPath, { force: true });
  });
});
