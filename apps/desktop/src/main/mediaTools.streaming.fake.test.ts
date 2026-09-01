import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createMediaStreams, mediaStreamingResponse } from "./mediaTools.js";

async function streamedText(body: ReadableStream<Uint8Array> | Buffer): Promise<string> {
  return Buffer.from(await new Response(body).arrayBuffer()).toString("utf8");
}

describe("mediaStreamingResponse with fabricated media streams", () => {
  it("opens one fabricated full stream and returns its complete body", async () => {
    const streams = createMediaStreams();
    const openStream = vi.fn(async () => Readable.from([Buffer.from("full body")]));
    streams.map.set("full", {
      bytes: Buffer.alloc(0),
      mime: "video/mp4",
      seq: 0,
      sizeBytes: 9,
      openStream,
    });

    const response = await mediaStreamingResponse(streams, "/full", null);

    expect(response.status).toBe(200);
    expect(response.headers).toContainEqual(["Content-Length", "9"]);
    await expect(streamedText(response.body)).resolves.toBe("full body");
    expect(openStream).toHaveBeenCalledOnce();
  });

  it("uses the fabricated seekable range factory without opening the full stream", async () => {
    const streams = createMediaStreams();
    const openStream = vi.fn(async () => Readable.from([Buffer.from("0123456789")]));
    const openRange = vi.fn(async (start: number, end: number) => Readable.from([Buffer.from(`range ${start}-${end}`)]));
    streams.map.set("seekable", {
      bytes: Buffer.alloc(0),
      mime: "audio/mp4",
      seq: 0,
      sizeBytes: 10,
      openStream,
      openRange,
    });

    const response = await mediaStreamingResponse(streams, "//seekable", "bytes=2-5");

    expect(response.status).toBe(206);
    expect(response.headers).toContainEqual(["Content-Range", "bytes 2-5/10"]);
    await expect(streamedText(response.body)).resolves.toBe("rang");
    expect(openRange).toHaveBeenCalledWith(2, 5);
    expect(openStream).not.toHaveBeenCalled();
  });

  it("selects the requested bytes from a fabricated non-seekable stream", async () => {
    const streams = createMediaStreams();
    const openStream = vi.fn(async () => Readable.from([Buffer.from("01"), Buffer.from("234"), Buffer.from("56789")]));
    streams.map.set("sequential", {
      bytes: Buffer.alloc(0),
      mime: "video/mp4",
      seq: 0,
      sizeBytes: 10,
      openStream,
    });

    const response = await mediaStreamingResponse(streams, "/sequential", "bytes=2-5");

    expect(response.status).toBe(206);
    await expect(streamedText(response.body)).resolves.toBe("2345");
    expect(openStream).toHaveBeenCalledOnce();
  });

  it("refuses an invalid range before opening a fabricated stream", async () => {
    const streams = createMediaStreams();
    const openStream = vi.fn(async () => Readable.from([Buffer.from("not opened")]));
    streams.map.set("invalid", {
      bytes: Buffer.alloc(0),
      mime: "video/mp4",
      seq: 0,
      sizeBytes: 10,
      openStream,
    });

    const response = await mediaStreamingResponse(streams, "/invalid", "bytes=50-60");

    expect(response).toMatchObject({ status: 416, body: Buffer.alloc(0) });
    expect(response.headers).toContainEqual(["Content-Range", "bytes */10"]);
    expect(openStream).not.toHaveBeenCalled();
  });

  it("delegates a fabricated legacy byte entry to the synchronous response path", async () => {
    const streams = createMediaStreams();
    streams.map.set("legacy", { bytes: Buffer.from("legacy"), mime: "audio/mp4", seq: 0 });

    const response = await mediaStreamingResponse(streams, "/legacy", "bytes=1-3");

    expect(response).toMatchObject({ status: 206, body: Buffer.from("ega") });
    expect(response.headers).toContainEqual(["Content-Range", "bytes 1-3/6"]);
  });
});
