import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  appendIntoHtml: vi.fn(),
  availableName: vi.fn(),
  getFileExtractedText: vi.fn(),
  getFileMeta: vi.fn(),
  queryOpt: vi.fn(),
  setFileExtractedText: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  availableName: fakes.availableName,
  currentDate: vi.fn(),
  getFileExtractedText: fakes.getFileExtractedText,
  getFileMeta: fakes.getFileMeta,
  inTransaction: vi.fn(),
  insertFile: vi.fn(),
  listFilesBrief: vi.fn(),
  newSourceFileCount: vi.fn(),
  setFileAiSummary: vi.fn(),
  setFileExtractedText: fakes.setFileExtractedText,
  updateFileContent: vi.fn(),
}));
vi.mock("./db-host/util.js", () => ({ queryOpt: fakes.queryOpt, queryRows: vi.fn() }));
vi.mock("./workflowSaveFile.js", () => ({
  appendIntoHtml: fakes.appendIntoHtml,
  cleanSaveName: vi.fn((name: string) => name),
  MAX_SAVE_NAME_CHARS: 120,
}));
vi.mock("./docsHtml.js", () => ({ htmlDocument: vi.fn() }));

import { saveFileNodeHybrid, saveNamedWorkspaceOutput } from "./workflowEngine.js";

const target = {
  content: "fresh workflow output",
  extension: "md",
  mime: "text/markdown",
  name: "Workflow output.md",
};

function fakeDb(row: { storage_kind: string; content_sha256: string | null } | undefined = {
  storage_kind: "workspace",
  content_sha256: "sha-before-write",
}) {
  const get = vi.fn(() => row);
  const run = vi.fn();
  const prepare = vi.fn((sql: string) => (
    sql.startsWith("SELECT storage_kind") ? { get } : { run }
  ));
  return { get, prepare, run };
}

function fakeWorkspace() {
  return {
    createFile: vi.fn(async () => ({ fileId: "created-file" })),
    snapshotVersion: vi.fn(async () => undefined),
    writeAtomic: vi.fn(async () => undefined),
  };
}

async function streamText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

beforeEach(() => {
  vi.resetAllMocks();
  fakes.appendIntoHtml.mockImplementation((existing: string, _name: string, inputs: string) => `${existing}\n<hr/>\n${inputs}`);
  fakes.availableName.mockImplementation((_: unknown, name: string) => `unique-${name}`);
  fakes.getFileExtractedText.mockReturnValue("existing workflow output");
  fakes.getFileMeta.mockImplementation((_db: unknown, id: string) => ({ id, name: `meta-${id}` }));
  fakes.queryOpt.mockReturnValue(null);
});

