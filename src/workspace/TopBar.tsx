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
  SparkIcon,
  WorkflowsIcon,
} from "../icons";
import LayoutMenu from "./LayoutMenu";
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
 * route badge, Layout, Assistant, the room menu, and Lock.
 *
 * Two things arrived here in the navigation redesign, both from the sidebar:
 * LAYOUT, which owns showing and hiding the two side panes (they were three
 * buttons at the top of a list of destinations, which is not what they are),
 * and ASSISTANT, which is that pane's own toggle plus the two marks that say
 * whether anything is waiting on you.
 *
 * WHICH MAKES THIS BAR THE CROWDED SURFACE NOW, and it is worth saying so
 * plainly rather than discovering it later. Counting conditionals, it can
 * carry eleven controls at once: seal, room name, ⌘K, recording chip, pinned
 * workflows, pinned scripts, engine, privacy, Layout, Assistant, ⋯, Lock. The
 * sidebar got calmer partly by pushing density up here. Nothing in this pass
 * addresses that; the next one should.
 *
 * Every popover this bar can raise shares ONE open slot (`s.openMenu`), so
 * opening any of them closes the rest and Escape closes whichever is up. That
 * used to be a convention enforced by hand at each open site — and the scripts
 * menu never joined it, so it stacked over the model picker.
 *
 * What has always stayed is what is true right now and cannot wait: a live
 * recording, the engine, where this room's content goes, and the lock. */
