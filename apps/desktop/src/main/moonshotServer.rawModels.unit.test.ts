import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authedHeaders: vi.fn(),
  busy: vi.fn(),
  ensureUp: vi.fn(),
  fetch: vi.fn(),
  getSetting: vi.fn(),
  release: vi.fn(),
  removeDiscovery: vi.fn(),
  resolvedBaseUrl: vi.fn(),
  setBaseUrlOverride: vi.fn(),
  setSetting: vi.fn(),
  webAccessEnabled: vi.fn(),
  writeDiscovery: vi.fn(),
}));

vi.mock("./db-host/settings.js", () => ({ getSetting: mocks.getSetting, setSetting: mocks.setSetting }));
vi.mock("./moonshotDiscovery.js", () => ({
  removeDiscovery: mocks.removeDiscovery,
  writeDiscovery: mocks.writeDiscovery,
}));
vi.mock("./gatherContext.js", () => ({ webAccessEnabled: mocks.webAccessEnabled }));
vi.mock("./engineRouting.js", () => ({
  resolvedBaseUrl: mocks.resolvedBaseUrl,
  setBaseUrlOverride: mocks.setBaseUrlOverride,
}));
vi.mock("./sidecar.js", () => ({
  authedHeaders: mocks.authedHeaders,
  busy: mocks.busy,
  ensureUp: mocks.ensureUp,
}));
vi.mock("./mcpBridge.js", () => ({ McpBridge: class McpBridge {} }));

import { testOllamaUrl } from "./moonshotServer.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authedHeaders.mockReturnValue({ "x-fake-sidecar-token": "token" });
  mocks.busy.mockReturnValue({ release: mocks.release });
  mocks.ensureUp.mockResolvedValue("http://fake-sidecar");
  mocks.resolvedBaseUrl.mockReturnValue("http://remote.example:11434");
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("testOllamaUrl raw model listing with fabricated sidecar boundaries", () => {
  it("filters a fabricated model payload and releases the busy guard", async () => {
    const json = vi.fn(async () => ({ models: ["writer:latest", 42, "vision:latest", null] }));
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json });

    await expect(testOllamaUrl(null, "http://remote.example:11434"))
      .resolves.toBe("✓ Reached http://remote.example:11434 — 2 models available.");

    expect(mocks.ensureUp).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith("http://fake-sidecar/models", {
      method: "POST",
      headers: { "x-fake-sidecar-token": "token", "content-type": "application/json" },
      body: JSON.stringify({ base_url: "http://remote.example:11434" }),
    });
    expect(json).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("reports a reached but empty server for a fabricated non-object payload", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ["not", "an", "object"] });

    await expect(testOllamaUrl(null, "http://remote.example:11434"))
      .resolves.toBe("Reached http://remote.example:11434, but it has no models installed — nothing there can answer yet.");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("wraps a fabricated sidecar status error and still releases the busy guard", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 503, json: vi.fn() });

    await expect(testOllamaUrl(null, "http://remote.example:11434"))
      .rejects.toThrow("Could not reach http://remote.example:11434: sidecar /models status 503");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
