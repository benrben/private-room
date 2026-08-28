import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import afterSign, { resolveOsxSignEntitlementsDirectory } from "./afterSign.mjs";

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

  it("resolves helper entitlements through the hoisted workspace dependency", () => {
    const directory = resolveOsxSignEntitlementsDirectory();

    expect(existsSync(path.join(directory, "default.darwin.plist"))).toBe(true);
    expect(directory).not.toContain("apps/desktop/node_modules");
  });
});
