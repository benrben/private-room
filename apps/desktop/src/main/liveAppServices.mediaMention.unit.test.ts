import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  findFileLikeQualified: vi.fn(),
  getFileBytes: vi.fn(),
  getFileMeta: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  findFileLikeQualified: fake.findFileLikeQualified,
  getFileBytes: fake.getFileBytes,
  getFileMeta: fake.getFileMeta,
}));

import { findMentionedMediaFile } from "./liveAppServices.js";

const conn = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findMentionedMediaFile", () => {
  it("uses a trimmed literal mention first, preserving a real leading at-sign", () => {
    fake.findFileLikeQualified.mockReturnValue(["media-1", "@intro.mp4"]);

    expect(findMentionedMediaFile(conn, "  @intro.mp4  ")).toEqual(["media-1", "@intro.mp4"]);
    expect(fake.findFileLikeQualified).toHaveBeenCalledTimes(1);
    expect(fake.findFileLikeQualified).toHaveBeenCalledWith(conn, "@intro.mp4");
  });

  it("retries without a mention sigil only after the literal lookup fails", () => {
    const literalFailure = new Error("literal name is absent");
    fake.findFileLikeQualified
      .mockImplementationOnce(() => {
        throw literalFailure;
      })
      .mockReturnValueOnce(["media-2", "intro.mp4"]);

    expect(findMentionedMediaFile(conn, "@  intro.mp4 ")).toEqual(["media-2", "intro.mp4"]);
    expect(fake.findFileLikeQualified.mock.calls).toEqual([
      [conn, "@  intro.mp4"],
      [conn, "intro.mp4"],
    ]);
  });

  it("keeps the original literal error when the fallback also fails", () => {
    const literalFailure = new Error("literal failure");
    const fallbackFailure = new Error("fallback failure");
    fake.findFileLikeQualified
      .mockImplementationOnce(() => {
        throw literalFailure;
      })
      .mockImplementationOnce(() => {
        throw fallbackFailure;
      });

    expect(() => findMentionedMediaFile(conn, "@intro.mp4")).toThrow(literalFailure);
    expect(fake.findFileLikeQualified.mock.calls).toEqual([
      [conn, "@intro.mp4"],
      [conn, "intro.mp4"],
    ]);
  });

  it.each([
    ["@", "@"],
    ["@   ", "@"],
    ["", ""],
    [null, ""],
    [undefined, ""],
    [7, ""],
  ])(
    "does not retry an empty or non-string mention (%j)",
    (rawName, requested) => {
      const literalFailure = new Error("not found");
      fake.findFileLikeQualified.mockImplementation(() => {
        throw literalFailure;
      });

      expect(() => findMentionedMediaFile(conn, rawName)).toThrow(literalFailure);
      expect(fake.findFileLikeQualified).toHaveBeenCalledTimes(1);
      expect(fake.findFileLikeQualified).toHaveBeenCalledWith(conn, requested);
    }
  );
});
