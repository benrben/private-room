import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  files: {
    availableName: vi.fn(),
    fileByExactName: vi.fn(),
    findFileLikeQualified: vi.fn(),
    findImageLike: vi.fn(),
    getFileExtractedText: vi.fn(),
    getFileMeta: vi.fn(),
    inTransaction: vi.fn(),
    renameFile: vi.fn(),
    setFileExtractedText: vi.fn(),
    setLibraryVisibility: vi.fn(),
    updateFileContent: vi.fn(),
  },
  folders: {
    createFolder: vi.fn(),
    listFolders: vi.fn(),
    moveFileToFolder: vi.fn(),
  },
  versions: {
    setFileProvenance: vi.fn(),
    snapshotFileVersion: vi.fn(),
  },
  artifacts: {
    commitStaged: vi.fn(),
    discardStaged: vi.fn(),
    provenanceToJson: vi.fn(),
    stageArtifact: vi.fn(),
  },
  organize: {
    MAX_BULK_FILES: 200,
    merge: vi.fn(),
    organize: vi.fn(),
    organizeSentence: vi.fn(),
    trashNamed: vi.fn(),
  },
  bulk: {
    bulkReportChangedAnything: vi.fn(),
    bulkReportSentence: vi.fn(),
  },
  docs: {
    htmlDocument: vi.fn(),
    isScratchPadName: vi.fn(),
    noteMime: vi.fn(),
    SCRATCH_PAD_NAME: "Scratch pad.md",
  },
}));

vi.mock("./db-host/files.js", () => fakes.files);
vi.mock("./db-host/folders.js", () => fakes.folders);
vi.mock("./db-host/versions.js", () => fakes.versions);
vi.mock("./db-host/artifacts.js", () => fakes.artifacts);
vi.mock("./organize.js", () => fakes.organize);
vi.mock("./bulkReport.js", () => fakes.bulk);
vi.mock("./docsHtml.js", () => fakes.docs);

import {
  execCreateFile,
  execCreateFileWorkspace,
  execMergeFilesWorkspace,
  execMoveFile,
  execMoveFileWorkspace,
  execOrganizeFiles,
  execRenameFileWorkspace,
  execSetInLibrary,
  execTrashFilesWorkspace,
} from "./organizeTools.js";

function responseDb(hash = "old-hash") {
  return {
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ content_sha256: hash })) })),
  };
}

function fakeEffects() {
  return { wrote: false };
}

beforeEach(() => {
  vi.resetAllMocks();
  fakes.docs.isScratchPadName.mockImplementation(
    (name: string) => name.trim().toLowerCase() === "scratch pad" || name === "Scratch pad.md",
  );
  fakes.docs.noteMime.mockReturnValue("text/markdown");
  fakes.docs.htmlDocument.mockImplementation((name: string, content: string) => `${name}\n${content}`);
  fakes.files.availableName.mockImplementation((_db: unknown, name: string) => name);
  fakes.artifacts.provenanceToJson.mockReturnValue('{"tool":"create_file"}');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("workspace scratch-pad rewrites with fabricated boundaries", () => {
  it("snapshots and rewrites the existing scratch pad before reporting its two room events", async () => {
    const db = responseDb();
    const existing = { id: "scratch-id", name: "Scratch pad.md" };
    const written: string[] = [];
    const workspace = {
      snapshotVersion: vi.fn(async () => undefined),
      writeAtomic: vi.fn(async (_id: string, stream: AsyncIterable<Uint8Array>) => {
        for await (const chunk of stream) written.push(Buffer.from(chunk).toString("utf8"));
      }),
    };
    const effects = fakeEffects();
    const emitted: Array<[string, unknown]> = [];
    fakes.files.fileByExactName.mockReturnValue(existing);

    const result = await execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "scratch pad", content: "revised notes" },
      effects,
      { emit: (event, payload) => emitted.push([event, payload]) },
    );

    expect(result).toEqual({
      ok: true,
      text: '"Scratch pad.md" already exists — rewrote it instead of creating a duplicate. The previous notes are kept in History.',
    });
    expect(workspace.snapshotVersion).toHaveBeenCalledWith("scratch-id", "AI edit");
    expect(workspace.writeAtomic).toHaveBeenCalledWith("scratch-id", expect.anything(), "old-hash");
    expect(written).toEqual(["revised notes"]);
    expect(fakes.files.setFileExtractedText).toHaveBeenCalledWith(db, "scratch-id", "revised notes");
    expect(fakes.versions.setFileProvenance).toHaveBeenCalledWith(
      db,
      "scratch-id",
      '{"tool":"create_file"}',
    );
    expect(effects.wrote).toBe(true);
    expect(emitted).toEqual([
      ["room-files-changed", undefined],
      ["file-updated", "scratch-id"],
    ]);
  });

  it("refuses blank or cancelled scratch-pad rewrites without contacting the fabricated workspace", async () => {
    const db = responseDb();
    const existing = { id: "scratch-id", name: "Scratch pad.md" };
    const workspace = { snapshotVersion: vi.fn(), writeAtomic: vi.fn() };
    fakes.files.fileByExactName.mockReturnValue(existing);

    const blank = await execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "scratch pad", content: "  \n  " },
      fakeEffects(),
    );
    expect(blank).toEqual({
      ok: false,
      error: 'Nothing was generated for "Scratch pad.md" — it was left as it was.',
    });

    const cancelled = await execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "scratch pad", content: "replacement" },
      fakeEffects(),
      { cancel: { load: () => true } },
    );
    expect(cancelled).toEqual({
      ok: false,
      error: 'Stopped before "Scratch pad.md" was rewritten — nothing was written to the room.',
    });
    expect(workspace.snapshotVersion).not.toHaveBeenCalled();
    expect(workspace.writeAtomic).not.toHaveBeenCalled();
  });

  it("returns a fabricated workspace failure without claiming the scratch pad changed", async () => {
    const db = responseDb();
    const workspace = {
      snapshotVersion: vi.fn(async () => { throw new Error("fake snapshot failure"); }),
      writeAtomic: vi.fn(),
    };
    const effects = fakeEffects();
    const emit = vi.fn();
    fakes.files.fileByExactName.mockReturnValue({ id: "scratch-id", name: "Scratch pad.md" });

    await expect(execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "scratch pad", content: "replacement" },
      effects,
      { emit },
    )).resolves.toEqual({ ok: false, error: "fake snapshot failure" });
    expect(workspace.writeAtomic).not.toHaveBeenCalled();
    expect(effects.wrote).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

