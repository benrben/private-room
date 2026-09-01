import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  assertNoSymlinkSegments: vi.fn(),
  createHash: vi.fn(),
  lstatSync: vi.fn(),
  mkdir: vi.fn(),
  open: vi.fn(),
  randomUUID: vi.fn(),
  resolveWorkspacePath: vi.fn(),
}));

vi.mock("node:crypto", () => ({ createHash: fakes.createHash, randomUUID: fakes.randomUUID }));
vi.mock("node:fs", () => ({
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
  lstatSync: fakes.lstatSync,
}));
vi.mock("node:fs/promises", () => ({
  chmod: vi.fn(),
  link: vi.fn(),
  lstat: vi.fn(),
  mkdir: fakes.mkdir,
  open: fakes.open,
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  rmdir: vi.fn(),
}));
vi.mock("../db-host/versions.js", () => ({ VERSIONS_KEPT: 10 }));
vi.mock("../db-host/files.js", () => ({ clearChunks: vi.fn() }));
vi.mock("./contentObjects.js", () => ({ ContentObjectStore: class ContentObjectStore {} }));
vi.mock("./manifest.js", () => ({ scanWorkspaceManifest: vi.fn() }));
vi.mock("./pathSafety.js", () => ({
  assertNoSymlinkSegments: fakes.assertNoSymlinkSegments,
  normalizeRelativePath: vi.fn(),
  pathKey: vi.fn(),
  resolveWorkspacePath: fakes.resolveWorkspacePath,
}));

import { WorkspaceService, type WorkspaceDirectoryState } from "./workspaceService.js";

const rootPath = "/fabricated/workspace";
const destination = "/fabricated/workspace/Archive";

function directory(relativePath: string, exists: boolean): WorkspaceDirectoryState {
  return { relativePath, exists, empty: !exists, fsIdentity: exists ? "fabricated:directory" : null };
}

function fakeWorkspace() {
  const run = vi.fn();
  const db = { prepare: vi.fn(() => ({ run })) };
  const workspace = new WorkspaceService(db as never, rootPath, "/fabricated/private");
  return { db, run, workspace };
}

describe("WorkspaceService.createDirectory with fabricated boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fakes.lstatSync.mockReturnValue({ isSymbolicLink: () => false });
    fakes.randomUUID.mockReturnValue("fabricated-operation");
    fakes.resolveWorkspacePath.mockReturnValue(destination);
    fakes.assertNoSymlinkSegments.mockResolvedValue(undefined);
    fakes.open.mockResolvedValue({ sync: vi.fn(), close: vi.fn() });
  });

  it("leaves an already present fabricated directory untouched", async () => {
    const { db, workspace } = fakeWorkspace();
    vi.spyOn(workspace, "directoryState").mockResolvedValue(directory("Archive", true));

    await expect(workspace.createDirectory("Archive")).resolves.toBe(false);

    expect(fakes.mkdir).not.toHaveBeenCalled();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("records every commit phase after creating a fabricated directory", async () => {
    const { run, workspace } = fakeWorkspace();
    vi.spyOn(workspace, "directoryState")
      .mockResolvedValueOnce(directory("Archive", false))
      .mockResolvedValueOnce(directory("Archive", true));
    fakes.mkdir.mockResolvedValue(destination);

    await expect(workspace.createDirectory("Archive")).resolves.toBe(true);

    expect(fakes.mkdir).toHaveBeenCalledWith(destination, { recursive: true });
    expect(fakes.assertNoSymlinkSegments).toHaveBeenCalledWith(rootPath, "Archive");
    expect(fakes.open).toHaveBeenCalledWith(rootPath, "r");
    expect(run).toHaveBeenCalledWith("fabricated-operation", "create_directory", null, null, "Archive", null, null);
    expect(run).toHaveBeenCalledWith("filesystem_committed", null, null, "fabricated-operation");
    expect(run).toHaveBeenCalledWith("database_committed", null, null, "fabricated-operation");
    expect(run).toHaveBeenCalledWith("completed", null, null, "fabricated-operation");
  });

  it("reports no creation when a fabricated concurrent creator wins the race", async () => {
    const { run, workspace } = fakeWorkspace();
    vi.spyOn(workspace, "directoryState")
      .mockResolvedValueOnce(directory("Archive", false))
      .mockResolvedValueOnce(directory("Archive", true));
    fakes.mkdir.mockResolvedValue(undefined);

    await expect(workspace.createDirectory("Archive")).resolves.toBe(false);

    expect(run).toHaveBeenCalledWith("completed", null, null, "fabricated-operation");
  });

  it("records a failure when the fabricated directory is still absent after mkdir", async () => {
    const { run, workspace } = fakeWorkspace();
    vi.spyOn(workspace, "directoryState")
      .mockResolvedValueOnce(directory("Archive", false))
      .mockResolvedValueOnce(directory("Archive", false));
    fakes.mkdir.mockResolvedValue(destination);

    await expect(workspace.createDirectory("Archive")).rejects.toThrow("The folder was not created.");

    expect(run).toHaveBeenCalledWith("failed", null, "The folder was not created.", "fabricated-operation");
  });

  it("records and rethrows a fabricated mkdir failure", async () => {
    const { run, workspace } = fakeWorkspace();
    vi.spyOn(workspace, "directoryState").mockResolvedValue(directory("Archive", false));
    fakes.mkdir.mockRejectedValue(new Error("fabricated mkdir refusal"));

    await expect(workspace.createDirectory("Archive")).rejects.toThrow("fabricated mkdir refusal");

    expect(run).toHaveBeenCalledWith("failed", null, "fabricated mkdir refusal", "fabricated-operation");
  });

  it("records a fabricated non-Error mkdir rejection without losing its message", async () => {
    const { run, workspace } = fakeWorkspace();
    vi.spyOn(workspace, "directoryState").mockResolvedValue(directory("Archive", false));
    fakes.mkdir.mockRejectedValue("fabricated string refusal");

    await expect(workspace.createDirectory("Archive")).rejects.toBe("fabricated string refusal");

    expect(run).toHaveBeenCalledWith("failed", null, "fabricated string refusal", "fabricated-operation");
  });
});
