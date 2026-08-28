import { RecentRoom } from "../api";
import { CloseIcon, FolderIcon, PlusIcon, TrashIcon } from "../icons";
import { relativeTime } from "../rooms/helpers";

/** What a room's own path lets us say truthfully about where it lives.
 *
 * Only two things are knowable from a path alone, and both are certain:
 * `~/Library/Mobile Documents` IS iCloud Drive, and `/Volumes/…` IS a mounted
 * volume other than the boot disk. Third-party sync folders are deliberately
 * NOT guessed at — a directory called "Dropbox" is not evidence of Dropbox,
 * and a badge that is wrong is worse on this screen than no badge at all.
 *
 * The hue only reinforces the word it rides with. iCloud is marked pending
 * because a synced room is the one case where a copy of the file exists
 * somewhere else; the other is informational.
 *
 * There is deliberately NO fallback badge. This returned "On this Mac" for
 * anything it could not classify, which meant a room in ~/Dropbox or
 * ~/Google Drive was affirmatively labelled local. Saying nothing is the only
 * honest answer for a path we cannot read, and it keeps the badge meaning what
 * it says: it appears when we know something, not always. */
function roomPlace(path: string): { label: string; sem: string } | null {
  if (path.includes("/Library/Mobile Documents/")) {
    return { label: "iCloud Drive", sem: "nb-sem-pending" };
  }
  if (path.startsWith("/Volumes/")) {
    return { label: "External volume", sem: "nb-sem-linked" };
  }
  return null;
}

type StartScreenProps = {
  recent: RecentRoom[];
  onCreate: () => void;
  onOpen: () => void;
  onDemo: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onTrashRoom: (room: RecentRoom) => void;
  onClearRecent: () => void;
};

export function StartScreen({
  recent,
  onCreate,
  onOpen,
  onDemo,
  onOpenRecent,
  onRemoveRecent,
  onTrashRoom,
  onClearRecent,
}: StartScreenProps) {
  return (
    <>
      {/* Current documents are ordinary files. Private Arcelle state is the
          encrypted part and stays inside the reserved folder. */}
      <p className="gate-sub">
        Your documents stay as normal files. Chats, memory, search and history
        stay encrypted.
      </p>
      <ul className="gate-assurances">
        {/* The check is a drawn glyph rather than a "✓" character: it is
            decoration reinforcing a sentence that already says the thing, so
            it stays out of the accessibility tree. */}
        {/* Not "Offline by default": this screen is on display while
            `checkForUpdatesQuietly` (updater.ts) is asking GitHub whether a
            newer build exists. Settings → Updates & version switches it off. */}
        <li>
          <span className="nb-ico nb-ico-check" aria-hidden="true" />
          Offline except a launch update check
        </li>
        <li>
          <span className="nb-ico nb-ico-check" aria-hidden="true" />
          No account needed
        </li>
        <li>
          <span className="nb-ico nb-ico-check" aria-hidden="true" />
          Normal files, encrypted private state
        </li>
      </ul>
      <div className="gate-actions">
        {/* The two ways into a room are equal in size and both outlined; the
            lead one is separated by pen weight, the accent swash and the hand
            arrow rather than by being the only filled object on the sheet. */}
        <button
          className="gate-action gate-action-lead nb-btn-go"
          onClick={onCreate}
        >
          <PlusIcon size={16} />
          Create New Room
        </button>
        <button className="gate-action" onClick={onOpen}>
          <FolderIcon size={16} />
          Open Room…
        </button>
        <button className="subtle gate-demo" onClick={onDemo}>
          Create a demo room
        </button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-label nb-subtitle">Recent</div>
          <ul className="recent-list">
            {recent.map((room) => {
              const place = roomPlace(room.path);
              return (
                <li
                  key={room.path}
                  className={`recent-row${room.missing ? " missing" : ""}`}
                >
                  <button
                    className="recent-open"
                    onClick={() => onOpenRecent(room.path)}
                    /* A room whose file is gone still OPENS — but through the
                       file picker, which is what can be told where it moved
                       to, rather than through a password form for a file that
                       isn't there. App.tsx routes it. */
                    title={
                      room.missing
                        ? "This room is not at that location any more — opens the room picker"
                        : undefined
                    }
                  >
                    <span className="recent-name">{room.name}</span>
                    {/* The row truncates a long path from the LEFT, so the
                        file name always survives; `direction: rtl` on the
                        span is what moves the ellipsis to the start. That
                        alone reordered the path's own neutral characters —
                        "/Users/ben/x.arcelle" rendered as
                        "Users/ben/x.arcelle/" — so the path is isolated in a
                        <bdi dir="ltr">: the ellipsis stays at the start and
                        the text reads the way it does in Finder. */}
                    <span className="recent-path">
                      <bdi dir="ltr">{room.path}</bdi>
                    </span>
                    <span className="recent-meta">
                      {room.missing ? (
                        <span className="recent-when recent-missing">
                          Room not found — moved, deleted, or on a drive that
                          isn't connected
                        </span>
                      ) : (
                        <>
                          {relativeTime(room.openedAt) && (
                            <span className="recent-when">
                              Opened {relativeTime(room.openedAt)}
                            </span>
                          )}
                          {/* Marker states, each one paired with its word so
                              the colour is never the signal on its own. In a
                              workspace, normal files are intentionally plain;
                              chats, history and other private state are the
                              encrypted part. */}
                          <span className="nb-tape nb-sem-done">
                            <span
                              className="nb-ico nb-ico-check"
                              aria-hidden="true"
                            />
                            Private state encrypted
                          </span>
                          {place && (
                            <span className={`nb-tape ${place.sem}`}>
                              {place.label}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </button>
                  <button
                    className="recent-remove"
                    title="Forget this shortcut"
                    aria-label="Forget this shortcut"
                    onClick={() => onRemoveRecent(room.path)}
                  >
                    <CloseIcon size={14} />
                  </button>
                  {!room.missing && (
                    <button
                      className="recent-remove"
                      title="Move room to Trash"
                      aria-label={`Move ${room.name} to Trash`}
                      onClick={() => onTrashRoom(room)}
                    >
                      <TrashIcon size={14} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <button className="recent-clear" onClick={onClearRecent}>
            Clear list
          </button>
        </div>
      )}
    </>
  );
}
