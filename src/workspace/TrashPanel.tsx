import { useEffect, useRef } from "react";
import { TrashActorKind, TrashedFile } from "../api";
import { displayName } from "./composer";
import DeleteControl from "./DeleteControl";
import { TrashIcon, UndoIcon } from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** How a deletion is attributed in the trash.
 *
 * The whole reason this column exists is the owner's decision to leave "ask
 * before AI edits files" OFF: the app removes things without asking, so "what
 * did the agent delete" has to be answerable at a glance. Each kind therefore
 * gets its own words — never a generic "Deleted" that reads the same whoever
 * did it.
 *
 * `unknown` is a row from before the actor was recorded. It says so rather than
 * being attributed to the person, because the database does not know. */
function actorLabel(by: TrashActorKind, byId: string | null): string {
  switch (by) {
    case "user":
      return "by you";
    case "agent":
      return byId ? `by the AI · ${byId}` : "by the AI";
    case "app":
      return byId ? `by Arcelle · ${byId}` : "by Arcelle";
    default:
      return "by an unrecorded actor";
  }
}

/** Room-local ISO-8601 ("2026-08-03T14:05:09Z") as something readable. An
 * unparseable stamp is shown verbatim — inventing a date would be worse than
 * showing the raw one. */
function whenLabel(iso: string): string {
  const t = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The Library pane's third tab: what has been deleted, when, and by what —
 * with the two ways out (put it back, or destroy it for good).
 *
 * Deliberately a peer of "Browse" rather than a modal: the trash is part of the
 * library's story, and a deletion the user cannot stumble across is a deletion
 * they will never undo. */
export default function TrashPanel({
  s,
  a,
}: {
  s: WSState;
  a: WSActions;
}) {
  // No filter box here (see Sidebar.tsx — it's suppressed for this tab), so
  // this reads the full trash. Filtering it by whatever text happened to be
  // left in the Library's search field would show a silently-trimmed list
  // with no visible control to explain or clear it.
  const shown: TrashedFile[] = s.trashed;

  if (s.trashed.length === 0) {
    return (
      <div className="library-scroll trash-list">
        <p className="trash-empty">
          Nothing deleted. Files you remove land here first — they leave the
          library, the counts and the AI's search, but stay inside this
          encrypted room until you delete them for good.
        </p>
      </div>
    );
  }

  // The trash gets the same multi-selection as the library, over its own rows.
  // Twenty files deleted by one agent errand is exactly the case where putting
  // them back one at a time is the difference between undo being real and undo
  // being theoretical.
  const picked = shown.filter((f) => s.selectedTrashIds.has(f.id));
  const toggle = (id: string) =>
    s.setSelectedTrashIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Select-all is scoped to the rows actually painted, same discipline as the
  // library's ⌘A (BrowsePanel's `paintedOrder`): it must never reach for a row
  // the reader cannot currently see.
  const allPicked = shown.length > 0 && picked.length === shown.length;
  const somePicked = picked.length > 0 && !allPicked;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = somePicked;
  }, [somePicked]);
  const toggleAll = () =>
    s.setSelectedTrashIds((cur) => {
      const next = new Set(cur);
      if (allPicked) shown.forEach((f) => next.delete(f.id));
      else shown.forEach((f) => next.add(f.id));
      return next;
    });

  return (
    <div className="library-scroll trash-list">
      <p className="trash-note">
        These files are out of the library and out of everything the AI can
        search. Their contents never left this room.
      </p>
      <label className="trash-select-all">
        <input
          type="checkbox"
          ref={selectAllRef}
          checked={allPicked}
          onChange={toggleAll}
          aria-label={allPicked ? "Deselect all deleted files" : "Select all deleted files"}
        />
        Select all
      </label>
      {picked.length > 0 && (
        <div className="selection-bar" role="toolbar" aria-label={`${picked.length} deleted files selected`}>
          <span className="selection-count" role="status">
            {picked.length} selected
          </span>
          <div className="selection-actions">
            <button
              className="chip-btn"
              title={`Put ${picked.length} files back in the library`}
              onClick={() => {
                const ids = picked.map((f) => f.id);
                s.setSelectedTrashIds(new Set());
                void a.restoreFiles(ids);
              }}
            >
              <UndoIcon size={14} /> Restore
            </button>
            {/* Its own confirm key and its own question: this one ends the
                files, unlike the library's Remove which lands them here. */}
            <DeleteControl
              k="trash-destroy-selection"
              trigger={<TrashIcon size={14} />}
              question={`Delete ${picked.length} file${picked.length === 1 ? "" : "s"} for good? This cannot be undone.`}
              title={`Delete ${picked.length} selected file${picked.length === 1 ? "" : "s"} for good`}
              onConfirm={() => {
                const ids = picked.map((f) => f.id);
                s.setSelectedTrashIds(new Set());
                void a.destroyFiles(ids);
              }}
              confirmDelete={s.confirmDelete}
              askConfirm={a.askConfirm}
              cancelConfirm={a.cancelConfirm}
            />
            <button
              className="chip-btn"
              title="Clear the selection"
              aria-label="Clear the selection"
              onClick={() => s.setSelectedTrashIds(new Set())}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {shown.map((f) => (
        <div
          className={`trash-row${s.selectedTrashIds.has(f.id) ? " is-picked" : ""}`}
          key={f.id}
        >
          <input
            type="checkbox"
            className="trash-row-check"
            checked={s.selectedTrashIds.has(f.id)}
            aria-label={`Select ${displayName(f.name)}`}
            onChange={() => toggle(f.id)}
          />
          <div className="trash-row-main">
            <span className="trash-row-name" dir="auto" title={f.name}>
              {displayName(f.name)}
            </span>
            <span className="trash-row-meta">
              {whenLabel(f.trashedAt)} · {actorLabel(f.trashedBy, f.trashedById)}{" "}
              · {sizeLabel(f.sizeBytes)}
            </span>
          </div>
          <div className="trash-row-actions">
            <button
              className="chip-btn"
              title={`Put "${displayName(f.name)}" back in the library`}
              aria-label={`Restore ${displayName(f.name)}`}
              onClick={() => void a.restoreFile(f.id)}
            >
              <UndoIcon size={14} />
            </button>
            {/* The armed confirm is a consent surface — ADD-25 blocks the
                agent driver from clicking ✓ on a destruction it didn't earn.
                It asks a DIFFERENT question than the library's delete: that one
                moves a file here and is undoable from this very panel, this one
                is the end of the file. Same prompt for both would make the
                irreversible click look like the recoverable one. */}
            <DeleteControl
              k={`trash-destroy-${f.id}`}
              trigger={<TrashIcon size={14} />}
              question="Delete for good? This cannot be undone."
              title={`Delete "${displayName(f.name)}" for good`}
              onConfirm={() => void a.destroyFile(f.id)}
              confirmDelete={s.confirmDelete}
              askConfirm={a.askConfirm}
              cancelConfirm={a.cancelConfirm}
            />
          </div>
        </div>
      ))}
      <div className="trash-footer">
        {s.confirmDelete === "trash-empty-all" ? (
          <div className="trash-confirm" data-agent-blocked role="alert">
            {/* Say the irreversible part out loud, and say how many. */}
            <span>
              Delete {s.trashed.length} file
              {s.trashed.length === 1 ? "" : "s"} for good? Their contents and
              every saved version go with them, and this cannot be undone.
            </span>
            <div className="trash-confirm-actions">
              <button
                className="qa-btn danger"
                onClick={() => {
                  a.cancelConfirm();
                  void a.emptyTrash();
                }}
              >
                Delete for good
              </button>
              <button className="qa-btn" onClick={a.cancelConfirm}>
                Keep them
              </button>
            </div>
          </div>
        ) : (
          <button
            className="qa-btn danger"
            onClick={() => a.askConfirm("trash-empty-all")}
          >
            <TrashIcon size={14} /> Empty the trash
          </button>
        )}
      </div>
    </div>
  );
}
