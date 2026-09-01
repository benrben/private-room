import { FileMeta, formatSize } from "../api";
import { DotsIcon, FileTypeIcon, PaperclipIcon } from "../icons";
import { fileLabel } from "./composer";
import { WSState } from "./state";
import { WSActions } from "./actions";

type RowProps = { f: FileMeta; s: WSState; a: WSActions };

function rowClass({
  attached,
  isOpen,
  picked,
}: {
  attached: boolean;
  isOpen: boolean;
  picked: boolean;
}) {
  return `file-row${isOpen ? " selected" : ""}${attached ? " attached" : ""}${picked ? " is-picked" : ""}`;
}

function selectionFiles(f: FileMeta, picked: boolean, a: WSActions) {
  return picked ? a.selectedFiles() : [f];
}

function openContextMenu(
  f: FileMeta,
  picked: boolean,
  s: WSState,
  a: WSActions,
  x: number,
  y: number,
) {
  s.setMoveMenuFor(null);
  a.cancelConfirm();
  const files = selectionFiles(f, picked, a);
  if (!picked) a.clearSelection();
  s.setCtxMenu({ file: f, files, x, y });
}

function RenameInput({ f, s, a }: RowProps) {
  if (s.renamingFile?.id !== f.id || s.renamingFile.where === "viewer")
    return null;
  return (
    <input
      className="file-rename-input"
      autoFocus
      dir="auto"
      value={s.renamingFile.name}
      onChange={(event) =>
        s.setRenamingFile({
          id: f.id,
          name: event.target.value,
          where: "library",
        })
      }
      onBlur={a.commitRenameFile}
      onKeyDown={(event) => {
        if (event.key === "Enter") a.commitRenameFile();
        if (event.key === "Escape") s.setRenamingFile(null);
      }}
    />
  );
}

function FileStatus({ f, s }: Pick<RowProps, "f" | "s">) {
  return (
    <>
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
      {s.sttStatus[f.name] === "processing" && (
        <span
          className="stt-badge"
          role="img"
          aria-label="Transcribing"
          title="Transcribing on this Mac — the transcript appears when it's done."
        />
      )}
    </>
  );
}

function FileMain({ f, s, a, picked }: RowProps & { picked: boolean }) {
  if (s.renamingFile?.id === f.id && s.renamingFile.where !== "viewer")
    return null;
  return (
    <button
      className="file-main"
      onClick={(event) =>
        a.clickFile(f, {
          meta: event.metaKey || event.ctrlKey,
          shift: event.shiftKey,
        })
      }
    >
      {picked && <span className="sr-only">Selected. </span>}
      <span className="file-icon">
        <FileTypeIcon file={f} />
      </span>
      <span className="file-name-col">
        <span className="file-name" title={f.name}>
          {fileLabel(f.name, s.files)}
        </span>
        {f.aiSummary && (
          <span className="file-description" title={f.aiSummary}>
            {f.aiSummary}
          </span>
        )}
      </span>
      <FileStatus f={f} s={s} />
      <span className="file-size">{formatSize(f.sizeBytes)}</span>
    </button>
  );
}

function RowActions({
  f,
  s,
  a,
  attached,
  picked,
}: RowProps & { attached: boolean; picked: boolean }) {
  const attachLabel = f.mimeType.startsWith("image/")
    ? "Attach image to your next question (vision)"
    : "Pin this file into your next question";
  const showMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    openContextMenu(f, picked, s, a, bounds.right - 4, bounds.bottom + 4);
  };
  return (
    <span className="row-actions">
      <button
        className={`chip-btn ${attached ? "active" : ""}`}
        title={attachLabel}
        aria-label={attachLabel}
        aria-pressed={attached}
        onClick={() => a.toggleAttach(f)}
      >
        <PaperclipIcon size={14} />
      </button>
      <button
        className="chip-btn"
        title="More actions"
        aria-label="More actions"
        onClick={showMenu}
      >
        <DotsIcon size={14} />
      </button>
    </span>
  );
}

export default function FileRow({ f, s, a }: RowProps) {
  const attached = s.attachments.some((file) => file.id === f.id);
  const isOpen = s.openFile?.id === f.id;
  const picked = s.selectedFileIds.has(f.id);
  const startDrag = (event: React.DragEvent<HTMLDivElement>) => {
    const ids = selectionFiles(f, picked, a).map((file) => file.id);
    event.dataTransfer.setData("text/plain", ids.join("\n"));
    event.dataTransfer.effectAllowed = "move";
    s.internalDragRef.current = true;
  };
  return (
    <div
      key={f.id}
      className={rowClass({ attached, isOpen, picked })}
      draggable
      onDragStart={startDrag}
      onDragEnd={() => {
        s.internalDragRef.current = false;
        s.setDragOverFolder(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        openContextMenu(f, picked, s, a, event.clientX, event.clientY);
      }}
    >
      <RenameInput f={f} s={s} a={a} />
      <FileMain f={f} s={s} a={a} picked={picked} />
      <RowActions f={f} s={s} a={a} attached={attached} picked={picked} />
    </div>
  );
}
