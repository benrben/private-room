import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceIndexService } from "./indexing.js";
import { WorkspaceService } from "./workspaceService.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("WorkspaceIndexService", () => {
  it("replaces stale extracted text and chunks from the current normal file", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-index-"));
    roots.push(parent);
    const root = path.join(parent, "Room");
    const source = path.join(parent, "notes.md");
    await writeFile(source, "fresh normal file", "utf8");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    try {
      const workspace = new WorkspaceService(db, root);
      const file = await workspace.importFile(source, "notes.md");
      db.prepare("UPDATE files SET extracted_text = 'old text' WHERE id = ?").run(file.fileId);
      db.prepare("INSERT INTO chunks(id, file_id, seq, text) VALUES ('old', ?, 0, 'old text')")
        .run(file.fileId);

      const indexer = new WorkspaceIndexService(workspace, async (_name, stream) => {
        const bytes = await collect(stream);
        return { text: bytes.toString("utf8"), sha256: digest(bytes), sizeBytes: bytes.length };
      });
      expect(await indexer.indexPending()).toMatchObject({ ready: 1, staleDiscarded: 0 });
      expect(db.prepare("SELECT extracted_text, index_state FROM files WHERE id = ?").get(file.fileId))
        .toEqual({ extracted_text: "fresh normal file", index_state: "ready" });
      expect(db.prepare("SELECT text FROM chunks WHERE file_id = ?").all(file.fileId))
        .toEqual([{ text: "fresh normal file" }]);
    } finally {
      db.close();
    }
  });

  it("discards extraction when the normal file changes during the run", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-index-race-"));
    roots.push(parent);
    const root = path.join(parent, "Room");
    const source = path.join(parent, "notes.md");
    await writeFile(source, "first bytes", "utf8");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    try {
      const workspace = new WorkspaceService(db, root);
      const file = await workspace.importFile(source, "notes.md");
      const indexer = new WorkspaceIndexService(workspace, async (_name, stream) => {
        const bytes = await collect(stream);
        await writeFile(path.join(root, "notes.md"), "second bytes", "utf8");
        await workspace.reconcile();
        return { text: "must not commit", sha256: digest(bytes), sizeBytes: bytes.length };
      });
      expect(await indexer.indexPending()).toMatchObject({ ready: 0, staleDiscarded: 1 });
      expect(db.prepare("SELECT extracted_text, index_state FROM files WHERE id = ?").get(file.fileId))
        .toEqual({ extracted_text: null, index_state: "stale" });
      expect(db.prepare("SELECT count(*) AS n FROM chunks WHERE file_id = ?").get(file.fileId))
        .toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("records an extraction failure without changing the user file", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-index-failure-"));
    roots.push(parent);
    const root = path.join(parent, "Room");
    const source = path.join(parent, "broken.pdf");
    await writeFile(source, "not really a pdf", "utf8");
    const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
    try {
      const workspace = new WorkspaceService(db, root);
      const file = await workspace.importFile(source, "broken.pdf");
      const indexer = new WorkspaceIndexService(workspace, async () => {
        throw new Error("extractor refused the document");
      });
      expect(await indexer.indexPending()).toMatchObject({ failed: 1 });
      expect(db.prepare("SELECT index_state, index_error FROM files WHERE id = ?").get(file.fileId))
        .toEqual({ index_state: "failed", index_error: "extractor refused the document" });
      expect(await workspace.readBuffer(file.fileId)).toEqual(Buffer.from("not really a pdf"));
    } finally {
      db.close();
    }
  });
});
