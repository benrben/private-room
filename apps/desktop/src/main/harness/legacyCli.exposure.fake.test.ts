import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessRuntime } from "./types.js";

const verifyExecutable = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./seatbelt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./seatbelt.js")>()),
  verifyNativeHarnessExecutable: verifyExecutable,
}));

import { RestrictedLegacyCliRuntime, RuntimeWithFallback } from "./legacyCli.js";

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runtime(name: HarnessRuntime["name"], available: boolean, exposed: boolean): HarnessRuntime {
  return {
    name,
    available: async () => available,
    verifyExposure: async () => exposed,
    startTurn: async () => { throw new Error("not used by this exposure test"); },
  };
}

describe("legacy CLI exposure verification", () => {
  it("probes a private isolated directory through the fake executable boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-legacy-exposure-"));
    roots.push(root);
    const runtime = new RestrictedLegacyCliRuntime("codex", { room: null } as never, {
      executable: "/fabricated/codex",
      available: () => true,
    });

    await expect(runtime.verifyExposure("/real/workspace", root)).resolves.toBe(true);
    const isolated = path.join(root, "legacy-cli-probe");
    expect((await stat(path.join(isolated, ".arcelle"))).isDirectory()).toBe(true);
    expect(verifyExecutable).toHaveBeenCalledWith({
      workspacePath: isolated,
      runtimePath: isolated,
      executable: "/fabricated/codex",
      provider: "codex",
      writeEnabled: false,
    }, ["--version"]);
  });

  it("records the primary when its exposure probe succeeds", async () => {
    const selected = new RuntimeWithFallback(
      runtime("codex-app-server", true, true),
      runtime("legacy-cli", true, true),
    );
    await expect(selected.verifyExposure("/workspace", "/runtime/primary", false)).resolves.toBe(true);
    expect(selected.consumeVerifiedHarness("/runtime/primary")).toBe("codex-app-server");
  });

  it("reports false when neither available runtime can verify exposure", async () => {
    const selected = new RuntimeWithFallback(
      runtime("codex-app-server", true, false),
      runtime("legacy-cli", false, false),
    );
    await expect(selected.verifyExposure("/workspace", "/runtime/none", false)).resolves.toBe(false);
    expect(selected.consumeVerifiedHarness("/runtime/none")).toBeNull();
  });
});
