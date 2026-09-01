import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sidecarPost: vi.fn() }));

vi.mock("./sidecarJsonCancellable.js", () => ({
  sidecarJsonCancellable: mocks.sidecarPost,
}));

import {
  VIDEO_VISUAL_CAPTURE_TIMEOUT_MS,
  VIDEO_VISUAL_FRAME_TIMEOUT_MS,
  VIDEO_VISUAL_INDEX_PROFILE_ID,
  VIDEO_VISUAL_WARM_TIMEOUT_MS,
  createVideoVisualIndexClient,
  videoVisualIndex,
  visualIndexId,
  type VisualIndexPost,
} from "./videoVisualIndex.js";

const SOURCE_SHA = "a".repeat(64);
const STAGED_VIDEO = "/private/tmp/arcelle-visual-index-x/source.mp4";

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readyWarm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ready",
    index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
    source_sha256: SOURCE_SHA,
    frame_count: 361,
    reused: false,
    profile: { id: VIDEO_VISUAL_INDEX_PROFILE_ID },
    ...overrides,
  };
}

function frameResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
    requested_second: 1,
    resolved_second: 1,
    mime: "image/jpeg",
    image_b64: "YQ==",
    sha256: "0".repeat(64),
    byte_size: 1,
    width: 1,
    height: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.sidecarPost.mockReset();
});

