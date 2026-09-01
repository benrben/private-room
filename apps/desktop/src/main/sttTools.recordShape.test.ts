import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  authedHeaders: vi.fn(),
  bestLocalDefault: vi.fn(),
  busy: vi.fn(),
  ensureUp: vi.fn(),
  fetch: vi.fn(),
  generate: vi.fn(),
  modelSetting: vi.fn(),
  resolvedBaseUrl: vi.fn(),
  runsOnThisMac: vi.fn(),
  stripThinkSpans: vi.fn(),
}));

vi.mock("./ollamaGenerate.js", () => ({ generate: fakes.generate }));
vi.mock("./engineRouting.js", () => ({
  resolvedBaseUrl: fakes.resolvedBaseUrl,
  stripThinkSpans: fakes.stripThinkSpans,
}));
vi.mock("./gatherContext.js", () => ({ modelSetting: fakes.modelSetting }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: fakes.runsOnThisMac }));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: fakes.bestLocalDefault }));
vi.mock("./sidecar.js", () => ({
  authToken: vi.fn(),
  authedHeaders: fakes.authedHeaders,
  busy: fakes.busy,
  ensureUp: fakes.ensureUp,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", fakes.fetch);
  fakes.authedHeaders.mockReset().mockReturnValue({ authorization: "Bearer fabricated" });
  fakes.bestLocalDefault.mockReset();
  fakes.busy.mockReset();
  fakes.ensureUp.mockReset().mockResolvedValue("http://sidecar.invalid");
  fakes.fetch.mockReset();
  fakes.generate.mockReset();
  fakes.modelSetting.mockReset();
  fakes.resolvedBaseUrl.mockReset().mockReturnValue("http://models.invalid");
  fakes.runsOnThisMac.mockReset();
  fakes.stripThinkSpans.mockReset().mockImplementation((text: string) => text);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

function response(json: unknown) {
  return { ok: true, json: vi.fn().mockResolvedValue(json) };
}

describe("defaultShapeTextDeps.listModelsRaw record shaping", () => {
  it("accepts only string model names from fabricated object-shaped model responses", async () => {
    const release = vi.fn();
    fakes.busy.mockReturnValue({ release });
    fakes.fetch.mockResolvedValueOnce(response({ models: ["local:latest", 7, null, "writer:latest"] }));
    const { defaultShapeTextDeps } = await import("./sttTools.js");

    await expect(defaultShapeTextDeps.listModelsRaw()).resolves.toEqual(["local:latest", "writer:latest"]);
    expect(fakes.fetch).toHaveBeenCalledWith("http://sidecar.invalid/models", {
      method: "POST",
      headers: { authorization: "Bearer fabricated", "content-type": "application/json" },
      body: JSON.stringify({ base_url: "http://models.invalid" }),
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("treats fabricated array, null, primitive, and object-without-models responses as no model list", async () => {
    const releases = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    let releaseIndex = 0;
    fakes.busy.mockImplementation(() => ({ release: releases[releaseIndex++]! }));
    fakes.fetch
      .mockResolvedValueOnce(response(["not a response envelope"]))
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response("not json object"))
      .mockResolvedValueOnce(response({ model: "wrong field" }));
    const { defaultShapeTextDeps } = await import("./sttTools.js");

    await expect(defaultShapeTextDeps.listModelsRaw()).resolves.toEqual([]);
    await expect(defaultShapeTextDeps.listModelsRaw()).resolves.toEqual([]);
    await expect(defaultShapeTextDeps.listModelsRaw()).resolves.toEqual([]);
    await expect(defaultShapeTextDeps.listModelsRaw()).resolves.toEqual([]);
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
  });

  it("releases the fabricated busy guard when the models endpoint reports an error", async () => {
    const release = vi.fn();
    fakes.busy.mockReturnValue({ release });
    fakes.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const { defaultShapeTextDeps } = await import("./sttTools.js");

    await expect(defaultShapeTextDeps.listModelsRaw()).rejects.toThrow("sidecar /models status 503");
    expect(release).toHaveBeenCalledOnce();
  });

  it("forwards generation arguments to the fabricated model boundary", async () => {
    fakes.generate.mockResolvedValue("shaped without a local model");
    const { defaultShapeTextDeps } = await import("./sttTools.js");
    const messages = [{ role: "user", content: "shape this" }] as const;

    await expect(defaultShapeTextDeps.generate("fake-model", messages, 0.2, "5m")).resolves.toBe(
      "shaped without a local model",
    );
    expect(fakes.generate).toHaveBeenCalledWith("fake-model", messages, 0.2, "5m");
  });
});
