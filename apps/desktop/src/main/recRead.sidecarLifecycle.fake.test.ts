import { afterEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  busy: vi.fn(),
  ensureUp: vi.fn(),
  release: vi.fn(),
}));

vi.mock("./sidecar.js", () => ({
  authedHeaders: () => ({ authorization: "Bearer fabricated" }),
  busy: fakes.busy,
  ensureUp: fakes.ensureUp,
}));

import { sidecarJsonCancellable } from "./recRead.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("recording read sidecar lifecycle", () => {
  it("holds and releases the busy guard around a fabricated successful request", async () => {
    fakes.ensureUp.mockResolvedValue("http://sidecar.invalid");
    fakes.busy.mockReturnValue({ release: fakes.release });
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ chapters: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const cancel = { load: () => false };

    await expect(sidecarJsonCancellable("/rec_read_map", { part: 1 }, cancel)).resolves.toEqual({
      kind: "value",
      value: { chapters: [] },
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://sidecar.invalid/rec_read_map",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ part: 1 }) }),
    );
    expect(fakes.release).toHaveBeenCalledOnce();
  });

  it("short-circuits cancellation before probing or taking a guard", async () => {
    await expect(
      sidecarJsonCancellable("/rec_read_map", {}, { load: () => true }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(fakes.ensureUp).not.toHaveBeenCalled();
    expect(fakes.busy).not.toHaveBeenCalled();
  });

  it("returns a typed sidecar-down error when startup fails", async () => {
    fakes.ensureUp.mockRejectedValue(new Error("fabricated bundled helper refusal"));

    await expect(
      sidecarJsonCancellable("/rec_read_map", {}, { load: () => false }),
    ).resolves.toEqual({
      kind: "error",
      error: {
        code: "SIDECAR_DOWN",
        error: "fabricated bundled helper refusal",
        status: 503,
      },
    });
    expect(fakes.busy).not.toHaveBeenCalled();
  });
});
