import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { RunProtection } from "./runProtection.js";
import type { HarnessContext } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RunProtection conflict recovery", () => {
  it("restores a protected baseline as a copy without overwriting a later user edit", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-run-protection-"));
    roots.push(parent);
    const workspaceRoot = path.join(parent, "Room");
    const source = path.join(parent, "source.txt");
    await writeFile(source, "before agent", "utf8");
    const { db, descriptor } = createWorkspaceRoom(
      workspaceRoot,
      "correct horse battery staple",
      "Room",
    );
    const workspace = new WorkspaceService(db, workspaceRoot);
    try {
      const file = await workspace.importFile(source, "notes.txt");
      const protection = new RunProtection(workspace, descriptor.roomId);
      const context: HarnessContext = {
        runId: "run-1",
        roomId: descriptor.roomId,
        provider: "codex",
        model: "test",
        workspacePath: workspaceRoot,
        privacyMode: "local",
        writeEnabled: true,
        exposureVerified: true,
      };
      await protection.createBaseline(context);
      await workspace.writeAtomic(file.fileId, Readable.from(["agent edit"]));
      await protection.finish(context.runId, "completed");

      await writeFile(path.join(workspaceRoot, "notes.txt"), "later user edit", "utf8");
      const rollback = await protection.rollback(context.runId);
      expect(rollback.conflicts).toEqual(["notes.txt"]);
      expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("later user edit");

      const copies = await protection.restoreBaselineAsCopies(context.runId, rollback.conflicts);
      expect(copies).toEqual(["notes (baseline).txt"]);
      expect(await readFile(path.join(workspaceRoot, copies[0]!), "utf8")).toBe("before agent");
      expect(await readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).toBe("later user edit");
      const copyRow = db.prepare(
        "SELECT original_bytes, source, relative_path FROM files WHERE relative_path = ?",
      ).get(copies[0]) as { original_bytes: Buffer | null; source: string; relative_path: string };
      expect(copyRow).toEqual({
        original_bytes: null,
        source: "rollback-copy",
        relative_path: "notes (baseline).txt",
      });
    } finally {
      db.close();
    }
  });
});
