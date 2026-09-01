import { useEffect, useState } from "react";
import { api, type RoomDocument } from "../../api";

type DocumentPickerProps = {
  open: boolean;
  title: string;
  /** What this file is about to be used FOR — the two callers use it very
   *  differently, and "which file" is not answerable without knowing why. */
  hint: string;
  onClose: () => void;
  onPick: (doc: RoomDocument) => void;
};

function useStoryDocuments(open: boolean) {
  const [docs, setDocs] = useState<RoomDocument[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setDocs(null);
    void api.storyDocuments().then(
      (all) => {
        if (!live) return;
        setDocs(all);
        setError("");
      },
      (reason: unknown) => {
        if (live) setError(String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [open]);

  return { docs, error };
}

function visibleDocuments(docs: RoomDocument[] | null, query: string): RoomDocument[] {
  const needle = query.trim().toLowerCase();
  return (docs ?? []).filter((document) => !needle || document.name.toLowerCase().includes(needle));
}

function PickerStatus({
  docs,
  error,
  query,
  shown,
}: {
  docs: RoomDocument[] | null;
  error: string;
  query: string;
  shown: RoomDocument[];
}) {
  if (error) return <div className="cr-note cr-note-bad">{error}</div>;
  if (!docs) return <div className="cr-note">Reading this room’s files…</div>;
  if (shown.length > 0) return null;
  if (query.trim()) return <div className="cr-note">Nothing matches “{query.trim()}”.</div>;
  return (
    <div className="cr-note">
      No file in this room has readable text yet. Import your script or character sheet and it will show up here.
    </div>
  );
}

function DocumentList({ shown, onPick, onClose }: Pick<DocumentPickerProps, "onPick" | "onClose"> & { shown: RoomDocument[] }) {
  return (
    <div className="cr-doc-list">
      {shown.map((doc) => (
        <button
          key={doc.fileId}
          type="button"
          className="cr-doc"
          onClick={() => {
            onPick(doc);
            onClose();
          }}
        >
          <span className="cr-doc-top">
            <span className="cr-doc-name">{doc.name}</span>
            <span className="nb-num cr-dim">
              {doc.words > 0 ? `≈${doc.words.toLocaleString()} words` : ""}
            </span>
          </span>
          <span className="cr-doc-snip">{doc.snippet}</span>
        </button>
      ))}
    </div>
  );
}

/** Pick a file the room already holds, instead of typing it in again.
 *
 * The sibling of `PicturePicker`, and it exists for the same reason that one
 * does: this is a room full of files, and a panel that asks you to paste the
 * contents of a file sitting six inches away in the Library is not asking for
 * input, it is asking you to do a copy by hand.
 *
 * Only files with readable text are listed. A picture or an archive has
 * nothing to offer a script box, and listing it would cost a click and a
 * puzzled moment to find that out. */
export function DocumentPicker({
  open,
  title,
  hint,
  onClose,
  onPick,
}: DocumentPickerProps) {
  const { docs, error } = useStoryDocuments(open);
  const [query, setQuery] = useState("");

  if (!open) return null;

  const shown = visibleDocuments(docs, query);

  return (
    <div className="cr-pick-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="nb-panel cr-pick">
        <div className="cr-pick-head">
          <h3>{title}</h3>
          <input
            type="search"
            className="cr-field cr-pick-search"
            value={query}
            placeholder="Filter by name…"
            aria-label="Filter files by name"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="cr-pick-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <p className="cr-hint">{hint}</p>

        <PickerStatus docs={docs} error={error} query={query} shown={shown} />
        <DocumentList shown={shown} onPick={onPick} onClose={onClose} />
      </div>
    </div>
  );
}
