import { randomUUID } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { recoverPassword, writeRecovery } from "../db-host/recovery.js";
import {
  createRoom,
  createRoomManagerState,
  openRoom,
  registerWorkspaceCopy,
  teardownOpenRoom,
  type RoomManagerDeps,
} from "../roomManager.js";
import { changePassword } from "../safetyTools.js";
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
  it("creates and repairs private database and recovery files as owner-only", async () => {
    const f = await fixture("private-modes");
    const dbPath = path.join(f.root, ".arcelle", "room.db");
    const recoveryPath = `${dbPath}.recovery`;
    try {
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
      await writeRecovery(dbPath, password);
      expect((await stat(recoveryPath)).mode & 0o777).toBe(0o600);
      await chmod(dbPath, 0o644);
      await chmod(recoveryPath, 0o644);
    } finally {
      f.created.db.close();
    }

    const reopened = openWorkspaceRoom(f.root, password);
    try {
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
      expect((await stat(recoveryPath)).mode & 0o777).toBe(0o600);
    } finally {
      reopened.db.close();
    }
  });

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

  it("rekeys workspace private state and replaces its recovery code without changing normal files", async () => {
    const f = await fixture("password-recovery");
    const dbPath = path.join(f.root, ".arcelle", "room.db");
    const newPassword = "new correct horse battery staple";
    try {
      await f.workspace.createFile("notes.txt", Readable.from(["still normal"]), "fixture");
      const oldCode = await writeRecovery(dbPath, password);
      expect(await recoverPassword(dbPath, oldCode)).toBe(password);

      const newCode = await changePassword(
        f.created.db,
        dbPath,
        password,
        newPassword,
        undefined,
        {
          databasePath: dbPath,
          biometricPath: f.root,
          recoveryPath: dbPath,
          checkpointsPath: f.root,
        },
      );
      expect(newCode).not.toBeNull();
      await expect(recoverPassword(dbPath, oldCode)).rejects.toThrow();
      expect(await recoverPassword(dbPath, newCode!)).toBe(newPassword);
      expect(await readFile(path.join(f.root, "notes.txt"), "utf8")).toBe("still normal");
    } finally {
      f.created.db.close();
    }

    const reopened = openWorkspaceRoom(f.root, newPassword);
    reopened.db.close();
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

  it("opens a raw Finder copy read-only, then registers it with a new room identity", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "arcelle-hardening-duplicate-"));
    roots.push(parent);
    const userDataDir = path.join(parent, "user-data");
    const originalPath = path.join(parent, "Original");
    const copyPath = path.join(parent, "Finder Copy");
    const state = createRoomManagerState();
    const deps: RoomManagerDeps = {
      userDataDir,
      spawnRoomServerIfEnabled: () => {},
    };

    createRoom(state, deps, originalPath, password, "Original", "workspace-folder");
    const originalId = state.room!.descriptor!.roomId;
    teardownOpenRoom(state, deps);
    await cp(originalPath, copyPath, { recursive: true });

    const duplicate = openRoom(state, deps, copyPath, password);
    expect(duplicate).toMatchObject({ readOnly: true, duplicateRoomIdentity: true });
    expect(state.room?.descriptor?.roomId).toBe(originalId);

    const registered = registerWorkspaceCopy(state, deps);
    expect(registered.readOnly).not.toBe(true);
    expect(registered.duplicateRoomIdentity).not.toBe(true);
    expect(state.room?.descriptor?.roomId).not.toBe(originalId);
    teardownOpenRoom(state, deps);
  });
});
