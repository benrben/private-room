import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileMetaSuggestion, FileVersion } from "../api";
import type { WSState } from "./state";

const mocks = vi.hoisted(() => {
  const api = new Proxy<Record<string, ReturnType<typeof vi.fn>>>(
    {},
    {
      get(target, key: string) {
        return (target[key] ??= vi.fn());
      },
    },
  );
  return { api, suggestFileMeta: vi.fn() };
});

vi.mock("../api", () => ({
  api: mocks.api,
  suggestFileMeta: mocks.suggestFileMeta,
}));
vi.mock("./guard", () => ({
  tryToast: async (
    _state: unknown,
    action: () => Promise<unknown>,
    after?: () => Promise<unknown>,
  ) => {
    await action();
    await after?.();
  },
}));
vi.mock("../viewers/registry", () => ({ editModeOf: vi.fn(() => null) }));
vi.mock("./fileVisibility", () => ({ sectionLabel: vi.fn(() => "Library") }));

import { makeFileActions } from "./fileActions";

type MutableState = Record<string, any>;

function state(overrides: MutableState = {}): MutableState {
  const value: MutableState = {
    files: [
      { id: "one", name: "one.md" },
      { id: "two", name: "two.md" },
    ],
    folders: [],
    messages: [
      { id: "question", createdAt: "2026-08-01T10:00:00.000Z" },
      { id: "answer", createdAt: "2026-08-01T10:01:00.000Z" },
    ],
    undoByMsg: { answer: ["one", "two"] },
    openFileRef: {
      current: { id: "one", content: { name: "one.md", kind: "markdown" } },
    },
    openFile: {
      id: "one",
      content: { name: "one.md", kind: "markdown", text: "old" },
    },
    exportWarnedRef: { current: false },
    editorDirtyRef: { current: false },
    editModeRef: { current: false },
    importSuggestions: [],
    trashed: [{ id: "trash", name: "trash.md" }],
    attachments: [],
    recLive: null,
    selectedFileIds: new Set<string>(),
    selectionAnchor: null,
    visibleFileOrder: ["one", "two"],
    showHistory: false,
    creatingFolder: null,
    renamingFolder: null,
    renamingFile: null,
    collapsedFolders: new Set<string>(),
    pushToast: vi.fn(),
    ...overrides,
  };
  value.setUndoByMsg = vi.fn((next: unknown) => {
    value.undoByMsg = typeof next === "function" ? next(value.undoByMsg) : next;
  });
  value.setFiles = vi.fn((next: unknown) => {
    value.files = typeof next === "function" ? next(value.files) : next;
  });
  value.setOpenFile = vi.fn((next: unknown) => {
    value.openFileRef.current =
      typeof next === "function" ? next(value.openFileRef.current) : next;
  });
  value.setViewerRev = vi.fn();
  const setter = (method: string, property: string) => {
    value[method] = vi.fn((next: unknown) => {
      value[property] =
        typeof next === "function" ? next(value[property]) : next;
    });
  };
  setter("setAttachments", "attachments");
  setter("setCollapsedFolders", "collapsedFolders");
  setter("setCompare", "compare");
  setter("setConfirmRestore", "confirmRestore");
  setter("setCreatingFolder", "creatingFolder");
  setter("setEditMode", "editMode");
  setter("setFolders", "folders");
  setter("setHeadProvenance", "headProvenance");
  setter("setImportProgress", "importProgress");
  setter("setImportSuggestions", "importSuggestions");
  setter("setMoveMenuFor", "moveMenuFor");
  setter("setOpeningFileId", "openingFileId");
  setter("setPendingLeave", "pendingLeave");
  setter("setRecLive", "recLive");
  setter("setRenamingFile", "renamingFile");
  setter("setRenamingFolder", "renamingFolder");
  setter("setSelectedFileIds", "selectedFileIds");
  setter("setSelectionAnchor", "selectionAnchor");
  setter("setShowHistory", "showHistory");
  setter("setShowMap", "showMap");
  setter("setTrashed", "trashed");
  setter("setVersions", "versions");
  setter("setVersionsKept", "versionsKept");
  value.forgetToastsAbout = vi.fn();
  return value;
}

function versions(...savedAt: string[]): FileVersion[] {
  return savedAt.map((time, index) => ({
    id: `version-${index + 1}`,
    savedAt: time,
    cause: "test",
    pinned: false,
    bytes: 1,
  }));
}

