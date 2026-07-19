import {
  api,
  FileContent,
  FileMeta,
  FileMetaSuggestion,
  FileTarget,
  FileVersion,
  suggestFileMeta,
} from "../api";
import { displayName } from "./composer";
import { tryToast } from "./guard";
import { WSState } from "./state";

/** File + folder + open-file state handlers (import/view/edit/versions/folders).
 * All state lives in `s`; this only owns the plumbing. Extracted verbatim. */
export function makeFileActions(s: WSState) {
  // ---- ADD-1: export copies out of the room ----
  function noteExportOnce() {
    if (s.exportWarnedRef.current) return;
    s.exportWarnedRef.current = true;
    s.pushToast("info", "Exported copies are normal, NOT encrypted files.");
  }

  async function exportOne(id: string, name: string) {
    const dest = await api.chooseSavePath({ defaultPath: name });
    if (!dest) return;
    try {
      await api.exportFile(id, dest);
      noteExportOnce();
      s.pushToast("success", `Exported "${name}".`);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function exportAllFiles() {
    const dir = await api.chooseOpenPath({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    try {
      const count = await api.exportAll(dir);
      noteExportOnce();
      s.pushToast(
        "success",
        `Exported ${count} file${count === 1 ? "" : "s"} out of the room.`,
      );
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  // ---- ADD-2: file version history ----
  async function openHistory() {
    if (!s.openFile) return;
    s.setConfirmRestore(null);
    if (s.showHistory) {
      s.setShowHistory(false);
      return;
    }
    try {
      const vs = await api.listFileVersions(s.openFile.id);
      s.setVersions([...vs].sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
      s.setShowHistory(true);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  // ---- Idea 11: open a read-only side-by-side compare of a version ----
  async function openCompare(v: FileVersion) {
    if (!s.openFile) return;
    try {
      const vc = await api.getFileVersion(v.id);
      s.setCompare({
        versionId: v.id,
        cause: v.cause,
        savedAt: v.savedAt,
        // The command shapes BOTH sides identically (same clip + size gates),
        // so we take the current text from its result, not s.openFile — the
        // viewer's raw text isn't clipped on the md/csv/code branches.
        versionText: vc.versionText,
        currentText: vc.currentText,
        fileName: vc.fileName,
      });
      // Close the popover; the modal takes over (its own Restore re-opens it).
      s.setShowHistory(false);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function restoreVersion(versionId: string) {
    const current = s.openFile;
    if (!current) return;
    try {
      await api.restoreFileVersion(versionId);
      const content = await api.getFileContent(current.id);
      s.setOpenFile({ ...current, content });
      s.setViewerRev((r) => r + 1);
      s.setFiles(await api.listFiles());
      s.setVersions(
        [...(await api.listFileVersions(current.id))].sort((a, b) =>
          b.savedAt.localeCompare(a.savedAt),
        ),
      );
      s.pushToast("success", "Restored an earlier version.");
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function undoEdits(msgId: string) {
    const fileIds = s.undoByMsg[msgId];
    if (!fileIds || fileIds.length === 0) return;
    try {
      for (const fid of fileIds) {
        const versions = await api.listFileVersions(fid);
        if (versions[0]) await api.restoreFileVersion(versions[0].id);
      }
      s.setUndoByMsg((u) => {
        const next = { ...u };
        delete next[msgId];
        return next;
      });
      s.setFiles(await api.listFiles());
      const current = s.openFileRef.current;
      if (current && fileIds.includes(current.id)) {
        const content = await api.getFileContent(current.id);
        s.setOpenFile({ ...current, content });
        s.setViewerRev((r) => r + 1);
      }
      s.pushToast(
        "success",
        fileIds.length > 1 ? `Undid changes to ${fileIds.length} files.` : "Change undone.",
      );
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  function suggestImports(imported: FileMeta[]) {
    imported.slice(0, 3).forEach((f) => {
      suggestFileMeta(f.id)
        .then((sug) => {
          const title = sug.title.trim();
          const titleChanged =
            title !== "" &&
            title !== f.name &&
            title !== displayName(f.name);
          const hasFolder = sug.folder.trim() !== "";
          if (!titleChanged && !hasFolder) return;
          s.setImportSuggestions((cur) =>
            cur.some((x) => x.fileId === f.id)
              ? cur
              : [...cur, { fileId: f.id, current: f.name, suggestion: sug }],
          );
        })
        .catch(() => {});
    });
  }

  function dismissImportSuggestion(fileId: string) {
    s.setImportSuggestions((cur) => cur.filter((x) => x.fileId !== fileId));
  }

  /** Rename + file one suggestion. Shared by the single-chip Apply and the
   * batched "Apply all"; the caller owns the receipt toast. */
  async function applyOneSuggestion(sug: {
    fileId: string;
    current: string;
    suggestion: FileMetaSuggestion;
  }) {
    const title = sug.suggestion.title.trim();
    if (title && title !== sug.current) {
      const dot = sug.current.lastIndexOf(".");
      const ext = dot > 0 ? sug.current.slice(dot) : "";
      const name = /\.[^.]+$/.test(title) ? title : `${title}${ext}`;
      await api.renameFile(sug.fileId, name);
      if (s.openFileRef.current?.id === sug.fileId) {
        s.setOpenFile((o) => (o ? { ...o, name } : o));
      }
    }
    const folderName = sug.suggestion.folder.trim();
    if (folderName) {
      let folder = s.folders.find(
        (f) => f.name.toLowerCase() === folderName.toLowerCase(),
      );
      if (!folder) folder = await api.createFolder(folderName);
      await api.moveFileToFolder(sug.fileId, folder.id);
      s.setFolders(await api.listFolders());
    }
  }

  async function applyImportSuggestion(sug: {
    fileId: string;
    current: string;
    suggestion: FileMetaSuggestion;
  }) {
    dismissImportSuggestion(sug.fileId);
    try {
      await applyOneSuggestion(sug);
      s.setFiles(await api.listFiles());
      s.pushToast("success", "Tidied up.");
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Batched "Apply all" for the collapsed tidy-up card — one receipt at the
   * end instead of a toast per file. */
  async function applyAllImportSuggestions() {
    const pending = s.importSuggestions;
    s.setImportSuggestions([]);
    let applied = 0;
    for (const sug of pending) {
      try {
        await applyOneSuggestion(sug);
        applied += 1;
      } catch (e) {
        s.pushToast("error", String(e));
      }
    }
    s.setFiles(await api.listFiles());
    if (applied > 0) {
      s.pushToast(
        "success",
        applied === 1 ? "Tidied up 1 file." : `Tidied up ${applied} files.`,
      );
    }
  }

  function dismissAllImportSuggestions() {
    s.setImportSuggestions([]);
  }

  /** Turn an import report into the ONE receipt toast (shared by the picker
   * and drag-drop; the live sidebar strip shows per-file progress). */
  function reportImport(report: { imported: FileMeta[]; errors: string[] }) {
    if (report.imported.length === 1) {
      s.pushToast(
        "success",
        `Added "${displayName(report.imported[0].name)}" to the room.`,
      );
    } else if (report.imported.length > 1) {
      s.pushToast(
        "success",
        `Added ${report.imported.length} files to the room.`,
      );
    }
    if (report.imported.length > 0) suggestImports(report.imported);
    if (report.errors.length > 3) {
      s.pushToast(
        "error",
        `${report.errors.length} files could not be added:\n${report.errors.join("\n")}`,
      );
    } else {
      report.errors.forEach((err) => s.pushToast("error", err));
    }
  }

  async function importFiles() {
    const picked = await api.chooseOpenPath({ title: "Add files to this room", multiple: true });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    // Show the queue strip immediately: a handful of small files can finish
    // importing before the first backend progress event paints, so the user
    // otherwise sees nothing until the files just appear.
    if (paths.length > 1) {
      s.setImportProgress({ done: 0, total: paths.length, name: "Starting…" });
    }
    try {
      const report = await api.importFiles(paths);
      s.setFiles(await api.listFiles());
      reportImport(report);
    } finally {
      s.setImportProgress(null);
    }
  }

  async function removeFile(id: string) {
    await api.deleteFile(id);
    s.setFiles(await api.listFiles());
    s.setAttachments((a) => a.filter((f) => f.id !== id));
    // A viewer left open on the deleted file would keep fetching a row that
    // no longer exists ("Query returned no rows" toasts).
    if (s.openFileRef.current?.id === id) s.setOpenFile(null);
    s.setRecLive((r) => (r?.fileId === id ? null : r));
  }

  async function viewFile(id: string, target?: FileTarget) {
    s.setOpenFile({ id, content: await api.getFileContent(id), target });
    s.setEditMode(false);
    s.setShowMap(false);
  }

  /** "New page": a blank Markdown note via the ordinary generated-file path
   * (same command chat's "Save to room" uses), opened straight into editing.
   * A dated name keeps repeat presses from colliding. */
  async function createNewNote() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}.${String(now.getSeconds()).padStart(2, "0")}`;
    try {
      const meta = await api.saveGeneratedFile(`Note ${stamp}.md`, "");
      s.setFiles(await api.listFiles());
      await viewFile(meta.id);
      s.setEditMode(true);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function saveEdit(newText: string) {
    if (!s.openFile) return;
    await api.updateFileContent(s.openFile.id, newText);
    s.setFiles(await api.listFiles());
    s.setOpenFile({
      ...s.openFile,
      content: { ...s.openFile.content, text: newText },
    });
    s.pushToast("success", `Saved "${s.openFile.content.name}".`);
  }

  async function saveEditAsCopy(newText: string) {
    if (!s.openFile) return;
    const base = s.openFile.content.name.replace(/\.[^.]+$/, "");
    const meta = await api.saveGeneratedFile(`${base} (edited).md`, newText);
    s.setFiles(await api.listFiles());
    s.pushToast("success", `Saved "${meta.name}" into the room — the original file is unchanged.`);
  }

  async function editCell(sheet: string, cell: string, value: string) {
    if (!s.openFile) return;
    try {
      await api.setCell(s.openFile.id, sheet || null, cell, value);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** What edit mode means for the open file, if anything. */
  function editModeOf(c: FileContent): "grid" | "editor" | "copy" | null {
    if (c.kind === "sheet" || c.kind === "csv") {
      return /\.xls$/i.test(c.name) ? null : "grid";
    }
    if (c.editable) return "editor";
    if (c.text && ["pdf", "docx", "text"].includes(c.kind)) return "copy";
    return null;
  }

  // ---- ADD-16: folders ----
  function startCreateFolder() {
    s.setCreatingFolder("");
  }

  async function commitCreateFolder() {
    if (s.creatingFolder === null) return;
    const name = s.creatingFolder.trim();
    s.setCreatingFolder(null);
    if (!name) return;
    await tryToast(
      s,
      () => api.createFolder(name),
      async () => s.setFolders(await api.listFolders()),
    );
  }

  async function commitFolderRename() {
    if (!s.renamingFolder) return;
    const { id, name } = s.renamingFolder;
    const trimmed = name.trim();
    s.setRenamingFolder(null);
    if (!trimmed) return;
    await tryToast(
      s,
      () => api.renameFolder(id, trimmed),
      async () => s.setFolders(await api.listFolders()),
    );
  }

  async function deleteFolder(id: string) {
    await tryToast(s, () => api.deleteFolder(id), async () => {
      s.setFolders(await api.listFolders());
      s.setFiles(await api.listFiles());
    });
  }

  async function moveFile(fileId: string, folderId: string | null) {
    s.setMoveMenuFor(null);
    await tryToast(
      s,
      () => api.moveFileToFolder(fileId, folderId),
      async () => s.setFiles(await api.listFiles()),
    );
  }

  async function commitRenameFile() {
    const pending = s.renamingFile;
    s.setRenamingFile(null);
    if (!pending) return;
    const name = pending.name.trim();
    const original = s.files.find((f) => f.id === pending.id);
    if (!name || name === original?.name) return;
    await tryToast(s, () => api.renameFile(pending.id, name), async () => {
      s.setFiles(await api.listFiles());
      if (s.openFileRef.current?.id === pending.id) {
        s.setOpenFile((o) => (o ? { ...o, name } : o));
      }
    });
  }

  function toggleFolderCollapse(id: string) {
    s.setCollapsedFolders((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Keep the fixed-position row menus inside the viewport.
  function clampMenu(el: HTMLDivElement | null, x: number, y: number) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - r.width - 8;
    const maxTop = window.innerHeight - r.height - 8;
    el.style.left = `${Math.max(8, Math.min(x, maxLeft))}px`;
    el.style.top = `${Math.max(8, Math.min(y, maxTop))}px`;
  }

  return {
    noteExportOnce, exportOne, exportAllFiles, openHistory, openCompare, restoreVersion,
    undoEdits, suggestImports, dismissImportSuggestion, applyImportSuggestion,
    applyAllImportSuggestions, dismissAllImportSuggestions,
    reportImport, importFiles, removeFile, viewFile, createNewNote, saveEdit, saveEditAsCopy,
    editCell, editModeOf, startCreateFolder, commitCreateFolder,
    commitFolderRename, deleteFolder, moveFile, commitRenameFile,
    toggleFolderCollapse, clampMenu,
  };
}
