import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  addScriptApproval,
  getScriptManifestInRoom,
  listScriptsInRoom,
  setScriptScheduleInRoom,
  stampScriptConsentsInRoom,
} from "../scriptConsent.js";
import { scriptFingerprint } from "../scriptRun.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceService } from "./workspaceService.js";

let temporary: string | null = null;

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

describe("workspace script consent cutover", () => {
  it("hashes, lists, parses, stamps and schedules the normal script file", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-script-consent-"));
    const root = path.join(temporary, "Room");
    const userData = path.join(temporary, "UserData");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const workspace = new WorkspaceService(db, root);
    const bytes = Buffer.from("# room-outputs: report.csv\nprint('ok')\n", "utf8");
    const entry = await workspace.createFile("report.py", Readable.from([bytes]), "upload");
    db.prepare("UPDATE files SET mime_type = 'text/x-python' WHERE id = ?").run(entry.fileId);
    const room = { db, path: root, workspace };
    try {
      const sha = scriptFingerprint(bytes);
      addScriptApproval(userData, sha);
      const scripts = await listScriptsInRoom(room, userData);
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toMatchObject({ fileId: entry.fileId, approved: true });
      expect((await getScriptManifestInRoom(room, entry.fileId)).outputs).toEqual(["report.csv"]);

      const stamped = await stampScriptConsentsInRoom(
        room,
        { nodes: [{ kind: "script_run", file: entry.fileId }] },
        new Set([sha]),
      );
      expect(stamped.get(entry.fileId)).toBe(sha);
      await setScriptScheduleInRoom(room, userData, entry.fileId, "daily", "09:00", true);

      const row = db.prepare("SELECT original_bytes FROM files WHERE id = ?").get(entry.fileId) as {
        original_bytes: Buffer | null;
      };
      expect(row.original_bytes).toBeNull();
    } finally {
      db.close();
    }
  });
});
