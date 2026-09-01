import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvedBaseUrl: vi.fn(),
  sidecarErrorSentinel: vi.fn(),
  sidecarJsonCancellable: vi.fn(),
}));

vi.mock("./engineRouting.js", () => ({ listModels: vi.fn(), resolvedBaseUrl: mocks.resolvedBaseUrl }));
vi.mock("./sidecar.js", () => ({ busy: vi.fn(), deliverCancel: vi.fn(), ensureUp: vi.fn() }));
vi.mock("./sidecarJsonCancellable.js", () => ({
  humanizeEmptyGeneration: vi.fn(),
  sidecarErrorSentinel: mocks.sidecarErrorSentinel,
  sidecarJsonCancellable: mocks.sidecarJsonCancellable,
}));

import { summarizeOneFileViaSidecar } from "./workflowEngine.js";

describe("summarizeOneFileViaSidecar with a fabricated sidecar transport", () => {
  it("posts the complete summary contract and returns a string summary", async () => {
    mocks.resolvedBaseUrl.mockReturnValue("http://fake-sidecar");
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value: { summary: "one line" } });

    await expect(summarizeOneFileViaSidecar("fake-model", "notes.md", "text/markdown", "fake text"))
      .resolves.toBe("one line");

    expect(mocks.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/summarize_file",
      {
        model: "fake-model",
        name: "notes.md",
        mime: "text/markdown",
        text: "fake text",
        base_url: "http://fake-sidecar",
        keep_alive: "30m",
      },
      expect.objectContaining({ load: expect.any(Function) }),
    );
  });

  it("keeps empty or non-object sidecar values distinct from a transport failure", async () => {
    mocks.sidecarJsonCancellable
      .mockResolvedValueOnce({ kind: "value", value: { summary: 3 } })
      .mockResolvedValueOnce({ kind: "value", value: [] })
      .mockResolvedValueOnce({ kind: "stopped" })
      .mockResolvedValueOnce({ kind: "error", error: { code: "MODEL_MISSING", error: "fake", status: 503 } });
    mocks.sidecarErrorSentinel.mockReturnValue("MODEL_MISSING:fake-model");

    await expect(summarizeOneFileViaSidecar("fake-model", "a", "text/plain", "x")).resolves.toBe("");
    await expect(summarizeOneFileViaSidecar("fake-model", "b", "text/plain", "x")).resolves.toBe("");
    await expect(summarizeOneFileViaSidecar("fake-model", "c", "text/plain", "x")).rejects.toThrow("STOPPED");
    await expect(summarizeOneFileViaSidecar("fake-model", "d", "text/plain", "x"))
      .rejects.toThrow("MODEL_MISSING:fake-model");
    expect(mocks.sidecarErrorSentinel).toHaveBeenCalledWith(
      { code: "MODEL_MISSING", error: "fake", status: 503 },
      "fake-model",
    );
  });
});
