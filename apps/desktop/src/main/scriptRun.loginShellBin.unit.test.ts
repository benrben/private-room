import { describe, expect, it, vi } from "vitest";

import {
  firstExistingBin,
  loginShellBin,
  probeBin,
  type LoginShellSpawn,
} from "./scriptRun.js";

describe("script runtime probes with fake filesystem and login-shell seams", () => {
  it("returns the first existing absolute candidate without invoking a shell", () => {
    const exists = vi.fn((candidate: string) => candidate === "/fake/second");
    const shell = vi.fn<LoginShellSpawn>();

    expect(probeBin(["", "/fake/first", "/fake/second"], "command -v uv", exists, shell)).toBe(
      "/fake/second",
    );
    expect(exists.mock.calls).toEqual([["/fake/first"], ["/fake/second"]]);
    expect(shell).not.toHaveBeenCalled();
  });

  it("uses the fake login shell only after all fake filesystem candidates miss", () => {
    const shell = vi.fn<LoginShellSpawn>(() => ({ status: 0, stdout: "  /fake/from-shell  \nignored" }));

    expect(probeBin(["/fake/missing"], "command -v node", () => false, shell)).toBe(
      "/fake/from-shell",
    );
    expect(shell).toHaveBeenCalledWith("zsh", ["-ilc", "command -v node"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it.each([
    ["nonzero status", { status: 1, stdout: "/fake/bin\n" }],
    ["non-string stdout", { status: 0, stdout: Buffer.from("/fake/bin\n") }],
    ["blank first line", { status: 0, stdout: " \n/fake/bin\n" }],
  ])("returns null for %s", (_reason, result) => {
    expect(loginShellBin("command -v uv", () => result)).toBeNull();
  });

  it("returns null when the fake platform process throws", () => {
    expect(loginShellBin("command -v uv", () => { throw new Error("no zsh"); })).toBeNull();
  });

  it("keeps the direct fake filesystem helper deterministic", () => {
    expect(firstExistingBin(["", "/no", "/yes"], (candidate) => candidate === "/yes")).toBe("/yes");
  });
});
