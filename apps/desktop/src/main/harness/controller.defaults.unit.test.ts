import { describe, expect, it, vi } from "vitest";
import { createRoomManagerState } from "../roomManager.js";
import { WEB_LANES_ALL } from "../toolSpecs.js";
import { nativeCliExecutable } from "./nativeCli.js";
import type { HarnessContext, HarnessName, HarnessRuntime } from "./types.js";
import type { WorkspaceCalls } from "./legacyCli.js";

const mocks = vi.hoisted(() => ({
  fallbackDispatcher: vi.fn(),
  dispatcherResult: {
    listTools: vi.fn(() => []),
    callTool: vi.fn(async () => ({ isError: false, content: [] })),
  },
  legacyOptions: [] as unknown[],
  nativeDispatcher: undefined as
    | ((context: HarnessContext, workspace: WorkspaceCalls) => unknown)
    | undefined,
  verifyNativeHarnessExecutable: vi.fn(async () => true),
}));

vi.mock("../roomServerLive.js", () => ({
  roomServerDispatcherFactory: vi.fn(() => mocks.fallbackDispatcher),
}));

vi.mock("./nativeRoomMcp.js", () => ({
  createNativeRoomMcpFactory: vi.fn((
    _state: unknown,
    dispatcher: (context: HarnessContext, workspace: WorkspaceCalls) => unknown,
  ) => {
    mocks.nativeDispatcher = dispatcher;
    return vi.fn();
  }),
}));

vi.mock("./seatbelt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./seatbelt.js")>();
  return { ...actual, verifyNativeHarnessExecutable: mocks.verifyNativeHarnessExecutable };
});

vi.mock("./legacyCli.js", () => {
  class RestrictedLegacyCliRuntime {
    readonly name = "legacy-cli" as const;
    constructor(_provider: unknown, _state: unknown, options: unknown) {
      mocks.legacyOptions.push(options);
    }
    async available(): Promise<boolean> { return true; }
    async startTurn(): Promise<never> { throw new Error("provider execution is outside this unit test"); }
  }
  class RuntimeWithFallback {
    readonly name = "codex-app-server" as const;
    constructor(_primary: unknown, _fallback: unknown) {}
    async available(): Promise<boolean> { return true; }
    async startTurn(): Promise<never> { throw new Error("provider execution is outside this unit test"); }
  }
  return { RestrictedLegacyCliRuntime, RuntimeWithFallback };
});

import { HarnessController } from "./controller.js";

function inertRuntime(name: HarnessName = "legacy-cli"): HarnessRuntime {
  return {
    name,
    available: async () => true,
    startTurn: async () => { throw new Error("provider execution is outside this unit test"); },
  };
}

function allInertRuntimes(): Record<"codex" | "claude" | "ollama-local" | "ollama-cloud" | "openrouter", HarnessRuntime> {
  return {
    codex: inertRuntime("codex-app-server"),
    claude: inertRuntime("claude-agent-sdk"),
    "ollama-local": inertRuntime("arcelle-deep"),
    "ollama-cloud": inertRuntime("arcelle-deep"),
    openrouter: inertRuntime("arcelle-deep"),
  };
}

function context(privacyMode: HarnessContext["privacyMode"]): HarnessContext {
  return {
    runId: "run-1",
    roomId: "room-1",
    workspacePath: "/workspace",
    runtimePath: "/runtime",
    model: "test",
    provider: "codex",
    privacyMode,
    writeEnabled: true,
    exposureVerified: true,
  };
}

describe("HarnessController default boundaries", () => {
  it("configures both fallback dispatchers with the workspace and privacy mode", () => {
    mocks.legacyOptions.length = 0;
    mocks.fallbackDispatcher.mockReset().mockReturnValue(mocks.dispatcherResult);
    mocks.nativeDispatcher = undefined;
    const runtimes = allInertRuntimes();
    delete (runtimes as Partial<typeof runtimes>).codex;
    new HarnessController(createRoomManagerState(), "/user-data", vi.fn(), {
      runtimes,
      outsideWorkspaceIsolation: true,
    });

    const options = mocks.legacyOptions[0] as {
      baseDispatcher(context: HarnessContext, workspace: WorkspaceCalls): unknown;
    };
    const workspace: WorkspaceCalls = { call: vi.fn(async () => ({})) };
    expect(options.baseDispatcher(context("cloud-direct"), workspace)).toBe(mocks.dispatcherResult);
    expect(mocks.fallbackDispatcher).toHaveBeenLastCalledWith(
      false,
      { kind: "CloudEngine" },
      WEB_LANES_ALL,
      { workspace, privacyBypass: true },
    );

    expect(mocks.nativeDispatcher).toBeTypeOf("function");
    expect(mocks.nativeDispatcher?.(context("cloud-redacted"), workspace)).toBe(mocks.dispatcherResult);
    expect(mocks.fallbackDispatcher).toHaveBeenLastCalledWith(
      false,
      { kind: "CloudEngine" },
      WEB_LANES_ALL,
      { workspace, privacyBypass: false },
    );
  });

  it("uses the provider-specific native executable probe when a runtime has no verifier", async () => {
    mocks.verifyNativeHarnessExecutable.mockReset().mockResolvedValue(true);
    const controller = new HarnessController(createRoomManagerState(), "/user-data", vi.fn(), {
      runtimes: allInertRuntimes(),
      outsideWorkspaceIsolation: true,
    });
    const verifier = controller as unknown as {
      defaultVerifyExposure(
        workspacePath: string,
        provider: "codex" | "claude",
        runtimePath: string,
        writeEnabled: boolean,
      ): Promise<boolean>;
    };

    await expect(verifier.defaultVerifyExposure("/workspace", "codex", "/runtime", true)).resolves.toBe(true);
    expect(mocks.verifyNativeHarnessExecutable).toHaveBeenLastCalledWith({
      workspacePath: "/workspace",
      runtimePath: "/runtime",
      provider: "codex",
      writeEnabled: true,
      executable: nativeCliExecutable("codex"),
    }, ["app-server", "--help"]);

    await expect(verifier.defaultVerifyExposure("/workspace", "claude", "/runtime", false)).resolves.toBe(true);
    expect(mocks.verifyNativeHarnessExecutable).toHaveBeenLastCalledWith({
      workspacePath: "/workspace",
      runtimePath: "/runtime",
      provider: "claude",
      writeEnabled: false,
      executable: nativeCliExecutable("claude"),
    }, ["--version"]);
  });

  it("rejects approval without an active orchestrator and otherwise delegates exactly", async () => {
    const controller = new HarnessController(createRoomManagerState(), "/user-data", vi.fn(), {
      runtimes: allInertRuntimes(),
      outsideWorkspaceIsolation: true,
    });
    expect(() => controller.approve("run-1", "tool-1", "allow-once")).toThrow("No harness run is active.");

    const approve = vi.fn(async () => undefined);
    (controller as unknown as { orchestrator: { approve: typeof approve } | null }).orchestrator = { approve };
    await expect(controller.approve("run-1", "tool-1", "allow-run")).resolves.toBeUndefined();
    expect(approve).toHaveBeenCalledWith("run-1", "tool-1", "allow-run");
  });
});
