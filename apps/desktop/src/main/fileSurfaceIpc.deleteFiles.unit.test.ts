import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  anyFileName: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  anyFileName: mocks.anyFileName,
  availableName: vi.fn(),
  deleteFile: mocks.deleteFile,
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
vi.mock("./derivedPreview.js", () => ({
  restoreFileWithDerivedPreviews: vi.fn(),
  trashFileWithDerivedPreviews: vi.fn(),
}));
vi.mock("./db-host/folders.js", () => ({ moveFileToFolder: vi.fn() }));
vi.mock("./db-host/versions.js", () => ({ snapshotFileVersion: vi.fn() }));
vi.mock("./turnEngine.js", () => ({ saveGeneratedFile: vi.fn() }));

import { registerFileSurfaceIpc } from "./fileSurfaceIpc.js";

type Handler = (event: unknown, raw: unknown) => unknown;

function handlerFor(state: object, emitted: string[]): Handler {
  const handlers = new Map<string, Handler>();
  registerFileSurfaceIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    state as never,
    (event: string) => emitted.push(event),
  );
  const handler = handlers.get("delete_files_permanently");
  if (!handler) throw new Error("delete_files_permanently handler was not registered");
  return handler;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.anyFileName.mockImplementation((_db: unknown, id: string) => `name:${id}`);
});

describe("delete_files_permanently IPC handler with fabricated rooms", () => {
  it("de-duplicates ids, keeps per-file refusals in the report, and emits only after a deletion", () => {
    const conn = {
      prepare: vi.fn(() => ({ get: (id: string) => ({ n: id === "live" ? 0 : 1 }) })),
    };
    const emitted: string[] = [];
    const handler = handlerFor({ room: { conn, path: "/fabricated-room" } }, emitted);

    expect(handler({}, { ids: ["trash-1", "trash-1", "live", 3] })).toEqual({
      ok: ["name:trash-1"],
      failed: [{ name: "name:live", error: "Only a file already in the trash can be deleted permanently." }],
      capped: 0,
    });
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile).toHaveBeenCalledWith(conn, "trash-1");
    expect(emitted).toEqual(["room-files-changed"]);
  });

  it("does not emit a false room-change event when every fabricated deletion is refused", () => {
    const conn = { prepare: vi.fn(() => ({ get: () => ({ n: 0 }) })) };
    const emitted: string[] = [];
    const handler = handlerFor({ room: { conn, path: "/fabricated-room" } }, emitted);

    expect(handler({}, { ids: ["live"] })).toEqual({
      ok: [],
      failed: [{ name: "name:live", error: "Only a file already in the trash can be deleted permanently." }],
      capped: 0,
    });
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("refuses a missing fabricated room before looking up names or deleting", () => {
    const handler = handlerFor({ room: null }, []);

    expect(() => handler({}, { ids: ["trash-1"] })).toThrow("No room is open.");
    expect(mocks.anyFileName).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });
});
