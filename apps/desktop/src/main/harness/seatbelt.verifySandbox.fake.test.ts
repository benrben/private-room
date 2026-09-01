import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  randomUUID: vi.fn(),
  readdirSync: vi.fn(),
  realpathSync: vi.fn(),
  rmSync: vi.fn(),
  spawnSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: fakes.spawnSync }));
vi.mock("node:crypto", () => ({ randomUUID: fakes.randomUUID }));
vi.mock("node:fs", () => ({
  existsSync: fakes.existsSync,
  lstatSync: fakes.lstatSync,
  mkdirSync: fakes.mkdirSync,
  readdirSync: fakes.readdirSync,
  realpathSync: fakes.realpathSync,
  rmSync: fakes.rmSync,
  writeFileSync: fakes.writeFileSync,
}));
vi.mock("node:os", () => ({
  default: {
    homedir: () => "/fake/home",
    userInfo: () => ({ username: "fake-user" }),
  },
}));

import {
  spawnWithNativeWorkspaceSandbox,
  spawnWithPrivatePathSandbox,
  verifyNativeWorkspaceSandbox,
  type NativeWorkspaceSandbox,
} from "./seatbelt.js";

const options: NativeWorkspaceSandbox = {
  workspacePath: "/fake/workspace",
  runtimePath: "/fake/runtime/run-1",
  executable: "/fake/bin/codex",
  provider: "codex",
  writeEnabled: true,
  env: { CODEX_HOME: "/fake/codex-home" },
};

const token = "fake-sandbox-token";

function regularWorkspace() {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.existsSync.mockReturnValue(true);
  fakes.lstatSync.mockReturnValue(regularWorkspace());
  fakes.readdirSync.mockReturnValue([]);
  fakes.realpathSync.mockImplementation((candidate: string) => path.resolve(candidate));
  fakes.randomUUID.mockReturnValue(token);
  fakes.spawnSync.mockReturnValue({ status: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyNativeWorkspaceSandbox", () => {
  it("fails closed before any filesystem work when sandbox-exec is unavailable", () => {
    fakes.existsSync.mockReturnValue(false);

    expect(verifyNativeWorkspaceSandbox(options)).toBe(false);

    expect(fakes.lstatSync).not.toHaveBeenCalled();
    expect(fakes.spawnSync).not.toHaveBeenCalled();
  });

  it("refuses an exposed fabricated workspace symlink before preparing canaries", () => {
    fakes.lstatSync.mockReturnValue({ isSymbolicLink: () => true, isDirectory: () => false });

    expect(verifyNativeWorkspaceSandbox(options)).toBe(false);

    expect(fakes.mkdirSync).not.toHaveBeenCalled();
    expect(fakes.spawnSync).not.toHaveBeenCalled();
  });

  it("fails closed when the fabricated workspace tree cannot be inspected", () => {
    fakes.lstatSync.mockImplementation(() => {
      throw new Error("fabricated lstat failure");
    });

    expect(verifyNativeWorkspaceSandbox(options)).toBe(false);

    expect(fakes.mkdirSync).not.toHaveBeenCalled();
    expect(fakes.spawnSync).not.toHaveBeenCalled();
  });

  it("returns the fabricated sandbox command success after preparing and cleaning all canaries", () => {
    expect(verifyNativeWorkspaceSandbox(options)).toBe(true);

    const allowed = "/fake/workspace/.sandbox.arcelle-fake-sandbox-token.tmp";
    const privateCanary = "/fake/workspace/.arcelle/fake-sandbox-token";
    const outside = "/fake/runtime/fake-sandbox-token-outside";
    const runtimeCanary = "/fake/runtime/run-1/fake-sandbox-token";
    expect(fakes.mkdirSync).toHaveBeenCalledWith("/fake/runtime/run-1", { recursive: true, mode: 0o700 });
    expect(fakes.writeFileSync).toHaveBeenCalledWith(allowed, "allowed", { mode: 0o600, flag: "wx" });
    expect(fakes.writeFileSync).toHaveBeenCalledWith(privateCanary, "private", { mode: 0o600, flag: "wx" });
    expect(fakes.writeFileSync).toHaveBeenCalledWith(outside, "outside", { mode: 0o600, flag: "wx" });
    expect(fakes.spawnSync).toHaveBeenCalledWith(
      "/usr/bin/sandbox-exec",
      expect.arrayContaining(["-p", expect.any(String), "/bin/sh", "-c", expect.any(String), "arcelle"]),
      expect.objectContaining({ cwd: "/fake/workspace", encoding: "utf8", timeout: 5_000 })
    );
    expect(fakes.rmSync.mock.calls).toEqual([
      [allowed, { force: true }],
      [privateCanary, { force: true }],
      [outside, { force: true }],
      [runtimeCanary, { force: true }],
    ]);
  });

  it("uses the read-only fabricated canary script when workspace writes are disabled", () => {
    expect(verifyNativeWorkspaceSandbox({ ...options, writeEnabled: false })).toBe(true);

    const command = fakes.spawnSync.mock.calls[0]?.[1];
    expect(command?.some((argument) => argument.includes('! ( : > "$1" )'))).toBe(true);
  });

  it("uses the fabricated ambient environment when no explicit provider environment is supplied", () => {
    expect(verifyNativeWorkspaceSandbox({ ...options, env: undefined })).toBe(true);

    expect(fakes.spawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ TMPDIR: "/fake/runtime/run-1" }) })
    );
  });

  it("returns false when the fabricated sandbox command rejects its canaries while still cleaning them", () => {
    fakes.spawnSync.mockReturnValue({ status: 1 });

    expect(verifyNativeWorkspaceSandbox(options)).toBe(false);

    expect(fakes.rmSync).toHaveBeenCalledTimes(4);
  });

  it("refuses native spawning when the fabricated preflight cannot prove isolation", () => {
    fakes.spawnSync.mockReturnValue({ status: 1 });

    expect(() => spawnWithNativeWorkspaceSandbox(options, ["--version"]))
      .toThrow("workspace isolation failed");
  });

  it("keeps the legacy private-path launcher fail-closed", () => {
    expect(() => spawnWithPrivatePathSandbox()).toThrow(
      "A run-private path is required for native workspace isolation.",
    );
  });

  it("returns false and cleans every canary when writing a fabricated preflight file fails", () => {
    fakes.writeFileSync.mockImplementation(() => {
      throw new Error("fabricated canary write failure");
    });

    expect(verifyNativeWorkspaceSandbox(options)).toBe(false);

    expect(fakes.spawnSync).not.toHaveBeenCalled();
    expect(fakes.rmSync).toHaveBeenCalledTimes(4);
  });
});
