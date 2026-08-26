import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRoom } from "./roomLayout.js";
import { createRoomFile, readRoomFile, writeRoomFile } from "./roomContent.js";

let temporary: string | null = null;

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

describe("roomContent hybrid byte access", () => {
  it("creates, reads, versions, and replaces normal workspace files without live blobs", async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-room-content-"));
    const root = path.join(temporary, "Room");
    const created = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    const room = { db: created.db, path: root };
    try {
      const meta = await createRoomFile(
        room,
        "notes.md",
        "text/markdown",
        Buffer.from("first"),
        "first",
        "generated",
      );
      expect((await readRoomFile(room, meta.id)).bytes?.toString("utf8")).toBe("first");

      await writeRoomFile(room, meta.id, Buffer.from("second"), "second", "You edited");
      expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("second");
      expect(created.db.prepare(
        "SELECT original_bytes, extracted_text, storage_kind FROM files WHERE id = ?",
      ).get(meta.id)).toEqual({
        original_bytes: null,
        extracted_text: "second",
        storage_kind: "workspace",
      });
      expect(created.db.prepare(
        `SELECT count(*) AS count FROM file_versions v
         JOIN content_object_refs r ON r.owner_type = 'file_version' AND r.owner_id = v.id
         WHERE v.file_id = ? AND r.role = 'content'`,
      ).get(meta.id)).toEqual({ count: 1 });
    } finally {
      created.db.close();
    }
  });
});
