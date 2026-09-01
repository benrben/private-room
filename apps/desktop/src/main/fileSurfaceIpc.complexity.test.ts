import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room, RoomManagerState } from "./roomManager.js";

const fileOps = vi.hoisted(() => ({
  anyFileName: vi.fn((_: unknown, id: string) => id),
  availableName: vi.fn(),
  deleteFile: vi.fn(),
  emptyTrash: vi.fn(),
  getFileMeta: vi.fn(),
  inTransaction: vi.fn(),
  listPublicFiles: vi.fn(),
  listTrashedFiles: vi.fn(),
  renameFile: vi.fn(),
  restoreFile: vi.fn(),
  setLibraryVisibility: vi.fn(),
  trashFile: vi.fn(),
  updateFileContent: vi.fn(),
}));
const folderOps = vi.hoisted(() => ({ moveFileToFolder: vi.fn() }));
const versionOps = vi.hoisted(() => ({ snapshotFileVersion: vi.fn() }));
const generatedFileOps = vi.hoisted(() => ({ saveGeneratedFile: vi.fn() }));
const derivedPreviewOps = vi.hoisted(() => ({
  restoreFileWithDerivedPreviews: vi.fn(),
  trashFileWithDerivedPreviews: vi.fn(),
}));

vi.mock("./db-host/files.js", () => fileOps);
vi.mock("./db-host/folders.js", () => folderOps);
vi.mock("./db-host/versions.js", () => versionOps);
vi.mock("./turnEngine.js", () => generatedFileOps);
vi.mock("./derivedPreview.js", () => derivedPreviewOps);

import { registerFileSurfaceIpc } from "./fileSurfaceIpc.js";

type Handler = (event: IpcMainInvokeEvent, raw: unknown) => unknown;

function handlersFor(state: RoomManagerState, emitted: string[]): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerFileSurfaceIpc({
    handle(channel, handler): void {
      handlers.set(channel, handler as Handler);
    },
  } as Pick<IpcMain, "handle">, state, (event) => emitted.push(event));
  return handlers;
}

function stateFor(room: Room): RoomManagerState {
  return { room } as RoomManagerState;
}

