import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolEffects, execTool } from "../execTool.js";
import {
  createSketch,
  createSketchInRoom,
  execReadDrawingInRoom,
  exportSketchPngInRoom,
  exportSketchSvgInRoom,
  writeSketch,
  writeSketchInRoom,
} from "../sketchCommands.js";
import { applyScript, defaultSketch, sketchToJson } from "../sketchDoc.js";
import { createRoom } from "../db-host/open.js";
import { listPublicFiles } from "../db-host/files.js";
import { convertLegacyRoomToWorkspace } from "./conversion.js";
import { createWorkspaceRoom, openWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceService } from "./workspaceService.js";

let temporary: string | null = null;

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

describe("workspace drawing cutover", () => {
  it("dispatches agent drawing, page save, read and exports through normal files", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-sketch-workspace-"));
    const root = path.join(temporary, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const workspace = new WorkspaceService(db, root);
      const room = { db, path: root, workspace };
    try {
      const manual = await createSketchInRoom(room, "Manual sketch");
      expect(JSON.parse(await readFile(path.join(root, manual.name), "utf8"))).toMatchObject({
        elements: [],
      });
      expect(listPublicFiles(db)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: manual.id, libraryVisibility: "sectionOnly" }),
      ]));

      const outcome = await execTool(
        "draw",
        { name: "Flow", script: 'rect 10 10 100 80 blue "Start"' },
        createToolEffects(),
        { db, routes: [], currentRoom: () => room },
      );
      expect(outcome.ok).toBe(true);

      const row = db.prepare(
        `SELECT id, original_bytes FROM files
         WHERE name = 'Flow.sketch' AND trashed_at IS NULL`,
      ).get() as { id: string; original_bytes: Buffer | null };
      expect(row.original_bytes).toBeNull();
      const json = await readFile(path.join(root, "Flow.sketch"), "utf8");
      expect(json).toContain("Start");

      await writeSketchInRoom(room, row.id, json, false);
      const read = await execReadDrawingInRoom(
        room,
        { name: "Flow" },
        { pendingImages: [], visionChat: false },
      );
      expect(read.ok && read.text).toContain('Drawing "Flow.sketch"');

      const svg = await exportSketchSvgInRoom(room, row.id);
      const png = await exportSketchPngInRoom(room, row.id);
      expect(await readFile(path.join(root, svg.name), "utf8")).toContain("<svg");
      expect((await readFile(path.join(root, png.name))).subarray(1, 4).toString("ascii")).toBe("PNG");
      const currentRows = db.prepare(
        "SELECT original_bytes FROM files WHERE storage_kind = 'workspace'",
      ).all() as Array<{ original_bytes: Buffer | null }>;
      expect(currentRows.every((item) => item.original_bytes === null)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps the page and agent drawing tools live after legacy conversion", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-sketch-converted-"));
    const password = "correct horse battery staple";
    const source = path.join(temporary, "Legacy.roomai");
    const root = path.join(temporary, "Converted Room");
    const legacy = createRoom(source, password, "Legacy");
    const meta = createSketch(legacy, "Converted flow");
    const before = defaultSketch();
    const seeded = applyScript(before, 'rect 20 20 120 70 blue "Before conversion"');
    if (!seeded.ok) throw new Error(seeded.error);
    writeSketch(legacy, meta.id, sketchToJson(before), false);
    legacy.close();

    await convertLegacyRoomToWorkspace(source, password, root);
    const opened = openWorkspaceRoom(root, password);
    const workspace = new WorkspaceService(opened.db, root);
    const room = { db: opened.db, path: root, workspace };
    try {
      expect(listPublicFiles(opened.db)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: meta.id,
          name: "Converted flow.sketch",
          libraryVisibility: "sectionOnly",
        }),
      ]));
      const outcome = await execTool(
        "draw",
        { name: "Converted flow", script: 'text 220 80 red 24 "After conversion"' },
        createToolEffects(),
        { db: opened.db, routes: [], currentRoom: () => room },
      );
      expect(outcome.ok).toBe(true);

      const disk = await readFile(path.join(root, "Converted flow.sketch"), "utf8");
      expect(disk).toContain("Before conversion");
      expect(disk).toContain("After conversion");
      const row = opened.db.prepare(
        "SELECT original_bytes, storage_kind FROM files WHERE id = ?",
      ).get(meta.id) as { original_bytes: Buffer | null; storage_kind: string };
      expect(row).toEqual({ original_bytes: null, storage_kind: "workspace" });

      const read = await execReadDrawingInRoom(
        room,
        { name: "Converted flow" },
        { pendingImages: [], visionChat: false },
      );
      expect(read.ok && read.text).toContain("After conversion");
      const svg = await exportSketchSvgInRoom(room, meta.id);
      expect(await readFile(path.join(root, svg.name), "utf8")).toContain("After conversion");

      // The canvas loaded `disk`, then another app changed the normal file.
      // Its autosave must not adopt a newer database hash and overwrite that
      // external work; it carries the exact document it was based on.
      const external = disk.replace("After conversion", "Changed outside Arcelle");
      await writeFile(path.join(root, "Converted flow.sketch"), external, "utf8");
      const local = disk.replace("After conversion", "Changed on canvas");
      await expect(writeSketchInRoom(room, meta.id, local, false, disk))
        .rejects.toThrow(/changed after it was opened/i);
      expect(await readFile(path.join(root, "Converted flow.sketch"), "utf8"))
        .toBe(external);
    } finally {
      opened.db.close();
    }
  });
});
