import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { applyWorkspaceWithStaleness, gatedWrite } from "../editGate.js";
import { planSingleEditWorkspace } from "../editMatch.js";
import { createToolEffects } from "../execTool.js";
import {
  execCreateFileWorkspace,
  execMergeFilesWorkspace,
  execMoveFileWorkspace,
  execOrganizeFilesWorkspace,
  execRenameFileWorkspace,
  execTrashFilesWorkspace,
} from "../organizeTools.js";
import { setFileExtractedText } from "../db-host/files.js";
import { createWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceService } from "./workspaceService.js";

let temporary: string | null = null;

afterEach(async () => {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
  temporary = null;
});

async function fixture() {
  temporary = await mkdtemp(path.join(os.tmpdir(), "arcelle-edit-organize-"));
  const root = path.join(temporary, "Room");
  const { db } = createWorkspaceRoom(root, "correct horse battery staple", "Room");
  const workspace = new WorkspaceService(db, root);
  return { root, db, workspace };
}

describe("workspace edit and organize cutover", () => {
  it("applies a gated edit to the normal file with encrypted history", async () => {
    const { root, db, workspace } = await fixture();
    const file = await workspace.createFile("notes.md", Readable.from(["alpha beta"]), "upload");
    setFileExtractedText(db, file.fileId, "alpha beta");
    const effects = createToolEffects();
    try {
      const result = await gatedWrite(
        "edit_file",
        "AI edit",
        {
          rooms: { currentRoom: () => ({ db, path: root, workspace }) },
          editPending: new Map(),
        },
        effects,
        (_db, active) => planSingleEditWorkspace(db, active!, {
          name: "notes.md", oldText: "beta", newText: "gamma", all: false,
        }),
      );
      expect(result.kind).toBe("applied");
      expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("alpha gamma");
      expect(effects.wrote).toBe(true);
      expect((db.prepare("SELECT original_bytes FROM files WHERE id = ?")
        .get(file.fileId) as { original_bytes: Buffer | null }).original_bytes).toBeNull();
      expect((db.prepare(
        `SELECT count(*) AS n FROM content_object_refs
         WHERE owner_type = 'file_version' AND role = 'content'`,
      ).get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });

  it("refuses an expected-hash conflict without overwriting the external edit", async () => {
    const { root, db, workspace } = await fixture();
    const file = await workspace.createFile("notes.md", Readable.from(["before"]), "upload");
    setFileExtractedText(db, file.fileId, "before");
    try {
      const plans = await planSingleEditWorkspace(db, workspace, {
        name: "notes.md", oldText: "before", newText: "agent", all: false,
      });
      await writeFile(path.join(root, "notes.md"), "external", "utf8");
      await expect(applyWorkspaceWithStaleness(db, workspace, plans, "AI edit"))
        .rejects.toThrow(/changed while the approval was pending/i);
      expect(await readFile(path.join(root, "notes.md"), "utf8")).toBe("external");
      expect((db.prepare("SELECT count(*) AS n FROM file_versions").get() as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });

  it("rolls back earlier workspace writes when a later batch operation fails", async () => {
    const { root, db, workspace } = await fixture();
    const a = await workspace.createFile("a.md", Readable.from(["old a"]), "upload");
    const b = await workspace.createFile("b.md", Readable.from(["old b"]), "upload");
    await workspace.createFile("taken.md", Readable.from(["occupied"]), "upload");
    try {
      const edit = await planSingleEditWorkspace(db, workspace, {
        name: "a.md", oldText: "old a", newText: "new a", all: false,
      });
      const bRow = db.prepare("SELECT content_sha256 FROM files WHERE id = ?")
        .get(b.fileId) as { content_sha256: string };
      const rename = {
        fileId: b.fileId,
        realName: "b.md",
        newBytes: null,
        renameTo: "taken.md",
        method: null,
        count: 0,
        staleness: null,
        before: "name: b.md",
        after: "name: taken.md",
        clipped: false,
      } as const;
      expect(bRow.content_sha256).toBeTruthy();
      await expect(applyWorkspaceWithStaleness(db, workspace, [...edit, rename], "AI batch"))
        .rejects.toThrow(/already exists/i);
      expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("old a");
      expect(await readFile(path.join(root, "b.md"), "utf8")).toBe("old b");
      expect((db.prepare("SELECT count(*) AS n FROM file_versions").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT original_bytes FROM files WHERE id = ?")
        .get(a.fileId) as { original_bytes: Buffer | null }).original_bytes).toBeNull();
    } finally { db.close(); }
  });

  it("creates, renames, moves, merges and trashes only normal files", async () => {
    const { root, db, workspace } = await fixture();
    const effects = createToolEffects();
    try {
      expect(await execCreateFileWorkspace(db, workspace, { name: "Plan", content: "first" }, effects))
        .toMatchObject({ ok: true });
      expect(await execRenameFileWorkspace(db, workspace, { name: "Plan.html", new_name: "Roadmap" }, effects))
        .toMatchObject({ ok: true });
      expect(await execMoveFileWorkspace(db, workspace, { name: "Roadmap.html", folder: "Archive" }, effects))
        .toMatchObject({ ok: true });
      expect(await readFile(path.join(root, "Archive/Roadmap.html"), "utf8")).toContain("first");

      const a = await workspace.createFile("a.md", Readable.from(["A"]), "upload");
      const b = await workspace.createFile("b.md", Readable.from(["B"]), "upload");
      setFileExtractedText(db, a.fileId, "A");
      setFileExtractedText(db, b.fileId, "B");
      expect(await execMergeFilesWorkspace(db, workspace, { names: ["a.md", "b.md"], into: "Combined" }, effects))
        .toMatchObject({ ok: true });
      expect(await readFile(path.join(root, "Combined.md"), "utf8")).toContain("## a.md");
      expect(await execTrashFilesWorkspace(db, workspace, { names: ["Combined.md"] }, effects))
        .toMatchObject({ ok: true });
      await expect(readFile(path.join(root, "Combined.md"))).rejects.toThrow();
      const rows = db.prepare("SELECT original_bytes FROM files WHERE storage_kind = 'workspace'")
        .all() as Array<{ original_bytes: Buffer | null }>;
      expect(rows.every((row) => row.original_bytes === null)).toBe(true);
    } finally { db.close(); }
  });

  it("creates and removes empty workspace folders without touching private storage", async () => {
    const { root, db, workspace } = await fixture();
    const effects = createToolEffects();
    try {
      const created = await execOrganizeFilesWorkspace(
        db,
        workspace,
        { make_folders: ["Empty", "Research/Nested"] },
        effects,
      );
      expect(created).toMatchObject({ ok: true });
      expect(created.ok && created.text).toContain('created folder(s) "Empty", "Research/Nested"');
      expect((await workspace.directoryState("Empty")).exists).toBe(true);
      expect((await workspace.directoryState("Research/Nested")).exists).toBe(true);
      expect(effects.wrote).toBe(true);

      const note = await workspace.createFile("Research/Nested/note.md", Readable.from(["keep"]), "fixture");
      const refused = await execOrganizeFilesWorkspace(
        db,
        workspace,
        { remove_folders: ["Research/Nested"] },
        effects,
      );
      expect(refused.ok && refused.text).toMatch(/not empty/i);
      expect(await readFile(path.join(root, "Research/Nested/note.md"), "utf8")).toBe("keep");

      await workspace.trash(note.fileId, note.sha256 ?? undefined);
      const removed = await execOrganizeFilesWorkspace(
        db,
        workspace,
        { remove_folders: ["Empty", "Research/Nested"] },
        effects,
      );
      expect(removed.ok && removed.text).toContain('removed folder(s) "Empty", "Research/Nested"');
      expect(removed.ok && removed.text).not.toContain("files went to the top level");
      expect((await workspace.directoryState("Empty")).exists).toBe(false);
      expect((await workspace.directoryState("Research/Nested")).exists).toBe(false);
      expect((db.prepare("SELECT count(*) AS n FROM files WHERE original_bytes IS NOT NULL").get() as { n: number }).n)
        .toBe(0);
    } finally { db.close(); }
  });

  it("previews empty-folder changes without mutating the workspace", async () => {
    const { root, db, workspace } = await fixture();
    const effects = createToolEffects();
    try {
      const preview = await execOrganizeFilesWorkspace(
        db,
        workspace,
        { make_folders: ["Preview Only"], dry_run: true },
        effects,
      );
      expect(preview.ok && preview.text).toMatch(/PREVIEW ONLY/i);
      expect((await workspace.directoryState("Preview Only")).exists).toBe(false);
      expect(effects.wrote).toBe(false);
      await expect(readFile(path.join(root, "Preview Only"))).rejects.toThrow();
    } finally { db.close(); }
  });
});
