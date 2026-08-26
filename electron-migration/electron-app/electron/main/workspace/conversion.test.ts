import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { insertFile } from "../db-host/files.js";
import { createFolder, moveFileToFolder } from "../db-host/folders.js";
import { setMeta } from "../db-host/meta.js";
import { createRoom, openRoomReadonly } from "../db-host/open.js";
import { sha256File } from "./hash.js";
import { openWorkspaceRoom } from "./roomLayout.js";
import { convertLegacyRoomToWorkspace } from "./conversion.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy workspace conversion", () => {
  it("exports normal files, preserves private state and leaves the source unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Converted Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    const folder = createFolder(legacy, "Research");
    const first = insertFile(
      legacy,
      "notes?.txt",
      "text/plain",
      Buffer.from("first bytes"),
      "first extracted text",
      "upload",
    );
    moveFileToFolder(legacy, first.id, folder.id);
    const second = insertFile(
      legacy,
      "notes*.txt",
      "text/plain",
      Buffer.from("second bytes"),
      "second extracted text",
      "generated",
    );
    moveFileToFolder(legacy, second.id, folder.id);
    setMeta(legacy, "private_test_state", "kept");
    legacy.close();
    const sourceHashBefore = await sha256File(sourcePath);

    const report = await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath);

    expect(report.convertedFiles).toBe(2);
    expect(report.renamed).toHaveLength(2);
    expect(report.skipped).toEqual([]);
    expect(await sha256File(sourcePath)).toBe(sourceHashBefore);
    expect(await readFile(path.join(destinationPath, "Research", "notes_.txt"), "utf8"))
      .toBe("first bytes");
    expect(await readFile(path.join(destinationPath, "Research", "notes_ (2).txt"), "utf8"))
      .toBe("second bytes");

    const workspace = openWorkspaceRoom(destinationPath, password);
    try {
      const rows = workspace.db.prepare(
        `SELECT id, original_bytes, storage_kind, relative_path, extracted_text
         FROM files ORDER BY rowid`,
      ).all() as Array<{
        id: string;
        original_bytes: Buffer | null;
        storage_kind: string;
        relative_path: string;
        extracted_text: string;
      }>;
      expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(rows.every((row) => row.original_bytes === null)).toBe(true);
      expect(rows.every((row) => row.storage_kind === "workspace")).toBe(true);
      expect(rows.map((row) => row.extracted_text)).toEqual([
        "first extracted text",
        "second extracted text",
      ]);
      expect(workspace.db.prepare("SELECT value FROM meta WHERE key = 'private_test_state'").pluck().get())
        .toBe("kept");
    } finally {
      workspace.db.close();
    }

    const source = openRoomReadonly(sourcePath, password);
    try {
      const sourceRows = source.prepare("SELECT id, original_bytes FROM files ORDER BY rowid")
        .all() as Array<{ id: string; original_bytes: Buffer }>;
      expect(sourceRows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(sourceRows.map((row) => row.original_bytes.toString("utf8"))).toEqual([
        "first bytes",
        "second bytes",
      ]);
    } finally {
      source.close();
    }
  });

  it("resumes after a file was exported and committed before interruption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-convert-resume-"));
    roots.push(root);
    const sourcePath = path.join(root, "Legacy.roomai");
    const destinationPath = path.join(root, "Resumed Room");
    const password = "correct horse battery staple";
    const legacy = createRoom(sourcePath, password, "Legacy");
    insertFile(legacy, "one.txt", "text/plain", Buffer.from("one"), "one", "upload");
    insertFile(legacy, "two.txt", "text/plain", Buffer.from("two"), "two", "upload");
    legacy.close();
    const sourceHash = await sha256File(sourcePath);
    let exported = 0;

    await expect(convertLegacyRoomToWorkspace(sourcePath, password, destinationPath, {
      afterFile: () => {
        exported += 1;
        if (exported === 1) throw new Error("simulated interruption");
      },
    })).rejects.toThrow(/simulated interruption/);

    const report = await convertLegacyRoomToWorkspace(sourcePath, password, destinationPath);
    expect(report.resumed).toBe(true);
    expect(report.convertedFiles).toBe(2);
    expect(await readFile(path.join(destinationPath, "one.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(destinationPath, "two.txt"), "utf8")).toBe("two");
    expect(await sha256File(sourcePath)).toBe(sourceHash);
  });
});
