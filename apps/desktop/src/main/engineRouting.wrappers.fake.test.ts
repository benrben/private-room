import { afterEach, describe, expect, it, vi } from "vitest";

const sidecar = vi.hoisted(() => ({
  ensureUp: vi.fn(async () => "https://fabricated-sidecar.invalid"),
  release: vi.fn(),
}));

vi.mock("./sidecar.js", () => ({
  authedHeaders: () => ({ authorization: "Bearer fabricated" }),
  busy: () => ({ release: sidecar.release }),
  ensureUp: sidecar.ensureUp,
}));

import { handoffSummary, listModels } from "./engineRouting.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("engine routing's ensured-sidecar wrappers", () => {
  it("holds and releases the busy guard around a successful summary", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: "fake-model",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.2,
      });
      return new Response(JSON.stringify({ summary: "A concise recap." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(handoffSummary(
      "fake-model",
      [{ role: "user", content: "hello" }],
      0.2,
    )).resolves.toBe("A concise recap.");
    expect(sidecar.release).toHaveBeenCalledOnce();
  });

  it("releases the guard when the sidecar rejects and listModels degrades safely", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fabricated transport failure"); }));

    await expect(handoffSummary("fake-model", [], null)).rejects.toThrow("fabricated transport failure");
    await expect(listModels()).resolves.toEqual([]);
    expect(sidecar.release).toHaveBeenCalledTimes(2);
  });
});
