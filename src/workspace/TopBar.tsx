import { useEffect } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ENGINE_LABELS, RoomInfo, splitExternalModel } from "../api";
import {
  ChevronDownIcon,
  DotsIcon,
  LockIcon,
  Logomark,
  SearchIcon,
} from "../icons";
import { isCloudEngine, isExternalEngine, isModelReady } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";
import EngineModelPicker from "./EngineModelPicker";

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
  // One dismissal grammar for the header popovers: Escape closes whichever
  // is open (and never leaks to deeper layers while one is).
  const anyMenuOpen = s.modelMenuOpen || s.roomMenuOpen;
  useEffect(() => {
    if (!anyMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      s.setModelMenuOpen(false);
      s.setRoomMenuOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [anyMenuOpen, s]);
  const modelReady = isModelReady(ai, model);
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
        {/* ADD-27: a recording keeps running while you work elsewhere — this
         * chip is the always-visible way back to it. */}
        {s.recLive && (
          <button
            className={`rec-indicator ${s.recLive.status}`}
            title="A live recording is running — click to open it"
            onClick={() => void a.viewFile(s.recLive!.fileId)}
          >
            <span className={`rec-dot ${s.recLive.status === "recording" ? "pulsing" : ""}`} />
            {s.recLive.status === "recording"
              ? "Recording"
              : s.recLive.status === "paused"
                ? "Recording paused"
                : "Saving…"}
          </button>
        )}
        {ai && (ai.models.length > 0 || ai.external.length > 0) ? (
          <div className="model-pill-wrap">
            <button
              className={`model-pill${isCloudEngine(model) ? " cloud" : ""}`}
              onClick={() => {
                // One popover at a time — never a menu stacked over a menu.
                s.setRoomMenuOpen(false);
                s.setModelMenuOpen((o) => !o);
              }}
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
                  // External CLIs need no daemon; a `:cloud` model still rides
                  // through the local Ollama daemon, so its dot tracks it.
                  isExternalEngine(model)
                    ? "ok"
                    : ai?.running
                      ? modelReady
                        ? "ok"
                        : "warn"
                      : "down"
                }`}
              />
              <span className="model-pill-name">{a.engineLabelOf(model)}</span>
              <span
                className={`model-pill-tier ${isCloudEngine(model) ? "cloud" : "local"}`}
                title={
                  isCloudEngine(model)
                    ? "This engine runs in the cloud — your prompts and context leave this Mac."
                    : "This model runs entirely on this Mac — nothing leaves the device."
                }
              >
                {isCloudEngine(model) ? "Cloud" : "On this Mac"}
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
                  <EngineModelPicker
                    ai={ai}
                    model={model}
                    engineModels={s.engineModels}
                    onModelsLoaded={a.recordEngineModels}
                    onSelect={(m) => {
                      a.changeModel(m);
                      // Keep the menu open only when the pick is a cloud model
                      // that still has an effort to choose (its chips just
                      // appeared); otherwise this is a final choice — close.
                      const [engine, sub, effort] = splitExternalModel(m);
                      const hasEfforts =
                        !!ENGINE_LABELS[engine] &&
                        !!sub &&
                        !effort &&
                        (s.engineModels[engine]?.find((x) => x.slug === sub)?.efforts.length ?? 0) > 0;
                      if (!hasEfforts) s.setModelMenuOpen(false);
                    }}
                  />
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
            onClick={() => {
              s.setModelMenuOpen(false);
              s.setRoomMenuOpen((o) => !o);
            }}
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
                {/* ADD-28: feedback → GitHub issue (opens in YOUR browser). */}
                <button
                  className="pop-item"
                  onClick={() => {
                    s.setShowFeedback(true);
                    s.setRoomMenuOpen(false);
                  }}
                >
                  Send feedback…
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