function metaSuggestion(title: string, folder: string): FileMetaSuggestion {
  return { title, folder, tags: [] };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.listFiles.mockResolvedValue([
    { id: "one", name: "one.md" },
    { id: "two", name: "two.md" },
  ]);
  mocks.api.getFileContent.mockResolvedValue({
    name: "one.md",
    kind: "markdown",
    text: "restored",
  });
  mocks.api.chooseSavePath.mockResolvedValue("/tmp/one.md");
  mocks.api.chooseOpenPath.mockResolvedValue("/tmp/export");
  mocks.api.createFolder.mockResolvedValue({ id: "folder", name: "Folder" });
  mocks.api.createSketch.mockResolvedValue({
    id: "sketch",
    name: "Sketch.sketch",
  });
  mocks.api.deleteFilePermanently.mockResolvedValue(undefined);
  mocks.api.deleteFileVersion.mockResolvedValue(undefined);
  mocks.api.deleteFilesPermanently.mockResolvedValue({
    ok: ["one.md"],
    failed: [],
    capped: 0,
  });
  mocks.api.deleteFolder.mockResolvedValue(undefined);
  mocks.api.emptyTrash.mockResolvedValue(1);
  mocks.api.exportAll.mockResolvedValue(2);
  mocks.api.exportFile.mockResolvedValue(undefined);
  mocks.api.exportSketchPng.mockResolvedValue({
    id: "png",
    name: "Sketch.png",
  });
  mocks.api.exportSketchSvg.mockResolvedValue({
    id: "svg",
    name: "Sketch.svg",
  });
  mocks.api.fileVersionsKept.mockResolvedValue(5);
  mocks.api.getFileProvenance.mockResolvedValue(null);
  mocks.api.getFileVersion.mockResolvedValue({
    versionText: "old",
    currentText: "new",
    fileName: "one.md",
  });
  mocks.api.importFiles.mockResolvedValue({ imported: [], errors: [] });
  mocks.api.listFolders.mockResolvedValue([]);
  mocks.api.listTrashedFiles.mockResolvedValue([]);
  mocks.api.moveFileToFolder.mockResolvedValue(undefined);
  mocks.api.moveFilesToFolder.mockResolvedValue({
    ok: ["one.md"],
    failed: [],
    capped: 0,
  });
  mocks.api.pinFileVersion.mockResolvedValue(undefined);
  mocks.api.renameFile.mockResolvedValue(undefined);
  mocks.api.renameFolder.mockResolvedValue(undefined);
  mocks.api.restoreFile.mockResolvedValue({ name: "trash.md" });
  mocks.api.restoreFileVersion.mockResolvedValue(undefined);
  mocks.api.restoreFiles.mockResolvedValue({
    ok: ["one.md"],
    failed: [],
    capped: 0,
  });
  mocks.api.saveGeneratedFile.mockResolvedValue({
    id: "generated",
    name: "generated.md",
  });
  mocks.api.setCell.mockResolvedValue(undefined);
  mocks.api.setFileInLibrary.mockResolvedValue(undefined);
  mocks.api.trashFile.mockResolvedValue(undefined);
  mocks.api.trashFiles.mockResolvedValue({
    ok: ["one.md"],
    failed: [],
    capped: 0,
  });
  mocks.api.updateDocxText.mockResolvedValue(undefined);
  mocks.api.updateFileContent.mockResolvedValue(undefined);
  mocks.suggestFileMeta.mockResolvedValue({ title: "", folder: "" });
});

afterEach(() => vi.restoreAllMocks());

