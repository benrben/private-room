import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createToolEffects, execTool } from "../execTool.js";
import {
  execReadDrawingInRoom,
  exportSketchPngInRoom,
  exportSketchSvgInRoom,
  writeSketchInRoom,
} from "../sketchCommands.js";
import { createWorkspaceRoom } from "./roomLayout.js";
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
});
