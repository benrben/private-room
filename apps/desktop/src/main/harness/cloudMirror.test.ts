import { lstat, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Redactor, type PrivacyRule } from "../privacyRedact.js";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { CloudRedactedMirror } from "./cloudMirror.js";

const roots: string[] = [];
const PASSWORD = "correct horse battery staple";
const RULES: PrivacyRule[] = [["Ben Reich", "[Person A]"]];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(runId: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-cloud-mirror-"));
  roots.push(root);
  const roomPath = path.join(root, "Room");
  const runtimeRoot = path.join(root, "Runtime");
  const source = path.join(root, "source.txt");
  await writeFile(source, "Ben Reich signed the contract", "utf8");
  const created = createWorkspaceRoom(roomPath, PASSWORD, "Room");
  const workspace = new WorkspaceService(created.db, roomPath);
  const text = await workspace.importFile(source, "notes.txt");
  await workspace.createFile("photo.png", Readable.from([Buffer.from([1, 2, 3, 4])]), "import");
  await workspace.createFile(
    "vector.svg",
    Readable.from([Buffer.from('<svg><text>Ben Reich</text></svg>')]),
    "import",
  );
  const pdf = await workspace.createFile("contract.pdf", Readable.from([Buffer.from("fake pdf")]), "import");
  created.db.prepare("UPDATE files SET extracted_text = ? WHERE id = ?")
    .run("Ben Reich appears in this extracted contract", pdf.fileId);
  const mirror = new CloudRedactedMirror(
    workspace,
    runtimeRoot,
    created.descriptor.roomId,
    runId,
    { redactor: new Redactor(RULES), rules: RULES },
  );
  return { root, roomPath, runtimeRoot, created, workspace, text, mirror };
}

