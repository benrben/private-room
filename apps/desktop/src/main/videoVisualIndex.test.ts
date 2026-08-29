import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import {
  VIDEO_VISUAL_CAPTURE_TIMEOUT_MS,
  VIDEO_VISUAL_FRAME_TIMEOUT_MS,
  VIDEO_VISUAL_INDEX_PROFILE_ID,
  createVideoVisualIndexClient,
  visualIndexId,
  type VisualIndexPost,
} from "./videoVisualIndex.js";

const SOURCE_SHA = "a".repeat(64);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("videoVisualIndex", () => {
  it("requests the exact cached second and converts authenticated JPEG pixels to the existing PNG contract", async () => {
    const jpeg = await sharp({
      create: { width: 2, height: 1, channels: 3, background: { r: 20, g: 40, b: 60 } },
    }).jpeg({ quality: 42 }).toBuffer();
    const post = vi.fn<VisualIndexPost>(async () => ({
      kind: "value",
      value: {
        index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        requested_second: 360,
        resolved_second: 360,
        mime: "image/jpeg",
        image_b64: jpeg.toString("base64"),
        sha256: digest(jpeg),
        byte_size: jpeg.length,
        width: 2,
        height: 1,
      },
    }));

    const frame = await createVideoVisualIndexClient(post).frame(SOURCE_SHA, 360);

    expect(post).toHaveBeenCalledWith(
      "/media/visual-index/frame",
      { index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`, second: 360 },
      VIDEO_VISUAL_FRAME_TIMEOUT_MS,
    );
    expect(frame).not.toBeNull();
    const png = Buffer.from(frame!.imageB64, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(frame).toMatchObject({ width: 2, height: 1, atSeconds: 360, sha256: digest(png) });
  });

  it("captures one exact cold second from the staged video without waiting for the full index", async () => {
    const jpeg = await sharp({
      create: { width: 1, height: 2, channels: 3, background: { r: 70, g: 80, b: 90 } },
    }).jpeg({ quality: 42 }).toBuffer();
    const staged = "/private/tmp/arcelle-visual-index-x/source.mp4";
    const post = vi.fn<VisualIndexPost>(async () => ({
      kind: "value",
      value: {
        requested_second: 360,
        resolved_second: 360,
        actual_second: 360,
        duration_secs: 3_399.3,
        mime: "image/jpeg",
        image_b64: jpeg.toString("base64"),
        sha256: digest(jpeg),
        byte_size: jpeg.length,
        width: 1,
        height: 2,
      },
    }));

    const frame = await createVideoVisualIndexClient(post).capture(staged, 360);

    expect(post).toHaveBeenCalledWith(
      "/media/visual-index/capture",
      { path: staged, second: 360 },
      VIDEO_VISUAL_CAPTURE_TIMEOUT_MS,
    );
    expect(frame).toMatchObject({ width: 1, height: 2, atSeconds: 360 });
    expect(Buffer.from(frame!.imageB64, "base64").subarray(0, 8).toString("hex"))
      .toBe("89504e470d0a1a0a");
  });

  it("treats a corrupt cached frame as a miss instead of handing unverified pixels to the model", async () => {
    const bytes = Buffer.from("not really a jpeg");
    const client = createVideoVisualIndexClient(async () => ({
      kind: "value",
      value: {
        index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        requested_second: 4,
        resolved_second: 4,
        mime: "image/jpeg",
        image_b64: bytes.toString("base64"),
        sha256: "0".repeat(64),
        byte_size: bytes.length,
        width: 1,
        height: 1,
      },
    }));
    expect(await client.frame(SOURCE_SHA, 4)).toBeNull();
  });

  it("content-addresses every lookup so a changed source cannot reuse the old video's frames", () => {
    const changed = "b".repeat(64);
    expect(visualIndexId(SOURCE_SHA)).toBe(`${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`);
    expect(visualIndexId(changed)).toBe(`${changed}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`);
    expect(visualIndexId(changed)).not.toBe(visualIndexId(SOURCE_SHA));
    expect(visualIndexId("not-a-hash")).toBeNull();
  });

  it("accepts a warm result only when its immutable source hash and pinned profile match", async () => {
    const post = vi.fn<VisualIndexPost>(async () => ({
      kind: "value",
      value: {
        status: "ready",
        index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        source_sha256: SOURCE_SHA,
        frame_count: 361,
        reused: false,
        profile: { id: VIDEO_VISUAL_INDEX_PROFILE_ID },
      },
    }));
    const client = createVideoVisualIndexClient(post);
    await expect(client.warm("/private/tmp/arcelle-visual-index-x/source.mp4", SOURCE_SHA))
      .resolves.toEqual({
        indexId: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        sourceSha256: SOURCE_SHA,
        frameCount: 361,
        reused: false,
      });
    await expect(client.warm("/private/tmp/arcelle-visual-index-x/source.mp4", "b".repeat(64)))
      .resolves.toBeNull();
  });
});