describe("makeFileActions.undoEdits", () => {
  it("restores the first version written during the full turn, refreshes an active file, and leaves newer heads alone", async () => {
    const s = state();
    mocks.api.listFileVersions.mockImplementation(async (fileId: string) => {
      if (fileId === "one") {
        return versions(
          "2026-08-01T10:00:59.000Z",
          "2026-08-01T10:00:30.000Z",
          "2026-08-01T10:00:10.000Z",
        );
      }
      return versions("2026-08-01T10:01:01.000Z");
    });
    const actions = makeFileActions(s as WSState);

    await actions.undoEdits("answer");

    expect(mocks.api.restoreFileVersion).toHaveBeenCalledWith("version-3");
    expect(mocks.api.restoreFileVersion).toHaveBeenCalledTimes(1);
    expect(mocks.api.getFileContent).toHaveBeenCalledWith("one");
    expect(s.setViewerRev).toHaveBeenCalledOnce();
    expect(s.undoByMsg).toEqual({});
    expect(s.pushToast).toHaveBeenCalledWith("success", "Change undone.");
    expect(s.pushToast).toHaveBeenCalledWith(
      "info",
      expect.stringContaining('"two" has been saved again since that answer'),
    );
  });

  it("restores every file in a turn and reports plural receipts", async () => {
    const s = state({ openFileRef: { current: null } });
    mocks.api.listFileVersions.mockResolvedValue(
      versions("2026-08-01T10:00:50.000Z", "2026-08-01T10:00:20.000Z"),
    );
    const actions = makeFileActions(s as WSState);

    await actions.undoEdits("answer");

    expect(mocks.api.restoreFileVersion).toHaveBeenNthCalledWith(
      1,
      "version-2",
    );
    expect(mocks.api.restoreFileVersion).toHaveBeenNthCalledWith(
      2,
      "version-2",
    );
    expect(s.pushToast).toHaveBeenCalledWith(
      "success",
      "Undid changes to 2 files.",
    );
    expect(s.pushToast).not.toHaveBeenCalledWith("info", expect.any(String));
  });

  it("keeps the undo record and reports an error when version lookup fails", async () => {
    const s = state();
    mocks.api.listFileVersions.mockRejectedValueOnce(new Error("offline"));
    const actions = makeFileActions(s as WSState);

    await actions.undoEdits("answer");

    expect(s.undoByMsg).toEqual({ answer: ["one", "two"] });
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: offline");
  });

  it("does nothing for an absent or empty undo entry", async () => {
    const absent = makeFileActions(state({ undoByMsg: {} }) as WSState);
    const empty = makeFileActions(
      state({ undoByMsg: { answer: [] } }) as WSState,
    );

    await absent.undoEdits("answer");
    await empty.undoEdits("answer");

    expect(mocks.api.listFileVersions).not.toHaveBeenCalled();
  });
});

