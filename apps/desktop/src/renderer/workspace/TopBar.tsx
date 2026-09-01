import { useEffect, useState } from "react";
import { revealItemInDir } from "../platform";
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
import { LayoutApi } from "../shell/useLayout";
import { toggleTheme } from "../theme";
import EngineModelPicker from "./EngineModelPicker";
import LayoutMenu from "./LayoutMenu";
import { isCloudRoute, isExternalEngine, isModelReady, trustState } from "./markup";
import { QuickAction, QuickActionsMenu } from "./QuickActions";
import { saveDetail } from "./RecordingsPage";
import { WSActions } from "./actions";
import { WSState } from "./state";
import { WorkflowGlyph } from "./workflows/workflowGlyph";

type TopBarProps = {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  sidebarTitle: string;
  onRenamed?: (info: RoomInfo) => void;
  approvals?: number;
  running?: number;
};

function useRoomRename(
  info: RoomInfo,
  s: WSState,
  onRenamed: ((info: RoomInfo) => void) | undefined,
) {
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const commitRename = async () => {
    const typed = (nameDraft ?? "").trim();
    setNameDraft(null);
    if (!typed || typed === info.name) return;
    try {
      onRenamed?.(await api.renameRoom(typed));
      s.pushToast("success", `This room is now called “${typed}”.`);
    } catch (error) {
      s.pushToast("error", `Could not rename this room: ${String(error)}`);
    }
  };
  return { nameDraft, setNameDraft, commitRename };
}

function useTopBarEscape(menuOpen: boolean, setOpenMenu: WSState["setOpenMenu"]) {
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpenMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menuOpen, setOpenMenu]);
}

function pinnedWorkflowActions(s: WSState, a: WSActions): QuickAction[] {
  return s.workflows
    .filter((workflow) => workflow.pinned && workflow.status === "active" && workflow.binding.scope === "general")
    .map((workflow) => ({
      id: workflow.id,
      label: workflow.name,
      icon: <WorkflowGlyph emoji={workflow.emoji} size={14} />,
      hint: workflow.name,
      onRun: () => void a.runWorkflowNow(workflow.id),
    }));
}

function globalScriptActions(s: WSState, a: WSActions): QuickAction[] {
  return s.scripts
    .filter((script) => script.shortcut === "global")
    .map((script) => ({
      id: script.fileId,
      label: script.name,
      icon: <PlayIcon size={14} />,
      hint: `Run ${script.name}`,
      onRun: () => void a.runScript(script.fileId),
    }));
}

