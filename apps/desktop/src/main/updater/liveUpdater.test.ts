import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  defaultInstallDeps: vi.fn(),
  performUpdate: vi.fn(),
}));

vi.mock("./tauriUpdater.js", () => ({
  checkForUpdate: mocks.checkForUpdate,
  performUpdate: mocks.performUpdate,
}));
vi.mock("./installBundle.js", () => ({ defaultInstallDeps: mocks.defaultInstallDeps }));

import { createLiveUpdater } from "./liveUpdater.js";
import type { FetchLike } from "./tauriUpdater.js";

const fakeFetch = vi.fn() as unknown as FetchLike;

function updater() {
  return createLiveUpdater({
    currentVersion: "0.26.0",
    execPath: "/fabricated/Arcelle",
    quit: vi.fn(),
    fetchImpl: fakeFetch,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLiveUpdater().check", () => {
  it("returns no update when the fabricated updater reports none", async () => {
    mocks.checkForUpdate.mockResolvedValue({ available: false, reason: "not_newer" });

    await expect(updater().check()).resolves.toBeNull();
    expect(mocks.checkForUpdate).toHaveBeenCalledWith(fakeFetch, "0.26.0");
  });

  it("uses a fabricated global fetch implementation when none is injected", async () => {
    const defaultFetch = vi.fn() as unknown as FetchLike;
    vi.stubGlobal("fetch", defaultFetch);
    mocks.checkForUpdate.mockResolvedValue({ available: false, reason: "not_newer" });
    const live = createLiveUpdater({
      currentVersion: "0.26.0",
      execPath: "/fabricated/Arcelle",
      quit: vi.fn(),
    });

    await expect(live.check()).resolves.toBeNull();
    expect(mocks.checkForUpdate).toHaveBeenCalledWith(defaultFetch, "0.26.0");
  });

  it("returns an available fabricated version without an absent release note", async () => {
    mocks.checkForUpdate.mockResolvedValue({
      available: true,
      manifest: { version: "0.27.0" },
    });

    await expect(updater().check()).resolves.toEqual({ version: "0.27.0" });
  });

  it("keeps a fabricated release note with the available version", async () => {
    mocks.checkForUpdate.mockResolvedValue({
      available: true,
      manifest: { version: "0.27.0", notes: "Faster notes." },
    });

    await expect(updater().check()).resolves.toEqual({ version: "0.27.0", notes: "Faster notes." });
  });

  it("propagates an asynchronous fabricated updater failure", async () => {
    mocks.checkForUpdate.mockRejectedValue(new Error("update service unavailable"));

    await expect(updater().check()).rejects.toThrow("update service unavailable");
  });
});

describe("createLiveUpdater().install", () => {
  it("downloads through the verified updater and stages its payload privately", async () => {
    const quit = vi.fn();
    const install = vi.fn();
    mocks.defaultInstallDeps.mockReturnValue(install);
    mocks.performUpdate.mockImplementation(async (deps: {
      writeVerifiedPayload(payload: Buffer): Promise<string>;
      install: unknown;
      execPath: string;
      fetchImpl: FetchLike;
    }, version: string) => {
      expect(version).toBe("0.26.0");
      expect(deps.fetchImpl).toBe(fakeFetch);
      expect(deps.install).toBe(install);
      expect(deps.execPath).toBe("/fabricated/Arcelle");

      const staged = await deps.writeVerifiedPayload(Buffer.from("signed update"));
      expect(await fs.readFile(staged, "utf8")).toBe("signed update");
      expect((await fs.stat(staged)).mode & 0o777).toBe(0o600);
      await fs.rm(staged.substring(0, staged.lastIndexOf("/")), { recursive: true });
    });
    const live = createLiveUpdater({
      currentVersion: "0.26.0",
      execPath: "/fabricated/Arcelle",
      quit,
      fetchImpl: fakeFetch,
    });

    await expect(live.install()).resolves.toBeUndefined();
    expect(mocks.defaultInstallDeps).toHaveBeenCalledWith(quit);
    expect(mocks.performUpdate).toHaveBeenCalledOnce();
  });
});
