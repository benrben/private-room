import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceRoom, openWorkspaceRoom } from "./roomLayout.js";
import { WorkspaceService } from "./workspaceService.js";

const roots: string[] = [];
const password = "correct horse battery staple";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(label: string) {
  const parent = await mkdtemp(path.join(os.tmpdir(), `arcelle-hardening-${label}-`));
  roots.push(parent);
  const root = path.join(parent, "Room");
  const created = createWorkspaceRoom(root, password, "Room");
  return { parent, root, created, workspace: new WorkspaceService(created.db, root) };
}

describe("workspace hardening acceptance", () => {
  it("handles startup recovery at every filesystem journal phase without touching normal files", async () => {
    const f = await fixture("journal");
    try {
      const file = await f.workspace.createFile("notes.txt", Readable.from(["normal bytes"]), "fixture");
      const phases = ["prepared", "filesystem_committed", "database_committed", "completed", "failed"] as const;
      const insert = f.created.db.prepare(
        `INSERT INTO fs_operations(operation_id, operation_type, phase, file_id, old_path, new_path)
         VALUES (?, 'write', ?, ?, 'notes.txt', 'notes.txt')`,
      );
      const ids = new Map<string, string>();
      for (const phase of phases) {
        const id = randomUUID();
        ids.set(phase, id);
        insert.run(id, phase, file.fileId);
      }

      expect(f.workspace.recoverIncompleteOperations()).toBe(3);
      for (const phase of phases) {
        const row = f.created.db.prepare(
          "SELECT phase, error FROM fs_operations WHERE operation_id = ?",
        ).get(ids.get(phase)) as { phase: string; error: string | null };
        if (["prepared", "filesystem_committed", "database_committed"].includes(phase)) {
          expect(row.phase, phase).toBe("failed");
          expect(row.error, phase).toMatch(/reconciliation required/i);
        } else {
          expect(row.phase, phase).toBe(phase);
        }
      }
      await f.workspace.reconcile();
      expect(await readFile(path.join(f.root, "notes.txt"), "utf8")).toBe("normal bytes");
    } finally {
      f.created.db.close();
    }
  });

  it("leaves normal files readable when the private database is corrupted", async () => {
    const f = await fixture("corruption");
    await f.workspace.createFile("Research/notes.txt", Readable.from(["survives"]), "fixture");
    f.created.db.close();

    await writeFile(path.join(f.root, ".arcelle", "room.db"), "not a database");
    expect(() => openWorkspaceRoom(f.root, password)).toThrow();
    expect(await readFile(path.join(f.root, "Research", "notes.txt"), "utf8")).toBe("survives");
  });

  it("normalizes Unicode, rejects case aliases, supports long names, and never exposes symlinks", async () => {
    const f = await fixture("paths");
    try {
      const decomposed = await f.workspace.createFile(
        "Cafe\u0301.txt",
        Readable.from(["unicode"]),
        "fixture",
      );
      expect(decomposed.relativePath).toBe("Café.txt");
      await expect(f.workspace.createFile("CAFÉ.TXT", Readable.from(["alias"]), "fixture"))
        .rejects.toThrow();

      const longName = `${"long-name-".repeat(18)}.txt`;
      await f.workspace.createFile(longName, Readable.from(["long path"]), "fixture");
      expect(await readFile(path.join(f.root, longName), "utf8")).toBe("long path");

      await expect(f.workspace.createFile(".arcelle/escape.txt", Readable.from(["private"]), "fixture"))
        .rejects.toThrow(/private/i);
      expect((await readdir(f.root)).some((name) => name.endsWith("escape.txt"))).toBe(false);
    } finally {
      f.created.db.close();
    }
  });
});