describe("saveNamedWorkspaceOutput with fabricated workspace storage", () => {
  it("creates a unique generated workspace file for a non-reusing mode", async () => {
    const db = fakeDb();
    const workspace = fakeWorkspace();

    await expect(saveNamedWorkspaceOutput(db as never, workspace as never, target, "new", "ignored", "Workflow saved"))
      .resolves.toEqual({ id: "created-file", name: "meta-created-file" });

    expect(fakes.queryOpt).not.toHaveBeenCalled();
    expect(fakes.availableName).toHaveBeenCalledWith(db, target.name);
    expect(workspace.createFile).toHaveBeenCalledWith("unique-Workflow output.md", expect.anything(), "generated");
    expect(await streamText(workspace.createFile.mock.calls[0]![1])).toBe(target.content);
    expect(fakes.setFileExtractedText).toHaveBeenCalledWith(db, "created-file", target.content);
  });

  it("creates a new file when the named generated result is absent or not workspace-backed", async () => {
    const db = fakeDb();
    const workspace = fakeWorkspace();
    fakes.queryOpt.mockReturnValueOnce(null).mockReturnValueOnce({ id: "legacy-file", storageKind: "blob" });

    await saveNamedWorkspaceOutput(db as never, workspace as never, target, "overwrite", "ignored", "Overwrite workflow output");
    await saveNamedWorkspaceOutput(db as never, workspace as never, target, "append", "ignored", "Append workflow output");

    expect(fakes.queryOpt).toHaveBeenCalledTimes(2);
    expect(workspace.createFile).toHaveBeenCalledTimes(2);
    expect(workspace.snapshotVersion).not.toHaveBeenCalled();
  });

  it("overwrites a named workspace result with the exact fabricated snapshot precondition", async () => {
    const db = fakeDb();
    const workspace = fakeWorkspace();
    fakes.queryOpt.mockReturnValue({ id: "workspace-file", storageKind: "workspace" });

    await expect(saveNamedWorkspaceOutput(
      db as never,
      workspace as never,
      target,
      "overwrite",
      "ignored",
      "Overwrite workflow output",
    )).resolves.toEqual({ id: "workspace-file", name: "meta-workspace-file" });

    expect(workspace.snapshotVersion).toHaveBeenCalledWith("workspace-file", "Overwrite workflow output");
    expect(workspace.writeAtomic).toHaveBeenCalledWith("workspace-file", expect.anything(), "sha-before-write");
    expect(await streamText(workspace.writeAtomic.mock.calls[0]![1])).toBe(target.content);
    expect(fakes.setFileExtractedText).toHaveBeenCalledWith(db, "workspace-file", target.content);
    expect(db.run).toHaveBeenCalledWith(target.mime, "workspace-file");
  });

  it("appends markdown input to the stored workspace text before writing", async () => {
    const db = fakeDb();
    const workspace = fakeWorkspace();
    fakes.queryOpt.mockReturnValue({ id: "workspace-file", storageKind: "workspace" });
    fakes.getFileExtractedText.mockReturnValue("previous workflow output");

    await saveNamedWorkspaceOutput(db as never, workspace as never, target, "append", "next workflow output", "Append workflow output");

    expect(fakes.getFileExtractedText).toHaveBeenCalledWith(db, "workspace-file");
    expect(await streamText(workspace.writeAtomic.mock.calls[0]![1]))
      .toBe("previous workflow output\n\nnext workflow output");
    expect(fakes.setFileExtractedText).toHaveBeenCalledWith(
      db,
      "workspace-file",
      "previous workflow output\n\nnext workflow output",
    );
  });

  it("refuses a found row that is no longer an ordinary workspace file before snapshotting", async () => {
    const db = fakeDb({ storage_kind: "blob", content_sha256: null });
    const workspace = fakeWorkspace();
    fakes.queryOpt.mockReturnValue({ id: "workspace-file", storageKind: "workspace" });

    await expect(saveNamedWorkspaceOutput(db as never, workspace as never, target, "overwrite", "ignored", "Overwrite workflow output"))
      .rejects.toThrow("That workflow output is no longer a normal workspace file.");
    expect(workspace.snapshotVersion).not.toHaveBeenCalled();
    expect(workspace.writeAtomic).not.toHaveBeenCalled();
  });
});

describe("saveFileNodeHybrid recorded output recovery", () => {
  it("overwrites the recorded output when it is still workspace-backed", async () => {
    const db = fakeDb();
    const workspace = fakeWorkspace();
    const rooms = {
      current: () => ({ db, path: "room://fake", workspace }),
    };
    const published = { value: null };

    await expect(saveFileNodeHybrid(
      rooms as never,
      "room://fake",
      "Recovered.md",
      "md",
      "overwrite",
      "recovered output",
      { file_id: "workspace-output" } as never,
      published as never,
      "Recover workflow output",
    )).resolves.toEqual({
      result: 'Saved "meta-workspace-output" into the room.',
      fileId: "workspace-output",
    });

    expect(workspace.snapshotVersion).toHaveBeenCalledWith(
      "workspace-output",
      "Recover workflow output",
    );
    expect(workspace.writeAtomic).toHaveBeenCalledOnce();
    expect(workspace.createFile).not.toHaveBeenCalled();
    expect(published.value).toEqual({
      id: "workspace-output",
      name: "meta-workspace-output",
    });
  });

  it("creates a new workspace file when the recorded output is no longer workspace-backed", async () => {
    const db = fakeDb({ storage_kind: "blob", content_sha256: null });
    const workspace = fakeWorkspace();
    const rooms = {
      current: () => ({ db, path: "room://fake", workspace }),
    };
    const published = { value: null };

    await expect(saveFileNodeHybrid(
      rooms as never,
      "room://fake",
      "Recovered.md",
      "md",
      "overwrite",
      "recovered output",
      { file_id: "legacy-output" } as never,
      published as never,
      "Recover workflow output",
    )).resolves.toEqual({
      result: 'Saved "meta-created-file" into the room.',
      fileId: "created-file",
    });

    expect(workspace.createFile).toHaveBeenCalledTimes(1);
    expect(workspace.snapshotVersion).not.toHaveBeenCalled();
    expect(published.value).toEqual({ id: "created-file", name: "meta-created-file" });
  });
});
