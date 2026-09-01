import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeFs = vi.hoisted(() => ({
  open: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: fakeFs.open,
  rename: fakeFs.rename,
  unlink: fakeFs.unlink,
}));

import { writeSidecarAtomically } from "./recovery.js";

beforeEach(() => {
  vi.clearAllMocks();
  fakeFs.unlink.mockResolvedValue(undefined);
});

describe("atomic recovery sidecar failure cleanup", () => {
  it("closes and removes the temporary file when writing it fails", async () => {
    const close = vi.fn(async () => { throw new Error("fabricated close failure"); });
    fakeFs.open.mockResolvedValue({
      chmod: vi.fn(async () => { throw new Error("fabricated chmod failure"); }),
      writeFile: vi.fn(),
      sync: vi.fn(),
      close,
    });
    fakeFs.unlink.mockRejectedValueOnce(new Error("fabricated cleanup failure"));

    await expect(writeSidecarAtomically("/fabricated/room.recovery", "{}"))
      .rejects.toThrow("fabricated chmod failure");
    expect(close).toHaveBeenCalledOnce();
    expect(fakeFs.unlink).toHaveBeenCalledWith("/fabricated/room.recovery.tmp");
    expect(fakeFs.rename).not.toHaveBeenCalled();
  });

  it("removes the flushed temporary file when the final rename fails", async () => {
    const handle = {
      chmod: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      sync: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    fakeFs.open.mockResolvedValue(handle);
    fakeFs.rename.mockRejectedValue(new Error("fabricated rename failure"));

    await expect(writeSidecarAtomically("/fabricated/room.recovery", "sealed"))
      .rejects.toThrow("fabricated rename failure");
    expect(handle.writeFile).toHaveBeenCalledWith("sealed", "utf8");
    expect(fakeFs.unlink).toHaveBeenCalledWith("/fabricated/room.recovery.tmp");
  });
});
