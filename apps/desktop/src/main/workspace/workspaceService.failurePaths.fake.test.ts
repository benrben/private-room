import { Readable, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  assertNoSymlinkSegments: vi.fn(),
  createHash: vi.fn(),
  createWriteStream: vi.fn(),
  lstat: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  randomUUID: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  resolveWorkspacePath: vi.fn(),
  rm: vi.fn(),
  rmdir: vi.fn(),
}));

vi.mock("node:crypto", () => ({ createHash: fakes.createHash, randomUUID: fakes.randomUUID }));
vi.mock("node:fs", () => ({
  createReadStream: vi.fn(),
  createWriteStream: fakes.createWriteStream,
  lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
}));
vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(),
  link: vi.fn(),
  lstat: fakes.lstat,
  mkdir: fakes.mkdir,
  open: fakes.open,
  readdir: fakes.readdir,
  rename: fakes.rename,
  rm: fakes.rm,
  rmdir: fakes.rmdir,
}));
vi.mock("../db-host/versions.js", () => ({ VERSIONS_KEPT: 10 }));
vi.mock("../db-host/files.js", () => ({ clearChunks: vi.fn() }));
vi.mock("./contentObjects.js", () => ({ ContentObjectStore: class ContentObjectStore {} }));
vi.mock("./manifest.js", () => ({ scanWorkspaceManifest: vi.fn() }));
vi.mock("./pathSafety.js", () => ({
  assertNoSymlinkSegments: fakes.assertNoSymlinkSegments,
  normalizeRelativePath: vi.fn((value: string) => value),
  pathKey: vi.fn((value: string) => value.toLowerCase()),
  resolveWorkspacePath: fakes.resolveWorkspacePath,
}));

import { WorkspaceService, type WorkspaceDirectoryState } from "./workspaceService.js";

const rootPath = "/fabricated/workspace";

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`fabricated ${code}`), { code });
}

function statementDb() {
  const run = vi.fn();
  const prepare = vi.fn(() => ({ get: vi.fn(), run }));
  const transaction = vi.fn((work: () => void) => () => work());
  return { db: { prepare, transaction }, prepare, run, transaction };
}

function serviceHarness() {
  const records = statementDb();
  const service = Object.create(WorkspaceService.prototype) as WorkspaceService;
  Object.assign(service, { db: records.db, rootPath, privateRoot: `${rootPath}/.arcelle` });
  return { service, ...records };
}

function directory(relativePath: string, exists: boolean, identity = "1:2:3"): WorkspaceDirectoryState {
  return { relativePath, exists, empty: true, fsIdentity: exists ? identity : null };
}

beforeEach(() => {
  vi.resetAllMocks();
  fakes.randomUUID.mockReturnValue("operation-id");
  fakes.resolveWorkspacePath.mockImplementation((_root: string, relative: string) => `${rootPath}/${relative}`);
  fakes.assertNoSymlinkSegments.mockResolvedValue(undefined);
  fakes.mkdir.mockResolvedValue(undefined);
  fakes.rm.mockResolvedValue(undefined);
  fakes.createHash.mockReturnValue({ update: vi.fn(), digest: vi.fn(() => "fabricated-hash") });
  fakes.createWriteStream.mockImplementation(() => new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("fabricated stream refusal"));
    },
  }));
});

describe("WorkspaceService directory failure paths with fabricated filesystem state", () => {
  it("keeps a successful directory creation successful when the parent directory cannot be fsynced", async () => {
    const { service } = serviceHarness();
    vi.spyOn(service, "directoryState")
      .mockResolvedValueOnce(directory("Archive", false))
      .mockResolvedValueOnce(directory("Archive", true));
    fakes.mkdir.mockResolvedValue(`${rootPath}/Archive`);
    fakes.open.mockRejectedValue(filesystemError("EACCES"));

    await expect(service.createDirectory("Archive")).resolves.toBe(true);
    expect(fakes.open).toHaveBeenCalledWith(rootPath, "r");
  });

  it("distinguishes a vanished directory from stat and listing failures", async () => {
    const { service } = serviceHarness();
    fakes.lstat.mockRejectedValueOnce(filesystemError("EACCES"));
    await expect(service.directoryState("Archive")).rejects.toMatchObject({ code: "EACCES" });

    fakes.lstat.mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
      dev: 1n,
      ino: 2n,
      birthtimeNs: 3n,
    });
    fakes.readdir.mockRejectedValueOnce(filesystemError("ENOENT"));
    await expect(service.directoryState("Archive")).resolves.toEqual(directory("Archive", false));

    fakes.readdir.mockRejectedValueOnce(filesystemError("EIO"));
    await expect(service.directoryState("Archive")).rejects.toMatchObject({ code: "EIO" });
  });

  it("records and rethrows identity changes and non-empty removal races", async () => {
    const changed = serviceHarness();
    vi.spyOn(changed.service, "directoryState")
      .mockResolvedValueOnce(directory("Archive", true, "before"))
      .mockResolvedValueOnce(directory("Archive", true, "after"));
    await expect(changed.service.removeDirectory("Archive")).rejects.toThrow(
      "The folder changed before it could be removed.",
    );
    expect(changed.run).toHaveBeenCalledWith(
      "failed",
      null,
      "The folder changed before it could be removed.",
      "operation-id",
    );

    const raced = serviceHarness();
    vi.spyOn(raced.service, "directoryState")
      .mockResolvedValueOnce(directory("Archive", true))
      .mockResolvedValueOnce(directory("Archive", true));
    fakes.rmdir.mockRejectedValue(filesystemError("ENOTEMPTY"));
    await expect(raced.service.removeDirectory("Archive")).rejects.toThrow(
      "The folder is not empty and was not removed.",
    );
    expect(raced.run).toHaveBeenCalledWith(
      "failed",
      null,
      "The folder is not empty and was not removed.",
      "operation-id",
    );
  });
});

