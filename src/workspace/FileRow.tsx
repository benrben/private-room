import { FileMeta, formatSize } from "../api";
import { DotsIcon, FileTypeIcon, PaperclipIcon } from "../icons";
import { displayName } from "./composer";
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
  const selected = s.openFile?.id === f.id;
  return (
    <div
      key={f.id}
      className={`file-row${selected ? " selected" : ""}${attached ? " attached" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", f.id);
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
        s.setCtxMenu({ file: f, x: e.clientX, y: e.clientY });
      }}
    >
      {s.renamingFile?.id === f.id ? (
        <input
          className="file-rename-input"
          autoFocus
          dir="auto"
          value={s.renamingFile.name}
          onChange={(e) => s.setRenamingFile({ id: f.id, name: e.target.value })}
          onBlur={a.commitRenameFile}
          onKeyDown={(e) => {
            if (e.key === "Enter") a.commitRenameFile();
            if (e.key === "Escape") s.setRenamingFile(null);
          }}
        />
      ) : (
        <button className="file-main" onClick={() => a.viewFile(f.id)}>
          <span className="file-icon">
            <FileTypeIcon file={f} />
          </span>
          <span className="file-name" title={f.name}>
            {displayName(f.name)}
          </span>
          {f.partiallyIndexed && (
            <span
              className="partial-badge"
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
          onClick={() => a.toggleAttach(f)}
        >
          <PaperclipIcon size={14} />
        </button>
        <button
          className="chip-btn"
          title="More actions"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            s.setMoveMenuFor(null);
            a.cancelConfirm();
            s.setCtxMenu({ file: f, x: r.right - 4, y: r.bottom + 4 });
          }}
        >
          <DotsIcon size={14} />
        </button>
      </span>
    </div>
  );
}
