import { FileMeta, formatSize } from "../api";
import { DotsIcon, FileTypeIcon, PaperclipIcon } from "../icons";
import { fileLabel } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** One file row — identical behaviour whether loose or inside a folder. Actions
 * (attach + a ••• menu) reveal on hover. Extracted verbatim from renderFileRow. */
export default function FileRow({
  f,
  s,
  a,
}: {
  f: FileMeta;
  s: WSState;
  a: WSActions;
}) {
  const attached = s.attachments.some((x) => x.id === f.id);
  const isOpen = s.openFile?.id === f.id;
  const picked = s.selectedFileIds.has(f.id);
  return (
    <div
      key={f.id}
      // Three independent states, three independent classes. `is-open` is
      // "you are reading this", `is-picked` is "this is in the set you are
      // about to act on", and they are genuinely different — the file you have
      // open is very often NOT one of the seven you just selected to move.
      className={`file-row${isOpen ? " selected" : ""}${attached ? " attached" : ""}${picked ? " is-picked" : ""}`}
      draggable
      onDragStart={(e) => {
        // Dragging a row that is part of the selection drags the WHOLE
        // selection. Dragging one that isn't drags just it — and does not
        // silently redefine what "selected" means underneath the user.
        const ids = picked ? a.selectedFiles().map((x) => x.id) : [f.id];
        e.dataTransfer.setData("text/plain", ids.join("\n"));
        e.dataTransfer.effectAllowed = "move";
        s.internalDragRef.current = true;
      }}
      onDragEnd={() => {
        s.internalDragRef.current = false;
        s.setDragOverFolder(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        s.setMoveMenuFor(null);
        a.cancelConfirm();
        // Finder's rule: right-clicking INSIDE a selection acts on all of it;
        // right-clicking outside one drops the selection and acts on that row.
        // The alternative — always acting on the clicked row — makes "select
        // 7, right-click, Remove" quietly delete one file.
        const inSelection = s.selectedFileIds.has(f.id);
        const files = inSelection ? a.selectedFiles() : [f];
        if (!inSelection) a.clearSelection();
        s.setCtxMenu({ file: f, files, x: e.clientX, y: e.clientY });
      }}
    >
      {/* Not when the VIEWER opened the rename: the library lists a row for the
          open file too, and two autoFocus inputs on one state slot blur — and
          so cancel — each other in the same commit. */}
      {s.renamingFile?.id === f.id && s.renamingFile.where !== "viewer" ? (
        <input
          className="file-rename-input"
          autoFocus
          dir="auto"
          value={s.renamingFile.name}
          onChange={(e) =>
            s.setRenamingFile({ id: f.id, name: e.target.value, where: "library" })
          }
          onBlur={a.commitRenameFile}
          onKeyDown={(e) => {
            if (e.key === "Enter") a.commitRenameFile();
            if (e.key === "Escape") s.setRenamingFile(null);
          }}
        />
      ) : (
        <button
          className="file-main"
          onClick={(e) =>
            a.clickFile(f, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })
          }
        >
          {/* Selection is what makes Move / Export / Remove act on seven files
              instead of one, so it has to be READABLE, not just tinted. It used
              to be `aria-selected` on the row's wrapper div — an attribute every
              browser drops on an element with no role and no listbox above it,
              so the state was announced on nothing. The word rides inside the
              button's own name instead, where it is read out with the file. */}
          {picked && <span className="sr-only">Selected. </span>}
          <span className="file-icon">
            <FileTypeIcon file={f} />
          </span>
          <span className="file-name-col">
            <span className="file-name" title={f.name}>
              {fileLabel(f.name, s.files)}
            </span>
            {/* "Describe new files automatically" (Settings > Behavior) fills
                this in on its own schedule — most files won't have one yet,
                which is why it's only drawn when present. */}
            {f.aiSummary && (
              <span className="file-description" title={f.aiSummary}>
                {f.aiSummary}
              </span>
            )}
          </span>
          {/* Both badges below are STATE, and a row is rendered hundreds of
              times, so each is a single span with no per-row cost. They are
              also the two states in this list that were carried by a glyph or
              a colour alone: a bare "◐" and an empty dot, each with only a
              `title`, which a screen reader is not obliged to announce and a
              keyboard user can never hover to see. `role="img"` plus a name
              makes each one a real, announced status. */}
          {f.partiallyIndexed && (
            <span
              className="partial-badge"
              role="img"
              aria-label="Partially indexed"
              title="Partially indexed — only the first part of this large file is searchable."
            >
              ◐
            </span>
          )}
          {/* ADD-18: media readiness scans from the row itself — a pulsing
              dot while the voice model is transcribing this file. */}
          {s.sttStatus[f.name] === "processing" && (
            <span
              className="stt-badge"
              role="img"
              aria-label="Transcribing"
              title="Transcribing on this Mac — the transcript appears when it's done."
            />
          )}
          <span className="file-size">{formatSize(f.sizeBytes)}</span>
        </button>
      )}
      <span className="row-actions">
        <button
          className={`chip-btn ${attached ? "active" : ""}`}
          title={
            f.mimeType.startsWith("image/")
              ? "Attach image to your next question (vision)"
              : "Pin this file into your next question"
          }
          aria-label={
            f.mimeType.startsWith("image/")
              ? "Attach image to your next question (vision)"
              : "Pin this file into your next question"
          }
          aria-pressed={attached}
          onClick={() => a.toggleAttach(f)}
        >
          <PaperclipIcon size={14} />
        </button>
        <button
          className="chip-btn"
          title="More actions"
          aria-label="More actions"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            s.setMoveMenuFor(null);
            a.cancelConfirm();
            // Same many-vs-one rule as the right-click: the ••• of a row inside
            // the selection opens the menu for the whole selection.
            const inSelection = s.selectedFileIds.has(f.id);
            const files = inSelection ? a.selectedFiles() : [f];
            if (!inSelection) a.clearSelection();
            s.setCtxMenu({ file: f, files, x: r.right - 4, y: r.bottom + 4 });
          }}
        >
          <DotsIcon size={14} />
        </button>
      </span>
    </div>
  );
}