describe("WorkspaceService write failure cleanup with fabricated streams and objects", () => {
  it("removes an atomic-write temp file and records the original stream failure", async () => {
    const { service } = serviceHarness();
    Object.assign(service, {
      fileRow: vi.fn(() => ({ relative_path: "notes.md" })),
      verifyExpected: vi.fn(async () => "old-hash"),
      prepareOperation: vi.fn(() => "write-operation"),
      updateOperation: vi.fn(),
    });
    fakes.lstat.mockResolvedValue({ mode: 0o644 });

    await expect(service.writeAtomic("file-1", Readable.from(["new text"]))).rejects.toThrow(
      "fabricated stream refusal",
    );
    expect(fakes.rm).toHaveBeenCalledWith(
      `${rootPath}/.notes.md.arcelle-operation-id.tmp`,
      { force: true },
    );
    expect((service as unknown as { updateOperation: ReturnType<typeof vi.fn> }).updateOperation)
      .toHaveBeenCalledWith("write-operation", "failed", undefined, "fabricated stream refusal");
  });

  it("removes a create temp file and records the original stream failure", async () => {
    const { service, run } = serviceHarness();
    fakes.lstat.mockRejectedValue(filesystemError("ENOENT"));

    await expect(service.createFile("notes.md", Readable.from(["new text"]))).rejects.toThrow(
      "fabricated stream refusal",
    );
    expect(fakes.rm).toHaveBeenCalledWith(
      `${rootPath}/.notes.md.arcelle-operation-id.tmp`,
      { force: true },
    );
    expect(run).toHaveBeenCalledWith(
      "failed",
      null,
      "fabricated stream refusal",
      "operation-id",
    );
  });

  it("rethrows unexpected destination inspection errors before restoring an object", async () => {
    const { service } = serviceHarness();
    const restoreTo = vi.fn();
    Object.assign(service, { objects: { restoreTo } });
    fakes.lstat.mockRejectedValue(filesystemError("EACCES"));

    await expect(service.createFileFromObject("object-1", "notes.md")).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(restoreTo).not.toHaveBeenCalled();
  });

  it("removes a partial restored object and records the object-store failure", async () => {
    const { service, run } = serviceHarness();
    const restoreTo = vi.fn(async () => { throw new Error("fabricated restore refusal"); });
    Object.assign(service, { objects: { restoreTo } });
    fakes.lstat.mockRejectedValue(filesystemError("ENOENT"));

    await expect(service.createFileFromObject("object-1", "notes.md")).rejects.toThrow(
      "fabricated restore refusal",
    );
    expect(fakes.rm).toHaveBeenCalledWith(`${rootPath}/notes.md`, { force: true });
    expect(run).toHaveBeenCalledWith(
      "failed",
      null,
      "fabricated restore refusal",
      "operation-id",
    );
  });

  it("records and rethrows a trash filesystem refusal", async () => {
    const { service } = serviceHarness();
    const updateOperation = vi.fn();
    Object.assign(service, {
      fileRow: vi.fn(() => ({ relative_path: "notes.md" })),
      verifyExpected: vi.fn(async () => "current-hash"),
      snapshot: vi.fn(async () => ({ id: "object-1" })),
      prepareOperation: vi.fn(() => "trash-operation"),
      updateOperation,
    });
    fakes.rm.mockRejectedValue(new Error("fabricated trash refusal"));

    await expect(service.trash("file-1")).rejects.toThrow("fabricated trash refusal");
    expect(updateOperation).toHaveBeenCalledWith(
      "trash-operation",
      "failed",
      undefined,
      "fabricated trash refusal",
    );
  });
});
