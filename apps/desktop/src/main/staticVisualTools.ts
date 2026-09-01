import { createHash } from "node:crypto";
import sharp from "sharp";
import { findFileLikeQualified } from "./db-host/files.js";
import { modelSetting } from "./gatherContext.js";
import { activePolicy } from "./privacy.js";
import { runsOnThisMac } from "./capabilities.js";
import {
  execReadDrawing,
  execReadDrawingInRoom,
  type SketchRoom,
} from "./sketchCommands.js";
import { readRoomFile } from "./workspace/roomContent.js";

export interface StaticVisualEffects {
  pendingImages: string[];
  visionChat: boolean;
}

export type StaticVisualOutcome =
  | { ok: true; text: string }
  | { ok: false; error: string };

type StaticVisualSuccess = Extract<StaticVisualOutcome, { ok: true }>;

const MAX_VISUAL_EDGE = 1280;

function fail(error: unknown): StaticVisualOutcome {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function receipt(
  name: string,
  png: Buffer,
  width: number,
  height: number,
): string {
  const sha256 = createHash("sha256").update(png).digest("hex");
  return `Image receipt: "${name}"; SHA-256 ${sha256}; ${width}×${height} PNG.`;
}

function maySendPixels(
  room: SketchRoom,
  effects: StaticVisualEffects,
): StaticVisualOutcome | null {
  if (!effects.visionChat) {
    return fail(
      "The selected model has no usable image-input channel, so no visual interpretation was performed.",
    );
  }
  const model = modelSetting(room.db);
  if (model !== null && !runsOnThisMac(model) && activePolicy() !== null) {
    return fail(
      "Cloud Privacy is keeping this room's image pixels on this Mac. Switch to On this Mac or use the one-turn privacy bypass to inspect it.",
    );
  }
  return null;
}

type ResolvedVisualFile = { fileId: string; realName: string };

type RenderedImage = { png: Buffer; width: number; height: number };

type RoomFile = Awaited<ReturnType<typeof readRoomFile>>;

function requestedVisualName(args: Record<string, unknown>): string {
  return typeof args.name === "string" ? args.name.trim() : "";
}

function findVisualFile(
  room: SketchRoom,
  requested: string,
): ResolvedVisualFile {
  try {
    const [fileId, realName] = findFileLikeQualified(room.db, requested);
    return { fileId, realName };
  } catch (first) {
    if (!requested.startsWith("@") || requested.length === 1) throw first;
    return findVisualFileWithoutMention(room, requested, first);
  }
}

function findVisualFileWithoutMention(
  room: SketchRoom,
  requested: string,
  first: unknown,
): ResolvedVisualFile {
  try {
    const [fileId, realName] = findFileLikeQualified(
      room.db,
      requested.slice(1),
    );
    return { fileId, realName };
  } catch {
    throw first;
  }
}

function isSketchFile(name: string): boolean {
  return name.toLowerCase().endsWith(".sketch");
}

function discardNewImages(effects: StaticVisualEffects, before: number): void {
  effects.pendingImages.splice(before);
}

async function readSketchImage(
  room: SketchRoom,
  realName: string,
  effects: StaticVisualEffects,
): Promise<StaticVisualOutcome> {
  return room.workspace === undefined
    ? execReadDrawing(room.db, { name: realName }, effects)
    : execReadDrawingInRoom(room, { name: realName }, effects);
}

function sketchImageAt(
  effects: StaticVisualEffects,
  before: number,
): string | StaticVisualOutcome {
  const image = effects.pendingImages[before];
  if (typeof image === "string" && image !== "") return image;
  discardNewImages(effects, before);
  return fail(
    "The sketch produced a text report but no image pixels. No visual interpretation was performed.",
  );
}

async function verifiedPng(
  png: Buffer,
): Promise<{ width: number; height: number }> {
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (meta.format !== "png" || width < 1 || height < 1)
    throw new Error("invalid PNG dimensions");
  return { width, height };
}

async function verifySketchImage(
  realName: string,
  image: string,
  outcome: StaticVisualSuccess,
  effects: StaticVisualEffects,
  before: number,
): Promise<StaticVisualOutcome> {
  const png = Buffer.from(image, "base64");
  if (png.length === 0) {
    discardNewImages(effects, before);
    return fail(
      "The sketch produced an empty image. No visual interpretation was performed.",
    );
  }
  try {
    const { width, height } = await verifiedPng(png);
    return {
      ok: true,
      text: `${outcome.text}\n${receipt(realName, png, width, height)}`,
    };
  } catch (error) {
    discardNewImages(effects, before);
    return fail(
      `The sketch raster could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function viewSketchFile(
  room: SketchRoom,
  realName: string,
  effects: StaticVisualEffects,
): Promise<StaticVisualOutcome> {
  const before = effects.pendingImages.length;
  const outcome = await readSketchImage(room, realName, effects);
  if (!outcome.ok) {
    discardNewImages(effects, before);
    return outcome;
  }
  const image = sketchImageAt(effects, before);
  if (typeof image !== "string") return image;
  return verifySketchImage(realName, image, outcome, effects, before);
}

function imageBytes(
  file: RoomFile,
  realName: string,
): Buffer | StaticVisualOutcome {
  if (!file.mimeType?.toLowerCase().startsWith("image/")) {
    return fail(`"${realName}" is not a supported image or sketch.`);
  }
  if (file.bytes === null || file.bytes.length === 0) {
    return fail(`"${realName}" has no image bytes.`);
  }
  return file.bytes;
}

async function renderImage(bytes: Buffer): Promise<RenderedImage> {
  const rendered = await sharp(bytes, { animated: false })
    .rotate()
    .resize({
      width: MAX_VISUAL_EDGE,
      height: MAX_VISUAL_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    png: rendered.data,
    width: rendered.info.width,
    height: rendered.info.height,
  };
}

function attachImage(
  realName: string,
  rendered: RenderedImage,
  effects: StaticVisualEffects,
): StaticVisualOutcome {
  const { png, width, height } = rendered;
  if (png.length === 0 || width < 1 || height < 1) {
    return fail(`"${realName}" could not be decoded into non-empty pixels.`);
  }
  effects.pendingImages.push(png.toString("base64"));
  return { ok: true, text: receipt(realName, png, width, height) };
}

async function viewImageFile(
  room: SketchRoom,
  fileId: string,
  realName: string,
  effects: StaticVisualEffects,
): Promise<StaticVisualOutcome> {
  try {
    const file = await readRoomFile(room, fileId);
    const bytes = imageBytes(file, realName);
    if (!Buffer.isBuffer(bytes)) return bytes;
    return attachImage(realName, await renderImage(bytes), effects);
  } catch (error) {
    return fail(
      `"${realName}" could not be decoded as an image: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Attach verified pixels for an image or sketch in the room.
 *
 * Sketches deliberately go through `execReadDrawing*`, whose image is made by
 * `sketchRaster.toPng`; the File and Drawing agents therefore see the same
 * raster and there is no second sketch renderer to drift. Ordinary images are
 * decoded, orientation-normalized, bounded, and transcoded to PNG here. A
 * textual receipt is never success by itself: the caller gets an error unless
 * a non-empty PNG was appended to `pendingImages`.
 */
export async function execViewFileImage(
  room: SketchRoom,
  args: Record<string, unknown>,
  effects: StaticVisualEffects,
): Promise<StaticVisualOutcome> {
  const privacy = maySendPixels(room, effects);
  if (privacy !== null) return privacy;

  const requested = requestedVisualName(args);
  if (requested === "") return fail("name is required");

  let file: ResolvedVisualFile;
  try {
    file = findVisualFile(room, requested);
  } catch (error) {
    return fail(error);
  }

  if (isSketchFile(file.realName))
    return viewSketchFile(room, file.realName, effects);
  return viewImageFile(room, file.fileId, file.realName, effects);
}
