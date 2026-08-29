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

const MAX_VISUAL_EDGE = 1280;

function fail(error: unknown): StaticVisualOutcome {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function receipt(name: string, png: Buffer, width: number, height: number): string {
  const sha256 = createHash("sha256").update(png).digest("hex");
  return `Image receipt: "${name}"; SHA-256 ${sha256}; ${width}×${height} PNG.`;
}

function maySendPixels(room: SketchRoom, effects: StaticVisualEffects): StaticVisualOutcome | null {
  if (!effects.visionChat) {
    return fail("The selected model has no usable image-input channel, so no visual interpretation was performed.");
  }
  const model = modelSetting(room.db);
  if (model !== null && !runsOnThisMac(model) && activePolicy() !== null) {
    return fail(
      "Cloud Privacy is keeping this room's image pixels on this Mac. Switch to On this Mac or use the one-turn privacy bypass to inspect it.",
    );
  }
  return null;
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

  const requested = typeof args.name === "string" ? args.name.trim() : "";
  if (requested === "") return fail("name is required");

  let fileId: string;
  let realName: string;
  try {
    // Composer mentions arrive as `@name.ext`. A real file whose literal name
    // starts with `@` wins; only retry without one leading sigil when that
    // exact/substring resolution fails, matching media-file mentions.
    try {
      [fileId, realName] = findFileLikeQualified(room.db, requested);
    } catch (first) {
      if (!requested.startsWith("@") || requested.length === 1) throw first;
      try {
        [fileId, realName] = findFileLikeQualified(room.db, requested.slice(1));
      } catch {
        throw first;
      }
    }
  } catch (error) {
    return fail(error);
  }

  if (realName.toLowerCase().endsWith(".sketch")) {
    const before = effects.pendingImages.length;
    const outcome = room.workspace === undefined
      ? await execReadDrawing(room.db, { name: realName }, effects)
      : await execReadDrawingInRoom(room, { name: realName }, effects);
    if (!outcome.ok) {
      effects.pendingImages.splice(before);
      return outcome;
    }
    const image = effects.pendingImages[before];
    if (typeof image !== "string" || image === "") {
      effects.pendingImages.splice(before);
      return fail("The sketch produced a text report but no image pixels. No visual interpretation was performed.");
    }
    const png = Buffer.from(image, "base64");
    if (png.length === 0) {
      effects.pendingImages.splice(before);
      return fail("The sketch produced an empty image. No visual interpretation was performed.");
    }
    try {
      const meta = await sharp(png).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (meta.format !== "png" || width < 1 || height < 1) throw new Error("invalid PNG dimensions");
      return { ok: true, text: `${outcome.text}\n${receipt(realName, png, width, height)}` };
    } catch (error) {
      effects.pendingImages.splice(before);
      return fail(`The sketch raster could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const file = await readRoomFile(room, fileId);
    if (!file.mimeType?.toLowerCase().startsWith("image/")) {
      return fail(`"${realName}" is not a supported image or sketch.`);
    }
    if (file.bytes === null || file.bytes.length === 0) {
      return fail(`"${realName}" has no image bytes.`);
    }
    const rendered = await sharp(file.bytes, { animated: false })
      .rotate()
      .resize({
        width: MAX_VISUAL_EDGE,
        height: MAX_VISUAL_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    const png = rendered.data;
    const width = rendered.info.width;
    const height = rendered.info.height;
    if (png.length === 0 || width < 1 || height < 1) {
      return fail(`"${realName}" could not be decoded into non-empty pixels.`);
    }
    effects.pendingImages.push(png.toString("base64"));
    return { ok: true, text: receipt(realName, png, width, height) };
  } catch (error) {
    return fail(`"${realName}" could not be decoded as an image: ${error instanceof Error ? error.message : String(error)}`);
  }
}
