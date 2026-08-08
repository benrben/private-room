import { useEffect, useState } from "react";
import { api, type RoomDocument } from "../../api";

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
}: {
  open: boolean;
  title: string;
  /** What this file is about to be used FOR — the two callers use it very
   *  differently, and "which file" is not answerable without knowing why. */
  hint: string;
  onClose: () => void;
  onPick: (doc: RoomDocument) => void;
}) {
  const [docs, setDocs] = useState<RoomDocument[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setDocs(null);
    api
      .storyDocuments()
      .then((all) => live && (setDocs(all), setError("")))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [open]);

  if (!open) return null;

  const needle = query.trim().toLowerCase();
  const shown = (docs ?? []).filter(
    (d) => !needle || d.name.toLowerCase().includes(needle),
  );

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

        {error && <div className="cr-note cr-note-bad">{error}</div>}
        {!docs && !error && <div className="cr-note">Reading this room’s files…</div>}

        {docs && shown.length === 0 && (
          <div className="cr-note">
            {needle
              ? `Nothing matches “${query.trim()}”.`
              : // The distinction matters: an empty room and a room full of
                // pictures are different problems with different fixes.
                "No file in this room has readable text yet. Import your script or " +
                "character sheet and it will show up here."}
          </div>
        )}

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
      </div>
    </div>
  );
}
