import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { creativeAttachment, storeCreativeOutput } from "../creativeJobSurfaceIpc.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceService } from "./workspaceService.js";

let temporary: string | null = null;

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

describe("creative workspace byte cutover", () => {
  it("reads references and publishes generated media through normal files", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-creative-workspace-"));
    const root = path.join(temporary, "Room");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const workspace = new WorkspaceService(db, root);
    const referenceBytes = Buffer.from([1, 2, 3]);
    const reference = await workspace.createFile(
      "reference.png",
      Readable.from([referenceBytes]),
      "upload",
    );
    db.prepare("UPDATE files SET mime_type = 'image/png' WHERE id = ?").run(reference.fileId);
    const room = { db, path: root, workspace };
    try {
      await expect(creativeAttachment(room, reference.fileId)).resolves.toEqual({
        b64: referenceBytes.toString("base64"),
        mime: "image/png",
      });

      const outputBytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
      const output = await storeCreativeOutput(
        room,
        "clip.mp4",
        "video/mp4",
        outputBytes,
        "Generated clip",
      );

      expect(await readFile(path.join(root, "clip.mp4"))).toEqual(outputBytes);
      const row = db.prepare(
        "SELECT storage_kind, original_bytes, extracted_text FROM files WHERE id = ?",
      ).get(output.id) as {
        storage_kind: string;
        original_bytes: Buffer | null;
        extracted_text: string;
      };
      expect(row).toEqual({
        storage_kind: "workspace",
        original_bytes: null,
        extracted_text: "Generated clip",
      });
    } finally {
      db.close();
    }
  });
});