describe("makeFileActions returned plumbing", () => {
  it("keeps the public action surface connected to its API and state handlers", async () => {
    const s = state({
      folders: [{ id: "folder", name: "Folder" }],
      importSuggestions: [
        {
          fileId: "one",
          current: "one.md",
          suggestion: metaSuggestion("One", "Folder"),
        },
      ],
      creatingFolder: "New folder",
      renamingFolder: { id: "folder", name: "Renamed" },
      renamingFile: { id: "one", name: "renamed.md" },
    });
    mocks.api.listFileVersions.mockResolvedValue(
      versions("2026-08-01T10:00:50.000Z"),
    );
    const actions = makeFileActions(s as WSState);
    const first = s.files[0];

    actions.noteExportOnce();
    await actions.exportOne("one", "one.md");
    await actions.exportAllFiles();
    await actions.openHistory();
    await actions.pinVersion("version-1", true);
    await actions.deleteVersion("version-1");
    await actions.openCompare(versions("2026-08-01T10:00:50.000Z")[0]);
    await actions.restoreVersion("version-1");
    actions.suggestImports([first]);
    await Promise.resolve();
    actions.dismissImportSuggestion("one");
    await actions.applyImportSuggestion({
      fileId: "one",
      current: "one.md",
      suggestion: metaSuggestion("One", "Folder"),
    });
    await actions.applyAllImportSuggestions();
    actions.dismissAllImportSuggestions();
    actions.reportImport({ imported: [first], errors: ["bad"] });
    await actions.importFiles();
    await actions.reloadTrash();
    await actions.removeFile("one");
    await actions.restoreFile("trash");
    await actions.destroyFile("trash");
    await actions.emptyTrash();

    s.selectedFileIds = new Set(["one"]);
    expect(actions.selectedFiles()).toEqual([first]);
    actions.clearSelection();
    s.selectionAnchor = "one";
    actions.clickFile(s.files[1], { meta: false, shift: true });
    actions.clickFile(first, { meta: true, shift: false });
    actions.selectAllVisible();
    await actions.moveFiles(["one"], "folder");
    await actions.removeFiles(["one"]);
    await actions.restoreFiles(["one"]);
    await actions.destroyFiles(["one"]);
    await actions.exportFiles([first]);
    actions.attachFiles([first]);
    await actions.viewFile("one");
    actions.createNewNote();
    await Promise.resolve();
    await actions.createSketch();
    await actions.setInLibrary("one", true);
    await actions.exportSketchAs("sketch", "png");
    await actions.exportSketchAs("sketch", "svg");
    actions.createNewScript();
    await Promise.resolve();
    await actions.saveEdit("changed");
    await actions.saveEditAsCopy("copy");
    await actions.duplicateOpenFile();
    await actions.editCell("Sheet1", "A1", "42");
    actions.guardLeave("Leaving", vi.fn());
    actions.startCreateFolder();
    s.creatingFolder = "Folder again";
    await actions.commitCreateFolder();
    s.renamingFolder = { id: "folder", name: "Folder twice" };
    await actions.commitFolderRename();
    await actions.deleteFolder("folder");
    await actions.moveFile("one", "folder");
    s.renamingFile = { id: "one", name: "final.md" };
    await actions.commitRenameFile();
    actions.toggleFolderCollapse("folder");
    Reflect.set(globalThis, "window", { innerWidth: 100, innerHeight: 100 });
    const menu = {
      getBoundingClientRect: () => ({ width: 20, height: 20 }),
      style: {},
    } as unknown as HTMLDivElement;
    actions.clampMenu(menu, 99, 99);

    expect(mocks.api.exportFile).toHaveBeenCalled();
    expect(mocks.api.listFiles).toHaveBeenCalled();
    expect(s.pushToast).toHaveBeenCalled();
  });

  it("keeps every recoverable failure visible without clearing the affected state", async () => {
    const error = new Error("offline");
    const actionFor = (overrides: MutableState = {}) => {
      const s = state(overrides);
      return { s, actions: makeFileActions(s as WSState) };
    };

    let entry = actionFor();
    mocks.api.exportFile.mockRejectedValueOnce(error);
    await entry.actions.exportOne("one", "one.md");
    expect(entry.s.pushToast).toHaveBeenCalledWith("error", "Error: offline");

    entry = actionFor();
    mocks.api.exportAll.mockRejectedValueOnce(error);
    await entry.actions.exportAllFiles();

    entry = actionFor({ showHistory: true });
    await entry.actions.openHistory();
    expect(entry.s.setShowHistory).toHaveBeenCalledWith(false);

    entry = actionFor();
    mocks.api.listFileVersions.mockRejectedValueOnce(error);
    await entry.actions.openHistory();
    mocks.api.pinFileVersion.mockRejectedValueOnce(error);
    await entry.actions.pinVersion("version-1", true);
    mocks.api.deleteFileVersion.mockRejectedValueOnce(error);
    await entry.actions.deleteVersion("version-1");
    mocks.api.getFileVersion.mockRejectedValueOnce(error);
    await entry.actions.openCompare(versions("2026-08-01T10:00:00.000Z")[0]);
    mocks.api.restoreFileVersion.mockRejectedValueOnce(error);
    await entry.actions.restoreVersion("version-1");

    entry = actionFor({ openFileRef: { current: null } });
    mocks.suggestFileMeta
      .mockResolvedValueOnce({ title: "", folder: "" })
      .mockResolvedValueOnce({ title: "A better name", folder: "" })
      .mockRejectedValueOnce(error);
    entry.actions.suggestImports(entry.s.files);
    entry.actions.suggestImports([entry.s.files[0]]);
    await settle();
    expect(entry.s.importSuggestions).toHaveLength(1);

    const suggestion = {
      fileId: "one",
      current: "one.md",
      suggestion: metaSuggestion("One", "Folder"),
    };
    entry = actionFor({ importSuggestions: [suggestion] });
    mocks.api.renameFile.mockRejectedValueOnce(error);
    await entry.actions.applyImportSuggestion(suggestion);
    mocks.api.renameFile.mockRejectedValueOnce(error);
    await entry.actions.applyAllImportSuggestions();
    entry.actions.reportImport({
      imported: entry.s.files,
      errors: ["a", "b", "c", "d"],
    });
    mocks.api.chooseOpenPath.mockResolvedValueOnce(["/tmp/a", "/tmp/b"]);
    mocks.api.importFiles.mockRejectedValueOnce(error);
    await entry.actions.importFiles();

    entry = actionFor({ files: [] });
    mocks.api.trashFile.mockRejectedValueOnce(error);
    await entry.actions.removeFile("missing");
    mocks.api.restoreFile.mockRejectedValueOnce(error);
    await entry.actions.restoreFile("missing");
    mocks.api.deleteFilePermanently.mockRejectedValueOnce(error);
    await entry.actions.destroyFile("missing");
    mocks.api.emptyTrash.mockRejectedValueOnce(error);
    await entry.actions.emptyTrash();
    mocks.api.emptyTrash.mockResolvedValueOnce(0);
    await entry.actions.emptyTrash();

    entry = actionFor({ folders: [] });
    const partial = {
      ok: ["one.md", "two.md"],
      failed: Array.from({ length: 6 }, (_, index) => ({
        name: `bad-${index}.md`,
        error: "blocked",
      })),
      capped: 2,
    };
    mocks.api.moveFilesToFolder.mockResolvedValueOnce(partial);
    await entry.actions.moveFiles(["one", "two"], null);
    mocks.api.moveFilesToFolder.mockRejectedValueOnce(error);
    await entry.actions.moveFiles(["one"], "missing");
    mocks.api.trashFiles.mockRejectedValueOnce(error);
    await entry.actions.removeFiles(["one"]);
    mocks.api.restoreFiles.mockRejectedValueOnce(error);
    await entry.actions.restoreFiles(["one"]);
    mocks.api.deleteFilesPermanently.mockRejectedValueOnce(error);
    await entry.actions.destroyFiles(["one"]);

    entry = actionFor();
    mocks.api.chooseOpenPath.mockResolvedValueOnce("/tmp/export");
    mocks.api.exportFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error);
    await entry.actions.exportFiles(entry.s.files);
    entry.actions.attachFiles(entry.s.files);
    entry.actions.attachFiles(entry.s.files);
    entry.s.selectionAnchor = "not-visible";
    entry.actions.clickFile(entry.s.files[0], { meta: false, shift: true });
    await settle();

    entry = actionFor({ openFileRef: { current: null } });
    mocks.api.getFileContent.mockRejectedValueOnce(error);
    await entry.actions.viewFile("one");
    expect(entry.s.forgetToastsAbout).not.toHaveBeenCalled();

    entry = actionFor();
    mocks.api.saveGeneratedFile.mockRejectedValueOnce(error);
    entry.actions.createNewNote();
    await settle();
    mocks.api.createSketch.mockRejectedValueOnce(error);
    await entry.actions.createSketch();
    mocks.api.setFileInLibrary.mockRejectedValueOnce(error);
    await entry.actions.setInLibrary("missing", false);
    mocks.api.exportSketchPng.mockRejectedValueOnce(error);
    await entry.actions.exportSketchAs("sketch", "png");
    mocks.api.saveGeneratedFile.mockRejectedValueOnce(error);
    entry.actions.createNewScript();
    await settle();

    mocks.api.updateFileContent.mockRejectedValueOnce(error);
    await expect(entry.actions.saveEdit("changed")).resolves.toBe(false);
    entry.s.openFile = {
      id: "docx",
      content: { name: "docx.docx", kind: "docx", text: "old" },
    };
    mocks.api.updateDocxText.mockRejectedValueOnce(error);
    await expect(entry.actions.saveEdit("changed")).resolves.toBe(false);
    mocks.api.saveGeneratedFile.mockRejectedValueOnce(error);
    await expect(entry.actions.saveEditAsCopy("copy")).resolves.toBe(false);
    mocks.api.saveGeneratedFile.mockRejectedValueOnce(error);
    await entry.actions.duplicateOpenFile();
    mocks.api.setCell.mockRejectedValueOnce(error);
    await entry.actions.editCell("Sheet1", "A1", "42");

    let proceeded = false;
    entry.s.editModeRef.current = true;
    entry.s.editorDirtyRef.current = true;
    entry.actions.guardLeave("Leaving", () => {
      proceeded = true;
    });
    expect(proceeded).toBe(false);
    expect(entry.s.pendingLeave).toMatchObject({ what: "Leaving" });
  });

  it("covers the alternate receipts, callbacks, and no-window undo fallbacks", async () => {
    let s = state({
      messages: [{ id: "answer", createdAt: "2026-08-01T10:01:00.000Z" }],
      openFileRef: { current: null },
    });
    mocks.api.listFileVersions.mockResolvedValueOnce(
      versions("2026-08-01T10:00:00.000Z"),
    );
    await makeFileActions(s as WSState).undoEdits("answer");

    s = state({ openFileRef: { current: null } });
    mocks.api.listFileVersions.mockResolvedValue(
      versions("2026-08-01T10:02:00.000Z"),
    );
    await makeFileActions(s as WSState).undoEdits("answer");
    expect(s.pushToast).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("have been saved again"),
    );

    s = state();
    mocks.api.listFileVersions.mockResolvedValue(
      versions("2026-08-01T10:00:10.000Z", "2026-08-01T10:00:00.000Z"),
    );
    let actions = makeFileActions(s as WSState);
    await actions.pinVersion("version-1", false);
    await actions.deleteVersion("version-1");
    await actions.restoreVersion("version-1");

    s = state({
      importSuggestions: [
        {
          fileId: "one",
          current: "one.md",
          suggestion: metaSuggestion("One", ""),
        },
        {
          fileId: "two",
          current: "two.md",
          suggestion: metaSuggestion("", "Folder"),
        },
      ],
    });
    actions = makeFileActions(s as WSState);
    mocks.suggestFileMeta.mockResolvedValueOnce({
      title: "Different name",
      folder: "",
    });
    actions.suggestImports([s.files[0]]);
    await settle();
    await actions.applyImportSuggestion({
      fileId: "one",
      current: "one.md",
      suggestion: metaSuggestion("Renamed", ""),
    });
    await actions.applyAllImportSuggestions();
    expect(s.pushToast).toHaveBeenCalledWith("success", "Tidied up 1 file.");

    s = state({ files: [] });
    actions = makeFileActions(s as WSState);
    await actions.removeFile("missing");
    const removeUndo = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[3] === "file:missing",
    )?.[2] as { run: () => void };
    removeUndo.run();
    await settle();

    s = state();
    actions = makeFileActions(s as WSState);
    mocks.api.trashFiles.mockResolvedValueOnce({
      ok: ["one.md"],
      failed: [{ name: "two.md", error: "locked" }],
      capped: 0,
    });
    await actions.removeFiles(["one", "two"]);
    actions.clickFile(s.files[1], { meta: true, shift: false });
    await actions.exportFiles(s.files);

    s = state({ openFileRef: { current: null } });
    actions = makeFileActions(s as WSState);
    mocks.api.getFileContent.mockRejectedValueOnce(new Error("offline"));
    await actions.viewFile("one");
    const retry = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[3] === "open:one",
    )?.[2] as { run: () => void };
    mocks.api.getFileContent.mockResolvedValueOnce({
      name: "one.md",
      kind: "markdown",
      text: "retried",
    });
    retry.run();
    await settle();

    s = state();
    actions = makeFileActions(s as WSState);
    await actions.setInLibrary("missing", false);
    const libraryUndo = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[3] === "library:missing",
    )?.[2] as { run: () => void };
    libraryUndo.run();
    await actions.exportSketchAs("sketch", "png");
    const openExport = s.pushToast.mock.calls.find(
      (call: unknown[]) =>
        (call[2] as { label?: string } | undefined)?.label === "Open it",
    )?.[2] as { run: () => void };
    openExport.run();
    await settle();
    expect(actions.editModeOf(s.openFile.content)).toBeNull();

    s = state({
      renamingFile: { id: "one", name: "renamed.md" },
      openFileRef: {
        current: { id: "one", content: { name: "one.md", kind: "markdown" } },
      },
    });
    actions = makeFileActions(s as WSState);
    await actions.commitRenameFile();
    expect(s.openFileRef.current.content.name).toBe("renamed.md");
  });

  it("keeps suggestion and bulk-undo callbacks safe for incomplete open-file state", async () => {
    const suggestion = {
      fileId: "one",
      current: "one.md",
      suggestion: metaSuggestion("Renamed", ""),
    };
    let s = state({
      openFileRef: { current: { id: "one", content: null } },
    });
    let actions = makeFileActions(s as WSState);
    await actions.applyImportSuggestion(suggestion);

    s = state({
      renamingFile: { id: "one", name: "renamed.md" },
      openFileRef: { current: { id: "one", content: { name: "one.md" } } },
    });
    s.setOpenFile = vi.fn((update: (current: null) => null) => update(null));
    actions = makeFileActions(s as WSState);
    await actions.commitRenameFile();

    s = state({
      openFileRef: { current: { id: "one", content: { name: "one.md" } } },
    });
    s.setOpenFile = vi.fn((update: (current: null) => null) => update(null));
    actions = makeFileActions(s as WSState);
    await actions.applyImportSuggestion(suggestion);

    s = state({ importSuggestions: [suggestion] });
    actions = makeFileActions(s as WSState);
    mocks.api.renameFile.mockRejectedValueOnce(new Error("blocked"));
    await actions.applyAllImportSuggestions();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: blocked");

    s = state();
    actions = makeFileActions(s as WSState);
    await actions.removeFiles(["one"]);
    const restoreAll = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[3] === "file-bulk",
    )?.[2] as { run: () => void };
    restoreAll.run();
    await settle();
    expect(mocks.api.restoreFiles).toHaveBeenCalledWith(["one"]);
  });
});