function generatedWorkspaceDb(existing?: { id: string; content_sha256: string | null }) {
  const select = { get: vi.fn(() => existing) };
  const update = { run: vi.fn() };
  const db = {
    prepare: vi.fn((sql: string) => (
      sql.includes("SELECT id, content_sha256 FROM files") ? select : update
    )),
    transaction: vi.fn((work: () => void) => () => work()),
  };
  return { db, update };
}

describe("workspace generated documents with fabricated artifact and stream boundaries", () => {
  it("creates a normal generated document when no matching workspace file exists", async () => {
    const { db, update } = generatedWorkspaceDb();
    const streamed: string[] = [];
    const workspace = {
      createFile: vi.fn(async (_name: string, stream: AsyncIterable<Uint8Array>) => {
        for await (const chunk of stream) streamed.push(Buffer.from(chunk).toString("utf8"));
        return { fileId: "created-file" };
      }),
      snapshotVersion: vi.fn(),
      writeAtomic: vi.fn(),
    };
    const effects = fakeEffects();
    const emit = vi.fn();
    fakes.artifacts.stageArtifact.mockReturnValue({ id: "staged-file", name: "Daily.md" });
    fakes.files.getFileMeta.mockReturnValue({ id: "created-file", name: "Daily.md" });

    await expect(execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "Daily.md", content: "fabricated notes" },
      effects,
      { emit, runId: "fake-run" },
    )).resolves.toEqual({ ok: true, text: 'Created "Daily.md" in the room.' });

    expect(streamed).toEqual(["fabricated notes"]);
    expect(workspace.snapshotVersion).not.toHaveBeenCalled();
    expect(workspace.createFile).toHaveBeenCalledWith("Daily.md", expect.anything(), "generated");
    expect(fakes.files.setFileExtractedText).toHaveBeenCalledWith(db, "created-file", "fabricated notes");
    expect(update.run).toHaveBeenCalledWith(
      "text/markdown",
      '{"tool":"create_file"}',
      "Daily.md",
      "created-file",
    );
    expect(fakes.artifacts.discardStaged).toHaveBeenCalledWith(db, "staged-file");
    expect(effects.wrote).toBe(true);
    expect(emit).toHaveBeenCalledWith("room-files-changed", undefined);
  });

  it("versions an existing generated document instead of creating a duplicate", async () => {
    const { db, update } = generatedWorkspaceDb({ id: "existing-file", content_sha256: "old-hash" });
    const streamed: string[] = [];
    const workspace = {
      createFile: vi.fn(),
      snapshotVersion: vi.fn(async () => undefined),
      writeAtomic: vi.fn(async (_id: string, stream: AsyncIterable<Uint8Array>) => {
        for await (const chunk of stream) streamed.push(Buffer.from(chunk).toString("utf8"));
      }),
    };
    fakes.artifacts.stageArtifact.mockReturnValue({ id: "staged-file", name: "Daily.md" });
    fakes.files.getFileMeta.mockReturnValue({ id: "existing-file", name: "Daily.md" });

    await expect(execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "Daily.md", content: "updated fake notes" },
      fakeEffects(),
    )).resolves.toEqual({
      ok: true,
      text: '"Daily.md" already existed — rewrote it instead of creating a duplicate. The previous version is kept in History.',
    });

    expect(workspace.snapshotVersion).toHaveBeenCalledWith("existing-file", "AI regenerated");
    expect(workspace.writeAtomic).toHaveBeenCalledWith("existing-file", expect.anything(), "old-hash");
    expect(streamed).toEqual(["updated fake notes"]);
    expect(workspace.createFile).not.toHaveBeenCalled();
    expect(update.run).toHaveBeenCalledWith(
      "text/markdown",
      '{"tool":"create_file"}',
      "Daily.md",
      "existing-file",
    );

    const { db: hashlessDb } = generatedWorkspaceDb({ id: "hashless-file", content_sha256: null });
    await expect(execCreateFileWorkspace(
      hashlessDb as never,
      workspace as never,
      { name: "Daily.md", content: "hashless fake notes" },
      fakeEffects(),
    )).resolves.toEqual({
      ok: true,
      text: '"Daily.md" already existed — rewrote it instead of creating a duplicate. The previous version is kept in History.',
    });
    expect(workspace.writeAtomic).toHaveBeenLastCalledWith("hashless-file", expect.anything(), undefined);
  });

  it("refuses a cancelled generated write after staging but before fake workspace activity", async () => {
    const { db } = generatedWorkspaceDb();
    const workspace = { createFile: vi.fn(), snapshotVersion: vi.fn(), writeAtomic: vi.fn() };
    const effects = fakeEffects();
    fakes.artifacts.stageArtifact.mockReturnValue({ id: "staged-file", name: "Daily.md" });

    await expect(execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "Daily.md", content: "cancelled notes" },
      effects,
      { cancel: { load: () => true } },
    )).resolves.toEqual({
      ok: false,
      error: 'Stopped before "Daily.md" was saved — nothing was written to the room.',
    });

    expect(fakes.artifacts.discardStaged).toHaveBeenCalledWith(db, "staged-file");
    expect(workspace.createFile).not.toHaveBeenCalled();
    expect(workspace.snapshotVersion).not.toHaveBeenCalled();
    expect(effects.wrote).toBe(false);
  });

  it("reports a fake workspace creation failure after discarding staged metadata", async () => {
    const { db } = generatedWorkspaceDb();
    const workspace = {
      createFile: vi.fn(async () => { throw new Error("fabricated workspace write failure"); }),
      snapshotVersion: vi.fn(),
      writeAtomic: vi.fn(),
    };
    const effects = fakeEffects();
    const emit = vi.fn();
    fakes.artifacts.stageArtifact.mockReturnValue({ id: "staged-file", name: "Daily.md" });

    await expect(execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "Daily.md", content: "failed notes" },
      effects,
      { emit },
    )).resolves.toEqual({ ok: false, error: "fabricated workspace write failure" });

    expect(fakes.artifacts.discardStaged).toHaveBeenCalledWith(db, "staged-file");
    expect(effects.wrote).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("creates the canonical scratch pad when the lookup finds no existing pad", async () => {
    const { db } = generatedWorkspaceDb();
    const workspace = {
      createFile: vi.fn(async () => ({ fileId: "created-scratch" })),
      snapshotVersion: vi.fn(),
      writeAtomic: vi.fn(),
    };
    fakes.files.fileByExactName.mockReturnValue(null);
    fakes.artifacts.stageArtifact.mockReturnValue({ id: "staged-scratch", name: "Scratch pad.md" });
    fakes.files.getFileMeta.mockReturnValue({ id: "created-scratch", name: "Scratch pad.md" });

    await expect(execCreateFileWorkspace(
      db as never,
      workspace as never,
      { name: "scratch pad", content: "first notes" },
      fakeEffects(),
    )).resolves.toEqual({ ok: true, text: 'Created "Scratch pad.md" in the room.' });

    expect(workspace.createFile).toHaveBeenCalledWith("Scratch pad.md", expect.anything(), "generated");
    expect(fakes.artifacts.discardStaged).toHaveBeenCalledWith(db, "staged-scratch");
  });
});

