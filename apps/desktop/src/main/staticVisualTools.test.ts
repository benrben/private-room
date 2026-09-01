import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createRoom } from "./db-host/open.js";
import { insertFile, trashFile } from "./db-host/files.js";
import { setSetting } from "./db-host/settings.js";
import { clearPolicy, setPolicyRulesForTests } from "./privacy.js";
import { applyScript, defaultSketch, sketchToJson } from "./sketchDoc.js";

vi.mock("sharp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sharp")>();
  return { default: vi.fn(actual.default) };
});

vi.mock("./sketchCommands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sketchCommands.js")>();
  return {
    ...actual,
    execReadDrawing: vi.fn(actual.execReadDrawing),
    execReadDrawingInRoom: vi.fn(actual.execReadDrawingInRoom),
  };
});

import { execReadDrawing, execReadDrawingInRoom } from "./sketchCommands.js";
import {
  execViewFileImage,
  type StaticVisualEffects,
} from "./staticVisualTools.js";

let temp = "";

afterEach(() => {
  vi.mocked(sharp).mockClear();
  vi.mocked(execReadDrawing).mockClear();
  vi.mocked(execReadDrawingInRoom).mockClear();
  clearPolicy();
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function room() {
  temp = mkdtempSync(path.join(os.tmpdir(), "static-visual-"));
  const roomPath = path.join(temp, "visual.roomai");
  return {
    db: createRoom(roomPath, "correct horse battery staple", "Visual"),
    path: roomPath,
  };
}

function effects(pendingImages: string[] = []): StaticVisualEffects {
  return { pendingImages, visionChat: true };
}

async function onePixel(red: number, blue: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: red, g: 0, b: blue, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("view_file_image", () => {
  it("normalizes one composer @ only after preserving a literal @-named file", async () => {
    const open = room();
    insertFile(
      open.db,
      "arc-file-pixels.png",
      "image/png",
      await onePixel(255, 0),
      null,
      "upload",
    );

    const fallback = effects();
    const first = await execViewFileImage(
      open,
      { name: "@arc-file-pixels.png" },
      fallback,
    );
    expect(first.ok && first.text).toMatch(
      /^Image receipt: "arc-file-pixels\.png"; SHA-256 [0-9a-f]{64}; 1×1 PNG\.$/,
    );
    expect(fallback.pendingImages).toHaveLength(1);

    insertFile(
      open.db,
      "@arc-file-pixels.png",
      "image/png",
      await onePixel(0, 255),
      null,
      "upload",
    );
    const literal = effects();
    const second = await execViewFileImage(
      open,
      { name: "@arc-file-pixels.png" },
      literal,
    );
    expect(second.ok && second.text).toContain(
      'Image receipt: "@arc-file-pixels.png";',
    );
    expect(literal.pendingImages).toHaveLength(1);
    expect(literal.pendingImages[0]).not.toBe(fallback.pendingImages[0]);
    open.db.close();
  });

  it("fails closed and leaves pending images untouched for corrupt pixels", async () => {
    const open = room();
    insertFile(
      open.db,
      "broken.png",
      "image/png",
      Buffer.from("not pixels"),
      null,
      "upload",
    );
    const fx = effects(["earlier-image"]);
    const outcome = await execViewFileImage(open, { name: "broken.png" }, fx);
    expect(outcome.ok).toBe(false);
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("will not resolve a trashed image held by an old id", async () => {
    const open = room();
    const image = insertFile(
      open.db,
      "gone.png",
      "image/png",
      await onePixel(255, 0),
      null,
      "upload",
    );
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
    const applied = applyScript(
      sketch,
      'rect 100 100 300 150 blue "Login form"',
    );
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
    expect(outcome.ok && outcome.text).toContain(
      'rect 100 100 300 150 blue "Login form"',
    );
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
    expect(!outcome.ok && outcome.error).toContain(
      "text report but no image pixels",
    );
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("refuses unavailable vision and cloud-pixel paths before looking up a file", async () => {
    const open = room();

    const noVision = effects();
    noVision.visionChat = false;
    const unavailable = await execViewFileImage(
      open,
      { name: "missing.png" },
      noVision,
    );
    expect(unavailable).toEqual({
      ok: false,
      error:
        "The selected model has no usable image-input channel, so no visual interpretation was performed.",
    });

    setSetting(open.db, "model", "openrouter::vendor/vision-agent");
    setPolicyRulesForTests(true, [["private", "[private]"]]);
    const cloud = await execViewFileImage(
      open,
      { name: "missing.png" },
      effects(),
    );
    expect(cloud).toEqual({
      ok: false,
      error:
        "Cloud Privacy is keeping this room's image pixels on this Mac. Switch to On this Mac or use the one-turn privacy bypass to inspect it.",
    });
    open.db.close();
  });

  it("requires a string name and keeps the first lookup error after an @ fallback fails", async () => {
    const open = room();

    await expect(
      execViewFileImage(open, { name: 17 }, effects()),
    ).resolves.toEqual({
      ok: false,
      error: "name is required",
    });

    const missing = await execViewFileImage(
      open,
      { name: "@missing.png" },
      effects(),
    );
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toContain(
      'No file matching "@missing.png"',
    );
    open.db.close();
  });

  it("rejects non-images and images without bytes without changing queued pixels", async () => {
    const open = room();
    insertFile(
      open.db,
      "notes.txt",
      "text/plain",
      Buffer.from("not an image"),
      null,
      "upload",
    );
    const empty = insertFile(
      open.db,
      "empty.png",
      "image/png",
      Buffer.from("pixels"),
      null,
      "upload",
    );
    open.db
      .prepare("UPDATE files SET original_bytes = NULL WHERE id = ?")
      .run(empty.id);
    const fx = effects(["earlier-image"]);

    await expect(
      execViewFileImage(open, { name: "notes.txt" }, fx),
    ).resolves.toEqual({
      ok: false,
      error: '"notes.txt" is not a supported image or sketch.',
    });
    await expect(
      execViewFileImage(open, { name: "empty.png" }, fx),
    ).resolves.toEqual({
      ok: false,
      error: '"empty.png" has no image bytes.',
    });
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("uses the workspace sketch reader and verifies the image it appends", async () => {
    const open = room();
    insertFile(
      open.db,
      "Workspace.sketch",
      "application/json",
      Buffer.from("{}"),
      null,
      "upload",
    );
    const png = await onePixel(20, 40);
    vi.mocked(execReadDrawingInRoom).mockImplementationOnce(
      async (_room, _args, fx) => {
        fx.pendingImages.push(png.toString("base64"));
        return { ok: true, text: "workspace raster" };
      },
    );
    const workspaceRoom = { ...open, workspace: {} } as Parameters<
      typeof execViewFileImage
    >[0];
    const fx = effects();

    const outcome = await execViewFileImage(
      workspaceRoom,
      { name: "Workspace.sketch" },
      fx,
    );
    expect(outcome.ok && outcome.text).toContain("workspace raster");
    expect(vi.mocked(execReadDrawingInRoom)).toHaveBeenCalledOnce();
    expect(fx.pendingImages).toHaveLength(1);
    open.db.close();
  });

  it("removes a sketch's new pixels when its reader fails, emits none, or emits invalid pixels", async () => {
    const open = room();
    insertFile(
      open.db,
      "Broken.sketch",
      "application/json",
      Buffer.from("{}"),
      null,
      "upload",
    );

    const reader = vi.mocked(execReadDrawing);
    reader.mockImplementationOnce(async (_db, _args, fx) => {
      fx.pendingImages.push("new-image");
      return { ok: false, error: "drawing failed" };
    });
    const readerFailure = effects(["earlier-image"]);
    await expect(
      execViewFileImage(open, { name: "Broken.sketch" }, readerFailure),
    ).resolves.toEqual({
      ok: false,
      error: "drawing failed",
    });
    expect(readerFailure.pendingImages).toEqual(["earlier-image"]);

    reader.mockImplementationOnce(async () => ({
      ok: true,
      text: "text only",
    }));
    const noPixels = effects(["earlier-image"]);
    await expect(
      execViewFileImage(open, { name: "Broken.sketch" }, noPixels),
    ).resolves.toEqual({
      ok: false,
      error:
        "The sketch produced a text report but no image pixels. No visual interpretation was performed.",
    });
    expect(noPixels.pendingImages).toEqual(["earlier-image"]);

    reader.mockImplementationOnce(async (_db, _args, fx) => {
      fx.pendingImages.push(Buffer.from("not a PNG").toString("base64"));
      return { ok: true, text: "bad raster" };
    });
    const invalidPixels = effects(["earlier-image"]);
    const invalid = await execViewFileImage(
      open,
      { name: "Broken.sketch" },
      invalidPixels,
    );
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error).toContain(
      "The sketch raster could not be verified:",
    );
    expect(invalidPixels.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("distinguishes an empty sketch raster from a sketch which emitted no image", async () => {
    const open = room();
    insertFile(
      open.db,
      "Empty.sketch",
      "application/json",
      Buffer.from("{}"),
      null,
      "upload",
    );
    vi.mocked(execReadDrawing).mockImplementationOnce(
      async (_db, _args, fx) => {
        fx.pendingImages.push(" ");
        return { ok: true, text: "empty raster" };
      },
    );
    const fx = effects(["earlier-image"]);

    await expect(
      execViewFileImage(open, { name: "Empty.sketch" }, fx),
    ).resolves.toEqual({
      ok: false,
      error:
        "The sketch produced an empty image. No visual interpretation was performed.",
    });
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("rejects a sketch raster with incomplete or non-Error metadata failures", async () => {
    const open = room();
    insertFile(
      open.db,
      "Metadata.sketch",
      "application/json",
      Buffer.from("{}"),
      null,
      "upload",
    );
    const png = await onePixel(8, 9);
    const reader = vi.mocked(execReadDrawing);

    reader.mockImplementationOnce(async (_db, _args, fx) => {
      fx.pendingImages.push(png.toString("base64"));
      return { ok: true, text: "missing dimensions" };
    });
    vi.mocked(sharp).mockImplementationOnce(
      () => ({ metadata: async () => ({ format: "png" }) }) as never,
    );
    const missingDimensions = effects(["earlier-image"]);
    await expect(
      execViewFileImage(open, { name: "Metadata.sketch" }, missingDimensions),
    ).resolves.toEqual({
      ok: false,
      error: "The sketch raster could not be verified: invalid PNG dimensions",
    });
    expect(missingDimensions.pendingImages).toEqual(["earlier-image"]);

    reader.mockImplementationOnce(async (_db, _args, fx) => {
      fx.pendingImages.push(png.toString("base64"));
      return { ok: true, text: "string failure" };
    });
    vi.mocked(sharp).mockImplementationOnce(
      () =>
        ({
          metadata: async () => Promise.reject("metadata unavailable"),
        }) as never,
    );
    const stringFailure = effects(["earlier-image"]);
    await expect(
      execViewFileImage(open, { name: "Metadata.sketch" }, stringFailure),
    ).resolves.toEqual({
      ok: false,
      error: "The sketch raster could not be verified: metadata unavailable",
    });
    expect(stringFailure.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("fails closed when image decoding produces no renderable pixels", async () => {
    const open = room();
    insertFile(
      open.db,
      "empty-render.png",
      "image/png",
      await onePixel(1, 2),
      null,
      "upload",
    );
    const pipeline = {
      rotate: () => pipeline,
      resize: () => pipeline,
      png: () => pipeline,
      toBuffer: async () => ({
        data: Buffer.alloc(0),
        info: { width: 0, height: 0 },
      }),
    };
    vi.mocked(sharp).mockImplementationOnce(() => pipeline as never);
    const fx = effects(["earlier-image"]);

    await expect(
      execViewFileImage(open, { name: "empty-render.png" }, fx),
    ).resolves.toEqual({
      ok: false,
      error: '"empty-render.png" could not be decoded into non-empty pixels.',
    });
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });

  it("reports a non-Error image decoder failure without queuing pixels", async () => {
    const open = room();
    insertFile(
      open.db,
      "decoder-failure.png",
      "image/png",
      await onePixel(2, 3),
      null,
      "upload",
    );
    const pipeline = {
      rotate: () => pipeline,
      resize: () => pipeline,
      png: () => pipeline,
      toBuffer: async () => Promise.reject("decoder unavailable"),
    };
    vi.mocked(sharp).mockImplementationOnce(() => pipeline as never);
    const fx = effects(["earlier-image"]);

    await expect(
      execViewFileImage(open, { name: "decoder-failure.png" }, fx),
    ).resolves.toEqual({
      ok: false,
      error:
        '"decoder-failure.png" could not be decoded as an image: decoder unavailable',
    });
    expect(fx.pendingImages).toEqual(["earlier-image"]);
    open.db.close();
  });
});
