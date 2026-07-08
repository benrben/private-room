import { RecentRoom } from "../api";
import { CloseIcon } from "../icons";
import { relativeTime } from "../rooms/helpers";

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
        <li>Offline by default</li>
        <li>No account needed</li>
        <li>One file, fully encrypted</li>
      </ul>
      <div className="gate-actions">
        <button className="primary" onClick={onCreate}>
          Create New Room
        </button>
        <button onClick={onOpen}>Open Room…</button>
        <button className="subtle" onClick={onDemo}>
          Try a demo room
        </button>
      </div>
      {recent.length > 0 && (
        <div className="recent">
          <div className="recent-label">Recent</div>
          <ul className="recent-list">
            {recent.map((room) => (
              <li key={room.path} className="recent-row">
                <button
                  className="recent-open"
                  onClick={() => onOpenRecent(room.path)}
                >
                  <span className="recent-name">{room.name}</span>
                  <span className="recent-path">{room.path}</span>
                  {relativeTime(room.openedAt) && (
                    <span className="recent-when">
                      Opened {relativeTime(room.openedAt)}
                    </span>
                  )}
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
            ))}
          </ul>
          <button className="recent-clear" onClick={onClearRecent}>
            Clear list
          </button>
        </div>
      )}
    </>
  );
}
