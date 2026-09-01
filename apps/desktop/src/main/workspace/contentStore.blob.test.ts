import { Readable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFileBytes: vi.fn(),
  insertFile: vi.fn(),
  listFiles: vi.fn(),
  restoreFile: vi.fn(),
  trashFile: vi.fn(),
  updateFileContent: vi.fn(),
}));

vi.mock("../db-host/files.js", () => ({
  getFileBytes: mocks.getFileBytes,
  updateFileContent: mocks.updateFileContent,
  insertFile: mocks.insertFile,
  listFiles: mocks.listFiles,
  restoreFile: mocks.restoreFile,
  trashFile: mocks.trashFile,
}));

import { BlobContentStore, WorkspaceContentStore, contentStoreFor } from "./contentStore.js";

const blobMeta = {
  id: "blob-1",
  name: "source.bin",
  mimeType: "application/octet-stream",
  sizeBytes: 4,
};

describe("BlobContentStore writeAtomic", () => {
  const db = {} as never;
  const store = new BlobContentStore(db);

  beforeEach(() => {
    mocks.getFileBytes.mockReset().mockReturnValue(Buffer.from("previous bytes"));
    mocks.updateFileContent.mockReset();
  });

  it("combines Buffer and Uint8Array stream chunks before saving", async () => {
    const result = await store.writeAtomic(
      "file-1",
      Readable.from([Buffer.from("first "), new Uint8Array([115, 101, 99, 111, 110, 100])]),
    );

    const bytes = mocks.updateFileContent.mock.calls[0]?.[2] as Buffer | undefined;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes?.toString()).toBe("first second");
    expect(mocks.updateFileContent).toHaveBeenCalledWith(db, "file-1", bytes, null);
    expect(result).toMatchObject({
      fileId: "file-1",
      relativePath: null,
      sizeBytes: 12,
      created: false,
    });
  });

  it("does not consume or overwrite a stale blob", async () => {
    await expect(
      store.writeAtomic("file-1", Readable.from([Buffer.from("must not save")]), "not-the-current-hash"),
    ).rejects.toThrow("The file changed after it was opened");

    expect(mocks.updateFileContent).not.toHaveBeenCalled();
  });
});

