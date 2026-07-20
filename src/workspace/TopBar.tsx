import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, ENGINE_LABELS, RoomInfo, splitExternalModel } from "../api";
import {
  ChevronDownIcon,
  CloudIcon,
  DotsIcon,
  LayoutResetIcon,
  LockIcon,
  Logomark,
  PlayIcon,
  ScriptIcon,
  SearchIcon,
  ThemeIcon,
  WorkflowsIcon,
} from "../icons";
import { WorkflowGlyph } from "./workflows/workflowGlyph";
import { isCloudEngine, isExternalEngine, isModelReady } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";
import EngineModelPicker from "./EngineModelPicker";
import { QuickActionsMenu, QuickAction } from "./QuickActions";
import { LayoutApi } from "../shell/useLayout";
import { toggleTheme } from "../theme";

/** The 46px room toolbar: brand seal, room identity, the ⌘K command entry,
 * pinned workflow/script shortcuts, the engine pill with its truthful
 * local/cloud route badge, theme, layout reset, the room menu, and Lock. */
export default function TopBar({
  s,
  a,
  info,
  layout,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
}) {
  const { ai, model } = s;
  // Wave 5 (Idea 13): the global-scripts shortcut menu open flag (local — it
  // sits beside the pinned-workflows menu in the top bar).
  const [scriptMenuOpen, setScriptMenuOpen] = useState(false);
  // One dismissal grammar for the header popovers: Escape closes whichever
  // is open (and never leaks to deeper layers while one is).
  const anyMenuOpen = s.modelMenuOpen || s.roomMenuOpen || s.qaMenuOpen;
  useEffect(() => {
    if (!anyMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      s.setModelMenuOpen(false);
      s.setRoomMenuOpen(false);
      s.setQaMenuOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [anyMenuOpen, s]);
  // Wave 4a: pinned general-purpose workflows as one-click top-bar shortcuts.
  const pinnedActions: QuickAction[] = s.workflows
    .filter((w) => w.pinned && w.status === "active" && w.binding.scope === "general")
    .map((w) => ({
      id: w.id,
      label: w.name,
      icon: <WorkflowGlyph emoji={w.emoji} size={15} />,
      hint: w.name,
      onRun: () => void a.runWorkflowNow(w.id),
    }));
  // Wave 5 (Idea 13): `room-shortcut: global` scripts as one-click top-bar runs.
  const globalScriptActions: QuickAction[] = s.scripts
    .filter((sc) => sc.shortcut === "global")
    .map((sc) => ({
      id: sc.fileId,
      label: sc.name,
      icon: <PlayIcon size={13} />,
      hint: `Run ${sc.name}`,
      onRun: () => void a.runScript(sc.fileId),
    }));
  const modelReady = isModelReady(ai, model);
  const cloud = isCloudEngine(model);
  return (
    <header className="pr-topbar">
      <div className="pr-brandmark" aria-label="Private Room" title={info.path}>
        <Logomark size={26} />
      </div>
      <div className="room-identity" title={info.path}>
        <div className="room-identity-text">
          <div className="room-kicker">Private Room</div>
          <div className="room-name">{info.name}</div>
        </div>
      </div>
      <div className="command-wrap">
        <button
          className="command-button"
          type="button"
          onClick={() => {
            s.setSearchSel(0);
            s.setShowSearch(true);
          }}
        >
          <SearchIcon size={14} />
          <span>Search room or run a command…</span>
          <kbd>⌘ K</kbd>
        </button>
      </div>
      <div className="top-actions">
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
        {/* Wave 4a: pinned-workflow shortcuts, left of the model pill (⌘J). */}
        <QuickActionsMenu
          actions={pinnedActions}
          open={s.qaMenuOpen}
          onOpenChange={(o) => {
            if (o) {
              s.setModelMenuOpen(false);
              s.setRoomMenuOpen(false);
            }
            s.setQaMenuOpen(o);
          }}
          buttonLabel="Workflows"
          buttonIcon={<WorkflowsIcon size={15} />}
          inlineMax={3}
          pill
          footer={{ label: "All workflows…", onClick: a.openWorkflows }}
        />
        {/* Wave 5: global-shortcut scripts, beside the workflow pins (only when
            a script opts into `room-shortcut: global`). */}
        {globalScriptActions.length > 0 && (
          <QuickActionsMenu
            actions={globalScriptActions}
            open={scriptMenuOpen}
            onOpenChange={setScriptMenuOpen}
            buttonLabel="Scripts"
            buttonIcon={<ScriptIcon size={14} />}
            inlineMax={2}
            pill
            footer={{ label: "All scripts…", onClick: a.openScripts }}
          />
        )}
        {ai && (ai.models.length > 0 || ai.external.length > 0) ? (
          <div className="model-pill-wrap">
            <button
              className="model-pill"
              onClick={() => {
                // One popover at a time — never a menu stacked over a menu.
                s.setRoomMenuOpen(false);
                s.setModelMenuOpen((o) => !o);
              }}
              aria-haspopup="menu"
              aria-expanded={s.modelMenuOpen}
              title={
                ai?.running
                  ? modelReady || cloud
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
              <ChevronDownIcon size={12} className="model-pill-caret" />
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
        {/* The truthful route badge: green only when processing stays local. */}
        <div
          className={`privacy-badge${cloud ? " cloud" : ""}`}
          title={
            cloud
              ? "This engine runs in the cloud — prompts and attached context leave this Mac."
              : "Files and AI processing stay on this Mac."
          }
        >
          {cloud ? (
            <CloudIcon size={12} />
          ) : (
            <span className="status-dot" aria-hidden />
          )}
          <span>{cloud ? "Cloud model" : "Local & private"}</span>
        </div>
        <button
          className="icon-btn"
          data-tip="Switch theme"
          aria-label="Switch between dark and light theme"
          onClick={() => toggleTheme()}
        >
          <ThemeIcon size={16} />
        </button>
        <button
          className="icon-btn"
          data-tip="Reset layout"
          aria-label="Reset the three-pane layout"
          onClick={layout.resetLayout}
        >
          <LayoutResetIcon size={16} />
        </button>
        <div className="room-menu-wrap">
          <button
            className="icon-btn"
            data-tip="Room actions"
            aria-label="Open the room actions menu"
            aria-haspopup="menu"
            aria-expanded={s.roomMenuOpen}
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
              <div className="pop-menu room-menu" role="menu">
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    s.setShowSettings(true);
                    s.setRoomMenuOpen(false);
                  }}
                >
                  Room settings
                </button>
                {/* Idea 9: one-click "commit" — a named checkpoint (default
                    name "Checkpoint — {date}") with a toast that names it.
                    Rolling back stays gated in Settings → Checkpoints. */}
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    s.setRoomMenuOpen(false);
                    api
                      .createRoomCheckpoint("")
                      .then((meta) =>
                        s.pushToast(
                          "success",
                          `Saved checkpoint “${meta.name}”. Roll back in Settings → Checkpoints.`,
                        ),
                      )
                      .catch((e) => s.pushToast("error", String(e)));
                  }}
                >
                  Save a checkpoint
                </button>
                {s.files.length > 0 && (
                  <button
                    className="pop-item"
                    role="menuitem"
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
                  role="menuitem"
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
                  role="menuitem"
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
          title="Lock this room (⌘L)"
          data-agent-blocked
          onClick={a.handleLock}
        >
          <LockIcon size={13} /> Lock
        </button>
      </div>
    </header>
  );
}
