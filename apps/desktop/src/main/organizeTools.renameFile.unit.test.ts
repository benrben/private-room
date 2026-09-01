import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFileLikeQualified: vi.fn(),
  renameFile: vi.fn(),
}));

vi.mock("./db-host/files.js", () => ({
  availableName: vi.fn(),
  fileByExactName: vi.fn(),
  findFileLikeQualified: mocks.findFileLikeQualified,
  findImageLike: vi.fn(),
  getFileExtractedText: vi.fn(),
  getFileMeta: vi.fn(),
  inTransaction: vi.fn(),
  renameFile: mocks.renameFile,
  setFileExtractedText: vi.fn(),
  setLibraryVisibility: vi.fn(),
  updateFileContent: vi.fn(),
}));
vi.mock("./db-host/folders.js", () => ({
  createFolder: vi.fn(),
  listFolders: vi.fn(),
  moveFileToFolder: vi.fn(),
}));
vi.mock("./db-host/versions.js", () => ({ setFileProvenance: vi.fn(), snapshotFileVersion: vi.fn() }));
vi.mock("./db-host/artifacts.js", () => ({
  commitStaged: vi.fn(),
  discardStaged: vi.fn(),
  provenanceToJson: vi.fn(),
  stageArtifact: vi.fn(),
}));
vi.mock("./organize.js", () => ({
  MAX_BULK_FILES: 100,
  merge: vi.fn(),
  organize: vi.fn(),
  organizeSentence: vi.fn(),
  trashNamed: vi.fn(),
}));
vi.mock("./bulkReport.js", () => ({ bulkReportChangedAnything: vi.fn(), bulkReportSentence: vi.fn() }));
vi.mock("./docsHtml.js", () => ({
  htmlDocument: vi.fn(),
  isScratchPadName: vi.fn(),
  noteMime: vi.fn(),
  SCRATCH_PAD_NAME: "Scratch pad.md",
}));

import { execRenameFile } from "./organizeTools.js";

const fakeDb = {} as Parameters<typeof execRenameFile>[0];

beforeEach(() => vi.resetAllMocks());

describe("execRenameFile with fabricated file and event boundaries", () => {
  it("refuses a blank target name before resolving a file", () => {
    const result = execRenameFile(fakeDb, { name: "draft.md", new_name: "  " }, { wrote: false });

    expect(result).toEqual({ ok: false, error: "new_name is required." });
    expect(mocks.findFileLikeQualified).not.toHaveBeenCalled();
  });

  it("returns the fabricated lookup failure without attempting a rename", () => {
    mocks.findFileLikeQualified.mockImplementation(() => {
      throw new Error("No matching file");
    });

    expect(execRenameFile(fakeDb, { name: "missing", new_name: "renamed" }, { wrote: false })).toEqual({
      ok: false,
      error: "No matching file",
    });
    expect(mocks.renameFile).not.toHaveBeenCalled();
  });

  it("keeps an explicitly supplied extension and emits both refresh events", () => {
    mocks.findFileLikeQualified.mockReturnValue(["file-1", "draft.md"]);
    const events: Array<[string, unknown]> = [];
    const effects = { wrote: false };

    const result = execRenameFile(
      fakeDb,
      { name: "draft.md", new_name: "  revised.txt  " },
      effects,
      (event, payload) => events.push([event, payload]),
    );

    expect(mocks.renameFile).toHaveBeenCalledWith(fakeDb, "file-1", "revised.txt");
    expect(events).toEqual([
      ["room-files-changed", undefined],
      ["file-updated", "file-1"],
    ]);
    expect(effects.wrote).toBe(true);
    expect(result).toEqual({ ok: true, text: 'Renamed "draft.md" to "revised.txt".' });
  });

  it("restores the original extension when the fabricated target omits one", () => {
    mocks.findFileLikeQualified.mockReturnValue(["file-2", "Invoices/q3.PDF"]);

    expect(execRenameFile(fakeDb, { name: "Invoices/q3.PDF", new_name: "Q3 final" }, { wrote: false })).toEqual({
      ok: true,
      text: 'Renamed "Invoices/q3.PDF" to "Q3 final.pdf".',
    });
    expect(mocks.renameFile).toHaveBeenCalledWith(fakeDb, "file-2", "Q3 final.pdf");
  });

  it("leaves an extensionless file extensionless and returns a fabricated rename failure", () => {
    mocks.findFileLikeQualified.mockReturnValue(["file-3", "README"]);
    mocks.renameFile.mockImplementation(() => {
      throw new Error("destination already exists");
    });
    const effects = { wrote: false };

    expect(execRenameFile(fakeDb, { name: "README", new_name: "Guide" }, effects)).toEqual({
      ok: false,
      error: "destination already exists",
    });
    expect(mocks.renameFile).toHaveBeenCalledWith(fakeDb, "file-3", "Guide");
    expect(effects.wrote).toBe(false);
  });
});
