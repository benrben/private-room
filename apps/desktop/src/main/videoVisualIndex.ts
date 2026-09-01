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
  frame(
    sourceSha256: string,
    seconds: number,
    timeoutMs?: number,
  ): Promise<CachedVisualFrame | null>;
  capture(
    stagedPath: string,
    seconds: number,
    timeoutMs?: number,
  ): Promise<CachedVisualFrame | null>;
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
    ? (value as Record<string, unknown>)
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

interface FrameClaim {
  indexId: string;
  requested: number;
  resolved: number;
  mime: string;
  encoded: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
}

function stringFrameField(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  return typeof value === "string" ? value : "";
}

function numericFrameField(
  body: Record<string, unknown>,
  field: string,
): number {
  return Number(body[field]);
}

function resolvedFrameSecond(body: Record<string, unknown>): number {
  return Number(body.resolved_second ?? body.actual_second);
}

function frameClaim(value: unknown): FrameClaim | null {
  const body = object(value);
  if (body === null) return null;
  return {
    indexId: stringFrameField(body, "index_id"),
    requested: numericFrameField(body, "requested_second"),
    resolved: resolvedFrameSecond(body),
    mime: stringFrameField(body, "mime").toLowerCase(),
    encoded: stringFrameField(body, "image_b64"),
    sha256: stringFrameField(body, "sha256").toLowerCase(),
    byteSize: numericFrameField(body, "byte_size"),
    width: numericFrameField(body, "width"),
    height: numericFrameField(body, "height"),
  };
}

function matchesFrameIndex(
  claim: FrameClaim,
  expectedIndexId: string | null,
): boolean {
  return expectedIndexId === null || claim.indexId === expectedIndexId;
}

function matchesFrameTiming(
  claim: FrameClaim,
  requestedSecond: number,
): boolean {
  return (
    claim.requested === requestedSecond &&
    Number.isSafeInteger(claim.resolved) &&
    claim.resolved >= 0
  );
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function hasSupportedFrameEncoding(claim: FrameClaim): boolean {
  return (
    claim.mime === "image/jpeg" &&
    claim.encoded !== "" &&
    HEX_SHA256.test(claim.sha256)
  );
}

function validFrameClaim(
  claim: FrameClaim,
  expectedIndexId: string | null,
  requestedSecond: number,
): boolean {
  if (!matchesFrameIndex(claim, expectedIndexId)) return false;
  if (!matchesFrameTiming(claim, requestedSecond)) return false;
  if (!hasSupportedFrameEncoding(claim)) return false;
  return (
    positiveSafeInteger(claim.byteSize) &&
    positiveSafeInteger(claim.width) &&
    positiveSafeInteger(claim.height)
  );
}

function authenticatedJpeg(claim: FrameClaim): Buffer | null {
  const jpeg = Buffer.from(claim.encoded, "base64");
  if (jpeg.length !== claim.byteSize || sha256(jpeg) !== claim.sha256)
    return null;
  return jpeg;
}

function renderedFrameMatches(
  claim: FrameClaim,
  width: number,
  height: number,
): boolean {
  return width === claim.width && height === claim.height;
}

async function pngFrame(
  jpeg: Buffer,
  claim: FrameClaim,
): Promise<CachedVisualFrame | null> {
  try {
    const converted = await sharp(jpeg, { failOn: "error" })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (
      !renderedFrameMatches(claim, converted.info.width, converted.info.height)
    )
      return null;
    return {
      imageB64: converted.data.toString("base64"),
      width: converted.info.width,
      height: converted.info.height,
      atSeconds: claim.resolved,
      sha256: sha256(converted.data),
    };
  } catch {
    return null;
  }
}

async function decodeFrame(
  value: unknown,
  expectedIndexId: string | null,
  requestedSecond: number,
): Promise<CachedVisualFrame | null> {
  const claim = frameClaim(value);
  if (
    claim === null ||
    !validFrameClaim(claim, expectedIndexId, requestedSecond)
  )
    return null;
  const jpeg = authenticatedJpeg(claim);
  return jpeg === null ? null : pngFrame(jpeg, claim);
}

interface WarmClaim {
  sourceSha256: string;
  indexId: string;
  profile: Record<string, unknown> | null;
  frameCount: number;
  reused: unknown;
}

function normalizedWarmSource(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function warmClaim(value: unknown): WarmClaim | null {
  const body = object(value);
  if (body === null || body.status !== "ready") return null;
  return {
    sourceSha256: normalizedWarmSource(body.source_sha256),
    indexId: stringFrameField(body, "index_id"),
    profile: object(body.profile),
    frameCount: Number(body.frame_count),
    reused: body.reused,
  };
}

function hasExpectedWarmIndex(claim: WarmClaim): boolean {
  const expectedId = visualIndexId(claim.sourceSha256);
  return expectedId !== null && claim.indexId === expectedId;
}

function hasPinnedWarmProfile(claim: WarmClaim): boolean {
  return claim.profile?.id === VIDEO_VISUAL_INDEX_PROFILE_ID;
}

function hasValidWarmFrameCount(claim: WarmClaim): boolean {
  return Number.isSafeInteger(claim.frameCount) && claim.frameCount >= 0;
}

function hasWarmReuseFlag(claim: WarmClaim): claim is WarmClaim & { reused: boolean } {
  return typeof claim.reused === "boolean";
}

function matchesExpectedWarmSource(
  sourceSha256: string,
  expectedSourceSha256: string | undefined,
): boolean {
  return expectedSourceSha256 === undefined || sourceSha256 === normalizedWarmSource(expectedSourceSha256.trim());
}

function validWarmClaim(
  claim: WarmClaim,
  expectedSourceSha256: string | undefined,
): claim is WarmClaim & { reused: boolean } {
  return (
    hasExpectedWarmIndex(claim) &&
    hasPinnedWarmProfile(claim) &&
    hasValidWarmFrameCount(claim) &&
    hasWarmReuseFlag(claim) &&
    matchesExpectedWarmSource(claim.sourceSha256, expectedSourceSha256)
  );
}

function decodeWarm(
  value: unknown,
  expectedSourceSha256?: string,
): VisualIndexWarmResult | null {
  const claim = warmClaim(value);
  if (claim === null || !validWarmClaim(claim, expectedSourceSha256)) return null;
  return {
    indexId: claim.indexId,
    sourceSha256: claim.sourceSha256,
    frameCount: claim.frameCount,
    reused: claim.reused,
  };
}

export function createVideoVisualIndexClient(
  post: VisualIndexPost = defaultPost,
): VideoVisualIndexClient {
  return {
    async frame(
      sourceSha256,
      seconds,
      timeoutMs = VIDEO_VISUAL_FRAME_TIMEOUT_MS,
    ) {
      const indexId = visualIndexId(sourceSha256);
      if (indexId === null || !Number.isFinite(seconds) || seconds < 0)
        return null;
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

    async capture(
      stagedPath,
      seconds,
      timeoutMs = VIDEO_VISUAL_CAPTURE_TIMEOUT_MS,
    ) {
      if (stagedPath.trim() === "" || !Number.isFinite(seconds) || seconds < 0)
        return null;
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

    async warm(
      stagedPath,
      expectedSourceSha256,
      timeoutMs = VIDEO_VISUAL_WARM_TIMEOUT_MS,
    ) {
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
