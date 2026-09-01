import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ sharp: vi.fn() }));

vi.mock("sharp", () => ({ default: fake.sharp }));
vi.mock("./sketchDoc.js", () => ({ toSvg: () => "<svg/>" }));

import { toPng } from "./sketchRaster.js";

describe("toPng failure boundary", () => {
  it("turns a native rasterizer failure into the drawing-specific error", async () => {
    fake.sharp.mockReturnValue({
      resize: () => ({
        png: () => ({ toBuffer: vi.fn().mockRejectedValue(new Error("fabricated libvips failure")) }),
      }),
    });

    await expect(toPng({ width: 10, height: 10 } as never)).rejects.toThrow(
      "The drawing could not be rendered (fabricated libvips failure).",
    );
  });
});