export default function TopBar({
  s,
  a,
  info,
  layout,
  onRenamed,
  approvals = 0,
  running = 0,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  onRenamed?: (info: RoomInfo) => void;
  /** How many things are WAITING ON THE READER. Drawn on the Assistant button
   * as a hand-circled number, because that is where answering them happens. */
  approvals?: number;
  /** How many jobs are running BY THEMSELVES. A quiet dot: news, not a
   * request. */
  running?: number;
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
  // One dismissal grammar for the toolbar popovers: Escape closes whichever
  // is open (and never leaks to deeper layers while one is). One slot, so
  // this closes the open menu whatever it is — including the two the
  // navigation redesign added, which under the old flag-per-menu scheme would
  // each have needed remembering here and at every other menu's open site.
  const menuOpen = s.openMenu !== null;
  const { setOpenMenu } = s;
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpenMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menuOpen, setOpenMenu]);
  // Wave 4a: pinned general-purpose workflows as one-click top-bar shortcuts.
  const pinnedActions: QuickAction[] = s.workflows
    .filter((w) => w.pinned && w.status === "active" && w.binding.scope === "general")
    .map((w) => ({
      id: w.id,
      label: w.name,
      icon: <WorkflowGlyph emoji={w.emoji} size={14} />,
      hint: w.name,
      onRun: () => void a.runWorkflowNow(w.id),
    }));
  // Wave 5 (Idea 13): `room-shortcut: global` scripts as one-click top-bar runs.
  const globalScriptActions: QuickAction[] = s.scripts
    .filter((sc) => sc.shortcut === "global")
    .map((sc) => ({
      id: sc.fileId,
      label: sc.name,
      icon: <PlayIcon size={14} />,
      hint: `Run ${sc.name}`,
      onRun: () => void a.runScript(sc.fileId),
    }));
  const modelReady = isModelReady(ai, model);
  const cloud = isCloudRoute(model, ai);
  // What is ON SCREEN, not what is stored. In a narrow window one pane shows
  // at a time, so the assistant can be "not hidden" and still not visible —
  // and a pressed-looking button beside a pane you cannot see is a lie.
  const aiShowing = layout.visible.includes("ai");
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
            open={s.openMenu === "workflows"}
            onOpenChange={(o) => setOpenMenu(o ? "workflows" : null)}
            buttonLabel="Workflows"
            buttonIcon={<WorkflowsIcon size={14} />}
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
            /* This menu used to own a LOCAL open flag, so it was the one
               toolbar popover outside the "only one at a time" rule and could
               stack over the model picker. One slot, no exception. */
            open={s.openMenu === "scripts"}
            onOpenChange={(o) => setOpenMenu(o ? "scripts" : null)}
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
              onClick={() =>
                setOpenMenu(s.openMenu === "model" ? null : "model")
              }
              aria-haspopup="menu"
              aria-expanded={s.openMenu === "model"}
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
            {s.openMenu === "model" && (
              <>
                <div
                  className="menu-backdrop"
                  onMouseDown={() => setOpenMenu(null)}
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
                      if (!hasEfforts) setOpenMenu(null);
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
        {/* The window's arrangement — the three pane buttons that used to sit
            at the top of the sidebar's list of destinations. See LayoutMenu
            for why they are not places and never were. */}
        <LayoutMenu
          layout={layout}
          open={s.openMenu === "layout"}
          onOpenChange={(o) => setOpenMenu(o ? "layout" : null)}
        />

        {/* The assistant, and the two facts that used to live on the rail's AI
            pane toggle.
            They belong on THIS button now for one reason: the toggle they were
            attached to is gone, and a count that only appears while the pane
            is already open is a count nobody needs. Here they are visible
            precisely when the pane is shut — which is the only time "two
            things are waiting on you" is news.
            Two facts, two shapes, and they can both be true at once: an
            approval is a REQUEST and gets the hand-circled number in the
            pending yellow; a running job is the software working on its own
            and gets the quiet dot in the linked blue Room Home already uses
            for it. Summing them into one number claimed N things needed you
            when N-1 did not. Both stay aria-hidden — the button's own label
            carries the words, and a control whose accessible name changed
            every time a job finished would be worse, not better. */}
        <button
          className="pill-btn assistant-toggle"
          type="button"
          data-testid="assistant-toggle"
          aria-pressed={aiShowing}
          aria-label={
            aiShowing
              ? "Hide the assistant (⌘2)"
              : approvals > 0
                ? `Show the assistant (⌘2) — ${approvals} ${approvals === 1 ? "thing needs" : "things need"} your approval`
                : running > 0
                  ? "Show the assistant (⌘2) — background work is running"
                  : "Show the assistant (⌘2)"
          }
          onClick={() => layout.togglePane("ai")}
        >
          <SparkIcon size={14} />
          <span>Assistant</span>
          {!aiShowing && approvals > 0 && (
            <span className="pill-count nb-circled nb-sem-pending" aria-hidden>
              {approvals > 99 ? "99+" : approvals}
            </span>
          )}
          {!aiShowing && approvals === 0 && running > 0 && (
            <span className="pill-live nb-sem-linked" aria-hidden />
          )}
        </button>

        <div className="room-menu-wrap">
          <button
            className="icon-btn"
            data-tip="Room actions"
            aria-label="Open the room actions menu"
            aria-haspopup="menu"
            aria-expanded={s.openMenu === "room"}
            onClick={() => setOpenMenu(s.openMenu === "room" ? null : "room")}
          >
            <DotsIcon size={16} />
          </button>
          {s.openMenu === "room" && (
            <>
              <div
                className="menu-backdrop"
                onMouseDown={() => setOpenMenu(null)}
              />
              <div className="pop-menu room-menu" role="menu">
                {/* Theme is a quick-access convenience, not a second home for
                    the control — its real home is Settings → Appearance, so
                    this row stays exactly one word. Same handler as before
                    (Overlays.tsx "theme" carries the same toggle from ⌘K).
                    Room settings was removed from this menu entirely (P1-9):
                    the rail's persistent Settings button is the one entry
                    point, and a second name for the same modal in a second
                    menu was redundant chrome, not a convenience. */}
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    toggleTheme();
                    setOpenMenu(null);
                  }}
                >
                  Theme
                </button>
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    layout.resetLayout();
                    setOpenMenu(null);
                  }}
                >
                  Reset the three-pane layout
                </button>
                {/* Idea 9: one-click "commit" — a named checkpoint (default
                    name "Checkpoint — {date}") with a toast that names it.
                    Rolling back stays gated in Settings → Checkpoints. */}
                <button
                  className="pop-item"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
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
                      setOpenMenu(null);
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
                    setOpenMenu(null);
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
                    setOpenMenu(null);
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
                    setOpenMenu(null);
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
          <LockIcon size={14} /> Lock
        </button>
      </div>
    </header>
  );
}
