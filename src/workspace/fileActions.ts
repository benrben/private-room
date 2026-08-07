import {
  api,
  BulkReport,
  FileContent,
  FileMeta,
  FileMetaSuggestion,
  FileTarget,
  FileVersion,
  suggestFileMeta,
} from "../api";
import { displayName, uniqueFileName } from "./composer";
import { tryToast } from "./guard";
import { WSState } from "./state";
import {
  EditMode,
  editModeOf as registryEditModeOf,
} from "../viewers/registry";

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
        // `content.name` is the ONE name the open file carries — the viewer
        // header, the breadcrumb and the tab strip all read it.
        s.setOpenFile((o) =>
          o ? { ...o, content: o.content ? { ...o.content, name } : o.content } : o,
        );
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
    // Say where it went. "Deleted" with no undo in sight is what made this the
    // audit's one high-severity gap; the toast is the first place the net is
    // visible, so it names the trash rather than just reporting success.
    s.pushToast(
      "success",
      name ? `Moved "${displayName(name)}" to the trash.` : "Moved to the trash.",
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

  // ---- the Library's multi-selection ----------------------------------------

  /** Turn a BulkReport into the ONE toast it deserves.
   *
   * The receipt is built from what the backend actually did, never from the
   * length of the list we sent: a batch is best-effort, so "moved 7 files" over
   * a run where 2 failed is precisely the lie these commands return a value to
   * prevent. Failures are NAMED — "3 could not be moved" leaves the reader to
   * diff two lists by eye to find out which three. */
  function reportBulk(report: BulkReport, verbPast: string) {
    const n = report.ok.length;
    if (n > 0) {
      s.pushToast(
        "success",
        n === 1
          ? `${verbPast[0].toUpperCase()}${verbPast.slice(1)} "${displayName(report.ok[0])}".`
          : `${n} files ${verbPast}.`,
      );
    }
    if (report.failed.length > 0) {
      const named = report.failed
        .slice(0, 5)
        .map((f) => `"${displayName(f.name)}" — ${f.error}`)
        .join("\n");
      const more =
        report.failed.length > 5
          ? `\n…and ${report.failed.length - 5} more.`
          : "";
      s.pushToast(
        "error",
        `${report.failed.length} could not be ${verbPast}:\n${named}${more}`,
      );
    }
    // The cap is a fact about work NOT done. Silence here would make a
    // truncated batch read as a complete one.
    if (report.capped > 0) {
      s.pushToast(
        "info",
        `${report.capped} more were not attempted — one batch handles at most 200 files.`,
      );
    }
  }

  function clearSelection() {
    s.setSelectedFileIds(new Set());
    s.setSelectionAnchor(null);
  }

  /** The selection, in the order the rows are painted — which is the order every
   * receipt and every menu label counts in. Filtered against what is actually on
   * screen, so a file that has been filtered out or trashed under the selection
   * can never be silently acted on. */
  function selectedFiles(): FileMeta[] {
    const picked = s.selectedFileIds;
    if (picked.size === 0) return [];
    const byId = new Map(s.files.map((f) => [f.id, f]));
    return s.visibleFileOrder
      .filter((id) => picked.has(id))
      .map((id) => byId.get(id))
      .filter((f): f is FileMeta => f !== undefined);
  }

  /** One row's click, with its modifiers. Finder's grammar, because this list
   * looks like Finder's and anything else would be a trap:
   *   plain      → open the file (unchanged behaviour — the common case)
   *   ⌘/Ctrl     → toggle this row in the selection
   *   Shift      → select the range from the anchor to here
   * A plain click also CLEARS a selection: leaving one armed while the user has
   * moved on to reading a file is how a later "Remove" hits rows they had
   * forgotten were picked. */
  function clickFile(f: FileMeta, mods: { meta: boolean; shift: boolean }) {
    if (mods.shift && s.selectionAnchor) {
      const order = s.visibleFileOrder;
      const from = order.indexOf(s.selectionAnchor);
      const to = order.indexOf(f.id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        // Replaces rather than extends: shift-clicking a second time from the
        // same anchor must redraw the range, which is what makes an
        // overshoot correctable without starting over.
        s.setSelectedFileIds(new Set(order.slice(lo, hi + 1)));
        return;
      }
    }
    if (mods.meta) {
      s.setSelectedFileIds((cur) => {
        const next = new Set(cur);
        if (next.has(f.id)) next.delete(f.id);
        else next.add(f.id);
        return next;
      });
      s.setSelectionAnchor(f.id);
      return;
    }
    clearSelection();
    void viewFile(f.id);
  }

  function selectAllVisible() {
    s.setSelectedFileIds(new Set(s.visibleFileOrder));
    s.setSelectionAnchor(s.visibleFileOrder[0] ?? null);
  }

  /** Move every selected file into one folder. */
  async function moveFiles(ids: string[], folderId: string | null) {
    s.setMoveMenuFor(null);
    if (ids.length === 0) return;
    try {
      const report = await api.moveFilesToFolder(ids, folderId);
      s.setFiles(await api.listFiles());
      reportBulk(
        report,
        folderId === null
          ? "moved to the top level"
          : `moved into "${s.folders.find((f) => f.id === folderId)?.name ?? "the folder"}"`,
      );
    } catch (e) {
      s.pushToast("error", `Could not move those files: ${String(e)}`);
    }
  }

  /** Move every selected file to the trash — recoverable from the Trash tab,
   * exactly like the single-file Remove. */
  async function removeFiles(ids: string[]) {
    if (ids.length === 0) return;
    let report: BulkReport;
    try {
      report = await api.trashFiles(ids);
    } catch (e) {
      s.pushToast("error", `Could not remove those files: ${String(e)}`);
      return;
    }
    // Detach EVERY id from the UI, not only the ones that succeeded: an id that
    // failed because it was already gone must not be left in the attachment set
    // or under an open viewer either.
    ids.forEach(forgetFile);
    clearSelection();
    await tryToast(s, async () => s.setFiles(await api.listFiles()));
    await reloadTrash();
    reportBulk(report, "moved to the trash");
  }

  async function restoreFiles(ids: string[]) {
    if (ids.length === 0) return;
    let report: BulkReport;
    try {
      report = await api.restoreFiles(ids);
    } catch (e) {
      s.pushToast("error", `Could not restore those files: ${String(e)}`);
      return;
    }
    await tryToast(s, async () => s.setFiles(await api.listFiles()));
    await reloadTrash();
    reportBulk(report, "restored");
  }

  async function destroyFiles(ids: string[]) {
    if (ids.length === 0) return;
    let report: BulkReport;
    try {
      report = await api.deleteFilesPermanently(ids);
    } catch (e) {
      s.pushToast("error", `Could not delete those files: ${String(e)}`);
      return;
    }
    ids.forEach(forgetFile);
    await reloadTrash();
    reportBulk(report, "deleted for good");
  }

  /** Export a whole selection into one chosen folder. Uses the per-file export
   * the single-file path uses, so the "exported copies are NOT encrypted" note
   * still fires exactly once. */
  async function exportFiles(files: FileMeta[]) {
    if (files.length === 0) return;
    const dir = await api.chooseOpenPath({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    const failed: string[] = [];
    let done = 0;
    for (const f of files) {
      try {
        await api.exportFile(f.id, `${dir}/${f.name}`);
        done += 1;
      } catch (e) {
        failed.push(`"${displayName(f.name)}" — ${String(e)}`);
      }
    }
    if (done > 0) {
      noteExportOnce();
      s.pushToast(
        "success",
        done === 1
          ? `Exported "${displayName(files[0].name)}".`
          : `Exported ${done} files out of the room.`,
      );
    }
    if (failed.length > 0) {
      s.pushToast("error", `${failed.length} could not be exported:\n${failed.join("\n")}`);
    }
  }

  /** Pin every selected file into the next question at once. Adds only what is
   * missing, so it is idempotent and never removes an attachment the user set
   * up in the Sources tab. */
  function attachFiles(files: FileMeta[]) {
    if (files.length === 0) return;
    s.setAttachments((cur) => {
      const have = new Set(cur.map((f) => f.id));
      const added = files.filter((f) => !have.has(f.id));
      if (added.length === 0) return cur;
      return [...cur, ...added];
    });
  }

  async function viewFile(id: string, target?: FileTarget) {
    let content: FileContent;
    try {
      content = await api.getFileContent(id);
    } catch (e) {
      // Opening is the most-used action in the app; failing it silently left
      // the previous file on screen and read as a dead click.
      s.pushToast("error", `Could not open that file: ${String(e)}`);
      return;
    }
    s.setOpenFile({ id, content, target });
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

  /** Create a starter `.py` script and open it in the editor (the Scripts page's
   * "New script" action — a room .py/.js file IS a script). */
  async function createNewScript() {
    const starter = `# /// script
# dependencies = []
# ///
# A room script. To read/write room files, declare them above, e.g.:
#   # room-inputs: data.csv
#   # room-outputs: result.csv
# In a workflow's "Pipe" mode, stdin is the previous step's text and whatever you
# print to stdout becomes this step's output.
import sys

data = sys.stdin.read()
print(data.upper())
`;
    try {
      const meta = await api.saveGeneratedFile("New script.py", starter);
      s.setFiles(await api.listFiles());
      await viewFile(meta.id);
      s.setEditMode(true);
      s.pushToast("info", "New script created — edit it, then run it from the Scripts page.");
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** The editor calls this and immediately paints "all changes saved" — its
   * onSave is fire-and-forget — so a failed write MUST be loud here, and must
   * leave the dirty mirror raised so the unsaved-edits guard still stops a tab
   * switch from throwing the text away. */
  async function saveEdit(newText: string): Promise<boolean> {
    const current = s.openFile;
    if (!current) return false;
    try {
      // A Word file is rewritten paragraph by paragraph inside its own OOXML
      // so its styles, tables and images survive; everything else is a plain
      // whole-file write. Both are in-place saves — the difference is only in
      // what "in place" means for the format.
      if (current.content.kind === "docx") {
        await api.updateDocxText(current.id, newText);
      } else {
        await api.updateFileContent(current.id, newText);
      }
    } catch (e) {
      s.editorDirtyRef.current = true;
      s.pushToast(
        "error",
        `Could not save "${current.content.name}" — your edit is still in the editor. ${String(e)}`,
      );
      return false;
    }
    s.setOpenFile({
      ...current,
      content: { ...current.content, text: newText },
    });
    s.pushToast("success", `Saved "${current.content.name}".`);
    await tryToast(s, async () => s.setFiles(await api.listFiles()));
    return true;
  }

  async function saveEditAsCopy(newText: string): Promise<boolean> {
    const current = s.openFile;
    if (!current) return false;
    const base = current.content.name.replace(/\.[^.]+$/, "");
    try {
      const meta = await api.saveGeneratedFile(`${base} (edited).md`, newText);
      s.setFiles(await api.listFiles());
      s.pushToast("success", `Saved "${meta.name}" into the room — the original file is unchanged.`);
      return true;
    } catch (e) {
      s.editorDirtyRef.current = true;
      s.pushToast(
        "error",
        `Could not save a copy of "${current.content.name}" — your edit is still in the editor. ${String(e)}`,
      );
      return false;
    }
  }

  /** Branch the open note: a second file in the room with the same text.
   * Without this the only way to fork a file was to export a copy out of the
   * room and import it back. Offered for genuinely editable text only — the
   * stored bytes of a PDF or a recording cannot be copied from here. */
  async function duplicateOpenFile() {
    const current = s.openFile;
    if (!current || current.content.text == null) return;
    const name = current.content.name;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    try {
      // Duplicate twice and "<base> (copy)" is taken; Rust does not dedup
      // (`save_generated_impl` inserts straight through), so the library would
      // hold two indistinguishable rows and a source chip could only ever open
      // the newer one. "(copy) 2" instead.
      const meta = await api.saveGeneratedFile(
        uniqueFileName(
          `${base} (copy)${ext}`,
          s.files.map((f) => f.name),
        ),
        current.content.text,
      );
      s.setFiles(await api.listFiles());
      await viewFile(meta.id);
      s.pushToast("success", `Duplicated as "${meta.name}".`);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  async function editCell(sheet: string, cell: string, value: string) {
    if (!s.openFile) return;
    try {
      await api.setCell(s.openFile.id, sheet || null, cell, value);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Ask before an action throws away an unsaved edit.
   *
   * Monaco holds ONE buffer — the file that is showing — so anything that
   * unmounts it takes the edit with it: closing the file, switching or closing
   * a tab, opening an area, ⌘T. Those paths used to disagree with each other:
   * locking and quitting asked, the tab strip refused with a toast that offered
   * no way forward, and the viewer's own Close button silently discarded the
   * work. One question, three answers, one code path.
   *
   * `what` completes "… now would lose them", and `proceed` is the interrupted
   * action, replayed by whichever answer the user gives.
   */
  function guardLeave(what: string, proceed: () => void) {
    if (!s.editModeRef.current || !s.editorDirtyRef.current) {
      proceed();
      return;
    }
    s.setPendingLeave({ what, proceed });
  }

  /** What edit mode means for the open file, if anything.
   *
   * Answered by the viewer registry now — one table, shared with the viewer
   * dispatch and checked against the Rust format registry by a test. This used
   * to restate the rules by hand, which is how ".docx offers Edit as text"
   * outlived the in-place docx writer that had already been built for the AI. */
  function editModeOf(c: FileContent): EditMode | null {
    return registryEditModeOf(c);
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
        // `content.name` is the ONE name the open file carries — the viewer
        // header, the breadcrumb and the tab strip all read it.
        s.setOpenFile((o) =>
          o ? { ...o, content: o.content ? { ...o.content, name } : o.content } : o,
        );
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
    pinVersion, deleteVersion,
    undoEdits, suggestImports, dismissImportSuggestion, applyImportSuggestion,
    applyAllImportSuggestions, dismissAllImportSuggestions,
    reportImport, importFiles, removeFile, reloadTrash, restoreFile, destroyFile, emptyTrash,
    // The multi-selection: its state handlers and the batch verbs they drive.
    clearSelection, selectedFiles, clickFile, selectAllVisible,
    moveFiles, removeFiles, restoreFiles, destroyFiles, exportFiles, attachFiles,
    viewFile, createNewNote, createNewScript, saveEdit, saveEditAsCopy,
    duplicateOpenFile, editCell, editModeOf, guardLeave, startCreateFolder, commitCreateFolder,
    commitFolderRename, deleteFolder, moveFile, commitRenameFile,
    toggleFolderCollapse, clampMenu,
  };
}
