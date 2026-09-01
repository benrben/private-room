import { api, type BulkReport, type FileMeta } from "../api";
import { displayName } from "./composer";
import { tryToast } from "./guard";
import type { WSState } from "./state";
import type { Toast } from "./types";
import type { FileStorageActions } from "./fileStorageActions";
import type { FileViewerActions } from "./fileViewerActions";

export function makeFileSelectionActions(s: WSState, actions: FileStorageActions & FileViewerActions) {
  const { noteExportOnce, reloadTrash, forgetFile, viewFile } = actions;


  // ---- the Library's multi-selection ----------------------------------------

  /** Turn a BulkReport into the ONE toast it deserves.
   *
   * The receipt is built from what the backend actually did, never from the
   * length of the list we sent: a batch is best-effort, so "moved 7 files" over
   * a run where 2 failed is precisely the lie these commands return a value to
   * prevent. Failures are NAMED — "3 could not be moved" leaves the reader to
   * diff two lists by eye to find out which three.
   *
   * `undo` rides on the success receipt for the batches that have an inverse.
   * It needs `about` too: a toast carrying an action but no `about` never
   * expires (toastStack.toastLifeMs), and one `about` per KIND of batch means
   * a second bulk removal replaces the first rather than leaving two Undos on
   * screen that mean different things. */
  function reportBulk(
    report: BulkReport,
    verbPast: string,
    undo?: { action: Toast["action"]; about: string },
  ) {
    const n = report.ok.length;
    if (n > 0) {
      s.pushToast(
        "success",
        n === 1
          ? `${verbPast[0].toUpperCase()}${verbPast.slice(1)} "${displayName(report.ok[0])}".`
          : `${n} files ${verbPast}.`,
        undo?.action,
        undo?.about,
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

  function selectionRange(id: string) {
    if (!s.selectionAnchor) return null;
    const order = s.visibleFileOrder;
    const from = order.indexOf(s.selectionAnchor);
    const to = order.indexOf(id);
    if (from === -1 || to === -1) return null;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return new Set(order.slice(lo, hi + 1));
  }

  function toggleFileSelection(id: string) {
    s.setSelectedFileIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    s.setSelectionAnchor(id);
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
    const range = mods.shift ? selectionRange(f.id) : null;
    if (range) {
      s.setSelectedFileIds(range);
      return;
    }
    if (mods.meta) {
      toggleFileSelection(f.id);
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
    // The Undo can only send the ids this call sent, so it is offered only when
    // every one of them actually landed in the trash. `db::restore_file` refuses
    // a file that was never trashed, so on a partial batch — some failed, or the
    // tail was past the backend's per-batch ceiling — pressing Undo would answer
    // a removal with a list of restore failures.
    const wholeBatchLanded = report.failed.length === 0 && report.capped === 0;
    reportBulk(
      report,
      "moved to the trash",
      wholeBatchLanded
        ? {
            action: { label: "Undo", run: () => void restoreFiles(ids) },
            about: "file-bulk",
          }
        : undefined,
    );
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

  async function exportEach(files: FileMeta[], directory: string) {
    const failed: string[] = [];
    let done = 0;
    for (const file of files) {
      try {
        await api.exportFile(file.id, `${directory}/${file.name}`);
        done += 1;
      } catch (error) {
        failed.push(`"${displayName(file.name)}" — ${String(error)}`);
      }
    }
    return { done, failed };
  }

  function reportExportSuccess(files: FileMeta[], done: number) {
    if (done === 0) return;
    noteExportOnce();
    s.pushToast(
      "success",
      done === 1
        ? `Exported "${displayName(files[0].name)}".`
        : `Exported ${done} files out of the room.`,
    );
  }

  function reportExportFailures(failed: string[]) {
    if (failed.length > 0) {
      s.pushToast(
        "error",
        `${failed.length} could not be exported:\n${failed.join("\n")}`,
      );
    }
  }

  /** Export a whole selection into one chosen folder. Uses the per-file export
   * the single-file path uses, so the "exported copies are NOT encrypted" note
   * still fires exactly once. */
  async function exportFiles(files: FileMeta[]) {
    if (files.length === 0) return;
    const directory = await api.chooseOpenPath({ directory: true });
    if (!directory || Array.isArray(directory)) return;
    const result = await exportEach(files, directory);
    reportExportSuccess(files, result.done);
    reportExportFailures(result.failed);
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
  return { reportBulk, clearSelection, selectedFiles, selectionRange, toggleFileSelection, clickFile, selectAllVisible, moveFiles, removeFiles, restoreFiles, destroyFiles, exportEach, reportExportSuccess, reportExportFailures, exportFiles, attachFiles };
}
