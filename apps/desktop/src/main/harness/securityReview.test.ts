import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Redactor, type PrivacyRule } from "../privacyRedact.js";
import { assertNoSymlinkSegments, normalizeRelativePath } from "../workspace/pathSafety.js";
import { createWorkspaceRoom } from "../workspace/roomLayout.js";
import { WorkspaceService } from "../workspace/workspaceService.js";
import { CloudRedactedMirror } from "./cloudMirror.js";

const roots: string[] = [];
const PASSWORD = "security review fixture password";
const SECRET = "Ben Reich";
const RULES: PrivacyRule[] = [[SECRET, "[Person A]"]];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function readRegularFiles(root: string): Promise<Array<{ relativePath: string; bytes: Buffer }>> {
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        files.push({ relativePath: path.relative(root, absolutePath), bytes: await readFile(absolutePath) });
      }
    }
  };
  await visit(root);
  return files;
}

describe("workspace harness security review", () => {
  it.each([
    "../secret.txt",
    "safe/../../secret.txt",
    "safe\\..\\secret.txt",
    "/tmp/secret.txt",
    "C:\\Windows\\secret.txt",
    "\\\\server\\share\\secret.txt",
    ".arcelle/room.db",
    ".ArCeLlE/room.db",
    ".ARCELLE",
    "safe\0name.txt",
  ])("rejects adversarial path %j", (candidate) => {
    expect(() => normalizeRelativePath(candidate)).toThrow();
  });

  it("rejects a symlink used as the final managed path segment", async () => {
    const root = await temporaryRoot("arcelle-security-path-");
    const workspace = path.join(root, "Room");
    const outside = path.join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(workspace, "escape.txt"));

    await expect(assertNoSymlinkSegments(workspace, "escape.txt", false))
      .rejects.toThrow(/symlink/i);
  });

  it("keeps protected content, inline image bytes, originals, and private state out of the mirror", async () => {
    const root = await temporaryRoot("arcelle-security-mirror-");
    const roomPath = path.join(root, "Room");
    const runtimeRoot = path.join(root, "Runtime");
    const created = createWorkspaceRoom(roomPath, PASSWORD, "Room");
    const workspace = new WorkspaceService(created.db, roomPath);
    const mirror = new CloudRedactedMirror(
      workspace,
      runtimeRoot,
      created.descriptor.roomId,
      "security-run",
      { redactor: new Redactor(RULES), rules: RULES },
    );
    try {
      await workspace.createFile(
        "notes.html",
        Readable.from([Buffer.from(`<p>${SECRET}</p><img src="data:image/png;base64,AQIDBA==">`)]),
        "security-test",
      );
      const document = await workspace.createFile(
        `${SECRET} contract.pdf`,
        Readable.from([Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 1, 2, 3])]),
        "security-test",
      );
      created.db.prepare("UPDATE files SET extracted_text = ? WHERE id = ?")
        .run(`${SECRET} is named in the document`, document.fileId);
      await mirror.create();

      const files = await readRegularFiles(mirror.workspacePath);
      const exposed = Buffer.concat(files.map(({ bytes }) => bytes)).toString("utf8");
      expect(exposed).not.toContain(SECRET);
      expect(files.map(({ relativePath }) => relativePath).join("\n")).not.toContain(SECRET);
      expect(exposed).not.toContain("AQIDBA==");
      expect(files.some(({ relativePath }) => relativePath.toLocaleLowerCase("en-US").includes(".arcelle")))
        .toBe(false);
      await expect(lstat(path.join(mirror.workspacePath, `${SECRET} contract.pdf`))).rejects.toThrow();
    } finally {
      await mirror.cleanup();
      created.db.close();
    }
  });

  it("rejects unsafe mirror locations and identifiers before creating files", async () => {
    const root = await temporaryRoot("arcelle-security-runtime-");
    const roomPath = path.join(root, "Room");
    const created = createWorkspaceRoom(roomPath, PASSWORD, "Room");
    const workspace = new WorkspaceService(created.db, roomPath);
    const policy = { redactor: new Redactor(RULES), rules: RULES };
    try {
      expect(() => new CloudRedactedMirror(
        workspace, path.join(roomPath, "runtime"), created.descriptor.roomId, "run", policy,
      )).toThrow(/outside the room/i);
      expect(() => new CloudRedactedMirror(
        workspace, path.join(root, "Runtime"), "../room", "run", policy,
      )).toThrow(/room id is not safe/i);
      expect(() => new CloudRedactedMirror(
        workspace, path.join(root, "Runtime"), created.descriptor.roomId, "../run", policy,
      )).toThrow(/run id is not safe/i);
    } finally {
      created.db.close();
    }
  });

  it("does not echo the protected value when damaged placeholders are rejected", async () => {
    const root = await temporaryRoot("arcelle-security-placeholder-");
    const roomPath = path.join(root, "Room");
    const created = createWorkspaceRoom(roomPath, PASSWORD, "Room");
    const workspace = new WorkspaceService(created.db, roomPath);
    const mirror = new CloudRedactedMirror(
      workspace,
      path.join(root, "Runtime"),
      created.descriptor.roomId,
      "placeholder-run",
      { redactor: new Redactor(RULES), rules: RULES },
    );
    try {
      await workspace.createFile("notes.txt", Readable.from([Buffer.from(SECRET)]), "security-test");
      await mirror.create();
      await writeFile(path.join(mirror.workspacePath, "notes.txt"), "[Person AX]", "utf8");
      const error = await mirror.writeBack().then(
        () => "write-back unexpectedly succeeded",
        (reason: unknown) => reason instanceof Error ? reason.message : String(reason),
      );
      expect(error).toMatch(/unknown or damaged/i);
      expect(error).not.toContain(SECRET);
    } finally {
      await mirror.cleanup();
      created.db.close();
    }
  });
});
