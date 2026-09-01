import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ statSync: vi.fn() }));

vi.mock("node:fs", () => ({ statSync: fakes.statSync }));

import { findFfmpeg } from "./ytdlp.js";

beforeEach(() => {
  fakes.statSync.mockReset();
});

describe("findFfmpeg default file probe with a fabricated filesystem", () => {
  it("accepts only a fabricated regular file from the default probe", () => {
    fakes.statSync.mockImplementation((candidate: string) => ({
      isFile: () => candidate === "/fabricated/bin/ffmpeg",
    }));

    expect(findFfmpeg({ pathEnv: "/fabricated/bin" })).toBe("/fabricated/bin/ffmpeg");
    expect(fakes.statSync).toHaveBeenLastCalledWith("/fabricated/bin/ffmpeg");
  });

  it("refuses fabricated directories even when their paths end in ffmpeg", () => {
    fakes.statSync.mockReturnValue({ isFile: () => false });

    expect(findFfmpeg({ pathEnv: "/fabricated-directory" })).toBeNull();
  });

  it("treats fabricated stat failures as a missing executable", () => {
    fakes.statSync.mockImplementation(() => {
      throw new Error("fabricated permission denial");
    });

    expect(findFfmpeg({ pathEnv: "/unreadable" })).toBeNull();
  });
});