describe("legacy organize failures through fabricated database boundaries", () => {
  it("keeps successful library changes successful when both UI events throw", () => {
    const effects = fakeEffects();
    fakes.files.findFileLikeQualified.mockReturnValue(["file-1", "Report.md"]);

    expect(execSetInLibrary(
      {} as never,
      { name: "Report.md", in_library: false },
      effects,
      () => { throw new Error("fabricated closed event sink"); },
    )).toEqual({
      ok: true,
      text: 'Removed "Report.md" from the Library. The object itself is untouched and still in its own section.',
    });
    expect(effects.wrote).toBe(true);
  });

  it("reports visibility, destination, and organize failures without claiming a write", () => {
    const db = {} as never;
    fakes.files.findFileLikeQualified.mockReturnValue(["file-1", "Report.md"]);
    fakes.files.setLibraryVisibility.mockImplementation(() => { throw new Error("visibility refused"); });
    expect(execSetInLibrary(db, { name: "Report.md" }, fakeEffects())).toEqual({
      ok: false,
      error: "visibility refused",
    });

    fakes.folders.listFolders.mockImplementation(() => { throw new Error("folders unreadable"); });
    expect(execMoveFile(db, { name: "Report.md", folder: "Archive" }, fakeEffects())).toEqual({
      ok: false,
      error: "folders unreadable",
    });

    fakes.organize.organize.mockImplementation(() => { throw new Error("organize refused"); });
    expect(execOrganizeFiles(db, { make_folders: ["Archive"] }, fakeEffects())).toEqual({
      ok: false,
      error: "organize refused",
    });
  });

  it("discards staged legacy metadata best-effort while preserving the commit failure", () => {
    const db = {} as never;
    const effects = fakeEffects();
    fakes.artifacts.stageArtifact.mockReturnValue({ id: "staged", name: "Report.html" });
    fakes.artifacts.commitStaged.mockImplementation(() => { throw new Error("commit refused"); });
    fakes.artifacts.discardStaged.mockImplementation(() => { throw new Error("cleanup refused"); });

    expect(execCreateFile(
      db,
      { name: "Report", content: "body" },
      effects,
    )).toEqual({ ok: false, error: "commit refused" });
    expect(fakes.artifacts.discardStaged).toHaveBeenCalledWith(db, "staged");
    expect(effects.wrote).toBe(false);
  });
});

