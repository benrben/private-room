import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, ENGINE_LABELS, RoomInfo, splitExternalModel } from "../api";
import {
  ChevronDownIcon,
  CloudIcon,
  DotsIcon,
  LockIcon,
  Logomark,
  PlayIcon,
  ScriptIcon,
  SearchIcon,
  WorkflowsIcon,
} from "../icons";
import { WorkflowGlyph } from "./workflows/workflowGlyph";
import { isCloudRoute, isExternalEngine, isModelReady, trustState } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";
import EngineModelPicker from "./EngineModelPicker";
import { QuickActionsMenu, QuickAction } from "./QuickActions";
import { LayoutApi } from "../shell/useLayout";
import { toggleTheme } from "../theme";

/** The room toolbar: brand seal, room name, the ⌘K command entry, pinned
 * workflow/script shortcuts, the engine pill with its truthful local/cloud
 * route badge, the room menu, and Lock.
 *
 * Shorter and quieter than it was, because a title bar is not where the work
 * happens. Three things went:
 *
 *   • the "ARCELLE" kicker over the room name — the seal to its left already
 *     says which app this is, twice was once too often, and the room's own
 *     name is what the line is for;
 *   • the theme switch and Reset layout, which are settings you touch twice a
 *     year sitting permanently beside the two controls you touch constantly.
 *     Both moved into the room menu, keeping their exact behaviour;
 *   • the pinned-workflows pill when nothing is pinned to it — it used to draw
 *     itself anyway for the sake of its "All workflows…" footer, which is a
 *     second, quieter route to a place the rail already lists by name.
 *
 * What stayed is what is true right now and cannot wait: a live recording, the
 * engine, where this room's content goes, and the lock. */
export default function TopBar({
  s,
  a,
  info,
  layout,
  onRenamed,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  onRenamed?: (info: RoomInfo) => void;
}) {
  const { ai, model } = s;
  // The room name, while it is being typed. `null` = not renaming. Local to
  // the bar: nothing else in the app cares about a half-typed name, and the
  // committed name comes back from the backend as a fresh RoomInfo.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  async function commitRename() {
    const typed = (nameDraft ?? "").trim();
    setNameDraft(null);
    if (!typed || typed === info.name) return;
    try {
      onRenamed?.(await api.renameRoom(typed));
      s.pushToast("success", `This room is now called “${typed}”.`);
    } catch (e) {
      s.pushToast("error", `Could not rename this room: ${String(e)}`);
    }
  }
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
  const cloud = isCloudRoute(model, ai);
  return (
    <header className="pr-topbar">
      <div className="pr-brandmark" aria-label="Arcelle" title={info.path}>
        <Logomark size={26} />
      </div>
      <div className="room-identity" title={info.path}>
        <div className="room-identity-text">
          {/* The room's name lives in its own encrypted `meta`, not in the file
              path — renaming the .roomai in Finder changes nothing — so this is
              the only place it can be changed. Inline, the same grammar the
              file and folder renames use. */}
          {nameDraft === null ? (
            <button
              type="button"
              className="room-name room-name-btn"
              title="Rename this room"
              onClick={() => setNameDraft(info.name)}
            >
              {info.name}
            </button>
          ) : (
            <input
              className="room-name room-name-input"
              aria-label="Room name"
              autoFocus
              value={nameDraft}
              maxLength={120}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setNameDraft(null);
              }}
            />
          )}
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
        {/* Wave 4a: pinned-workflow shortcuts, left of the model pill (⌘J).
            Only when something is actually pinned — an empty shortcut rack is
            not a shortcut, and Workflows is one click away in the rail. */}
        {pinnedActions.length > 0 && (
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
        )}
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
        {/* The truthful route badge — same vocabulary and colour as the
            status-bar trust chip (workspace/markup.ts trustState), so this room
            can never say two different things about where its content goes. */}
        {(() => {
          const trust = trustState(cloud, s.privacyOn);
          return (
            <div
              className={`privacy-badge ${trust.tone}`}
              title={trust.title}
            >
              {cloud ? (
                <CloudIcon size={12} />
              ) : (
                <span className="status-dot" aria-hidden />
              )}
              <span>{trust.label}</span>
            </div>
          );
        })()}
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
                {/* The two controls that used to sit permanently in the bar.
                    Same handlers, same outcomes; they are named in full here
                    because a menu row has the space an icon square never did,
                    and the visible words now ARE the accessible name rather
                    than a tooltip standing in for one. Neither was ever only
                    reachable from the bar — ⌘K carries both (Overlays.tsx
                    "reset-layout" / "theme"), Settings → App carries the
                    theme, and double-clicking a splitter still resets. */}
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    toggleTheme();
                    s.setRoomMenuOpen(false);
                  }}
                >
                  Switch between dark and light theme
                </button>
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    layout.resetLayout();
                    s.setRoomMenuOpen(false);
                  }}
                >
                  Reset the three-pane layout
                </button>
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
                {/* The one discoverable way in to the shortcut list — the
                    keys themselves were only learnable from tooltips. */}
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    s.setShowShortcuts(true);
                    s.setRoomMenuOpen(false);
                  }}
                >
                  Keyboard shortcuts (⌘/)
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
