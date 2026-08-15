import { RecentRoom } from "../api";
import { CloseIcon, FolderIcon, PlusIcon } from "../icons";
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
 * because a synced room is the one case where "never leaves this computer"
 * deserves a second look; the other is informational.
 *
 * There is deliberately NO fallback badge. This returned "On this Mac" for
 * anything it could not classify, which meant a room in ~/Dropbox or
 * ~/Google Drive was affirmatively labelled local — on the very screen whose
 * lead copy promises the file never leaves this computer. Saying nothing is
 * the only honest answer for a path we cannot read, and it keeps the badge
 * meaning what it says: it appears when we know something, not always. */
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
  onClearRecent: () => void;
};

export function StartScreen({
  recent,
  onCreate,
  onOpen,
  onDemo,
  onOpenRecent,
  onRemoveRecent,
  onClearRecent,
}: StartScreenProps) {
  return (
    <>
      <p className="gate-sub">
        Your files, links, chats and AI — sealed inside one encrypted
        file that never leaves this computer.
      </p>
      <ul className="gate-assurances">
        {/* The check is a drawn glyph rather than a "✓" character: it is
            decoration reinforcing a sentence that already says the thing, so
            it stays out of the accessibility tree. */}
        <li>
          <span className="nb-ico nb-ico-check" aria-hidden="true" />
          Offline by default
        </li>
        <li>
          <span className="nb-ico nb-ico-check" aria-hidden="true" />
          No account needed
        </li>
        <li>
          <span className="nb-ico nb-ico-check" aria-hidden="true" />
          One file, fully encrypted
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
          Try a demo room
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
                    /* A room whose file is gone still OPENS: the open path is
                       what knows how to ask you where it moved to. Saying so
                       here just stops you typing a password for a file that
                       isn't there. */
                    title={
                      room.missing
                        ? "This room's file is not at that location any more"
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
                          File not found — moved, deleted, or on a drive that
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
                              the colour is never the signal on its own. Green
                              is "verified" — every room file is encrypted at
                              rest, which is the whole promise of the format.
                              The second tape says where the file actually
                              lives, and is absent whenever the path does not
                              tell us — see roomPlace above. */}
                          <span className="nb-tape nb-sem-done">
                            <span
                              className="nb-ico nb-ico-check"
                              aria-hidden="true"
                            />
                            Encrypted
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
                    title="Remove from list"
                    aria-label="Remove from list"
                    onClick={() => onRemoveRecent(room.path)}
                  >
                    <CloseIcon size={14} />
                  </button>
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
