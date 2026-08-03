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
  filterQ,
}: {
  s: WSState;
  a: WSActions;
  filterQ: string;
}) {
  const shown: TrashedFile[] = s.trashed.filter(
    (f) =>
      !filterQ ||
      f.name.toLowerCase().includes(filterQ) ||
      displayName(f.name).toLowerCase().includes(filterQ),
  );

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

  return (
    <div className="library-scroll trash-list">
      <p className="trash-note">
        These files are out of the library and out of everything the AI can
        search. Their contents never left this room.
      </p>
      {shown.length === 0 && (
        <p className="trash-empty">No deleted file matches that filter.</p>
      )}
      {shown.map((f) => (
        <div className="trash-row" key={f.id}>
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
              <UndoIcon size={13} />
            </button>
            {/* The armed confirm is a consent surface — ADD-25 blocks the
                agent driver from clicking ✓ on a destruction it didn't earn.
                It asks a DIFFERENT question than the library's delete: that one
                moves a file here and is undoable from this very panel, this one
                is the end of the file. Same prompt for both would make the
                irreversible click look like the recoverable one. */}
            <DeleteControl
              k={`trash-destroy-${f.id}`}
              trigger={<TrashIcon size={13} />}
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
            <TrashIcon size={13} /> Empty the trash
          </button>
        )}
      </div>
    </div>
  );
}
