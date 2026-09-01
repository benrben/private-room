import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  listen: vi.fn<() => Promise<number>>(),
  stop: vi.fn<() => Promise<void>>(),
}));
const signalHandlers = new Map<string, (...args: unknown[]) => void>();

vi.mock("./mcpBridge.js", () => ({
  McpBridge: class {
    constructor(options: Record<string, unknown>) {
      bridge.options.push(options);
    }

    listen = bridge.listen;
    stop = bridge.stop;
  },
}));

async function loadRunner(cancelled = false) {
  vi.resetModules();
  vi.stubEnv("MCP_BRIDGE_TOKEN", "fake-runner-token");
  vi.stubEnv("MCP_BRIDGE_CANCELLED", cancelled ? "1" : "");
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
    signalHandlers.set(event, listener);
    return process;
  }) as typeof process.on);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const runner = await import("./mcpBridgeRunner.js");
  await Promise.resolve();
  return runner;
}

beforeEach(() => {
  signalHandlers.clear();
  bridge.options.splice(0);
  bridge.listen.mockReset().mockResolvedValue(45_678);
  bridge.stop.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("mcpBridgeRunner with a fabricated bridge transport", () => {
  it("keeps every fake tools/call result on the documented MCP result shape", async () => {
    const { fakeWireDispatcher } = await loadRunner();
    const scope = { kind: "LocalEngine" } as const;

    expect(fakeWireDispatcher.listTools(scope)).toEqual([
      expect.objectContaining({ name: "echo" }),
      expect.objectContaining({ name: "boom" }),
    ]);
    await expect(fakeWireDispatcher.callTool(scope, "echo", { text: "fake echo" })).resolves.toEqual({
      isError: false,
      content: [{ type: "text", text: "fake echo" }],
    });
    await expect(fakeWireDispatcher.callTool(scope, "echo", {})).resolves.toEqual({
      isError: false,
      content: [{ type: "text", text: "" }],
    });
    await expect(fakeWireDispatcher.callTool(scope, "boom", {})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "boom failed on purpose" }],
    });
    await expect(fakeWireDispatcher.callTool(scope, "not-a-tool", {})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "unknown tool: not-a-tool" }],
    });

    expect(bridge.listen).toHaveBeenCalledWith(0);
    expect(bridge.options).toEqual([
      expect.objectContaining({
        token: "fake-runner-token",
        scope,
        dispatcher: fakeWireDispatcher,
        cancelFlag: undefined,
        serverVersion: "0.0.0-wire-compat",
      }),
    ]);
  });

  it("passes the fabricated already-cancelled flag to the bridge without listening for real", async () => {
    await loadRunner(true);
    const cancelFlag = bridge.options[0]?.cancelFlag as { load?: () => boolean } | undefined;

    expect(cancelFlag?.load?.()).toBe(true);
    expect(bridge.listen).toHaveBeenCalledWith(0);
    expect(bridge.stop).not.toHaveBeenCalled();
  });

  it.each(["SIGTERM", "SIGINT"])("stops the bridge before exiting on %s", async (signal) => {
    await loadRunner();

    signalHandlers.get(signal)?.();
    await vi.waitFor(() => expect(bridge.stop).toHaveBeenCalledOnce());
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it("reports a fabricated listen failure and exits unsuccessfully", async () => {
    bridge.listen.mockRejectedValue(new Error("fabricated listen failure"));

    await loadRunner();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.objectContaining({
      message: "fabricated listen failure",
    })));
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
