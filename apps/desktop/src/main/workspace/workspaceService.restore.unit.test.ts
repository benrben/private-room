import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

const fakes = vi.hoisted(() => ({
  assertNoSymlinkSegments: vi.fn(),
  clearChunks: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: fakes.randomUUID,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  lstat: fakes.lstat,
  mkdir: fakes.mkdir,
}));

vi.mock("../db-host/files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db-host/files.js")>()),
  clearChunks: fakes.clearChunks,
}));

vi.mock("./pathSafety.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pathSafety.js")>()),
  assertNoSymlinkSegments: fakes.assertNoSymlinkSegments,
}));

import { WorkspaceService } from "./workspaceService.js";

interface Statement {
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

interface RestoreHarness {
  db: Database.Database;
  rootPath: string;
  objects: {
    restoreTo(objectId: string, destination: string): Promise<{
      id: string;
      sha256: string;
      sizeBytes: number;
    }>;
  };
  restore(fileId: string, destinationPath?: string): Promise<void>;
}

interface RestoreFixture {
  readonly row?: { id: string; relative_path: string };
  readonly object?: { object_id: string };
  readonly restoreTo?: ReturnType<typeof vi.fn>;
}

function restoreHarness(fixture: RestoreFixture = {}): {
  readonly service: RestoreHarness;
  readonly prepare: ReturnType<typeof vi.fn>;
  readonly transaction: ReturnType<typeof vi.fn>;
  readonly insertOperation: Statement;
  readonly updateOperation: Statement;
  readonly updateFile: Statement;
  readonly restoreTo: ReturnType<typeof vi.fn>;
} {
  const trashedRow: Statement = { get: vi.fn(() => fixture.row), run: vi.fn() };
  const objectRow: Statement = { get: vi.fn(() => fixture.object), run: vi.fn() };
  const insertOperation: Statement = { get: vi.fn(), run: vi.fn() };
  const updateOperation: Statement = { get: vi.fn(), run: vi.fn() };
  const updateFile: Statement = { get: vi.fn(), run: vi.fn() };
  const prepare = vi.fn((sql: string): Statement => {
    if (sql.includes("SELECT id, relative_path FROM files")) return trashedRow;
    if (sql.includes("SELECT r.object_id FROM content_object_refs")) return objectRow;
    if (sql.includes("INSERT INTO fs_operations")) return insertOperation;
    if (sql.includes("UPDATE fs_operations")) return updateOperation;
    if (sql.includes("UPDATE files SET name")) return updateFile;
    throw new Error(`Unexpected fabricated SQL: ${sql}`);
  });
  const transaction = vi.fn((work: () => void) => () => work());
  const db = { prepare, transaction } as unknown as Database.Database;
  const restoreTo = fixture.restoreTo ?? vi.fn(async () => ({
    id: "object-1",
    sha256: "restored-sha",
    sizeBytes: 123,
  }));
  const service = Object.create(WorkspaceService.prototype) as RestoreHarness;
  Object.assign(service, {
    db,
    rootPath: "/workspace",
    objects: { restoreTo },
  });
  return { service, prepare, transaction, insertOperation, updateOperation, updateFile, restoreTo };
}

function missingDestination(): NodeJS.ErrnoException {
  return Object.assign(new Error("fabricated missing destination"), { code: "ENOENT" });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.randomUUID.mockReturnValue("restore-operation");
  fakes.assertNoSymlinkSegments.mockResolvedValue(undefined);
  fakes.mkdir.mockResolvedValue(undefined);
  fakes.lstat.mockImplementation(async (_destination: string, options?: { bigint?: boolean }) => {
    if (!options?.bigint) throw missingDestination();
    return { mtimeNs: 42n, dev: 7n, ino: 8n, birthtimeNs: 9n };
  });
});

