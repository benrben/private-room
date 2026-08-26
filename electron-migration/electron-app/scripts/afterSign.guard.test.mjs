import { afterEach, describe, expect, it, vi } from "vitest";
import afterSign from "./afterSign.mjs";

afterEach(() => {
  delete process.env.ARCELLE_PACKAGE_UNSIGNED_PROOF;
  vi.restoreAllMocks();
});

describe("afterSign unsigned proof guard", () => {
  it("returns before reading context or invoking any signing logic", async () => {
    process.env.ARCELLE_PACKAGE_UNSIGNED_PROOF = "1";
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(afterSign(null)).resolves.toBeUndefined();
  });
});