describe("cloud redacted workspace mirror", () => {
  it("exposes redacted text and companions but never original binary bytes", async () => {
    const f = await fixture("run-one");
    try {
      await f.workspace.createFile(
        "page.html",
        Readable.from([Buffer.from('<p>Ben Reich</p><img src="data:image/png;base64,AQIDBA==">')]),
        "import",
      );
      const info = await f.mirror.create();
      expect(info).toMatchObject({ editableFiles: 2, companionFiles: 3, imagesBlocked: 2 });
      expect((await lstat(info.workspacePath)).mode & 0o777).toBe(0o700);
      expect(await readFile(path.join(info.workspacePath, "notes.txt"), "utf8"))
        .toBe("[Person A] signed the contract");
      await expect(readFile(path.join(info.workspacePath, "photo.png"))).rejects.toThrow();
      await expect(readFile(path.join(info.workspacePath, "vector.svg"))).rejects.toThrow();
      const imageStub = await readFile(
        path.join(info.workspacePath, "_Arcelle Companions", "photo.png.txt"),
        "utf8",
      );
      expect(imageStub).toContain("No pixel data");
      expect(imageStub).not.toContain(String.fromCharCode(1, 2, 3, 4));
      expect(await readFile(
        path.join(info.workspacePath, "_Arcelle Companions", "contract.pdf.txt"),
        "utf8",
      )).toContain("[Person A]");
      const html = await readFile(path.join(info.workspacePath, "page.html"), "utf8");
      expect(html).toContain("[Person A]");
      expect(html).not.toContain("AQIDBA==");
      await expect(lstat(path.join(info.workspacePath, ".arcelle"))).rejects.toThrow();
    } finally {
      await f.mirror.cleanup();
      f.created.db.close();
    }
  });

  it("restores known placeholders locally and rejects damaged placeholders before writing", async () => {
    const f = await fixture("run-two");
    try {
      await f.mirror.create();
      const mirrorFile = path.join(f.mirror.workspacePath, "notes.txt");
      await writeFile(mirrorFile, "The signer is [Person AX]", "utf8");
      await expect(f.mirror.writeBack()).rejects.toThrow(/unknown or damaged/i);
      expect(await readFile(path.join(f.roomPath, "notes.txt"), "utf8"))
        .toBe("Ben Reich signed the contract");

      await writeFile(mirrorFile, "The signer is [Person A]", "utf8");
      const result = await f.mirror.writeBack();
      expect(result).toEqual({ updated: ["notes.txt"], created: [], requiresReview: [] });
      expect(await readFile(path.join(f.roomPath, "notes.txt"), "utf8"))
        .toBe("The signer is Ben Reich");
    } finally {
      await f.mirror.cleanup();
      f.created.db.close();
    }
  });

  it("requires review for protected-value duplication and supports safe new text files", async () => {
    const f = await fixture("run-three");
    try {
      await f.mirror.create();
      await writeFile(
        path.join(f.mirror.workspacePath, "notes.txt"),
        "[Person A] and [Person A] signed",
        "utf8",
      );
      await writeFile(path.join(f.mirror.workspacePath, "summary.md"), "About [Person A]", "utf8");
      expect(await f.mirror.writeBack()).toEqual({
        updated: [],
        created: [],
        requiresReview: ["[Person A]"],
      });
      const applied = await f.mirror.writeBack(true);
      expect(applied.updated).toEqual(["notes.txt"]);
      expect(applied.created).toEqual(["summary.md"]);
      expect(await readFile(path.join(f.roomPath, "summary.md"), "utf8")).toBe("About Ben Reich");
    } finally {
      await f.mirror.cleanup();
      f.created.db.close();
    }
  });

  it("applies a mirror move and edit with the stable real file id", async () => {
    const f = await fixture("run-move");
    try {
      await f.mirror.create();
      await mkdir(path.join(f.mirror.workspacePath, "Archive"));
      const destination = path.join(f.mirror.workspacePath, "Archive", "archived notes.txt");
      await rename(path.join(f.mirror.workspacePath, "notes.txt"), destination);
      await writeFile(destination, "Archived for [Person A]", "utf8");

      expect(await f.mirror.writeBack()).toEqual({
        updated: ["Archive/archived notes.txt"],
        created: [],
        requiresReview: [],
      });
      await expect(lstat(path.join(f.roomPath, "notes.txt"))).rejects.toThrow();
      expect(await readFile(path.join(f.roomPath, "Archive", "archived notes.txt"), "utf8"))
        .toBe("Archived for Ben Reich");
      expect(f.created.db.prepare("SELECT relative_path FROM files WHERE id = ?").get(f.text.fileId))
        .toEqual({ relative_path: "Archive/archived notes.txt" });
    } finally {
      await f.mirror.cleanup();
      f.created.db.close();
    }
  });

  it("turns a deleted mirror text file into recoverable Arcelle Trash", async () => {
    const f = await fixture("run-delete");
    try {
      await f.mirror.create();
      await rm(path.join(f.mirror.workspacePath, "notes.txt"));

      expect(await f.mirror.writeBack()).toEqual({ updated: [], created: [], requiresReview: [] });
      await expect(lstat(path.join(f.roomPath, "notes.txt"))).rejects.toThrow();
      const row = f.created.db.prepare(
        "SELECT relative_path, trashed_at FROM files WHERE id = ?",
      ).get(f.text.fileId) as { relative_path: string; trashed_at: string | null };
      expect(row.relative_path).toBe("notes.txt");
      expect(row.trashed_at).not.toBeNull();
      expect(f.created.db.prepare(
        "SELECT 1 FROM content_object_refs WHERE owner_type = 'trash' AND owner_id = ? AND role = 'content'",
      ).get(f.text.fileId)).toBeDefined();
    } finally {
      await f.mirror.cleanup();
      f.created.db.close();
    }
  });

  it("removes abandoned run mirrors during startup cleanup", async () => {
    const f = await fixture("old-run");
    try {
      await f.mirror.create();
      const old = new Date(Date.now() - 60_000);
      await utimes(f.mirror.runRoot, old, old);
      expect(await CloudRedactedMirror.cleanupAbandoned(f.runtimeRoot, 1)).toBe(1);
      await expect(lstat(f.mirror.runRoot)).rejects.toThrow();
    } finally {
      f.created.db.close();
    }
  });
});
