/**
 * Local 1-FPS visual index client for room videos.
 *
 * The Python sidecar owns the derived cache and accepts only app-created
 * private staging paths. This module owns the Electron contract: derive an
 * immutable index id from the workspace content hash, validate every byte the
 * sidecar returns, and turn the compact JPEG into the PNG shape the existing
 * `view_media_frame` MCP bridge already promises.
 */

import { createHash } from "node:crypto";
import sharp from "sharp";
import { CancelFlag } from "./cancel.js";
import {
  sidecarJsonCancellable,
  type SidecarPostOutcome,
} from "./sidecarJsonCancellable.js";

export const VIDEO_VISUAL_INDEX_PROFILE_ID = "jpeg-320-1fps-q42-v1";
export const VIDEO_VISUAL_FRAME_TIMEOUT_MS = 10_000;
export const VIDEO_VISUAL_CAPTURE_TIMEOUT_MS = 20_000;
export const VIDEO_VISUAL_WARM_TIMEOUT_MS = 120_000;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export interface CachedVisualFrame {
  imageB64: string;
  width: number;
  height: number;
  atSeconds: number;
  sha256: string;
}

export interface VisualIndexWarmResult {
  indexId: string;
  sourceSha256: string;
  frameCount: number;
  reused: boolean;
}

export interface VideoVisualIndexClient {
  frame(sourceSha256: string, seconds: number, timeoutMs?: number): Promise<CachedVisualFrame | null>;
  capture(stagedPath: string, seconds: number, timeoutMs?: number): Promise<CachedVisualFrame | null>;
  warm(
    stagedPath: string,
    expectedSourceSha256?: string,
    timeoutMs?: number,
  ): Promise<VisualIndexWarmResult | null>;
}

export type VisualIndexPost = (
  path: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<SidecarPostOutcome>;

function defaultPost(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<SidecarPostOutcome> {
  return sidecarJsonCancellable(endpoint, body, new CancelFlag(), timeoutMs);
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The immutable sidecar key. A changed workspace source hash necessarily
 * addresses a different cache entry, so old frames cannot be mistaken for the
 * current file after an external edit/reconcile. */
export function visualIndexId(sourceSha256: string): string | null {
  const normalized = sourceSha256.trim().toLowerCase();
  return HEX_SHA256.test(normalized)
    ? `${normalized}.${VIDEO_VISUAL_INDEX_PROFILE_ID}`
    : null;
}

async function decodeFrame(
  value: unknown,
  expectedIndexId: string | null,
  requestedSecond: number,
): Promise<CachedVisualFrame | null> {
  const body = object(value);
  if (body === null) return null;
  const indexId = typeof body.index_id === "string" ? body.index_id : "";
  const requested = Number(body.requested_second);
  const resolved = Number(body.resolved_second ?? body.actual_second);
  const mime = typeof body.mime === "string" ? body.mime.toLowerCase() : "";
  const encoded = typeof body.image_b64 === "string" ? body.image_b64 : "";
  const claimedSha = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
  const claimedBytes = Number(body.byte_size);
  const claimedWidth = Number(body.width);
  const claimedHeight = Number(body.height);
  if (
    (expectedIndexId !== null && indexId !== expectedIndexId)
    || requested !== requestedSecond
    || !Number.isSafeInteger(resolved)
    || resolved < 0
    || mime !== "image/jpeg"
    || encoded === ""
    || !HEX_SHA256.test(claimedSha)
    || !Number.isSafeInteger(claimedBytes)
    || claimedBytes <= 0
    || !Number.isSafeInteger(claimedWidth)
    || claimedWidth <= 0
    || !Number.isSafeInteger(claimedHeight)
    || claimedHeight <= 0
  ) {
    return null;
  }

  const jpeg = Buffer.from(encoded, "base64");
  if (jpeg.length !== claimedBytes || sha256(jpeg) !== claimedSha) return null;
  try {
    const converted = await sharp(jpeg, { failOn: "error" })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (converted.info.width !== claimedWidth || converted.info.height !== claimedHeight) return null;
    return {
      imageB64: converted.data.toString("base64"),
      width: converted.info.width,
      height: converted.info.height,
      atSeconds: resolved,
      sha256: sha256(converted.data),
    };
  } catch {
    return null;
  }
}

function decodeWarm(
  value: unknown,
  expectedSourceSha256?: string,
): VisualIndexWarmResult | null {
  const body = object(value);
  if (body === null || body.status !== "ready") return null;
  const sourceSha256 = typeof body.source_sha256 === "string"
    ? body.source_sha256.toLowerCase()
    : "";
  const indexId = typeof body.index_id === "string" ? body.index_id : "";
  const expectedId = visualIndexId(sourceSha256);
  const profile = object(body.profile);
  const frameCount = Number(body.frame_count);
  if (
    expectedId === null
    || indexId !== expectedId
    || profile?.id !== VIDEO_VISUAL_INDEX_PROFILE_ID
    || !Number.isSafeInteger(frameCount)
    || frameCount < 0
    || typeof body.reused !== "boolean"
    || (
      expectedSourceSha256 !== undefined
      && sourceSha256 !== expectedSourceSha256.trim().toLowerCase()
    )
  ) {
    return null;
  }
  return { indexId, sourceSha256, frameCount, reused: body.reused };
}

export function createVideoVisualIndexClient(
  post: VisualIndexPost = defaultPost,
): VideoVisualIndexClient {
  return {
    async frame(sourceSha256, seconds, timeoutMs = VIDEO_VISUAL_FRAME_TIMEOUT_MS) {
      const indexId = visualIndexId(sourceSha256);
      if (indexId === null || !Number.isFinite(seconds) || seconds < 0) return null;
      const second = Math.floor(seconds);
      try {
        const outcome = await post(
          "/media/visual-index/frame",
          { index_id: indexId, second },
          Math.max(1, Math.min(timeoutMs, VIDEO_VISUAL_FRAME_TIMEOUT_MS)),
        );
        return outcome.kind === "value"
          ? await decodeFrame(outcome.value, indexId, second)
          : null;
      } catch {
        return null;
      }
    },

    async capture(stagedPath, seconds, timeoutMs = VIDEO_VISUAL_CAPTURE_TIMEOUT_MS) {
      if (stagedPath.trim() === "" || !Number.isFinite(seconds) || seconds < 0) return null;
      const second = Math.floor(seconds);
      try {
        const outcome = await post(
          "/media/visual-index/capture",
          { path: stagedPath, second },
          Math.max(1, Math.min(timeoutMs, VIDEO_VISUAL_CAPTURE_TIMEOUT_MS)),
        );
        return outcome.kind === "value"
          ? await decodeFrame(outcome.value, null, second)
          : null;
      } catch {
        return null;
      }
    },

    async warm(stagedPath, expectedSourceSha256, timeoutMs = VIDEO_VISUAL_WARM_TIMEOUT_MS) {
      if (stagedPath.trim() === "") return null;
      try {
        const outcome = await post(
          "/media/visual-index/warm",
          { path: stagedPath },
          Math.max(1, Math.min(timeoutMs, VIDEO_VISUAL_WARM_TIMEOUT_MS)),
        );
        return outcome.kind === "value"
          ? decodeWarm(outcome.value, expectedSourceSha256)
          : null;
      } catch {
        return null;
      }
    },
  };
}

export const videoVisualIndex = createVideoVisualIndexClient();
