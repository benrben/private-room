import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ENGINE_LABELS, modelLabel, RoomInfo } from "../api";
import {
  CheckIcon,
  ChevronDownIcon,
  DotsIcon,
  LockIcon,
  Logomark,
  SearchIcon,
} from "../icons";
import { isCloudEngine } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The top bar: room identity, the engine pill/menu, search, room menu, lock.
 * Extracted verbatim from the <header className="topbar"> block. */
export default function TopBar({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  const { ai, model } = s;
  const modelReady =
    (ai?.running &&
      (ai.models.includes(model) ||
        ai.models.some((m) => m.startsWith(model + ":") || model.startsWith(m)))) ||
    ai?.external.includes(model);
  return (
    <header className="topbar">
      <div className="room-id" title={info.path}>
        <span className="room-lock">
          <Logomark size={26} />
        </span>
        <div className="room-id-text">
          <div className="room-name">{info.name}</div>
          <div className="room-sub">Private Room</div>
        </div>
      </div>
      <div className="topbar-right">
        {ai && (ai.models.length > 0 || ai.external.length > 0) ? (
          <div className="model-pill-wrap">
            <button
              className={`model-pill${isCloudEngine(model) ? " cloud" : ""}`}
              onClick={() => s.setModelMenuOpen((o) => !o)}
              title={
                ai?.running
                  ? modelReady || isCloudEngine(model)
                    ? "AI ready — click to switch engine"
                    : "Model not downloaded"
                  : "Ollama not running"
              }
            >
              <span
                className={`model-dot ${
                  isCloudEngine(model)
                    ? "ok"
                    : ai?.running
                      ? modelReady
                        ? "ok"
                        : "warn"
                      : "down"
                }`}
              />
              <span className="model-pill-name">{a.engineLabelOf(model)}</span>
              <span className="model-pill-tier">
                {isCloudEngine(model) ? "Cloud" : "Local"}
              </span>
              <ChevronDownIcon size={13} className="model-pill-caret" />
            </button>
            {s.modelMenuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onMouseDown={() => s.setModelMenuOpen(false)}
                />
                <div className="pop-menu model-menu">
                  {ai.models.map((m) => (
                    <button
                      key={m}
                      className={`model-menu-item${m === model ? " sel" : ""}`}
                      onClick={() => {
                        a.changeModel(m);
                        s.setModelMenuOpen(false);
                      }}
                    >
                      <span className="model-dot local" />
                      <span className="model-menu-name">
                        {modelLabel(m) ?? m}
                      </span>
                      <span className="model-menu-tier">Local</span>
                      {m === model && <CheckIcon size={14} />}
                    </button>
                  ))}
                  {ai.external.map((e) => (
                    <button
                      key={e}
                      className={`model-menu-item${e === model ? " sel" : ""}`}
                      onClick={() => {
                        a.changeModel(e);
                        s.setModelMenuOpen(false);
                      }}
                    >
                      <span className="model-dot cloud" />
                      <span className="model-menu-name">
                        {ENGINE_LABELS[e] ?? e}
                      </span>
                      <span className="model-menu-tier cloud">Cloud</span>
                      {e === model && <CheckIcon size={14} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <button className="subtle" onClick={a.refreshAi}>
            Check AI
          </button>
        )}
        <button
          className="icon-btn"
          title="Search ⌘F"
          onClick={() => {
            s.setSearchSel(0);
            s.setShowSearch(true);
          }}
        >
          <SearchIcon size={16} />
        </button>
        <div className="room-menu-wrap">
          <button
            className="icon-btn"
            title="Room menu"
            onClick={() => s.setRoomMenuOpen((o) => !o)}
          >
            <DotsIcon size={16} />
          </button>
          {s.roomMenuOpen && (
            <>
              <div
                className="menu-backdrop"
                onMouseDown={() => s.setRoomMenuOpen(false)}
              />
              <div className="pop-menu room-menu">
                <button
                  className="pop-item"
                  onClick={() => {
                    s.setShowSettings(true);
                    s.setRoomMenuOpen(false);
                  }}
                >
                  Room settings
                </button>
                {s.files.length > 0 && (
                  <button
                    className="pop-item"
                    onClick={() => {
                      a.exportAllFiles();
                      s.setRoomMenuOpen(false);
                    }}
                  >
                    Export all files…
                  </button>
                )}
                <button
                  className="pop-item"
                  onClick={() => {
                    revealItemInDir(info.path).catch(() => {});
                    s.setRoomMenuOpen(false);
                  }}
                >
                  Reveal in Finder
                </button>
              </div>
            </>
          )}
        </div>
        {/* ADD-25: locking the room is the user's call, never the agent's. */}
        <button
          className="lock-btn btn-ic"
          title="Lock ⌘L"
          data-agent-blocked
          onClick={a.handleLock}
        >
          <LockIcon size={14} /> Lock
        </button>
      </div>
    </header>
  );
}
