import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import type { MediaLimits } from "../shared/apiTypes.js";

const readState = vi.hoisted(() => ({
  file: ["cast.md", null, null, ""] as [string, string | null, Buffer | null, string | null],
  model: null as string | null,
}));

vi.mock("./db-host/files.js", () => ({
  getFileBytes: vi.fn(),
  getFileFull: vi.fn(() => readState.file),
  getFileMeta: vi.fn(),
  listFiles: vi.fn(),
}));

vi.mock("./gatherContext.js", () => ({ modelSetting: vi.fn(() => readState.model) }));
vi.mock("./sidecarJsonCancellable.js", () => ({ sidecarJsonCancellable: vi.fn() }));

import { getFileFull } from "./db-host/files.js";
import { modelSetting } from "./gatherContext.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import {
  castReadOutcome,
  snapToMediaLimits,
  storyReadCastFile,
} from "./storyTools.js";

const fakeDb = {} as Database.Database;

function limits(durations: number[]): MediaLimits {
  return {
    durations,
    resolutions: [],
    aspectRatios: [],
    frameImages: [],
    maxReferences: null,
    generateAudio: false,
  };
}

afterEach(() => {
  readState.file = ["cast.md", null, null, ""];
  readState.model = null;
  vi.clearAllMocks();
});

describe("story tool read and duration decisions", () => {
  it("rejects unreadable text before consulting any model setting", async () => {
    readState.file = ["empty.md", null, null, " \n "];

    await expect(storyReadCastFile(fakeDb, "cast-1")).rejects.toThrow(
      "“empty.md” has no readable text in this room.",
    );
    expect(vi.mocked(getFileFull)).toHaveBeenCalledWith(fakeDb, "cast-1");
    expect(vi.mocked(modelSetting)).not.toHaveBeenCalled();
    expect(vi.mocked(sidecarJsonCancellable)).not.toHaveBeenCalled();
  });

  it("uses the pattern reader without invoking a sidecar when no model is set", async () => {
    readState.file = ["cast.md", null, null, "## Mira\nTall, grey coat.\n\nLost her ship.\n"];

    await expect(storyReadCastFile(fakeDb, "cast-1")).resolves.toEqual({
      name: "cast.md",
      found: [{ name: "Mira", description: "Tall, grey coat.", story: "Lost her ship." }],
      readBy: "pattern matching",
      fellBack:
        "This room has no AI model set, so the file was read by pattern " +
        "matching — headings, bold names and `Name:` lines. Set a model " +
        "in Settings for a messy sheet.",
    });
    expect(vi.mocked(sidecarJsonCancellable)).not.toHaveBeenCalled();
  });

  it("keeps value, stopped, and failed model outcomes distinct without a sidecar", () => {
    expect(
      castReadOutcome(
        {
          kind: "value",
          value: { cast: [{ name: "Mira", description: "grey coat", story: "a sailor" }] },
        },
        "cast.md",
        "ignored by a value response",
        "model-x",
      ),
    ).toEqual({
      name: "cast.md",
      found: [{ name: "Mira", description: "grey coat", story: "a sailor" }],
      readBy: "model-x",
      fellBack: null,
    });
    expect(() => castReadOutcome({ kind: "stopped" }, "cast.md", "", "model-x")).toThrow(
      "Stopped before “cast.md” could be read.",
    );
    expect(
      castReadOutcome(
        { kind: "error", error: { code: "ENGINE_ERROR", error: "temporarily unavailable...", status: 503 } },
        "cast.md",
        "## Doran\nBroad, scarred.\n",
        "model-x",
      ),
    ).toMatchObject({
      readBy: "pattern matching",
      fellBack: expect.stringContaining("model-x could not read it (temporarily unavailable)"),
      found: [{ name: "Doran", description: "Broad, scarred.", story: "" }],
    });
  });

  it("snaps only an illegal known duration and breaks ties toward the first value", () => {
    expect(snapToMediaLimits(5, limits([4, 6, 8]))).toBe(4);
    expect(snapToMediaLimits(10, limits([4, 6, 8]))).toBe(8);
    expect(snapToMediaLimits(6, limits([4, 6, 8]))).toBe(6);
    expect(snapToMediaLimits(7, limits([]))).toBe(7);
    expect(snapToMediaLimits(7, undefined)).toBe(7);
  });
});
