import { useEffect, useState } from "react";
import { api, type RoomPicture } from "../../api";

/** Choose a picture that is already in this room.
 *
 * Deliberately NOT a Finder dialog. The pictures are already here — a hero's
 * portrait made yesterday, a photograph imported last week — and the whole
 * point of using them is that they never have to leave the encrypted file to
 * be chosen. A file dialog would invite pulling in something from the desktop
 * and quietly make the room a worse place to keep things.
 *
 * Thumbnails come pre-shrunk from `story_pictures`: a grid of full-size
 * pictures drawn 100px wide would cost hundreds of megabytes to show a few
 * kilobytes of information. */
export function PicturePicker({
  open,
  title,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  onPick: (picture: RoomPicture) => void;
  onClose: () => void;
}) {
  const [pictures, setPictures] = useState<RoomPicture[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError("");
    // Re-read on every open rather than once: the most likely picture to want
    // is the one generated a minute ago, and a cached list would not have it.
    api
      .storyPictures()
      .then((next) => live && setPictures(next))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [open]);

  if (!open) return null;

  const needle = query.trim().toLowerCase();
  const shown = (pictures ?? []).filter(
    (p) => !needle || p.name.toLowerCase().includes(needle),
  );

  return (
    <div className="cr-pick-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="nb-panel cr-pick">
        <header className="cr-pick-head">
          <h3>{title}</h3>
          <input
            type="search"
            className="cr-pick-search"
            value={query}
            placeholder="Filter by name…"
            aria-label="Filter pictures by name"
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="cr-pick-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error ? (
          <div className="cr-note cr-note-bad">Could not read this room’s pictures: {error}</div>
        ) : pictures === null ? (
          <div className="cr-note">Looking through this room…</div>
        ) : shown.length === 0 ? (
          <div className="cr-note">
            {pictures.length === 0
              ? "There are no pictures in this room yet. Make one on the Images tab, or import one."
              : `No picture here is called “${query.trim()}”.`}
          </div>
        ) : (
          <div className="cr-pick-grid">
            {shown.map((p) => (
              <button
                key={p.fileId}
                type="button"
                className="cr-pick-item"
                onClick={() => {
                  onPick(p);
                  onClose();
                }}
                title={p.name}
              >
                <img src={`data:image/jpeg;base64,${p.thumbB64}`} alt="" />
                <span className="cr-pick-name">{p.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One attached picture, shown with what it is FOR.
 *
 * The label is not decoration. A first frame and a reference are different
 * things — one begins the clip, the other only guides how it looks — and a
 * row of anonymous thumbnails would make that distinction invisible at exactly
 * the moment it costs money to get wrong. */
export function Attached({
  picture,
  role,
  onClear,
}: {
  picture: RoomPicture;
  role: string;
  onClear: () => void;
}) {
  return (
    <span className="cr-attached">
      <img src={`data:image/jpeg;base64,${picture.thumbB64}`} alt="" />
      <span className="cr-attached-text">
        <span className="cr-attached-role">{role}</span>
        <span className="cr-attached-name">{picture.name}</span>
      </span>
      <button
        type="button"
        className="cr-attached-x"
        onClick={onClear}
        aria-label={`Remove ${picture.name}`}
        title="Remove"
      >
        ✕
      </button>
    </span>
  );
}
