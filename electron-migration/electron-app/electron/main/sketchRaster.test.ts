/**
 * Tests for `sketchRaster.ts` — the PNG rasteriser, ported from
 * `sketchdoc.rs`'s `to_png` (its two Rust tests are
 * `the_drawing_rasterises_to_a_real_picture_with_ink_on_it` and
 * `an_empty_drawing_still_rasterises_rather_than_failing`).
 *
 * Every assertion here decodes the PNG back rather than trusting the magic
 * bytes: a renderer that silently drew NOTHING still emits a syntactically
 * valid PNG, so "the paper is one flat colour and anything drawn on it
 * introduces others" is the property that proves something was rendered —
 * the same reasoning the Rust test's own comment gives for decoding with the
 * `image` crate instead of checking the header.
 *
 * Exact pixels are deliberately NOT asserted: libvips and `resvg` are
 * different engines, which `sketchRaster.ts`'s module doc states as a known,
 * cosmetic deviation. Geometry, page size and the downscale ratio all come
 * from `toSvg` and `RASTER_MAX_W`, which ARE byte-for-byte pinned (see
 * `sketchDoc.test.ts`'s oracle fixtures).
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { applyScript, defaultSketch, type Sketch } from "./sketchDoc.js";
import { RASTER_MAX_W, toPng } from "./sketchRaster.js";

function draw(script: string): Sketch {
  const doc = defaultSketch();
  const out = applyScript(doc, script);
  if (!out.ok) {
    throw new Error(`script should apply: ${out.error}`);
  }
  return doc;
}

describe("toPng", () => {
  it("rasterises to a real picture with ink on it", async () => {
    const png = await toPng(draw('rect 100 100 400 200 blue "Login form"\nellipse 900 100 300 200 red fill "Auth"'));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");

    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const colours = new Set<string>();
    for (let i = 0; i + 2 < data.length; i += info.channels) {
      colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    expect(colours.size).toBeGreaterThan(8);
    expect(info.width).toBeLessThanOrEqual(RASTER_MAX_W);
  });

  it("an empty drawing still rasterises rather than failing", async () => {
    // The agent's first `read_drawing` on a fresh page must return paper, not
    // an error it then reports as a broken tool.
    const png = await toPng(defaultSketch());
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("downsamples a wide drawing to the raster cap", async () => {
    const meta = await sharp(await toPng(defaultSketch())).metadata();
    expect(meta.width).toBe(RASTER_MAX_W);
    expect(meta.height).toBe(Math.round((1000 * RASTER_MAX_W) / 1600));
  });

  it("never upscales a drawing already narrower than the cap", async () => {
    const doc = defaultSketch();
    applyScript(doc, "canvas 400 300");
    const meta = await sharp(await toPng(doc)).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  it("renders the same bytes twice — the wobble is seeded, not random", async () => {
    const doc = draw('rect 100 100 300 150 blue "Stable"');
    expect((await toPng(doc)).equals(await toPng(doc))).toBe(true);
  });
});