function roomFor(conn: unknown, workspace?: unknown): Room {
  return {
    conn,
    path: "/fake/room",
    name: "Fake room",
    password: "not-used",
    workspace,
  } as Room;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("file surface IPC complexity guards", () => {
  it("renames a database file and emits only after the rename", () => {
    const renamed: string[] = [];
    fileOps.renameFile.mockImplementation(() => renamed.push("rename"));
    const emitted: string[] = [];
    const conn = {};
    const handlers = handlersFor(stateFor(roomFor(conn)), emitted);

    const result = handlers.get("rename_file")!({} as IpcMainInvokeEvent, {
      id: "file-1",
      name: "new name.txt",
    });

    expect(result).toBeUndefined();
    expect(fileOps.renameFile).toHaveBeenCalledWith(conn, "file-1", "new name.txt");
    expect(renamed).toEqual(["rename"]);
    expect(emitted).toEqual(["room-files-changed"]);
  });

  it("renames a workspace file in its existing parent before emitting", async () => {
    const move = vi.fn(async () => undefined);
    const conn = {
      prepare: vi.fn(() => ({ get: () => ({ relative_path: "Plans/old name.txt" }) })),
    };
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor(conn, { move })), emitted);

    await handlers.get("rename_file")!({} as IpcMainInvokeEvent, {
      id: "file-1",
      name: "new name.txt",
    });

    expect(move).toHaveBeenCalledWith("file-1", "Plans/new name.txt");
    expect(emitted).toEqual(["room-files-changed"]);
    expect(fileOps.renameFile).not.toHaveBeenCalled();
  });

  it("keeps the workspace rename unavailable error and does not emit", () => {
    const conn = {
      prepare: vi.fn(() => ({ get: () => ({ relative_path: null }) })),
    };
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor(conn, { move: vi.fn() })), emitted);

    expect(() => handlers.get("rename_file")!({} as IpcMainInvokeEvent, { id: "file-1" }))
      .toThrow("That file is unavailable.");
    expect(emitted).toEqual([]);
  });

  it("trashes database files directly and workspace files through the fabricated preview cascade", async () => {
    const databaseConn = {};
    const databaseEvents: string[] = [];
    const databaseHandlers = handlersFor(stateFor(roomFor(databaseConn)), databaseEvents);

    expect(databaseHandlers.get("trash_file")!({} as IpcMainInvokeEvent, { id: "database-file" }))
      .toBeUndefined();
    expect(fileOps.trashFile).toHaveBeenCalledWith(databaseConn, "database-file", { kind: "user" });
    expect(databaseEvents).toEqual(["room-files-changed"]);

    const workspaceConn = {};
    derivedPreviewOps.trashFileWithDerivedPreviews.mockResolvedValueOnce(undefined);
    const workspaceEvents: string[] = [];
    const workspaceHandlers = handlersFor(
      stateFor(roomFor(workspaceConn, { notUsed: true })),
      workspaceEvents,
    );

    await expect(workspaceHandlers.get("trash_file")!({} as IpcMainInvokeEvent, {
      id: "workspace-file",
    })).resolves.toBeUndefined();
    expect(derivedPreviewOps.trashFileWithDerivedPreviews).toHaveBeenCalledWith(
      { db: workspaceConn, path: "/fake/room" },
      "workspace-file",
    );
    expect(workspaceEvents).toEqual(["room-files-changed"]);
  });

  it("does not report a file change when the fabricated workspace trash cascade rejects", async () => {
    const conn = {};
    derivedPreviewOps.trashFileWithDerivedPreviews.mockRejectedValueOnce(
      new Error("fake workspace trash failure"),
    );
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor(conn, { notUsed: true })), emitted);

    await expect(handlers.get("trash_file")!({} as IpcMainInvokeEvent, { id: "file-1" }))
      .rejects.toThrow("fake workspace trash failure");
    expect(emitted).toEqual([]);
  });

  it("restores files through their matching fabricated storage path before returning metadata", async () => {
    const databaseMeta = { id: "database-file", name: "Restored.md" };
    const databaseConn = {};
    fileOps.getFileMeta.mockReturnValueOnce(databaseMeta);
    const databaseEvents: string[] = [];
    const databaseHandlers = handlersFor(stateFor(roomFor(databaseConn)), databaseEvents);

    expect(databaseHandlers.get("restore_file")!({} as IpcMainInvokeEvent, { id: "database-file" }))
      .toEqual(databaseMeta);
    expect(fileOps.restoreFile).toHaveBeenCalledWith(databaseConn, "database-file");
    expect(databaseEvents).toEqual(["room-files-changed"]);

    const workspaceMeta = { id: "workspace-file", name: "Workspace.md" };
    const workspaceConn = {};
    derivedPreviewOps.restoreFileWithDerivedPreviews.mockResolvedValueOnce(undefined);
    fileOps.getFileMeta.mockReturnValueOnce(workspaceMeta);
    const workspaceEvents: string[] = [];
    const workspaceHandlers = handlersFor(
      stateFor(roomFor(workspaceConn, { notUsed: true })),
      workspaceEvents,
    );

    await expect(workspaceHandlers.get("restore_file")!({} as IpcMainInvokeEvent, {
      id: "workspace-file",
    })).resolves.toEqual(workspaceMeta);
    expect(derivedPreviewOps.restoreFileWithDerivedPreviews).toHaveBeenCalledWith(
      { db: workspaceConn, path: "/fake/room" },
      "workspace-file",
    );
    expect(workspaceEvents).toEqual(["room-files-changed"]);
  });

  it("keeps permanent deletion limited to fabricated files already in trash", () => {
    const liveConn = { prepare: vi.fn(() => ({ get: () => ({ n: 0 }) })) };
    const liveEvents: string[] = [];
    const liveHandlers = handlersFor(stateFor(roomFor(liveConn)), liveEvents);

    expect(() => liveHandlers.get("delete_file_permanently")!(
      {} as IpcMainInvokeEvent,
      { id: "live-file" },
    )).toThrow("Only a file already in the trash can be deleted permanently.");
    expect(fileOps.deleteFile).not.toHaveBeenCalled();
    expect(liveEvents).toEqual([]);

    const trashedConn = { prepare: vi.fn(() => ({ get: () => ({ n: 1 }) })) };
    const trashedEvents: string[] = [];
    const trashedHandlers = handlersFor(stateFor(roomFor(trashedConn)), trashedEvents);

    expect(trashedHandlers.get("delete_file_permanently")!(
      {} as IpcMainInvokeEvent,
      { id: "trashed-file" },
    )).toBeUndefined();
    expect(fileOps.deleteFile).toHaveBeenCalledWith(trashedConn, "trashed-file");
    expect(trashedEvents).toEqual(["room-files-changed"]);
  });

  it("moves database files in a bulk report before emitting", async () => {
    const moved: string[] = [];
    folderOps.moveFileToFolder.mockImplementation((_: unknown, id: string) => moved.push(id));
    const emitted: string[] = [];
    const conn = {};
    const handlers = handlersFor(stateFor(roomFor(conn)), emitted);

    await handlers.get("move_files_to_folder")!({} as IpcMainInvokeEvent, {
      fileIds: ["one", "one", "two", 3],
      folderId: "folder-1",
    });

    expect(folderOps.moveFileToFolder).toHaveBeenNthCalledWith(1, conn, "one", "folder-1");
    expect(folderOps.moveFileToFolder).toHaveBeenNthCalledWith(2, conn, "two", "folder-1");
    expect(moved).toEqual(["one", "two"]);
    expect(emitted).toEqual(["room-files-changed"]);
  });

  it("caps, de-duplicates, and reports individual fabricated database move failures", async () => {
    folderOps.moveFileToFolder.mockImplementation((_: unknown, id: string) => {
      if (id === "broken") throw new Error("fabricated move refusal");
    });
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor({})), emitted);
    const fileIds = ["ok", "ok", "broken", ...Array.from({ length: 201 }, (_, index) => `many-${index}`)];

    const report = await handlers.get("move_files_to_folder")!({} as IpcMainInvokeEvent, {
      fileIds,
      folderId: null,
    });

    expect(report).toEqual({
      ok: expect.arrayContaining(["ok"]),
      failed: [{ name: "broken", error: "fabricated move refusal" }],
      capped: 3,
    });
    expect(folderOps.moveFileToFolder).toHaveBeenCalledTimes(200);
    expect(emitted).toEqual(["room-files-changed"]);
  });

  it("moves a workspace file before recording its folder metadata", async () => {
    const updates: unknown[][] = [];
    const move = vi.fn(async () => undefined);
    const conn = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT name FROM folders")) return { get: () => ({ name: "Archive" }) };
        if (sql.startsWith("SELECT relative_path, content_sha256")) {
          return { get: () => ({ relative_path: "Inbox/letter.txt", content_sha256: "hash" }) };
        }
        return { run: (...args: unknown[]) => updates.push(args) };
      }),
    };
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor(conn, { move })), emitted);

    await handlers.get("move_files_to_folder")!({} as IpcMainInvokeEvent, {
      fileIds: ["file-1"],
      folderId: "folder-1",
    });

    expect(move).toHaveBeenCalledWith("file-1", "Archive/letter.txt", "hash");
    expect(updates).toEqual([["folder-1", "file-1"]]);
    expect(emitted).toEqual(["room-files-changed"]);
  });

  it("moves a workspace file to the room root using only its basename", async () => {
    const move = vi.fn(async () => undefined);
    const conn = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT relative_path, content_sha256")) {
          return { get: () => ({ relative_path: "Inbox/letter.txt", content_sha256: null }) };
        }
        return { run: vi.fn() };
      }),
    };
    const handlers = handlersFor(stateFor(roomFor(conn, { move })), []);

    await handlers.get("move_files_to_folder")!({} as IpcMainInvokeEvent, {
      fileIds: ["file-1"],
      folderId: null,
    });

    expect(move).toHaveBeenCalledWith("file-1", "letter.txt", undefined);
  });

  it("reports an unavailable workspace file without emitting a false file-change event", async () => {
    const conn = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT name FROM folders")) return { get: () => ({ name: "Archive" }) };
        return { get: () => undefined };
      }),
    };
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor(conn, { move: vi.fn() })), emitted);

    await expect(handlers.get("move_files_to_folder")!({} as IpcMainInvokeEvent, {
      fileIds: ["gone"],
      folderId: "folder-1",
    })).resolves.toEqual({
      ok: [],
      failed: [{ name: "gone", error: "That file is no longer in this room." }],
      capped: 0,
    });
    expect(emitted).toEqual([]);
  });

  it("rejects a missing workspace folder before moving or emitting", async () => {
    const move = vi.fn();
    const conn = {
      prepare: vi.fn(() => ({ get: () => undefined })),
    };
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor(conn, { move })), emitted);

    await expect(handlers.get("move_files_to_folder")!({} as IpcMainInvokeEvent, {
      fileIds: ["file-1"],
      folderId: "missing-folder",
    })).rejects.toThrow("That folder no longer exists.");
    expect(move).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("updates a database file transactionally, then emits its two renderer events", () => {
    const updated: unknown[][] = [];
    const meta = { id: "file-1", name: "note.md" };
    fileOps.inTransaction.mockImplementation((_db: unknown, operation: () => void) => operation());
    fileOps.getFileMeta.mockReturnValue(meta);
    fileOps.updateFileContent.mockImplementation((_db, _id, bytes, content) => updated.push([bytes, content]));
    const emitted: Array<[string, unknown]> = [];
    const conn = {};
    const handlers = new Map<string, Handler>();
    registerFileSurfaceIpc({
      handle(channel, handler): void {
        handlers.set(channel, handler as Handler);
      },
    } as Pick<IpcMain, "handle">, stateFor(roomFor(conn)), (event, payload) => emitted.push([event, payload]));

    const result = handlers.get("update_file_content")!({} as IpcMainInvokeEvent, {
      id: "file-1",
      content: "updated text",
    });

    expect(result).toEqual(meta);
    expect(versionOps.snapshotFileVersion).toHaveBeenCalledWith(conn, "file-1", "You saved");
    expect(fileOps.inTransaction).toHaveBeenCalledWith(conn, expect.any(Function));
    expect(fileOps.getFileMeta).toHaveBeenCalledWith(conn, "file-1");
    expect(emitted).toEqual([["room-files-changed", null], ["file-updated", { id: "file-1" }]]);
    expect((updated[0][0] as Buffer).toString("utf8")).toBe("updated text");
    expect(updated[0][1]).toBe("updated text");
  });

  it("writes workspace content only after its snapshot, then records metadata and emits", async () => {
    const writes: unknown[][] = [];
    const meta = { id: "file-1", name: "note.md" };
    fileOps.getFileMeta.mockReturnValue(meta);
    const snapshotVersion = vi.fn(async () => undefined);
    const writeAtomic = vi.fn(async () => undefined);
    const conn = {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("SELECT content_sha256")) return { get: () => ({ content_sha256: "old-hash" }) };
        return { run: (...args: unknown[]) => writes.push(args) };
      }),
    };
    const emitted: Array<[string, unknown]> = [];
    const handlers = new Map<string, Handler>();
    registerFileSurfaceIpc({
      handle(channel, handler): void {
        handlers.set(channel, handler as Handler);
      },
    } as Pick<IpcMain, "handle">, stateFor(roomFor(conn, { snapshotVersion, writeAtomic })), (event, payload) => emitted.push([event, payload]));

    await expect(handlers.get("update_file_content")!({} as IpcMainInvokeEvent, {
      id: "file-1",
      content: "workspace text",
    })).resolves.toEqual(meta);

    expect(snapshotVersion).toHaveBeenCalledWith("file-1", "You saved");
    expect(writeAtomic).toHaveBeenCalledWith("file-1", expect.anything(), "old-hash");
    expect(writes).toEqual([["workspace text", "file-1"]]);
    expect(emitted).toEqual([["room-files-changed", null], ["file-updated", { id: "file-1" }]]);
  });

  it("saves generated database files directly and creates workspace files through fake streams", async () => {
    const databaseMeta = { id: "generated-db", name: "Generated.md" };
    const workspaceMeta = { id: "generated-workspace", name: "Renamed.md" };
    const emitted: Array<[string, unknown]> = [];
    const databaseConn = {};
    generatedFileOps.saveGeneratedFile.mockReturnValue(databaseMeta);
    const databaseHandlers = new Map<string, Handler>();
    registerFileSurfaceIpc({
      handle(channel, handler): void {
        databaseHandlers.set(channel, handler as Handler);
      },
    } as Pick<IpcMain, "handle">, stateFor(roomFor(databaseConn)), (event, payload) => emitted.push([event, payload]));

    expect(databaseHandlers.get("save_generated_file")!({} as IpcMainInvokeEvent, {
      name: "Draft.md",
      content: "database body",
    })).toEqual(databaseMeta);
    expect(generatedFileOps.saveGeneratedFile).toHaveBeenCalledWith(databaseConn, "Draft.md", "database body");

    const updates: unknown[][] = [];
    const workspaceConn = { prepare: vi.fn(() => ({ run: (...args: unknown[]) => updates.push(args) })) };
    let createdText = "";
    const createFile = vi.fn(async (_name: string, stream: AsyncIterable<Uint8Array>) => {
      for await (const chunk of stream) createdText += Buffer.from(chunk).toString("utf8");
      return { fileId: "generated-workspace" };
    });
    fileOps.availableName.mockReturnValue("Renamed.md");
    fileOps.getFileMeta.mockReturnValue(workspaceMeta);
    const workspaceHandlers = new Map<string, Handler>();
    registerFileSurfaceIpc({
      handle(channel, handler): void {
        workspaceHandlers.set(channel, handler as Handler);
      },
    } as Pick<IpcMain, "handle">, stateFor(roomFor(workspaceConn, { createFile })), (event, payload) => emitted.push([event, payload]));

    await expect(workspaceHandlers.get("save_generated_file")!({} as IpcMainInvokeEvent, {
      name: "",
      content: "workspace body",
    })).resolves.toEqual(workspaceMeta);
    expect(fileOps.availableName).toHaveBeenCalledWith(workspaceConn, "Generated.md");
    expect(createFile).toHaveBeenCalledWith("Renamed.md", expect.anything(), "generated");
    expect(createdText).toBe("workspace body");
    expect(updates).toEqual([["workspace body", "generated-workspace"]]);
    expect(emitted).toEqual([
      ["room-files-changed", null],
      ["room-files-changed", null],
    ]);
  });

  it("empties trash and toggles library visibility while emitting only real changes", () => {
    const meta = { id: "file-1", linked: true };
    const conn = {};
    fileOps.emptyTrash.mockReturnValueOnce(0).mockReturnValueOnce(2);
    fileOps.getFileMeta.mockReturnValue(meta);
    const emitted: string[] = [];
    const handlers = handlersFor(stateFor(roomFor(conn)), emitted);

    expect(handlers.get("empty_trash")!({} as IpcMainInvokeEvent, {})).toBe(0);
    expect(handlers.get("empty_trash")!({} as IpcMainInvokeEvent, {})).toBe(2);
    expect(handlers.get("set_file_in_library")!({} as IpcMainInvokeEvent, {
      id: "file-1",
      linked: true,
    })).toEqual(meta);

    expect(fileOps.setLibraryVisibility).toHaveBeenCalledWith(conn, "file-1", true);
    expect(fileOps.getFileMeta).toHaveBeenCalledWith(conn, "file-1");
    expect(emitted).toEqual(["room-files-changed", "room-files-changed"]);
  });

  it("bulk trashes and restores through both database and workspace storage paths", async () => {
    const dbConn = {};
    const dbEvents: string[] = [];
    const dbHandlers = handlersFor(stateFor(roomFor(dbConn)), dbEvents);

    await expect(dbHandlers.get("trash_files")!({} as IpcMainInvokeEvent, { ids: ["db-trash"] }))
      .resolves.toMatchObject({ ok: ["db-trash"] });
    await expect(dbHandlers.get("restore_files")!({} as IpcMainInvokeEvent, { ids: ["db-restore"] }))
      .resolves.toMatchObject({ ok: ["db-restore"] });
    expect(fileOps.trashFile).toHaveBeenCalledWith(dbConn, "db-trash", { kind: "user" });
    expect(fileOps.restoreFile).toHaveBeenCalledWith(dbConn, "db-restore");

    derivedPreviewOps.trashFileWithDerivedPreviews.mockResolvedValue(undefined);
    derivedPreviewOps.restoreFileWithDerivedPreviews.mockResolvedValue(undefined);
    const workspaceConn = {};
    const workspaceEvents: string[] = [];
    const workspaceHandlers = handlersFor(
      stateFor(roomFor(workspaceConn, { kind: "fabricated workspace" })),
      workspaceEvents,
    );
    await expect(workspaceHandlers.get("trash_files")!({} as IpcMainInvokeEvent, { ids: ["ws-trash"] }))
      .resolves.toMatchObject({ ok: ["ws-trash"] });
    await expect(workspaceHandlers.get("restore_files")!({} as IpcMainInvokeEvent, { ids: ["ws-restore"] }))
      .resolves.toMatchObject({ ok: ["ws-restore"] });
    expect(derivedPreviewOps.trashFileWithDerivedPreviews).toHaveBeenCalledWith(
      { db: workspaceConn, path: "/fake/room" },
      "ws-trash",
    );
    expect(derivedPreviewOps.restoreFileWithDerivedPreviews).toHaveBeenCalledWith(
      { db: workspaceConn, path: "/fake/room" },
      "ws-restore",
    );
    expect(dbEvents).toEqual(["room-files-changed", "room-files-changed"]);
    expect(workspaceEvents).toEqual(["room-files-changed", "room-files-changed"]);
  });
});
