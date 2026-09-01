import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  authedHeaders: vi.fn(),
  busy: vi.fn(),
  ensureUp: vi.fn(),
  fetch: vi.fn(),
  listModels: vi.fn(),
  resolvedBaseUrl: vi.fn(),
  splitCompleteLines: vi.fn(),
}));

vi.mock("./engineRouting.js", () => ({
  listModels: fakes.listModels,
  resolvedBaseUrl: fakes.resolvedBaseUrl,
}));

vi.mock("./sidecar.js", () => ({
  authedHeaders: fakes.authedHeaders,
  busy: fakes.busy,
  ensureUp: fakes.ensureUp,
  splitCompleteLines: fakes.splitCompleteLines,
}));

import { defaultAiStatusDeps } from "./ollamaModels.js";

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(body) };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fakes.fetch);
  fakes.authedHeaders.mockReset().mockReturnValue({ authorization: "Bearer fabricated" });
  fakes.busy.mockReset();
  fakes.ensureUp.mockReset().mockResolvedValue("http://fabricated-sidecar.invalid");
  fakes.fetch.mockReset();
  fakes.listModels.mockReset();
  fakes.resolvedBaseUrl.mockReset().mockReturnValue("http://fabricated-engine.invalid");
  fakes.splitCompleteLines.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("defaultAiStatusDeps.listModelsRaw", () => {
  it("posts to the fabricated sidecar and keeps only string model names", async () => {
    const release = vi.fn();
    fakes.busy.mockReturnValue({ release });
    fakes.fetch.mockResolvedValueOnce(okResponse({ models: ["writer:latest", 3, null, "local:latest"] }));

    await expect(defaultAiStatusDeps.listModelsRaw()).resolves.toEqual(["writer:latest", "local:latest"]);
    expect(fakes.fetch).toHaveBeenCalledWith("http://fabricated-sidecar.invalid/models", {
      method: "POST",
      headers: { authorization: "Bearer fabricated", "content-type": "application/json" },
      body: JSON.stringify({ base_url: "http://fabricated-engine.invalid" }),
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("treats a fabricated response without a model array as an empty list", async () => {
    const release = vi.fn();
    fakes.busy.mockReturnValue({ release });
    fakes.fetch.mockResolvedValueOnce(okResponse({ models: "not-an-array" }));

    await expect(defaultAiStatusDeps.listModelsRaw()).resolves.toEqual([]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports a rejected fabricated status response and releases the busy guard", async () => {
    const release = vi.fn();
    fakes.busy.mockReturnValue({ release });
    fakes.fetch.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(defaultAiStatusDeps.listModelsRaw()).rejects.toThrow("sidecar /models status 503");
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates a fabricated fetch rejection after releasing the busy guard", async () => {
    const release = vi.fn();
    const refused = new Error("fabricated sidecar unavailable");
    fakes.busy.mockReturnValue({ release });
    fakes.fetch.mockRejectedValueOnce(refused);

    await expect(defaultAiStatusDeps.listModelsRaw()).rejects.toBe(refused);
    expect(release).toHaveBeenCalledOnce();
  });
});
