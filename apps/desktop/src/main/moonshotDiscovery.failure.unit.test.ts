import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ userInfo: vi.fn() }));

vi.mock("node:os", () => ({ userInfo: fake.userInfo }));

import { discoveryFile, removeDiscovery } from "./moonshotDiscovery.js";

const originalHome = process.env["HOME"];

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  vi.clearAllMocks();
});

describe("discovery home failure", () => {
  it("refuses an absent environment and passwd home, while removal stays best-effort", () => {
    process.env["HOME"] = "";
    fake.userInfo.mockReturnValue({ homedir: "" });

    expect(() => discoveryFile()).toThrow("Could not determine the home directory.");
    expect(() => removeDiscovery()).not.toThrow();
    expect(fake.userInfo).toHaveBeenCalledTimes(2);
  });

  it("uses the same refusal when the passwd lookup itself fails", () => {
    process.env["HOME"] = "";
    fake.userInfo.mockImplementation(() => {
      throw new Error("fabricated passwd lookup failure");
    });

    expect(() => discoveryFile()).toThrow("Could not determine the home directory.");
  });
});
