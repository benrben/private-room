import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({ readFileSync: vi.fn() }));

vi.mock("node:fs", () => ({ readFileSync: filesystem.readFileSync }));

const originalManifestPath = process.env.ARCELLE_AGENT_MANIFEST_PATH;

beforeEach(() => {
  vi.resetModules();
  filesystem.readFileSync.mockReset().mockImplementation(() => {
    throw new Error("manifest unavailable");
  });
  process.env.ARCELLE_AGENT_MANIFEST_PATH = "/fixtures/missing-agent-manifest.json";
});

afterEach(() => {
  if (originalManifestPath === undefined) delete process.env.ARCELLE_AGENT_MANIFEST_PATH;
  else process.env.ARCELLE_AGENT_MANIFEST_PATH = originalManifestPath;
  vi.clearAllMocks();
});

describe("agent manifest loading", () => {
  it("reports every failed candidate without starting an agent", async () => {
    const { loadAgentManifest } = await import("./agentManifest.js");
    expect(() => loadAgentManifest()).toThrow(
      "Arcelle could not load its shared agent manifest. /fixtures/missing-agent-manifest.json: manifest unavailable",
    );
    expect(filesystem.readFileSync).toHaveBeenCalledTimes(3);
  });
});
