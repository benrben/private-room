import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authToken: vi.fn(() => "fake token"),
  authedHeaders: vi.fn(() => ({ authorization: "Bearer fake" })),
  ensureUp: vi.fn(async () => "http://127.0.0.1:43123"),
  release: vi.fn(),
}));

vi.mock("./sidecar.js", () => ({
  authToken: mocks.authToken,
  authedHeaders: mocks.authedHeaders,
  busy: () => ({ release: mocks.release }),
  ensureUp: mocks.ensureUp,
}));

import { createRecBridgeCtx } from "./recBridge.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rec bridge production default adapters", () => {
  it("constructs an authenticated renderer session URL without starting a real sidecar", async () => {
    const ctx = createRecBridgeCtx({ currentRoom: () => null });

    await expect(ctx.deps.sessionWsUrl("file / one")).resolves.toBe(
      "ws://127.0.0.1:43123/rec/session?token=fake%20token&fileId=file%20%2F%20one",
    );
    expect(mocks.ensureUp).toHaveBeenCalledOnce();
    expect(mocks.authToken).toHaveBeenCalledOnce();
    expect(ctx.deps.resolveSttModel()).toBeNull();
    expect(ctx.deps.spoolDir()).toBeTypeOf("string");
    expect(ctx.deps.spoolDir().length).toBeGreaterThan(0);
  });

  it("wraps the default control POST in the busy lease and releases it after invalid JSON", async () => {
    const json = vi.fn().mockRejectedValue(new SyntaxError("fabricated invalid JSON"));
    const fetch = vi.fn().mockResolvedValue({ status: 502, json });
    vi.stubGlobal("fetch", fetch);
    const ctx = createRecBridgeCtx({ currentRoom: () => null });

    await expect(ctx.deps.sidecarPost("/rec/pause", { fileId: "file-1" })).resolves.toEqual({
      status: 502,
      json: null,
    });

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43123/rec/pause", {
      method: "POST",
      headers: { authorization: "Bearer fake", "content-type": "application/json" },
      body: JSON.stringify({ fileId: "file-1" }),
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
