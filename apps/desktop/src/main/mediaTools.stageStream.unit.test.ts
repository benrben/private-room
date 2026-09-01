import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ randomUUID: vi.fn() }));

vi.mock("node:crypto", () => ({ randomUUID: mocks.randomUUID }));

import { MAX_STAGED, createMediaStreams, stageMediaStream } from "./mediaTools.js";

describe("stageMediaStream with fabricated stream factories", () => {
  beforeEach(() => vi.resetAllMocks());

  it("stores lazy full and range factories without opening either during staging", async () => {
    mocks.randomUUID.mockReturnValue("fake-stream-token");
    const streams = createMediaStreams();
    const openStream = vi.fn(async () => Readable.from([Buffer.from("full")]));
    const openRange = vi.fn(async () => Readable.from([Buffer.from("range")]));

    const token = stageMediaStream(streams, 4096, "video/mp4", openStream, openRange);
    const staged = streams.map.get(token);
    if (!staged) throw new Error("missing staged stream");

    expect(token).toBe("0-fake-stream-token");
    expect(staged).toMatchObject({ bytes: Buffer.alloc(0), mime: "video/mp4", seq: 0, sizeBytes: 4096 });
    expect(staged.openStream).toBe(openStream);
    expect(staged.openRange).toBe(openRange);
    expect(openStream).not.toHaveBeenCalled();
    expect(openRange).not.toHaveBeenCalled();

    await staged.openStream!();
    await staged.openStream!();
    await staged.openRange!(64, 127);
    expect(openStream).toHaveBeenCalledTimes(2);
    expect(openRange).toHaveBeenCalledWith(64, 127);
  });

  it("evicts oldest sequence entries to keep only the newest four staged streams", () => {
    mocks.randomUUID.mockReturnValue("newest-token");
    const streams = createMediaStreams();
    streams.next = 10;
    streams.map.set("late", { bytes: Buffer.alloc(0), mime: "video/mp4", seq: 9 });
    streams.map.set("oldest", { bytes: Buffer.alloc(0), mime: "video/mp4", seq: 1 });
    streams.map.set("middle", { bytes: Buffer.alloc(0), mime: "video/mp4", seq: 5 });
    streams.map.set("second-oldest", { bytes: Buffer.alloc(0), mime: "video/mp4", seq: 2 });
    streams.map.set("newer", { bytes: Buffer.alloc(0), mime: "video/mp4", seq: 7 });

    const token = stageMediaStream(
      streams,
      12,
      "audio/mp4",
      async () => Readable.from([Buffer.from("fabricated")]),
    );

    expect(token).toBe("10-newest-token");
    expect(streams.map.size).toBe(MAX_STAGED);
    expect(streams.map.has("oldest")).toBe(false);
    expect(streams.map.has("second-oldest")).toBe(false);
    expect([...streams.map.keys()].sort()).toEqual(["10-newest-token", "late", "middle", "newer"]);
    expect(streams.map.get(token)).toMatchObject({
      bytes: Buffer.alloc(0),
      mime: "audio/mp4",
      seq: 10,
      sizeBytes: 12,
      openRange: undefined,
    });
    expect(streams.next).toBe(11);
  });
});