describe("WorkspaceService.restore", () => {
  it("restores a fabricated trash object to its original workspace path and commits metadata", async () => {
    const { service, insertOperation, updateOperation, updateFile, restoreTo, transaction } = restoreHarness({
      row: { id: "file-1", relative_path: "archive/notes.md" },
      object: { object_id: "object-1" },
    });

    await service.restore("file-1");

    expect(fakes.assertNoSymlinkSegments).toHaveBeenNthCalledWith(
      1,
      "/workspace",
      "archive/notes.md",
      true,
    );
    expect(fakes.assertNoSymlinkSegments).toHaveBeenNthCalledWith(
      2,
      "/workspace",
      "archive/notes.md",
      true,
    );
    expect(fakes.mkdir).toHaveBeenCalledWith("/workspace/archive", { recursive: true });
    expect(restoreTo).toHaveBeenCalledWith("object-1", "/workspace/archive/notes.md");
    expect(fakes.lstat).toHaveBeenNthCalledWith(1, "/workspace/archive/notes.md");
    expect(fakes.lstat).toHaveBeenNthCalledWith(2, "/workspace/archive/notes.md", { bigint: true });
    expect(insertOperation.run).toHaveBeenCalledWith(
      "restore-operation",
      "restore",
      "file-1",
      null,
      "archive/notes.md",
      null,
      null,
    );
    expect(fakes.clearChunks).toHaveBeenCalledWith(service.db, "file-1");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(updateFile.run).toHaveBeenCalledWith(
      "notes.md",
      "archive/notes.md",
      "archive/notes.md",
      "restored-sha",
      123,
      42,
      "7:8:9",
      "file-1",
    );
    expect(updateOperation.run).toHaveBeenNthCalledWith(
      1,
      "filesystem_committed",
      "restored-sha",
      null,
      "restore-operation",
    );
    expect(updateOperation.run).toHaveBeenNthCalledWith(
      2,
      "database_committed",
      "restored-sha",
      null,
      "restore-operation",
    );
    expect(updateOperation.run).toHaveBeenNthCalledWith(
      3,
      "completed",
      "restored-sha",
      null,
      "restore-operation",
    );
  });

  it("refuses a non-trash row or an absent recovered object before filesystem work", async () => {
    const missingFile = restoreHarness();
    await expect(missingFile.service.restore("file-1")).rejects.toThrow(
      "That file is not in Arcelle Trash.",
    );
    expect(fakes.mkdir).not.toHaveBeenCalled();

    const missingObject = restoreHarness({ row: { id: "file-1", relative_path: "notes.md" } });
    await expect(missingObject.service.restore("file-1")).rejects.toThrow(
      "The deleted file has no recoverable content object.",
    );
    expect(fakes.mkdir).not.toHaveBeenCalled();
  });

  it("records a fabricated object restore failure against an explicit destination", async () => {
    const failure = new Error("fabricated content object failure");
    const restoreTo = vi.fn(async () => { throw failure; });
    const { service, updateFile, updateOperation } = restoreHarness({
      row: { id: "file-1", relative_path: "notes.md" },
      object: { object_id: "object-1" },
      restoreTo,
    });

    await expect(service.restore("file-1", "Recovered/notes.md")).rejects.toBe(failure);

    expect(fakes.mkdir).toHaveBeenCalledWith("/workspace/Recovered", { recursive: true });
    expect(updateFile.run).not.toHaveBeenCalled();
    expect(updateOperation.run).toHaveBeenCalledTimes(1);
    expect(updateOperation.run).toHaveBeenCalledWith(
      "failed",
      null,
      "fabricated content object failure",
      "restore-operation",
    );
  });
});

describe("WorkspaceService.restoreVersion", () => {
  it("restores inline version bytes and recording metadata in one fabricated transaction", async () => {
    const updateFile = { get: vi.fn(), run: vi.fn() };
    const updateRecording = { get: vi.fn(), run: vi.fn() };
    const objectLookup = { get: vi.fn(() => undefined), run: vi.fn() };
    const prepare = vi.fn((sql: string): Statement => {
      if (sql.includes("SELECT object_id FROM content_object_refs")) return objectLookup;
      if (sql.includes("UPDATE files SET extracted_text")) return updateFile;
      if (sql.includes("UPDATE recordings SET meta")) return updateRecording;
      throw new Error(`Unexpected fabricated SQL: ${sql}`);
    });
    const transaction = vi.fn((work: () => void) => () => work());
    const received: string[] = [];
    const service = Object.create(WorkspaceService.prototype) as WorkspaceService & {
      db: Database.Database;
      fileRow(fileId: string): { content_sha256: string };
    };
    Object.assign(service, {
      db: { prepare, transaction },
      objects: { readStream: vi.fn() },
      fileRow: vi.fn(() => ({ content_sha256: "current-hash" })),
      versionSnapshot: vi.fn(async () => ({
        fileId: "file-1",
        bytes: Buffer.from("restored inline bytes"),
        text: "restored text",
        recMeta: '{"duration":12}',
        provenance: '{"tool":"restore"}',
      })),
      snapshotVersion: vi.fn(async () => "snapshot-id"),
      writeAtomic: vi.fn(async (_fileId: string, content: AsyncIterable<Uint8Array>) => {
        for await (const chunk of content) received.push(Buffer.from(chunk).toString("utf8"));
      }),
    });

    await expect(service.restoreVersion("version-1")).resolves.toBe("file-1");

    expect(received).toEqual(["restored inline bytes"]);
    expect((service as unknown as { writeAtomic: ReturnType<typeof vi.fn> }).writeAtomic)
      .toHaveBeenCalledWith("file-1", expect.anything(), "current-hash");
    expect(updateFile.run).toHaveBeenCalledWith(
      "restored text",
      '{"tool":"restore"}',
      "file-1",
    );
    expect(updateRecording.run).toHaveBeenCalledWith('{"duration":12}', "file-1");
    expect(transaction).toHaveBeenCalledOnce();
  });
});
