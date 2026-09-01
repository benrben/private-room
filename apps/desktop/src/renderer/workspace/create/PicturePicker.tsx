import { useEffect, useState, type ReactNode } from "react";
import { api, type RoomPicture } from "../../api";
import { useFocusTrap } from "../../settings/useFocusTrap";

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
  const { pictures, error } = useRoomPictures(open);
  const [query, setQuery] = useState("");

  if (!open) return null;

  return (
    <PickerSheet label={title} onClose={onClose}>
      <div className="nb-panel cr-pick" onClick={(event) => event.stopPropagation()}>
        <PicturePickerHeader title={title} query={query} setQuery={setQuery} onClose={onClose} />
        <PicturePickerContent
          pictures={pictures}
          error={error}
          query={query}
          onPick={onPick}
          onClose={onClose}
        />
      </div>
    </PickerSheet>
  );
}

function useRoomPictures(open: boolean) {
  const [pictures, setPictures] = useState<RoomPicture[] | null>(null);
  const [error, setError] = useState("");

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

  return { pictures, error };
}

function filterPictures(pictures: RoomPicture[], query: string): RoomPicture[] {
  const needle = query.trim().toLowerCase();
  return pictures.filter((picture) => !needle || picture.name.toLowerCase().includes(needle));
}

function PicturePickerHeader({
  title,
  query,
  setQuery,
  onClose,
}: {
  title: string;
  query: string;
  setQuery: (query: string) => void;
  onClose: () => void;
}) {
  return (
    <header className="cr-pick-head">
      <h3>{title}</h3>
      <input
        type="search"
        className="cr-pick-search"
        value={query}
        placeholder="Filter by name…"
        aria-label="Filter pictures by name"
        onChange={(event) => setQuery(event.target.value)}
      />
      <button type="button" className="cr-pick-x" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </header>
  );
}

function EmptyPictureList({ pictures, query }: { pictures: RoomPicture[]; query: string }) {
  if (pictures.length === 0) {
    return <div className="cr-note">There are no pictures in this room yet. Make one on the Images tab, or import one.</div>;
  }
  return <div className="cr-note">No picture here is called “{query.trim()}”.</div>;
}

function PictureGrid({
  pictures,
  onPick,
  onClose,
}: {
  pictures: RoomPicture[];
  onPick: (picture: RoomPicture) => void;
  onClose: () => void;
}) {
  return (
    <div className="cr-pick-grid">
      {pictures.map((picture) => (
        <button
          key={picture.fileId}
          type="button"
          className="cr-pick-item"
          onClick={() => {
            onPick(picture);
            onClose();
          }}
          title={picture.name}
        >
          <img src={`data:image/jpeg;base64,${picture.thumbB64}`} alt="" />
          <span className="cr-pick-name">{picture.name}</span>
        </button>
      ))}
    </div>
  );
}

function PictureResults({
  pictures,
  query,
  onPick,
  onClose,
}: {
  pictures: RoomPicture[];
  query: string;
  onPick: (picture: RoomPicture) => void;
  onClose: () => void;
}) {
  const shown = filterPictures(pictures, query);
  if (shown.length === 0) return <EmptyPictureList pictures={pictures} query={query} />;
  return <PictureGrid pictures={shown} onPick={onPick} onClose={onClose} />;
}

function PicturePickerContent({
  pictures,
  error,
  query,
  onPick,
  onClose,
}: {
  pictures: RoomPicture[] | null;
  error: string;
  query: string;
  onPick: (picture: RoomPicture) => void;
  onClose: () => void;
}) {
  if (error) return <div className="cr-note cr-note-bad">Could not read this room’s pictures: {error}</div>;
  if (pictures === null) return <div className="cr-note">Looking through this room…</div>;
  return <PictureResults pictures={pictures} query={query} onPick={onPick} onClose={onClose} />;
}

/** The scrim, and the keyboard contract `aria-modal` was already promising.
 *
 * Its own component because `useFocusTrap` moves focus in on mount and hands it
 * back on unmount, and the picker itself stays mounted with `open` false. Until
 * this existed Escape did nothing here — or worse, reached the app-level
 * handler and closed the FILE behind a sheet that stayed on screen. */
function PickerSheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { modalRef, onModalKeyDown } = useFocusTrap(onClose);
  return (
    <div
      ref={modalRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
        onModalKeyDown(e);
      }}
      onClick={onClose}
      className="cr-pick-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      {children}
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
