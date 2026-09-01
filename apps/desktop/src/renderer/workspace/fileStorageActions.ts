import { api, type FileMeta, type FileMetaSuggestion, type FileVersion, suggestFileMeta } from "../api";
import { displayName } from "./composer";
import { tryToast } from "./guard";
import type { WSState } from "./state";
import {
  undoWindow,
  undoFileVersions,
  clearUndoRecord,
  refreshUndoneFile,
  reportUndoneFiles,
  reportMovedFiles,
} from "./fileActions";

export function makeFileStorageActions(s: WSState) {

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
      // The retention limit is the host's constant, asked for rather than
      // duplicated here — the strip has to state a number that is actually the
      // one the prune uses, or it becomes a second lie about the same thing.
      s.setVersionsKept(await api.fileVersionsKept());
      // ART-1: what made the state currently on screen. Fetched alongside the
      // list — a version history that can say where the OLD states came from but
      // not the one you are looking at answers the less useful half.
      s.setHeadProvenance(await api.getFileProvenance(s.openFile.id));
      s.setShowHistory(true);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Keep this version out of the rolling window, or let it back in. The list
   *  is re-read rather than patched in place: pinning changes what the NEXT
   *  save would evict, and the strip's "only N kept" note is derived from it. */
  async function pinVersion(versionId: string, pinned: boolean) {
    const current = s.openFile;
    if (!current) return;
    try {
      await api.pinFileVersion(versionId, pinned);
      s.setVersions(
        [...(await api.listFileVersions(current.id))].sort((a, b) =>
          b.savedAt.localeCompare(a.savedAt),
        ),
      );
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Delete ONE saved version. Every version is a whole copy of the file, so
   *  this is how a 200 MB recording's ten snapshots stop costing 2 GB. Not
   *  undoable — the caller arms it behind a confirm row. */
  async function deleteVersion(versionId: string) {
    const current = s.openFile;
    if (!current) return;
    try {
      await api.deleteFileVersion(versionId);
      s.setVersions(
        [...(await api.listFileVersions(current.id))].sort((a, b) =>
          b.savedAt.localeCompare(a.savedAt),
        ),
      );
      s.pushToast("success", "Deleted that saved version.");
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
      // ART-1: a restore moves the head's provenance back with the bytes, so the
      // strip must re-read it rather than keep describing the state it replaced.
      s.setHeadProvenance(await api.getFileProvenance(current.id));
      s.pushToast("success", "Restored an earlier version.");
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Undo the file writes ONE answer made.
   *
   * The chip records file ids only, so WHICH saved version each file goes back
   * to is worked out here, from the turn this answer belongs to: the writes of
   * a turn are the version rows cut between the question and the answer that
   * finished it. Restoring the newest row instead — whatever made it — got both
   * halves wrong. A turn that wrote one file twice was only half undone (the
   * first write stayed, and the chip was gone). And a file the user had SAVED
   * THEMSELVES since was rolled back onto the AI's wording under a toast that
   * said "Change undone" — their paragraph, discarded by an undo of something
   * else. A file whose head has moved on since the answer is left alone and
   * said so, the way `apply_with_staleness` refuses a stale edit. */
  async function undoEdits(msgId: string) {
    const fileIds = s.undoByMsg[msgId];
    if (!fileIds || fileIds.length === 0) return;
    try {
      const result = await undoFileVersions(
        fileIds,
        undoWindow(s.messages, msgId),
      );
      clearUndoRecord(s, msgId);
      await refreshUndoneFile(s, result.undone);
      reportUndoneFiles(s, result.undone);
      reportMovedFiles(s, result.moved);
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
            title !== "" && title !== f.name && title !== displayName(f.name);
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

  function suggestedFileName(sug: {
    current: string;
    suggestion: FileMetaSuggestion;
  }) {
    const title = sug.suggestion.title.trim();
    if (!title || title === sug.current) return null;
    const dot = sug.current.lastIndexOf(".");
    const extension = dot > 0 ? sug.current.slice(dot) : "";
    return /\.[^.]+$/.test(title) ? title : `${title}${extension}`;
  }

  function updateOpenSuggestionName(fileId: string, name: string) {
    if (s.openFileRef.current?.id !== fileId) return;
    s.setOpenFile((openFile) =>
      openFile
        ? {
            ...openFile,
            content: openFile.content
              ? { ...openFile.content, name }
              : openFile.content,
          }
        : openFile,
    );
  }

  async function suggestionFolder(folderName: string) {
    const found = s.folders.find(
      (folder) => folder.name.toLowerCase() === folderName.toLowerCase(),
    );
    return found ?? api.createFolder(folderName);
  }

  async function applySuggestionFolder(fileId: string, folderName: string) {
    if (!folderName) return;
    const folder = await suggestionFolder(folderName);
    await api.moveFileToFolder(fileId, folder.id);
    s.setFolders(await api.listFolders());
  }

  /** Rename + file one suggestion. Shared by the single-chip Apply and the
   * batched "Apply all"; the caller owns the receipt toast. */
  async function applyOneSuggestion(sug: {
    fileId: string;
    current: string;
    suggestion: FileMetaSuggestion;
  }) {
    const name = suggestedFileName(sug);
    if (name) {
      await api.renameFile(sug.fileId, name);
      updateOpenSuggestionName(sug.fileId, name);
    }
    await applySuggestionFolder(sug.fileId, sug.suggestion.folder.trim());
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
    const picked = await api.chooseOpenPath({
      title: "Add files to this room",
      multiple: true,
    });
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
    } catch (e) {
      // Drag-and-drop already reported its failures; the picker used to
      // swallow them, so a refused import looked like a click that did nothing.
      s.pushToast("error", `Could not add those files: ${String(e)}`);
    } finally {
      s.setImportProgress(null);
    }
  }

  /** Refresh the trash list + count. Every trash mutation ends with this, so
   * the badge is read back from the room rather than adjusted by hand. */
  async function reloadTrash() {
    await tryToast(s, async () => s.setTrashed(await api.listTrashedFiles()));
  }

  /** Detach a file id from everything in the UI that is still pointing at it.
   * Shared by trash and by permanent delete: both make the id unreadable, and
   * a viewer left open on it would keep fetching a row it can no longer get
   * ("Query returned no rows" toasts). */
  function forgetFile(id: string) {
    s.setAttachments((a) => a.filter((f) => f.id !== id));
    if (s.openFileRef.current?.id === id) s.setOpenFile(null);
    s.setRecLive((r) => (r?.fileId === id ? null : r));
  }

  async function removeFile(id: string) {
    const name = s.files.find((f) => f.id === id)?.name;
    try {
      await api.trashFile(id);
    } catch (e) {
      s.pushToast("error", `Could not remove that file: ${String(e)}`);
      return;
    }
    forgetFile(id);
    await tryToast(s, async () => s.setFiles(await api.listFiles()));
    await reloadTrash();
    // Say where it went, and offer the way back from the message itself. The
    // toast machinery already models this: an `about` + an `action` is an
    // OFFER and waits 12s rather than 5 (toastStack.toastLifeMs), which is the
    // window someone needs to read it, decide it was wrong, and press Undo.
    // Without the offer the only route back is Trash → find the row → Restore.
    s.pushToast(
      "success",
      name
        ? `Moved "${displayName(name)}" to the trash.`
        : "Moved to the trash.",
      { label: "Undo", run: () => void restoreFile(id) },
      `file:${id}`,
    );
  }

  async function restoreFile(id: string) {
    let name: string;
    try {
      name = (await api.restoreFile(id)).name;
    } catch (e) {
      s.pushToast("error", `Could not restore that file: ${String(e)}`);
      return;
    }
    await tryToast(s, async () => s.setFiles(await api.listFiles()));
    await reloadTrash();
    s.pushToast("success", `Restored "${displayName(name)}".`);
  }

  async function destroyFile(id: string) {
    const name = s.trashed.find((f) => f.id === id)?.name;
    try {
      await api.deleteFilePermanently(id);
    } catch (e) {
      s.pushToast("error", `Could not delete that file: ${String(e)}`);
      return;
    }
    forgetFile(id);
    await reloadTrash();
    s.pushToast(
      "success",
      name ? `Deleted "${displayName(name)}" for good.` : "Deleted for good.",
    );
  }

  async function emptyTrash() {
    let destroyed: number;
    try {
      destroyed = await api.emptyTrash();
    } catch (e) {
      s.pushToast("error", `Could not empty the trash: ${String(e)}`);
      return;
    }
    await reloadTrash();
    // Report the number the backend actually destroyed. An empty trash must
    // not read as work done.
    s.pushToast(
      destroyed > 0 ? "success" : "info",
      destroyed > 0
        ? `Deleted ${destroyed} file${destroyed === 1 ? "" : "s"} for good.`
        : "The trash was already empty.",
    );
  }
  return { noteExportOnce, exportOne, exportAllFiles, openHistory, pinVersion, deleteVersion, openCompare, restoreVersion, undoEdits, suggestImports, dismissImportSuggestion, suggestedFileName, updateOpenSuggestionName, suggestionFolder, applySuggestionFolder, applyOneSuggestion, applyImportSuggestion, applyAllImportSuggestions, dismissAllImportSuggestions, reportImport, importFiles, reloadTrash, forgetFile, removeFile, restoreFile, destroyFile, emptyTrash };
}
export type FileStorageActions = ReturnType<typeof makeFileStorageActions>;
