import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  createdConnection: null as null | { open: boolean; close: () => void },
  workspaceConnection: null as null | { open: boolean; close: () => void },
}));

vi.mock("./db-host/open.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db-host/open.js")>();
  return {
    ...actual,
    createRoom: (...args: Parameters<typeof actual.createRoom>) => {
      const conn = actual.createRoom(...args);
      conn.exec("DROP TABLE files");
      fakes.createdConnection = conn;
      return conn;
    },
  };
});

vi.mock("./workspace/roomLayout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace/roomLayout.js")>();
  return {
    ...actual,
    createWorkspaceRoom: (...args: Parameters<typeof actual.createWorkspaceRoom>) => {
      const created = actual.createWorkspaceRoom(...args);
      const close = created.db.close.bind(created.db);
      created.db.close = () => {
        close();
        throw new Error("simulated close failure");
      };
      fakes.workspaceConnection = created.db;
      return created;
    },
    acquireWorkspaceLease: () => {
      throw new Error("simulated lease refusal");
    },
  };
});

import { createRoom, createRoomManagerState, spawnRoomServerIfEnabledNotImplemented } from "./roomManager.js";

const PASSWORD = "correct horse battery staple";
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "roomManager-create-failure-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  fakes.createdConnection = null;
  fakes.workspaceConnection = null;
});

describe("room creation cleanup boundaries", () => {
  it("closes a workspace database when its writer lease cannot be acquired", () => {
    const root = path.join(freshDir(), "Lease refusal workspace");

    expect(() => createRoom(
      createRoomManagerState(),
      { userDataDir: path.dirname(root), spawnRoomServerIfEnabled: spawnRoomServerIfEnabledNotImplemented },
      root,
      PASSWORD,
      "Lease refusal",
      "workspace-folder",
    )).toThrow("simulated lease refusal");

    expect(fakes.workspaceConnection?.open).toBe(false);
  });

  it("closes a newly created database when composing its room info fails", () => {
    const dir = freshDir();
    const target = path.join(dir, "missing-files.roomai");

    expect(() => createRoom(
      createRoomManagerState(),
      { userDataDir: dir, spawnRoomServerIfEnabled: spawnRoomServerIfEnabledNotImplemented },
      target,
      PASSWORD,
      "Missing files",
    )).toThrow(/files/);

    expect(fakes.createdConnection?.open).toBe(false);
  });
});
