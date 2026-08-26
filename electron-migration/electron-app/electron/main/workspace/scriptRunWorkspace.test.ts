import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CancelFlag } from "../cancel.js";
import type { RoomHandle, RoomSource } from "../jobs.js";
import { runScriptProcess, scriptFingerprint } from "../scriptRun.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceService } from "./workspaceService.js";

let temporary: string | null = null;
afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

class OneRoom implements RoomSource {
  constructor(private readonly room: RoomHandle) {}
  current(): RoomHandle { return this.room; }
}

describe("workspace script execution", () => {
  it("materializes normal-file inputs and imports outputs as normal files", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-script-workspace-"));
    const root = path.join(temporary, "Room");
    const created = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const workspace = new WorkspaceService(created.db, root);
    const script = Buffer.from(
      "# room-inputs: input.txt\n# room-outputs: output.txt\nprint('ok')\n",
    );
    const scriptEntry = await workspace.createFile("run.py", Readable.from([script]), "upload");
    await workspace.createFile("input.txt", Readable.from([Buffer.from("input")]), "upload");
    try {
      const report = await runScriptProcess(
        {
          rooms: new OneRoom({ db: created.db, path: root }),
          cacheDir: path.join(temporary, "cache"),
          execute: async (runRoot) => {
            expect(await readFile(path.join(runRoot, "input.txt"), "utf8")).toBe("input");
            await writeFile(path.join(runRoot, "output.txt"), "output");
            return { exitCode: 0, stdoutTail: "ok", stderrTail: "" };
          },
        },
        "job-workspace",
        0,
        root,
        scriptEntry.fileId,
        scriptFingerprint(script),
        null,
        new CancelFlag(),
      );
      expect(report.imported).toHaveLength(1);
      expect(await readFile(path.join(root, "output.txt"), "utf8")).toBe("output");
      expect(created.db.prepare(
        "SELECT original_bytes, storage_kind FROM files WHERE name = 'output.txt'",
      ).get()).toEqual({ original_bytes: null, storage_kind: "workspace" });
    } finally {
      created.db.close();
    }
  });
});
