import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createRoom } from "./db-host/open.js";
import { insertFile, trashFile } from "./db-host/files.js";
import { clearPolicy } from "./privacy.js";
import { applyScript, defaultSketch, sketchToJson } from "./sketchDoc.js";
import { execViewFileImage, type StaticVisualEffects } from "./staticVisualTools.js";

let temp = "";

afterEach(() => {
  clearPolicy();
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function room() {
  temp = mkdtempSync(path.join(os.tmpdir(), "static-visual-"));
  const roomPath = path.join(temp, "visual.roomai");
  return { db: createRoom(roomPath, "correct horse battery staple", "Visual"), path: roomPath };
}

function effects(pendingImages: string[] = []): StaticVisualEffects {
  return { pendingImages, visionChat: true };
}

async function onePixel(red: number, blue: number): Promise<Buffer> {
  return sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: red, g: 0, b: blue, alpha: 1 } },
  }).png().toBuffer();
}

describe("view_file_image", () => {
  it("normalizes one composer @ only after preserving a literal @-named file", async () => {
    const open = room();
    insertFile(open.db, "arc-file-pixels.png", "image/png", await onePixel(255, 0), null, "upload");

    const fallback = effects();
    const first = await execViewFileImage(open, { name: "@arc-file-pixels.png" }, fallback);
    expect(first.ok && first.text).toMatch(/^Image receipt: "arc-file-pixels\.png"; SHA-256 [0-9a-f]{64}; 1×1 PNG\.$/);
    expect(fallback.pendingImages).toHaveLength(1);

    insertFile(open.db, "@arc-file-pixels.png", "image/png", await onePixel(0, 255), null, "upload");
    const literal = effects();
    const second = await execViewFileImage(open, { name: "@arc-file-pixels.png" }, literal);
    expect(second.ok && second.text).toContain('Image receipt: "@arc-file-pixels.png";');
    expect(literal.pendingImages).toHaveLength(1);
    expect(literal.pendingImages[0]).not.toBe(fallback.pendingImages[0]);
    open.db.close();
  });

  it("fails closed and leaves pending images untouched for corrupt pixels", async () => {
    const open = room();
    insertFile(open.db, "broken.png", "image/png", Buffer.from("not pixels"), null, "upload");
    const fx = effects(["earlier-image"]);
    const outcome = await execViewFileImage(open, { name: "broken.png" }, fx);
    expect(outcome.ok).toBe(false);
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("will not resolve a trashed image held by an old id", async () => {
    const open = room();
    const image = insertFile(open.db, "gone.png", "image/png", await onePixel(255, 0), null, "upload");
    trashFile(open.db, image.id, { kind: "user" });
    const fx = effects();
    const outcome = await execViewFileImage(open, { name: "gone.png" }, fx);
    expect(outcome.ok).toBe(false);
    expect(fx.pendingImages).toEqual([]);
    open.db.close();
  });

  it("routes .sketch through the existing raster and emits one hash-pinned PNG", async () => {
    const open = room();
    const sketch = defaultSketch();
    const applied = applyScript(sketch, 'rect 100 100 300 150 blue "Login form"');
    if (!applied.ok) throw new Error(applied.error);
    insertFile(
      open.db,
      "Flow.sketch",
      "application/json",
      Buffer.from(sketchToJson(sketch), "utf8"),
      "Login form",
      "upload",
    );
    const fx = effects();
    const outcome = await execViewFileImage(open, { name: "Flow.sketch" }, fx);

    expect(outcome.ok).toBe(true);
    expect(fx.pendingImages).toHaveLength(1);
    const png = Buffer.from(fx.pendingImages[0]!, "base64");
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    const sha = createHash("sha256").update(png).digest("hex");
    expect(outcome.ok && outcome.text).toContain(
      `Image receipt: "Flow.sketch"; SHA-256 ${sha}; 1024×640 PNG.`,
    );
    expect(outcome.ok && outcome.text).toContain('rect 100 100 300 150 blue "Login form"');
    open.db.close();
  });

  it("fails closed when an empty sketch has a text report but no pixels", async () => {
    const open = room();
    insertFile(
      open.db,
      "Blank.sketch",
      "application/json",
      Buffer.from(sketchToJson(defaultSketch()), "utf8"),
      null,
      "upload",
    );
    const fx = effects(["earlier-image"]);
    const outcome = await execViewFileImage(open, { name: "Blank.sketch" }, fx);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain("text report but no image pixels");
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });
});