describe("videoVisualIndex", () => {
  it("requests the exact cached second and converts authenticated JPEG pixels to the existing PNG contract", async () => {
    const jpeg = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .jpeg({ quality: 42 })
      .toBuffer();
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

    const frame = await createVideoVisualIndexClient(post).frame(
      SOURCE_SHA,
      360,
    );

    expect(post).toHaveBeenCalledWith(
      "/media/visual-index/frame",
      {
        index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        second: 360,
      },
      VIDEO_VISUAL_FRAME_TIMEOUT_MS,
    );
    expect(frame).not.toBeNull();
    const png = Buffer.from(frame!.imageB64, "base64");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(frame).toMatchObject({
      width: 2,
      height: 1,
      atSeconds: 360,
      sha256: digest(png),
    });
  });

  it("captures one exact cold second from the staged video without waiting for the full index", async () => {
    const jpeg = await sharp({
      create: {
        width: 1,
        height: 2,
        channels: 3,
        background: { r: 70, g: 80, b: 90 },
      },
    })
      .jpeg({ quality: 42 })
      .toBuffer();
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

    const frame = await createVideoVisualIndexClient(post).capture(STAGED_VIDEO, 360);

    expect(post).toHaveBeenCalledWith(
      "/media/visual-index/capture",
      { path: STAGED_VIDEO, second: 360 },
      VIDEO_VISUAL_CAPTURE_TIMEOUT_MS,
    );
    expect(frame).toMatchObject({ width: 1, height: 2, atSeconds: 360 });
    expect(
      Buffer.from(frame!.imageB64, "base64").subarray(0, 8).toString("hex"),
    ).toBe("89504e470d0a1a0a");
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

  it("rejects malformed cache claims before attempting to decode their pixels", async () => {
    const malformed = [
      { label: "non-object", value: "not an object" },
      { label: "wrong index", value: frameResponse({ index_id: "wrong" }) },
      { label: "wrong requested second", value: frameResponse({ requested_second: 2 }) },
      { label: "negative resolved second", value: frameResponse({ resolved_second: -1 }) },
      { label: "unsupported mime", value: frameResponse({ mime: "image/png" }) },
      { label: "empty encoded pixels", value: frameResponse({ image_b64: "" }) },
      { label: "invalid digest", value: frameResponse({ sha256: "not-a-digest" }) },
      { label: "zero byte size", value: frameResponse({ byte_size: 0 }) },
      { label: "fractional width", value: frameResponse({ width: 1.5 }) },
      { label: "zero height", value: frameResponse({ height: 0 }) },
    ];

    for (const { label, value } of malformed) {
      const client = createVideoVisualIndexClient(async () => ({ kind: "value", value }));
      await expect(client.frame(SOURCE_SHA, 1), label).resolves.toBeNull();
    }
  });

  it("treats checksum-authenticated bytes that fail JPEG decoding as a cache miss", async () => {
    const bytes = Buffer.from("not really a jpeg");
    const client = createVideoVisualIndexClient(async () => ({
      kind: "value",
      value: {
        index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        requested_second: 4,
        actual_second: 4,
        mime: "image/jpeg",
        image_b64: bytes.toString("base64"),
        sha256: digest(bytes),
        byte_size: bytes.length,
        width: 1,
        height: 1,
      },
    }));

    await expect(client.frame(SOURCE_SHA, 4)).resolves.toBeNull();
  });

  it("content-addresses every lookup so a changed source cannot reuse the old video's frames", () => {
    const changed = "b".repeat(64);
    expect(visualIndexId(SOURCE_SHA)).toBe(
      `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
    );
    expect(visualIndexId(changed)).toBe(
      `${changed}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
    );
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
    await expect(
      client.warm("/private/tmp/arcelle-visual-index-x/source.mp4", SOURCE_SHA),
    ).resolves.toEqual({
      indexId: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
      sourceSha256: SOURCE_SHA,
      frameCount: 361,
      reused: false,
    });
    await expect(
      client.warm(
        "/private/tmp/arcelle-visual-index-x/source.mp4",
        "b".repeat(64),
      ),
    ).resolves.toBeNull();
  });

  it("normalizes the trusted warm source hash, including its expected comparison", async () => {
    const post = vi.fn<VisualIndexPost>(async () => ({
      kind: "value",
      value: readyWarm({ source_sha256: SOURCE_SHA.toUpperCase() }),
    }));

    await expect(
      createVideoVisualIndexClient(post).warm(
        STAGED_VIDEO,
        ` ${SOURCE_SHA.toUpperCase()} `,
      ),
    ).resolves.toEqual({
      indexId: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
      sourceSha256: SOURCE_SHA,
      frameCount: 361,
      reused: false,
    });
  });

  it("rejects every malformed ready response before exposing a visual-index cache result", async () => {
    const malformed = [
      { label: "non-object", value: null },
      { label: "array instead of object", value: [] },
      { label: "wrong status", value: readyWarm({ status: "warming" }) },
      { label: "invalid source hash", value: readyWarm({ source_sha256: "not-a-hash" }) },
      { label: "missing source hash", value: readyWarm({ source_sha256: null }) },
      { label: "wrong immutable index", value: readyWarm({ index_id: "other-index" }) },
      { label: "wrong profile", value: readyWarm({ profile: { id: "old-profile" } }) },
      { label: "fractional frame count", value: readyWarm({ frame_count: 3.5 }) },
      { label: "negative frame count", value: readyWarm({ frame_count: -1 }) },
      { label: "untyped reuse flag", value: readyWarm({ reused: "false" }) },
      { label: "different expected source", value: readyWarm() },
    ];

    for (const { label, value } of malformed) {
      const expected = label === "different expected source" ? "b".repeat(64) : SOURCE_SHA;
      const client = createVideoVisualIndexClient(async () => ({ kind: "value", value }));
      await expect(client.warm(STAGED_VIDEO, expected), label).resolves.toBeNull();
    }
  });

  it("treats authenticated pixels with an inconsistent claimed size as a cache miss", async () => {
    const jpeg = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg({ quality: 42 })
      .toBuffer();
    const client = createVideoVisualIndexClient(async () => ({
      kind: "value",
      value: {
        index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`,
        requested_second: 1,
        resolved_second: 1,
        mime: "image/jpeg",
        image_b64: jpeg.toString("base64"),
        sha256: digest(jpeg),
        byte_size: jpeg.length,
        width: 3,
        height: 1,
      },
    }));

    await expect(client.frame(SOURCE_SHA, 1)).resolves.toBeNull();
  });

  it("uses a fresh cancellation flag for the default sidecar post", async () => {
    mocks.sidecarPost.mockResolvedValue({ kind: "stopped" });

    await expect(videoVisualIndex.warm(STAGED_VIDEO)).resolves.toBeNull();
    expect(mocks.sidecarPost).toHaveBeenCalledWith(
      "/media/visual-index/warm",
      { path: STAGED_VIDEO },
      expect.anything(),
      VIDEO_VISUAL_WARM_TIMEOUT_MS,
    );
  });

  it("fails closed for stopped and rejected frame, capture, and warm requests", async () => {
    const stopped = { kind: "stopped" } as const;
    const client = createVideoVisualIndexClient(async () => stopped);
    await expect(client.frame(SOURCE_SHA, 1)).resolves.toBeNull();
    await expect(client.capture(STAGED_VIDEO, 1)).resolves.toBeNull();
    await expect(client.warm(STAGED_VIDEO)).resolves.toBeNull();

    const rejected = createVideoVisualIndexClient(async () => {
      throw new Error("sidecar unavailable");
    });
    await expect(rejected.frame(SOURCE_SHA, 1)).resolves.toBeNull();
    await expect(rejected.capture(STAGED_VIDEO, 1)).resolves.toBeNull();
    await expect(rejected.warm(STAGED_VIDEO)).resolves.toBeNull();
  });

  it("does not start invalid requests and clamps accepted request timeouts", async () => {
    const post = vi.fn<VisualIndexPost>(async () => ({ kind: "stopped" }));
    const client = createVideoVisualIndexClient(post);
    await expect(client.frame("not-a-hash", 1)).resolves.toBeNull();
    await expect(client.frame(SOURCE_SHA, -1)).resolves.toBeNull();
    await expect(client.capture("   ", 1)).resolves.toBeNull();
    await expect(client.capture(STAGED_VIDEO, Number.NaN)).resolves.toBeNull();
    await expect(client.warm("\t")).resolves.toBeNull();
    expect(post).not.toHaveBeenCalled();

    await client.frame(SOURCE_SHA, 1, 0);
    await client.capture(STAGED_VIDEO, 1, VIDEO_VISUAL_CAPTURE_TIMEOUT_MS + 1);
    await client.warm(STAGED_VIDEO, undefined, 0);
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/media/visual-index/frame",
      { index_id: `${SOURCE_SHA}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`, second: 1 },
      1,
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/media/visual-index/capture",
      { path: STAGED_VIDEO, second: 1 },
      VIDEO_VISUAL_CAPTURE_TIMEOUT_MS,
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      "/media/visual-index/warm",
      { path: STAGED_VIDEO },
      1,
    );
  });
});