describe("BlobContentStore reads, imports, snapshots, and restore", () => {
  beforeEach(() => {
    mocks.getFileBytes.mockReset();
    mocks.insertFile.mockReset();
    mocks.listFiles.mockReset();
    mocks.restoreFile.mockReset();
  });

  it("enumerates database metadata as blob entries", async () => {
    mocks.listFiles.mockReturnValue([blobMeta]);
    const store = new BlobContentStore({} as never);
    const entries = [];
    for await (const entry of store.enumerate()) entries.push(entry);

    expect(entries).toEqual([{
      fileId: "blob-1",
      name: "source.bin",
      relativePath: null,
      mimeType: "application/octet-stream",
      sizeBytes: 4,
      storageKind: "blob",
      sha256: null,
      indexState: "ready",
    }]);
  });

  it("streams saved bytes and rejects a blob without saved bytes", async () => {
    mocks.getFileBytes.mockReturnValueOnce(Buffer.from("blob")).mockReturnValueOnce(null);
    const store = new BlobContentStore({} as never);
    const chunks: Buffer[] = [];
    for await (const chunk of await store.readStream("blob-1")) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("blob");
    await expect(store.readStream("missing")).rejects.toThrow("That file has no saved bytes.");
  });

  it("imports real source bytes under the destination basename", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "blob-content-store-"));
    const source = path.join(dir, "upload.tmp");
    writeFileSync(source, "four");
    mocks.insertFile.mockReturnValue(blobMeta);
    try {
      const db = {} as never;
      await expect(new BlobContentStore(db).importFile(source, "nested/source.bin")).resolves.toMatchObject({
        fileId: "blob-1",
        name: "source.bin",
        storageKind: "blob",
      });
      expect(mocks.insertFile).toHaveBeenCalledWith(
        db,
        "source.bin",
        "application/octet-stream",
        Buffer.from("four"),
        null,
        "upload",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores through the database helper and snapshots byte-exact content", async () => {
    mocks.getFileBytes.mockReturnValue(Buffer.from("snapshot bytes"));
    const run = vi.fn();
    const db = { prepare: vi.fn(() => ({ run })) };
    const store = new BlobContentStore(db as never);

    await store.restore("blob-1");
    const snapshot = await store.createSnapshot("blob-1");

    expect(mocks.restoreFile).toHaveBeenCalledWith(db, "blob-1");
    expect(run).toHaveBeenCalledWith(expect.any(String), "blob-1", Buffer.from("snapshot bytes"));
    expect(snapshot).toMatchObject({ sizeBytes: 14, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("refuses to snapshot a blob whose bytes are absent", async () => {
    mocks.getFileBytes.mockReturnValue(null);
    await expect(new BlobContentStore({} as never).createSnapshot("missing")).rejects.toThrow(
      "That file has no saved bytes.",
    );
  });
});

describe("BlobContentStore move and trash with a fabricated blob database", () => {
  beforeEach(() => {
    mocks.getFileBytes.mockReset().mockReturnValue(Buffer.from("current blob bytes"));
    mocks.trashFile.mockReset();
  });

  it("renames only the blob filename and marks a current blob as user-trashed", async () => {
    const run = vi.fn();
    const db = { prepare: vi.fn(() => ({ run })) };
    const store = new BlobContentStore(db as never);
    const expectedHash = (await store.stat("blob-1")).sha256;

    await store.move("blob-1", "nested/renamed.md", expectedHash);
    await store.trash("blob-1", expectedHash);

    expect(db.prepare).toHaveBeenCalledWith(
      "UPDATE files SET name = ?, artifact_key = NULL WHERE id = ? AND trashed_at IS NULL",
    );
    expect(run).toHaveBeenCalledWith("renamed.md", "blob-1");
    expect(mocks.trashFile).toHaveBeenCalledWith(db, "blob-1", { kind: "user" });
  });

  it("rejects stale move and trash requests before mutating the fabricated database", async () => {
    const prepare = vi.fn();
    const db = { prepare };
    const store = new BlobContentStore(db as never);

    await expect(store.move("blob-1", "renamed.md", "stale-hash"))
      .rejects.toThrow("The file changed after it was opened.");
    await expect(store.trash("blob-1", "stale-hash"))
      .rejects.toThrow("The file changed after it was opened.");

    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.trashFile).not.toHaveBeenCalled();
  });
});

describe("WorkspaceContentStore metadata reads", () => {
  it("maps indexed workspace rows without treating a missing MIME value as a string", async () => {
    const all = vi.fn().mockReturnValue([
      {
        id: "workspace-1",
        name: "notes.md",
        mime_type: null,
        size_bytes: 42,
        relative_path: "notes.md",
        content_sha256: "a".repeat(64),
        index_state: "ready",
      },
    ]);
    const prepare = vi.fn().mockReturnValue({ all });
    const store = new WorkspaceContentStore({ db: { prepare } } as never);
    const entries = [];
    for await (const entry of store.enumerate()) entries.push(entry);

    expect(entries).toEqual([{
      fileId: "workspace-1",
      name: "notes.md",
      relativePath: "notes.md",
      mimeType: "",
      sizeBytes: 42,
      storageKind: "workspace",
      sha256: "a".repeat(64),
      indexState: "ready",
    }]);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("returns indexed metadata and refuses missing or unhashed workspace rows", async () => {
    const get = vi.fn()
      .mockReturnValueOnce({ relative_path: "notes.md", size_bytes: 42, content_sha256: "b".repeat(64), mtime_ns: 9 })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ relative_path: "draft.md", size_bytes: 7, content_sha256: null, mtime_ns: null });
    const store = new WorkspaceContentStore({ db: { prepare: vi.fn().mockReturnValue({ get }) } } as never);

    await expect(store.stat("workspace-1")).resolves.toEqual({
      fileId: "workspace-1",
      relativePath: "notes.md",
      sizeBytes: 42,
      sha256: "b".repeat(64),
      mtimeNs: 9,
    });
    await expect(store.stat("missing")).rejects.toThrow("That workspace file is not indexed.");
    await expect(store.stat("unhashed")).rejects.toThrow("That workspace file is not indexed.");
  });
});

describe("WorkspaceContentStore command delegation", () => {
  it("forwards every mutating and streaming operation without changing arguments", async () => {
    const stream = Readable.from([Buffer.from("bytes")]);
    const workspace = {
      db: { prepare: vi.fn() },
      readStream: vi.fn().mockResolvedValue(stream),
      writeAtomic: vi.fn().mockResolvedValue({ fileId: "file-1" }),
      importFile: vi.fn().mockResolvedValue({ fileId: "file-2" }),
      move: vi.fn().mockResolvedValue(undefined),
      trash: vi.fn().mockResolvedValue(undefined),
      restore: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockResolvedValue({ id: "snapshot-1" }),
    };
    const store = new WorkspaceContentStore(workspace as never);

    await expect(store.readStream("file-1")).resolves.toBe(stream);
    await store.writeAtomic("file-1", stream, "expected");
    await store.importFile("/tmp/source", "nested/destination");
    await store.move("file-1", "nested/moved", "move-hash");
    await store.trash("file-1", "trash-hash");
    await store.restore("file-1", "restored/name");
    await store.createSnapshot("file-1");

    expect(workspace.writeAtomic).toHaveBeenCalledWith("file-1", stream, "expected");
    expect(workspace.importFile).toHaveBeenCalledWith("/tmp/source", "nested/destination");
    expect(workspace.move).toHaveBeenCalledWith("file-1", "nested/moved", "move-hash");
    expect(workspace.trash).toHaveBeenCalledWith("file-1", "trash-hash");
    expect(workspace.restore).toHaveBeenCalledWith("file-1", "restored/name");
    expect(workspace.snapshot).toHaveBeenCalledWith("file-1");
  });

  it("selects blob and workspace implementations from the room format", () => {
    expect(contentStoreFor({} as never, null)).toBeInstanceOf(BlobContentStore);
    const root = mkdtempSync(path.join(os.tmpdir(), "content-store-select-"));
    try {
      expect(contentStoreFor({} as never, root)).toBeInstanceOf(WorkspaceContentStore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
