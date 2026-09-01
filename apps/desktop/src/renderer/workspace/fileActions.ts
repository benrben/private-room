import { api, FileVersion } from "../api";
import { displayName } from "./composer";
import { WSState } from "./state";

/** The file id of the most recent open request, so a slower earlier open can
 * tell it has been superseded. Module-level because `makeFileActions` is
 * rebuilt on every render, and there is one workspace in the process. */
export let openIntent: string | null = null;

export function setOpenIntent(id: string) {
  openIntent = id;
}

export type UndoWindow = { askedAt: string | null; answeredAt: string | null };
export type UndoResult = { moved: string[]; undone: string[] };

export function undoWindow(messages: WSState["messages"], msgId: string): UndoWindow {
  const at = messages.findIndex((message) => message.id === msgId);
  return {
    answeredAt: at === -1 ? null : messages[at]!.createdAt,
    askedAt: at > 0 ? messages[at - 1]!.createdAt : null,
  };
}

export function headMovedSinceAnswer(head: FileVersion, answeredAt: string | null) {
  return !!answeredAt && head.savedAt > answeredAt;
}

export function versionToRestore(versions: FileVersion[], window: UndoWindow) {
  const head = versions[0];
  if (!head) return null;
  if (headMovedSinceAnswer(head, window.answeredAt)) return "moved" as const;
  const inTurn =
    window.askedAt && window.answeredAt
      ? versions.filter(
          (version) =>
            version.savedAt >= window.askedAt! &&
            version.savedAt <= window.answeredAt!,
        )
      : [];
  return (inTurn[inTurn.length - 1] ?? head).id;
}

async function undoFileVersion(fileId: string, window: UndoWindow) {
  const target = versionToRestore(await api.listFileVersions(fileId), window);
  if (target === null || target === "moved") return target;
  await api.restoreFileVersion(target);
  return "undone" as const;
}

export async function undoFileVersions(
  fileIds: string[],
  window: UndoWindow,
): Promise<UndoResult> {
  const result: UndoResult = { moved: [], undone: [] };
  for (const fileId of fileIds) {
    const outcome = await undoFileVersion(fileId, window);
    if (outcome === "moved") result.moved.push(fileId);
    if (outcome === "undone") result.undone.push(fileId);
  }
  return result;
}

export function clearUndoRecord(s: WSState, msgId: string) {
  s.setUndoByMsg((undoByMsg) => {
    const next = { ...undoByMsg };
    delete next[msgId];
    return next;
  });
}

export async function refreshUndoneFile(s: WSState, undone: string[]) {
  s.setFiles(await api.listFiles());
  const current = s.openFileRef.current;
  if (!current || !undone.includes(current.id)) return;
  const content = await api.getFileContent(current.id);
  s.setOpenFile({ ...current, content });
  s.setViewerRev((revision) => revision + 1);
}

export function undoFileName(s: WSState, id: string) {
  const file = s.files.find((candidate) => candidate.id === id);
  return file ? `"${displayName(file.name)}"` : "That file";
}

export function reportUndoneFiles(s: WSState, undone: string[]) {
  if (undone.length === 0) return;
  s.pushToast(
    "success",
    undone.length > 1
      ? `Undid changes to ${undone.length} files.`
      : "Change undone.",
  );
}

export function reportMovedFiles(s: WSState, moved: string[]) {
  if (moved.length === 0) return;
  const which = moved.map((id) => undoFileName(s, id)).join(", ");
  const text =
    moved.length > 1
      ? `${which} have been saved again since that answer, so they were left alone — open a file's version history to go further back.`
      : `${which} has been saved again since that answer, so it was left alone — open its version history to go further back.`;
  s.pushToast("info", text);
}

/** File + folder + open-file state handlers (import/view/edit/versions/folders).
 * All state lives in `s`; this only owns the plumbing. Extracted verbatim. */

import { makeFileStorageActions } from "./fileStorageActions";
import { makeFileViewerActions } from "./fileViewerActions";
import { makeFileSelectionActions } from "./fileSelectionActions";

export function makeFileActions(s: WSState) {
  const storage = makeFileStorageActions(s);
  const viewer = makeFileViewerActions(s);
  const selection = makeFileSelectionActions(s, { ...storage, ...viewer });
  const actions = { ...storage, ...selection, ...viewer };
  const { noteExportOnce, exportOne, exportAllFiles, openHistory, openCompare, restoreVersion, pinVersion, deleteVersion, undoEdits, suggestImports, dismissImportSuggestion, applyImportSuggestion, applyAllImportSuggestions, dismissAllImportSuggestions, reportImport, importFiles, removeFile, reloadTrash, restoreFile, destroyFile, emptyTrash, clearSelection, selectedFiles, clickFile, selectAllVisible, moveFiles, removeFiles, restoreFiles, destroyFiles, exportFiles, attachFiles, viewFile, createNewNote, createNewScript, createSketch, setInLibrary, exportSketchAs, saveEdit, saveEditAsCopy, duplicateOpenFile, editCell, editModeOf, guardLeave, startCreateFolder, commitCreateFolder, commitFolderRename, deleteFolder, moveFile, commitRenameFile, toggleFolderCollapse, clampMenu } = actions;
  return { noteExportOnce, exportOne, exportAllFiles, openHistory, openCompare, restoreVersion, pinVersion, deleteVersion, undoEdits, suggestImports, dismissImportSuggestion, applyImportSuggestion, applyAllImportSuggestions, dismissAllImportSuggestions, reportImport, importFiles, removeFile, reloadTrash, restoreFile, destroyFile, emptyTrash, clearSelection, selectedFiles, clickFile, selectAllVisible, moveFiles, removeFiles, restoreFiles, destroyFiles, exportFiles, attachFiles, viewFile, createNewNote, createNewScript, createSketch, setInLibrary, exportSketchAs, saveEdit, saveEditAsCopy, duplicateOpenFile, editCell, editModeOf, guardLeave, startCreateFolder, commitCreateFolder, commitFolderRename, deleteFolder, moveFile, commitRenameFile, toggleFolderCollapse, clampMenu };
}