describe("workspace rename, move, and trash failures through fabricated boundaries", () => {
  function movableDb(hash = "old-hash") {
    return {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ relative_path: "Inbox/Report.md", content_sha256: hash })),
      })),
    };
  }

  it("reports workspace rename and move refusals without emitting a success event", async () => {
    const db = movableDb();
    const workspace = { move: vi.fn(async () => { throw new Error("move refused"); }) };
    const emit = vi.fn();
    fakes.files.findFileLikeQualified.mockReturnValue(["file-1", "Report.md"]);

    await expect(execRenameFileWorkspace(
      db as never,
      workspace as never,
      { name: "Report.md", new_name: "Renamed" },
      fakeEffects(),
      emit,
    )).resolves.toEqual({ ok: false, error: "move refused" });
    await expect(execMoveFileWorkspace(
      db as never,
      workspace as never,
      { name: "Report.md", folder: "Archive" },
      fakeEffects(),
      emit,
    )).resolves.toEqual({ ok: false, error: "move refused" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("moves a workspace file to the top level with its current content hash", async () => {
    const db = movableDb();
    const workspace = { move: vi.fn(async () => undefined) };
    const effects = fakeEffects();
    fakes.files.findFileLikeQualified.mockReturnValue(["file-1", "Report.md"]);

    await expect(execMoveFileWorkspace(
      db as never,
      workspace as never,
      { name: "Report.md", folder: "top" },
      effects,
    )).resolves.toEqual({ ok: true, text: 'Moved "Report.md" to the top level.' });
    expect(workspace.move).toHaveBeenCalledWith("file-1", "Report.md", "old-hash");
    expect(effects.wrote).toBe(true);
  });

  it("reports malformed or wholly missing trash requests without claiming a write", async () => {
    const workspace = { trash: vi.fn() };
    expect(await execTrashFilesWorkspace(
      {} as never,
      workspace as never,
      { names: ["Report.md", 42] },
      fakeEffects(),
    )).toEqual({ ok: false, error: "trash_files needs at least one file name." });

    fakes.files.findFileLikeQualified.mockImplementation(() => { throw new Error("missing"); });
    const effects = fakeEffects();
    expect(await execTrashFilesWorkspace(
      {} as never,
      workspace as never,
      { names: ["Report.md"] },
      effects,
    )).toEqual({
      ok: true,
      text: 'Nothing was moved to the trash. Not found: "Report.md". They are recoverable from Library → Trash.',
    });
    expect(effects.wrote).toBe(false);
    expect(workspace.trash).not.toHaveBeenCalled();
  });
});

describe("workspace merges with fabricated source and trash boundaries", () => {
  function mergeDb() {
    return {
      prepare: vi.fn((_query: string) => ({
        get: (id: string) => ({ relative_path: `${id}.md`, content_sha256: `hash-${id}` }),
      })),
    };
  }

  function readableSources() {
    fakes.files.findFileLikeQualified.mockImplementation((_db: unknown, name: string) => {
      if (name === "first") return ["file-1", "First.md"];
      if (name === "second") return ["file-2", "Second.md"];
      throw new Error("missing fake source");
    });
    fakes.files.getFileExtractedText.mockImplementation((_db: unknown, id: string) => (
      id === "file-1" ? "first text" : "second text"
    ));
  }

  it("refuses a fabricated merge with fewer than two readable sources before creating anything", async () => {
    const workspace = { createFile: vi.fn(), trash: vi.fn() };
    fakes.files.findFileLikeQualified.mockReturnValue(["file-1", "First.md"]);
    fakes.files.getFileExtractedText.mockReturnValue("first text");

    await expect(execMergeFilesWorkspace(
      mergeDb() as never,
      workspace as never,
      { names: ["first"] },
      fakeEffects(),
    )).resolves.toEqual({
      ok: false,
      error: "merge_files needs at least two files with readable text.",
    });
    expect(workspace.createFile).not.toHaveBeenCalled();
    expect(workspace.trash).not.toHaveBeenCalled();
  });

  it("treats a source lookup failure as unreadable instead of aborting the merge", async () => {
    const workspace = { createFile: vi.fn(), trash: vi.fn() };
    readableSources();

    await expect(execMergeFilesWorkspace(
      mergeDb() as never,
      workspace as never,
      { names: ["first", "missing"] },
      fakeEffects(),
    )).resolves.toEqual({
      ok: false,
      error: "merge_files needs at least two files with readable text.",
    });
    expect(workspace.createFile).not.toHaveBeenCalled();
  });

  it("creates a merged fake stream, then trashes each original with its current hash", async () => {
    const db = mergeDb();
    const created: string[] = [];
    const workspace = {
      createFile: vi.fn(async (_name: string, stream: AsyncIterable<Uint8Array>) => {
        for await (const chunk of stream) created.push(Buffer.from(chunk).toString("utf8"));
        return { fileId: "merged-id" };
      }),
      trash: vi.fn(async () => undefined),
    };
    const effects = fakeEffects();
    const emitted: Array<[string, unknown]> = [];
    readableSources();
    fakes.files.availableName.mockReturnValue("Combined.md");

    const result = await execMergeFilesWorkspace(
      db as never,
      workspace as never,
      { names: ["first", "second"], into: "Combined", headings: false, trash_sources: true },
      effects,
      (event, payload) => emitted.push([event, payload]),
    );

    expect(result).toEqual({
      ok: true,
      text: 'Merged 2 files into "Combined.md" (23 characters) and moved the originals to the trash.',
    });
    expect(created).toEqual(["first text\n\nsecond text"]);
    expect(fakes.files.setFileExtractedText).toHaveBeenCalledWith(
      db,
      "merged-id",
      "first text\n\nsecond text",
    );
    expect(workspace.trash).toHaveBeenNthCalledWith(1, "file-1", "hash-file-1");
    expect(workspace.trash).toHaveBeenNthCalledWith(2, "file-2", "hash-file-2");
    expect(effects.wrote).toBe(true);
    expect(emitted).toEqual([["room-files-changed", undefined]]);
  });

  it("returns a fabricated source-trash failure without a success event or write flag", async () => {
    const db = mergeDb();
    const workspace = {
      createFile: vi.fn(async () => ({ fileId: "merged-id" })),
      trash: vi.fn(async () => { throw new Error("fake source trash failure"); }),
    };
    const effects = fakeEffects();
    const emit = vi.fn();
    readableSources();
    fakes.files.availableName.mockReturnValue("Combined.md");

    await expect(execMergeFilesWorkspace(
      db as never,
      workspace as never,
      { names: ["first", "second"], headings: true, trash_sources: true },
      effects,
      emit,
    )).resolves.toEqual({ ok: false, error: "fake source trash failure" });
    expect(workspace.trash).toHaveBeenCalledOnce();
    expect(effects.wrote).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
