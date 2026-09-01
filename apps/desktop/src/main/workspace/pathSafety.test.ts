import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoSymlinkSegments, normalizeRelativePath } from "./pathSafety.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-path-safety-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("normalizeRelativePath", () => {
  it("keeps canonical relative paths while retaining every validation error", () => {
    expect(normalizeRelativePath("notes\\./today.txt")).toBe("notes/today.txt");
    expect(() => normalizeRelativePath("\0")).toThrow(/NUL/i);
    expect(() => normalizeRelativePath("/tmp/secret.txt")).toThrow(/relative/i);
    expect(() => normalizeRelativePath("C:\\temp\\secret.txt")).toThrow(/relative/i);
    expect(() => normalizeRelativePath("./")).toThrow(/empty/i);
    expect(() => normalizeRelativePath("notes/../secret.txt")).toThrow(/leave the room/i);
    expect(() => normalizeRelativePath(".ARCELLE/room.db")).toThrow(/private/i);
  });
});

describe("assertNoSymlinkSegments", () => {
  it("accepts regular existing segments", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes", "today.txt"), "safe", "utf8");

    await expect(assertNoSymlinkSegments(root, "notes/today.txt")).resolves.toBeUndefined();
  });

  it("rejects a symlink before an otherwise missing leaf", async () => {
    const root = await temporaryRoot();
    await symlink(os.tmpdir(), path.join(root, "escape"));

    await expect(assertNoSymlinkSegments(root, "escape/new.txt", true)).rejects.toThrow(/symlink/i);
  });

  it("preserves missing-segment handling for creates and incomplete paths", async () => {
    const root = await temporaryRoot();

    await expect(assertNoSymlinkSegments(root, "missing/nested.txt")).resolves.toBeUndefined();
    await expect(assertNoSymlinkSegments(root, "new.txt", true)).resolves.toBeUndefined();
    await expect(assertNoSymlinkSegments(root, "new.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