function RoomIdentity({
  info,
  nameDraft,
  onStartRename,
  onChange,
  onCommit,
  onCancel,
}: {
  info: RoomInfo;
  nameDraft: string | null;
  onStartRename: () => void;
  onChange: (name: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const handleKey = (key: string) => {
    if (key === "Enter") onCommit();
    if (key === "Escape") onCancel();
  };
  return (
    <div className="room-identity" title={info.path}>
      <div className="room-identity-text">
        {nameDraft === null ? (
          <button
            type="button"
            className="room-name room-name-btn"
            title="Rename this room"
            onClick={onStartRename}
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
            onChange={(event) => onChange(event.target.value)}
            onBlur={onCommit}
            onKeyDown={(event) => handleKey(event.key)}
          />
        )}
      </div>
    </div>
  );
}

function CommandButton({ s }: { s: WSState }) {
  const openSearch = () => {
    s.setSearchSel(0);
    s.setShowSearch(true);
  };
  return (
    <div className="command-wrap">
      <button className="command-button" type="button" onClick={openSearch}>
        <SearchIcon size={14} />
        <span>Search room or run a command…</span>
        <kbd>⌘ K</kbd>
      </button>
    </div>
  );
}

function recordingTitle(
  recording: NonNullable<WSState["recLive"]>,
  save: WSState["recSave"],
) {
  if (recording.status === "saving") return `${saveDetail(save)} — click to open it`;
  if (recording.status === "paused") {
    return "Recording paused — the microphone is closed. Nothing is lost; click to open it and resume.";
  }
  return "A live recording is running — click to open it";
}

function recordingLabel(recording: NonNullable<WSState["recLive"]>) {
  if (recording.status === "recording") return "Recording";
  if (recording.status === "paused") return "Recording paused";
  return "Saving…";
}

function RecordingIndicator({ s, onOpen }: { s: WSState; onOpen: (fileId: string) => void }) {
  if (!s.recLive) return null;
  const recording = s.recLive;
  const pulsing = recording.status === "recording" ? "pulsing" : "";
  return (
    <button
      className={`rec-indicator ${recording.status}`}
      title={recordingTitle(recording, s.recSave)}
      onClick={() => onOpen(recording.fileId)}
    >
      <span className={`rec-dot ${pulsing}`} />
      {recordingLabel(recording)}
    </button>
  );
}

function ShortcutMenus({ s, a }: { s: WSState; a: WSActions }) {
  const workflows = pinnedWorkflowActions(s, a);
  const scripts = globalScriptActions(s, a);
  const { setOpenMenu } = s;
  return (
    <>
      {workflows.length > 0 && (
        <QuickActionsMenu
          actions={workflows}
          open={s.openMenu === "workflows"}
          onOpenChange={(open) => setOpenMenu(open ? "workflows" : null)}
          buttonLabel="Workflows"
          buttonIcon={<WorkflowsIcon size={14} />}
          inlineMax={3}
          pill
          footer={{ label: "All workflows…", onClick: a.openWorkflows }}
        />
      )}
      {scripts.length > 0 && (
        <QuickActionsMenu
          actions={scripts}
          open={s.openMenu === "scripts"}
          onOpenChange={(open) => setOpenMenu(open ? "scripts" : null)}
          buttonLabel="Scripts"
          buttonIcon={<ScriptIcon size={14} />}
          inlineMax={2}
          pill
          footer={{ label: "All scripts…", onClick: a.openScripts }}
        />
      )}
    </>
  );
}

function modelPillTitle(ai: NonNullable<WSState["ai"]>, ready: boolean, cloud: boolean) {
  if (!ai.running) return "Ollama not running";
  if (ready || cloud) return "AI ready — click to switch engine";
  return "Model not downloaded";
}

function modelDotClass(ai: NonNullable<WSState["ai"]>, model: string, ready: boolean) {
  if (isExternalEngine(model)) return "ok";
  if (!ai.running) return "down";
  return ready ? "ok" : "warn";
}

function shouldKeepModelMenuOpen(model: string, engineModels: WSState["engineModels"]) {
  const [engine, submodel, effort] = splitExternalModel(model);
  if (!ENGINE_LABELS[engine]) return false;
  if (!submodel || effort) return false;
  const selected = engineModels[engine]?.find((candidate) => candidate.slug === submodel);
  return (selected?.efforts.length ?? 0) > 0;
}

function ModelMenu({
  s,
  a,
}: {
  s: WSState;
  a: WSActions;
}) {
  if (s.openMenu !== "model" || !s.ai) return null;
  const selectModel = (model: string) => {
    a.changeModel(model);
    if (!shouldKeepModelMenuOpen(model, s.engineModels)) s.setOpenMenu(null);
  };
  return (
    <>
      <div className="menu-backdrop" onMouseDown={() => s.setOpenMenu(null)} />
      <div className="pop-menu model-menu">
        <EngineModelPicker
          ai={s.ai}
          model={s.model}
          engineModels={s.engineModels}
          onModelsLoaded={a.recordEngineModels}
          onSelect={selectModel}
        />
      </div>
    </>
  );
}

function ModelControl({ s, a }: { s: WSState; a: WSActions }) {
  const ai = s.ai;
  if (!ai || (ai.models.length === 0 && ai.external.length === 0)) {
    return <button className="subtle" onClick={a.refreshAi}>Check AI</button>;
  }
  const ready = isModelReady(ai, s.model);
  const cloud = isCloudRoute(s.model, ai);
  const toggleModelMenu = () => s.setOpenMenu(s.openMenu === "model" ? null : "model");
  return (
    <div className="model-pill-wrap">
      <button
        className="model-pill"
        onClick={toggleModelMenu}
        aria-haspopup="menu"
        aria-expanded={s.openMenu === "model"}
        title={modelPillTitle(ai, ready, cloud)}
      >
        <span className={`model-dot ${modelDotClass(ai, s.model, ready)}`} />
        <span className="model-pill-name">{a.engineLabelOf(s.model)}</span>
        <ChevronDownIcon size={12} className="model-pill-caret" />
      </button>
      <ModelMenu s={s} a={a} />
    </div>
  );
}

function PrivacyBadge({ s }: { s: WSState }) {
  const cloud = isCloudRoute(s.model, s.ai);
  const trust = trustState(cloud, s.privacyOn);
  return (
    <div className={`privacy-badge ${trust.tone}`} title={trust.title}>
      {cloud ? <CloudIcon size={12} /> : <span className="status-dot" aria-hidden />}
      <span>{trust.label}</span>
    </div>
  );
}

function assistantLabel(aiShowing: boolean, approvals: number, running: number) {
  if (aiShowing) return "Hide the assistant (⌘2)";
  if (approvals > 0) {
    const subject = approvals === 1 ? "thing needs" : "things need";
    return `Show the assistant (⌘2) — ${approvals} ${subject} your approval`;
  }
  if (running > 0) return "Show the assistant (⌘2) — background work is running";
  return "Show the assistant (⌘2)";
}

function AssistantMarker({
  aiShowing,
  approvals,
  running,
}: {
  aiShowing: boolean;
  approvals: number;
  running: number;
}) {
  if (aiShowing || approvals > 0) return null;
  if (running === 0) return null;
  return <span className="pill-live nb-sem-linked" aria-hidden />;
}

function ApprovalMarker({ aiShowing, approvals }: { aiShowing: boolean; approvals: number }) {
  if (aiShowing || approvals === 0) return null;
  const count = approvals > 99 ? "99+" : approvals;
  return <span className="pill-count nb-circled nb-sem-pending" aria-hidden>{count}</span>;
}

function AssistantToggle({
  layout,
  approvals,
  running,
}: {
  layout: LayoutApi;
  approvals: number;
  running: number;
}) {
  const aiShowing = layout.visible.includes("ai");
  return (
    <button
      className="pill-btn assistant-toggle"
      type="button"
      data-testid="assistant-toggle"
      aria-pressed={aiShowing}
      aria-label={assistantLabel(aiShowing, approvals, running)}
      onClick={() => layout.togglePane("ai")}
    >
      <SparkIcon size={14} />
      <span>Assistant</span>
      <ApprovalMarker aiShowing={aiShowing} approvals={approvals} />
      <AssistantMarker aiShowing={aiShowing} approvals={approvals} running={running} />
    </button>
  );
}

function RoomMenu({ s, a, info }: { s: WSState; a: WSActions; info: RoomInfo }) {
  if (s.openMenu !== "room") return null;
  const close = () => s.setOpenMenu(null);
  const saveCheckpoint = () => {
    close();
    api
      .createRoomCheckpoint("")
      .then((meta) => s.pushToast("success", `Saved checkpoint “${meta.name}”. Roll back in Settings → Checkpoints.`))
      .catch((error) => s.pushToast("error", String(error)));
  };
  const exportFiles = () => {
    a.exportAllFiles();
    close();
  };
  const revealRoom = () => {
    revealItemInDir(info.path).catch(() => {});
    close();
  };
  const showShortcuts = () => {
    s.setShowShortcuts(true);
    close();
  };
  const showFeedback = () => {
    s.setShowFeedback(true);
    close();
  };
  const changeTheme = () => {
    toggleTheme();
    close();
  };
  return (
    <div className="room-menu-wrap">
      <button
        className="icon-btn"
        data-tip="Room actions"
        aria-label="Open the room actions menu"
        aria-haspopup="menu"
        aria-expanded
        onClick={close}
      >
        <DotsIcon size={16} />
      </button>
      <div className="menu-backdrop" onMouseDown={close} />
      <div className="pop-menu room-menu" role="menu">
        <button className="pop-item" role="menuitem" onClick={changeTheme}>Theme</button>
        <button className="pop-item" role="menuitem" onClick={saveCheckpoint}>Save a checkpoint</button>
        {s.files.length > 0 && (
          <button className="pop-item" role="menuitem" onClick={exportFiles}>Export all files…</button>
        )}
        <button className="pop-item" role="menuitem" onClick={revealRoom}>Reveal in Finder</button>
        <button className="pop-item" role="menuitem" onClick={showShortcuts}>Keyboard shortcuts (⌘/)</button>
        <button className="pop-item" role="menuitem" onClick={showFeedback}>Send feedback…</button>
      </div>
    </div>
  );
}

function RoomMenuTrigger({ s }: { s: WSState }) {
  const toggle = () => s.setOpenMenu("room");
  return (
    <div className="room-menu-wrap">
      <button
        className="icon-btn"
        data-tip="Room actions"
        aria-label="Open the room actions menu"
        aria-haspopup="menu"
        aria-expanded={false}
        onClick={toggle}
      >
        <DotsIcon size={16} />
      </button>
    </div>
  );
}

function LockButton({ onLock }: { onLock: () => void | Promise<void> }) {
  return (
    <button className="lock-btn btn-ic" title="Lock this room (⌘L)" data-agent-blocked onClick={onLock}>
      <LockIcon size={14} /> Lock
    </button>
  );
}

export default function TopBar({
  s,
  a,
  info,
  layout,
  sidebarTitle,
  onRenamed,
  approvals = 0,
  running = 0,
}: TopBarProps) {
  const rename = useRoomRename(info, s, onRenamed);
  useTopBarEscape(s.openMenu !== null, s.setOpenMenu);
  return (
    <header className="pr-topbar">
      <div className="pr-brandmark" aria-label="Arcelle" title={info.path}><Logomark size={26} /></div>
      <RoomIdentity
        info={info}
        nameDraft={rename.nameDraft}
        onStartRename={() => rename.setNameDraft(info.name)}
        onChange={rename.setNameDraft}
        onCommit={rename.commitRename}
        onCancel={() => rename.setNameDraft(null)}
      />
      <CommandButton s={s} />
      <div className="top-actions">
        <RecordingIndicator s={s} onOpen={a.viewFile} />
        <ShortcutMenus s={s} a={a} />
        <ModelControl s={s} a={a} />
        <PrivacyBadge s={s} />
        <LayoutMenu
          layout={layout}
          sidebarTitle={sidebarTitle}
          open={s.openMenu === "layout"}
          onOpenChange={(open) => s.setOpenMenu(open ? "layout" : null)}
        />
        <AssistantToggle layout={layout} approvals={approvals} running={running} />
        {s.openMenu === "room" ? (
          <RoomMenu s={s} a={a} info={info} />
        ) : (
          <RoomMenuTrigger s={s} />
        )}
        <LockButton onLock={a.handleLock} />
      </div>
    </header>
  );
}
