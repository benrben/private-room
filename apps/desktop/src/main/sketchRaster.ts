/**
 * Ported from `src-tauri/src/commands/sketchdoc.rs`'s `to_png` (and its
 * `RASTER_MAX_W`/`font_db` neighbours) — rasterising a drawing to a PNG:
 * the picture `read_drawing` attaches for a vision-capable chat model, and
 * the bytes `export_sketch_png` writes as a standalone room file.
 *
 * Kept OUT of `sketchDoc.ts` deliberately. This is the ONE function in the
 * whole `sketchdoc.rs` port with a native dependency, and isolating it keeps
 * the rest of the engine pure, synchronous and dependency-free.
 *
 * IT IS A REAL RASTERISER, NOT A STUB. Rust renders through `resvg`/
 * `tiny_skia`, which have no Node binding in this project; `sharp` — already
 * a committed dependency, used for exactly this job by `visionTools.ts` and
 * `storyTools.ts` — rasterises the very SVG {@link toSvg} builds through
 * libvips, text included.
 *
 * TWO DELIBERATE DEVIATIONS, both stated rather than silently absorbed:
 *
 * 1. ASYNC, not sync. libvips' decode/encode pipeline has no synchronous
 *    entry point, so {@link toPng} returns a `Promise` the Rust call sites
 *    never had to carry — which is why `execReadDrawing`/`exportSketchPng`
 *    are `async` here and are not in Rust.
 * 2. A DIFFERENT ENGINE, not a reimplementation of the same one. librsvg's
 *    antialiasing and font substitution are not `resvg`'s, so a PNG from this
 *    build will not match a Rust build pixel-for-pixel when the hand-drawn
 *    font stack in `sketchDoc.ts`'s `FONT` is absent. Nothing about ELEMENT
 *    POSITION, PAGE SIZE or the downscale ratio differs — those all come from
 *    `toSvg` and the {@link RASTER_MAX_W} cap, both byte-for-byte ported —
 *    and neither test suite asserts on exact pixels (Rust's own test checks
 *    "decodes as a PNG under the width cap, with more than a handful of
 *    distinct colours", which is what this port's test checks too).
 */

import sharp from "sharp";
import { toSvg, type Sketch } from "./sketchDoc.js";

/** Widest raster handed to a model. A drawing is line art on flat paper, so
 * there is nothing above this width for a vision model to resolve — and the
 * image rides in the context window, where every extra pixel is paid for. */
export const RASTER_MAX_W = 1024;

/**
 * Render the drawing to a PNG.
 *
 * This is what makes "look at what you drew and fix it" real rather than a
 * promise: the agent's own output, rasterised the same way the page draws it,
 * with no dependency on the editor being open or even on a window existing.
 *
 * The scale is capped at 1 (`.min(1.0)` in Rust), so a drawing narrower than
 * the cap is rendered at its own size and never blown up.
 */
export async function toPng(doc: Sketch): Promise<Buffer> {
  const svg = toSvg(doc);
  const scale = Math.min(RASTER_MAX_W / Math.max(doc.width, 1), 1.0);
  const w = Math.max(Math.round(doc.width * scale), 1);
  const h = Math.max(Math.round(doc.height * scale), 1);
  try {
    // `fit: "fill"` rather than the default "cover": `w`/`h` are already the
    // source's own aspect ratio scaled by one factor, and letting sharp crop
    // to fit would silently lose an edge of the page on a rounding remainder.
    return await sharp(Buffer.from(svg, "utf8")).resize(w, h, { fit: "fill" }).png().toBuffer();
  } catch (e) {
    throw new Error(`The drawing could not be rendered (${e instanceof Error ? e.message : String(e)}).`);
  }
}
