import { beforeEach, describe, expect, it, vi } from "vitest";

const sidecar = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("./sidecarJsonCancellable.js", () => ({
  sidecarJsonCancellable: sidecar.post,
}));

import { renderQuickLook } from "./previewTools.js";

const bytes = Buffer.from([0, 1, 2, 3]);

beforeEach(() => {
  sidecar.post.mockReset();
});

describe("renderQuickLook with a fabricated sidecar response", () => {
  it("sends encoded bytes only to the injected sidecar seam and returns its PNG", async () => {
    sidecar.post.mockResolvedValue({
      kind: "value",
      value: { png_b64: Buffer.from("fake png").toString("base64") },
    });

    await expect(renderQuickLook("diagram.key", bytes)).resolves.toEqual(Buffer.from("fake png"));
    expect(sidecar.post).toHaveBeenCalledWith(
      "/quicklook",
      { name: "diagram.key", data_b64: bytes.toString("base64") },
      expect.any(Object),
      30_000,
    );
  });

  it("returns no preview for every fabricated absent response shape", async () => {
    sidecar.post
      .mockResolvedValueOnce({ kind: "value", value: null })
      .mockResolvedValueOnce({ kind: "value", value: undefined })
      .mockResolvedValueOnce({ kind: "value", value: {} })
      .mockResolvedValueOnce({ kind: "value", value: { png_b64: null } });

    await expect(renderQuickLook("none.key", bytes)).resolves.toBeNull();
    await expect(renderQuickLook("none.key", bytes)).resolves.toBeNull();
    await expect(renderQuickLook("none.key", bytes)).resolves.toBeNull();
    await expect(renderQuickLook("none.key", bytes)).resolves.toBeNull();
  });

  it("keeps stopped, renderer-error, malformed, and transport failures distinct", async () => {
    sidecar.post.mockResolvedValueOnce({ kind: "stopped" });
    await expect(renderQuickLook("stopped.key", bytes)).rejects.toThrow("The preview was stopped.");

    sidecar.post.mockResolvedValueOnce({ kind: "error", error: { error: "Quick Look denied the file" } });
    await expect(renderQuickLook("failed.key", bytes)).rejects.toThrow("Quick Look denied the file");

    sidecar.post.mockResolvedValueOnce({ kind: "value", value: { png_b64: 42 } });
    await expect(renderQuickLook("malformed.key", bytes)).rejects.toThrow(
      "The preview renderer returned unreadable data.",
    );

    sidecar.post.mockRejectedValueOnce(new Error("fake sidecar transport failed"));
    await expect(renderQuickLook("transport.key", bytes)).rejects.toThrow("fake sidecar transport failed");
  });
});
