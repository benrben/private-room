import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  configureVisualIndexDir,
  ensureUp,
  probeRecorded,
  type EnsureUpDeps,
  type RecordedProbeDeps,
} from "./sidecar.js";
import { configuredVisualIndexDir } from "./sidecarAuth.js";

describe("sidecar launch cache configuration", () => {
  it("pins the visual index below the resolved application-data directory", () => {
    configureVisualIndexDir("/tmp/app-data/../trusted-data");
    expect(configuredVisualIndexDir).toBe(path.join(path.resolve("/tmp/app-data/../trusted-data"), "visual-index-v1"));
  });
});

function probeFakes() {
  const probeOnce = vi.fn();
  const sleep = vi.fn().mockResolvedValue(undefined);
  const deps: RecordedProbeDeps = { probeOnce, sleep };
  return { deps, probeOnce, sleep };
}

function ensureFakes() {
  const currentBaseUrl = vi.fn();
  const probeRecorded = vi.fn();
  const shouldReplace = vi.fn();
  const inflightCount = vi.fn();
  const stopOurs = vi.fn();
  const probeOnce = vi.fn();
  const spawnAndWait = vi.fn();
  const deps: EnsureUpDeps = {
    currentBaseUrl,
    probeRecorded,
    shouldReplace,
    inflightCount,
    stopOurs,
    probeOnce,
    spawnAndWait,
  };
  return { deps, currentBaseUrl, probeRecorded, shouldReplace, inflightCount, stopOurs, probeOnce, spawnAndWait };
}

describe("probeRecorded with fabricated health transport", () => {
  it("returns on the first healthy result without waiting", async () => {
    const fake = probeFakes();
    fake.probeOnce.mockResolvedValue("healthy");

    await expect(probeRecorded("http://fake-sidecar", fake.deps)).resolves.toBe("healthy");
    expect(fake.probeOnce).toHaveBeenCalledOnce();
    expect(fake.sleep).not.toHaveBeenCalled();
  });

  it("folds busy across all fake attempts instead of treating later gone readings as dead", async () => {
    const fake = probeFakes();
    fake.probeOnce.mockResolvedValueOnce("gone").mockResolvedValueOnce("busy").mockResolvedValueOnce("gone");

    await expect(probeRecorded("http://fake-sidecar", fake.deps)).resolves.toBe("busy");
    expect(fake.probeOnce).toHaveBeenCalledTimes(3);
    expect(fake.sleep).toHaveBeenCalledTimes(2);
    expect(fake.sleep).toHaveBeenCalledWith(300);
  });
});

describe("ensureUp with fabricated lifecycle operations", () => {
  it("reuses a recorded healthy sidecar without replacement or spawning", async () => {
    const fake = ensureFakes();
    fake.currentBaseUrl.mockReturnValue("http://fake-sidecar");
    fake.probeRecorded.mockResolvedValue("healthy");

    await expect(ensureUp(fake.deps)).resolves.toBe("http://fake-sidecar");
    expect(fake.shouldReplace).not.toHaveBeenCalled();
    expect(fake.stopOurs).not.toHaveBeenCalled();
    expect(fake.spawnAndWait).not.toHaveBeenCalled();
  });

  it("keeps a busy recorded sidecar when fabricated work is in flight", async () => {
    const fake = ensureFakes();
    fake.currentBaseUrl.mockReturnValue("http://fake-sidecar");
    fake.probeRecorded.mockResolvedValue("busy");
    fake.inflightCount.mockReturnValue(1);
    fake.shouldReplace.mockReturnValue(false);

    await expect(ensureUp(fake.deps)).resolves.toBe("http://fake-sidecar");
    expect(fake.shouldReplace).toHaveBeenCalledWith("busy", 1);
    expect(fake.stopOurs).not.toHaveBeenCalled();
    expect(fake.spawnAndWait).not.toHaveBeenCalled();
  });

  it("stops a dead recorded sidecar before fabricating a replacement", async () => {
    const fake = ensureFakes();
    fake.currentBaseUrl.mockReturnValueOnce("http://dead-sidecar").mockReturnValueOnce(null);
    fake.probeRecorded.mockResolvedValue("gone");
    fake.inflightCount.mockReturnValue(0);
    fake.shouldReplace.mockReturnValue(true);
    fake.spawnAndWait.mockResolvedValue("http://replacement-sidecar");

    await expect(ensureUp(fake.deps)).resolves.toBe("http://replacement-sidecar");
    expect(fake.stopOurs).toHaveBeenCalledOnce();
    expect(fake.spawnAndWait).toHaveBeenCalledWith(30_000);
  });

  it("rechecks a sidecar that appeared while waiting for the fake spawn slot", async () => {
    const fake = ensureFakes();
    fake.currentBaseUrl.mockReturnValueOnce(null).mockReturnValueOnce("http://arrived-sidecar");
    fake.probeOnce.mockResolvedValue("healthy");

    await expect(ensureUp(fake.deps)).resolves.toBe("http://arrived-sidecar");
    expect(fake.probeOnce).toHaveBeenCalledWith("http://arrived-sidecar", 1_500);
    expect(fake.spawnAndWait).not.toHaveBeenCalled();
  });

  it("shares one fabricated spawn between simultaneous callers", async () => {
    const fake = ensureFakes();
    fake.currentBaseUrl.mockReturnValue(null);
    let resolveSpawn!: (url: string) => void;
    fake.spawnAndWait.mockReturnValue(new Promise<string>((resolve) => {
      resolveSpawn = resolve;
    }));

    const first = ensureUp(fake.deps);
    const second = ensureUp(fake.deps);

    expect(fake.spawnAndWait).toHaveBeenCalledOnce();
    resolveSpawn("http://replacement-sidecar");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "http://replacement-sidecar",
      "http://replacement-sidecar",
    ]);
  });

  it("releases the fabricated single-flight slot after a startup failure", async () => {
    const fake = ensureFakes();
    fake.currentBaseUrl.mockReturnValue(null);
    fake.spawnAndWait.mockRejectedValueOnce(new Error("fabricated startup failure"));
    fake.spawnAndWait.mockResolvedValueOnce("http://replacement-sidecar");

    await expect(ensureUp(fake.deps)).rejects.toThrow("fabricated startup failure");
    await expect(ensureUp(fake.deps)).resolves.toBe("http://replacement-sidecar");
    expect(fake.spawnAndWait).toHaveBeenCalledTimes(2);
  });
});
