import { api, type FileContent, type FileTarget } from "../api";
import { displayName, uniqueFileName } from "./composer";
import { sectionLabel } from "./fileVisibility";
import { tryToast } from "./guard";
import type { WSState } from "./state";
import { EditMode, editModeOf as registryEditModeOf } from "../viewers/registry";
import { openIntent, setOpenIntent } from "./fileActions";

export function makeFileViewerActions(s: WSState) {


  /** Open a file into the viewer — the funnel every open in the app goes
   * through (Library click, ⌘K hit, agent open, job toast, recording chip).
   *
   * Replacing the open document unmounts Monaco with its buffer in it, which
   * is the same loss closing the file causes, from a click that never mentions
   * the file being left. So it asks first — except when the id ALREADY showing
   * is the one being opened: that is a reload (the agent rewrote it, a
   * recording finished writing it), and a dialog there would be a false alarm
   * about work nothing is about to throw away. */
  async function viewFile(id: string, target?: FileTarget) {
    const showing = s.openFileRef.current;
    if (showing && showing.id !== id) {
      // `guardLeave` runs `proceed` ON THE SPOT when there is nothing to lose —
      // the ordinary path — so hold onto that promise: callers await this to
      // know the file is on screen. "New page" turns edit mode on the moment it
      // resolves, and an unawaited open lands `setEditMode(false)` behind them,
      // opening the new note read-only. When the dialog DOES go up there is
      // nothing here to wait for: the open happens whenever it is answered, and
      // blocking until then would hang callers that must carry on regardless
      // (a started recording attaches its microphone on the next line).
      let opening: Promise<void> = Promise.resolve();
      guardLeave("Opening another file", () => {
        opening = openFile(id, target);
      });
      await opening;
      return;
    }
    await openFile(id, target);
  }

  async function openFile(id: string, target?: FileTarget) {
    // One key for every message about opening THIS file. It makes the failure
    // replaceable rather than stackable, and retirable by the success below.
    const about = `open:${id}`;
    // The LAST open asked for is the one that must land. Two can be in flight
    // at once — a click while a big PDF is still fetching, the job-finished
    // toast's auto-open, a recording's reload — and `get_file_content` calls
    // are separate tasks whose order out of the room mutex is not the order
    // they went in. Whoever resolved last used to win the screen, which is the
    // click the user made FIRST.
    setOpenIntent(id);
    // Say it is opening BEFORE the wait, not after it. `get_file_content` is a
    // synchronous command behind the room mutex, so on a large file this await
    // is the whole delay — and nothing on screen changed for its duration.
    s.setOpeningFileId(id);
    let content: FileContent;
    try {
      content = await api.getFileContent(id);
    } catch (e) {
      // Opening is the most-used action in the app; failing it silently left
      // the previous file on screen and read as a dead click. The failure is
      // reported either way — but the "Opening…" indicator belongs to whichever
      // open is still running, so a superseded call must not clear it.
      if (openIntent === id) s.setOpeningFileId(null);
      // NAME THE FILE. "Could not open that file" is unanswerable in a room of
      // two hundred: the click that failed is over, the Library selection may
      // have moved on, and the message outlives both.
      const known = s.files.find((f) => f.id === id);
      const what = known ? `“${displayName(known.name)}”` : "that file";
      s.pushToast(
        "error",
        `Could not open ${what}: ${String(e)}`,
        { label: "Try again", run: () => void viewFile(id, target) },
        about,
      );
      return;
    }
    // A newer open was asked for while this one was fetching: that one owns the
    // screen and the "Opening…" line. Painting this content now would put the
    // file the user left back over the one they just chose.
    if (openIntent !== id) return;
    // It opened. Whatever this file's last failure said about it is now false.
    s.forgetToastsAbout(about);
    s.setOpeningFileId(null);
    s.setOpenFile({ id, content, target });
    s.setEditMode(false);
    s.setShowMap(false);
  }

  /** "New page": a blank Markdown note via the ordinary generated-file path
   * (same command chat's "Save to room" uses), opened straight into editing.
   * A dated name keeps repeat presses from colliding.
   *
   * The unsaved-edits question is asked BEFORE anything is written, not by the
   * `viewFile` below: cancelling it must not leave a note nobody asked for in
   * the library, and the `setEditMode` that follows the open belongs to the new
   * note, never to the file the user is still editing. */
  function createNewNote() {
    guardLeave("Making a new note", () => void writeNewNote());
  }

  async function writeNewNote() {
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

  /** "New sketch": a blank drawing, filed under Sketches and opened on its
   * canvas. Section-only from birth (`commands/sketch.rs`) — it appears in
   * Sketches and reaches Home only if the person who drew it says so.
   *
   * Lives here rather than in the sketch gallery because it is now reachable
   * from three places — the Sketches sidebar header, ⌘T in that destination,
   * and the gallery — and three copies of "mint a unique name, create, refresh,
   * open" is three chances for them to drift. */
  async function createSketch() {
    try {
      const taken = new Set(s.files.map((f) => f.name.toLowerCase()));
      let name = "Sketch";
      for (let n = 2; taken.has(`${name.toLowerCase()}.sketch`); n++)
        name = `Sketch ${n}`;
      const meta = await api.createSketch(name);
      s.setFiles(await api.listFiles());
      await viewFile(meta.id);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Add this object to Home's Library, or take the Home reference away.
   *
   * ONE OBJECT THROUGHOUT. The command updates a single column on a single row,
   * so the id, the bytes, the version history, the title and the metadata are
   * untouched and both views go on reading the same file. Removing is not
   * deleting and never has been: the object stays exactly where it lives, which
   * is why the confirmation says so out loud.
   *
   * Idempotent — the value is stated, not toggled — so a double press, a
   * repeated agent call and a replayed undo all land in the same place. */
  async function setInLibrary(id: string, linked: boolean) {
    const before = s.files.find((f) => f.id === id);
    const label = before ? displayName(before.name) : "That object";
    const where = before
      ? sectionLabel(before.originDestination)
      : "its section";
    try {
      await api.setFileInLibrary(id, linked);
      s.setFiles(await api.listFiles());
      // Keyed on the OBJECT, so changing your mind about one sketch leaves one
      // message rather than a column of contradictory ones — and so this
      // confirmation expires, unlike an offer, because the object's own chip
      // still offers both directions long after the toast has gone.
      const said = linked
        ? `Added “${label}” to the Library — it is still in ${where}.`
        : `Removed “${label}” from the Library — it is still in ${where}.`;
      s.pushToast(
        "success",
        said,
        { label: "Undo", run: () => void setInLibrary(id, !linked) },
        `library:${id}`,
      );
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  /** Flatten a drawing into a picture or a vector, as a new room file.
   *
   * A drawing's two shareable formats. Deliberately a room file rather than a
   * download: everything else in this app stays inside the room unless the
   * user explicitly exports it out, and a sketch should not be the one thing
   * that quietly writes to the Desktop. */
  async function exportSketchAs(id: string, kind: "png" | "svg") {
    try {
      const meta =
        kind === "png"
          ? await api.exportSketchPng(id)
          : await api.exportSketchSvg(id);
      s.setFiles(await api.listFiles());
      s.pushToast(
        "success",
        `Saved “${displayName(meta.name)}” into this room.`,
        {
          label: "Open it",
          run: () => void viewFile(meta.id),
        },
      );
    } catch (e) {
      s.pushToast(
        "error",
        `Could not save that ${kind.toUpperCase()}: ${String(e)}`,
      );
    }
  }

  /** Create a starter `.py` script and open it in the editor (the Scripts page's
   * "New script" action — a room .py/.js file IS a script). Asks about an
   * unsaved edit before writing anything, for the same reason `createNewNote`
   * does. */
  function createNewScript() {
    guardLeave("Making a new script", () => void writeNewScript());
  }

  async function writeNewScript() {
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
    // `save_generated_impl` does not de-duplicate, so a second press used to
    // file a second row also called "New script.py" — indistinguishable in the
    // Scripts list, the top-bar shortcut menu and the run-consent card.
    const name = uniqueFileName(
      "New script.py",
      s.files.map((f) => f.name),
    );
    try {
      const meta = await api.saveGeneratedFile(name, starter);
      s.setFiles(await api.listFiles());
      await viewFile(meta.id);
      s.setEditMode(true);
      s.pushToast(
        "info",
        `"${displayName(name)}" created — edit it, then run it from the Scripts page.`,
      );
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
      s.pushToast(
        "success",
        `Saved "${meta.name}" into the room — the original file is unchanged.`,
      );
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
    await tryToast(
      s,
      () => api.deleteFolder(id),
      async () => {
        s.setFolders(await api.listFolders());
        s.setFiles(await api.listFiles());
      },
    );
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
    await tryToast(
      s,
      () => api.renameFile(pending.id, name),
      async () => {
        s.setFiles(await api.listFiles());
        if (s.openFileRef.current?.id === pending.id) {
          // `content.name` is the ONE name the open file carries — the viewer
          // header, the breadcrumb and the tab strip all read it.
          s.setOpenFile((o) =>
            o
              ? {
                  ...o,
                  content: o.content ? { ...o.content, name } : o.content,
                }
              : o,
          );
        }
      },
    );
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
  return { viewFile, openFile, createNewNote, writeNewNote, createSketch, setInLibrary, exportSketchAs, createNewScript, writeNewScript, saveEdit, saveEditAsCopy, duplicateOpenFile, editCell, guardLeave, editModeOf, startCreateFolder, commitCreateFolder, commitFolderRename, deleteFolder, moveFile, commitRenameFile, toggleFolderCollapse, clampMenu };
}
export type FileViewerActions = ReturnType<typeof makeFileViewerActions>;
